export const WORLD = { w: 4000, h: 4000 };
export const TICK_RATE = 30;

const PELLET_COUNT = 900;
const MIN_ACTORS = 14; // bots fill the arena up to this many so it never feels empty
const START_MASS = 20;
const EAT_RATIO = 1.25; // a cell must be 25% heavier to eat another
const BOOST_COST = 10; // mass per second, per cell
const BOOST_MULT = 1.8;
const MAX_CELLS = 16;
const MIN_SPLIT_MASS = 36; // a cell needs this much mass to split in two
const SPLIT_SPEED = 900; // launch speed of a freshly split cell
const SPLIT_FRICTION = 4.5; // how fast that launch slows down
const SPLIT_COOLDOWN = 0.15;
const STEER_REACH = 400; // full throttle aims this far ahead of the player's centre
const mergeDelay = (mass) => 8 + mass * 0.02; // seconds before split cells can rejoin
const GRID = 128; // pellet bucket size

// Power-up orbs scattered around the arena. Order matters: the client indexes its icons by it.
const POWERUP_TYPES = ['speed', 'shield', 'magnet'];
const POWERUP_DURATION = { speed: 6, shield: 5, magnet: 8 }; // seconds
const POWERUP_COUNT = 6;
const POWERUP_RESPAWN = 4; // seconds between new orbs while below POWERUP_COUNT
const POWERUP_RADIUS = 18;
const SPEED_MULT = 1.5;
const MAGNET_REACH = 140; // extra pellet pickup range

const BOT_NAMES = [
  'Nova', 'Pixel', 'Blip', 'Orbit', 'Zed', 'Echo', 'Volt', 'Rune',
  'Comet', 'Glitch', 'Byte', 'Flux', 'Neon', 'Quark', 'Drift', 'Sable',
];

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const radiusOf = (mass) => 6 * Math.sqrt(mass);
const speedOf = (mass) => 340 * Math.pow(mass, -0.18);

// Pellets bucketed by position, so cells only check the food right around them.
class PelletGrid {
  constructor() {
    this.cols = Math.ceil(WORLD.w / GRID);
    this.rows = Math.ceil(WORLD.h / GRID);
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    this.count = 0;
  }

  add(pellet) {
    const cx = clamp(Math.floor(pellet.x / GRID), 0, this.cols - 1);
    const cy = clamp(Math.floor(pellet.y / GRID), 0, this.rows - 1);
    this.buckets[cy * this.cols + cx].push(pellet);
    this.count++;
  }

  // Calls fn for every pellet in the box; a pellet is removed when fn returns true.
  forEachIn(x0, y0, x1, y1, fn) {
    const cx0 = clamp(Math.floor(x0 / GRID), 0, this.cols - 1);
    const cx1 = clamp(Math.floor(x1 / GRID), 0, this.cols - 1);
    const cy0 = clamp(Math.floor(y0 / GRID), 0, this.rows - 1);
    const cy1 = clamp(Math.floor(y1 / GRID), 0, this.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.buckets[cy * this.cols + cx];
        for (let i = bucket.length - 1; i >= 0; i--) {
          if (fn(bucket[i])) {
            bucket[i] = bucket[bucket.length - 1];
            bucket.pop();
            this.count--;
          }
        }
      }
    }
  }
}

// Mass-weighted centre of a player's cells.
function centroid(p) {
  let x = 0;
  let y = 0;
  let m = 0;
  for (const c of p.cells) {
    x += c.x * c.mass;
    y += c.y * c.mass;
    m += c.mass;
  }
  return { x: x / m, y: y / m };
}

export class Game {
  constructor() {
    this.players = new Map();
    this.pellets = new PelletGrid();
    this.nextId = 1;
    this.nextCellId = 1;
    this.time = 0;
    this.powerups = [];
    this.nextPowerupAt = 0;
    this.refillPellets();
    while (this.powerups.length < POWERUP_COUNT) this.spawnPowerup();
  }

  refillPellets() {
    while (this.pellets.count < PELLET_COUNT) {
      this.pellets.add({ x: rand(0, WORLD.w), y: rand(0, WORLD.h), hue: Math.floor(rand(0, 360)) });
    }
    if (this.powerups.length < POWERUP_COUNT && this.time >= this.nextPowerupAt) {
      this.spawnPowerup();
      this.nextPowerupAt = this.time + POWERUP_RESPAWN;
    }
  }

  spawnPowerup() {
    this.powerups.push({
      x: rand(100, WORLD.w - 100),
      y: rand(100, WORLD.h - 100),
      type: Math.floor(Math.random() * POWERUP_TYPES.length),
    });
  }

  hasEffect(p, type) {
    return p.effects[type] > this.time;
  }

  pickUpPowerups(p) {
    for (const c of p.cells) {
      const reach = radiusOf(c.mass) + POWERUP_RADIUS;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const pu = this.powerups[i];
        if (Math.hypot(pu.x - c.x, pu.y - c.y) > reach) continue;
        const type = POWERUP_TYPES[pu.type];
        p.effects[type] = this.time + POWERUP_DURATION[type];
        this.powerups.splice(i, 1);
      }
    }
  }

  newCell(x, y, mass) {
    return { id: this.nextCellId++, x, y, mass, vx: 0, vy: 0, mergeAt: 0 };
  }

  // Picks the spawn point (out of a few tries) farthest from any cell big enough to eat a newcomer.
  safeSpawnPoint() {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const x = rand(200, WORLD.w - 200);
      const y = rand(200, WORLD.h - 200);
      let nearest = Infinity;
      for (const p of this.players.values()) {
        for (const c of p.cells) {
          if (c.mass < START_MASS * EAT_RATIO) continue;
          nearest = Math.min(nearest, Math.hypot(c.x - x, c.y - y) - radiusOf(c.mass));
        }
      }
      if (nearest > bestScore) {
        best = { x, y };
        bestScore = nearest;
      }
    }
    return best;
  }

  spawnPlayer(name, isBot = false) {
    const { x, y } = this.safeSpawnPoint();
    const p = {
      id: this.nextId++,
      name,
      isBot,
      cells: [this.newCell(x, y, START_MASS)],
      mass: START_MASS, // total of all cells, refreshed every tick
      peak: START_MASS,
      hue: Math.floor(rand(0, 360)),
      angle: rand(0, Math.PI * 2),
      throttle: isBot ? 1 : 0,
      boost: false,
      splitRequested: false,
      lastSplit: -Infinity,
      dropTimer: 0,
      thinkTimer: 0,
      effects: { speed: 0, shield: 0, magnet: 0 }, // game time each power-up wears off
    };
    this.players.set(p.id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || p.isBot) return;
    if (Number.isFinite(input.angle)) p.angle = input.angle;
    if (Number.isFinite(input.throttle)) p.throttle = clamp(input.throttle, 0, 1);
    p.boost = input.boost === true;
  }

  requestSplit(id) {
    const p = this.players.get(id);
    if (p && !p.isBot) p.splitRequested = true;
  }

  // Advances the simulation by dt seconds. Returns the players eaten this tick, keyed by id.
  tick(dt) {
    this.time += dt;
    this.balanceBots();
    for (const p of this.players.values()) {
      if (p.isBot) this.thinkBot(p, dt);
      // A request made during the cooldown waits for it, so a quick double-tap still splits twice.
      if (p.splitRequested && this.time - p.lastSplit >= SPLIT_COOLDOWN) {
        p.splitRequested = false;
        this.split(p);
      }
      this.move(p, dt);
      const pelletReach = this.hasEffect(p, 'magnet') ? MAGNET_REACH : 0;
      for (const c of p.cells) this.eatPellets(c, pelletReach);
      this.pickUpPowerups(p);
      this.pushApartOwnCells(p);
      this.mergeOwnCells(p);
    }
    this.refillPellets();
    const eaten = this.resolveCollisions();
    for (const p of this.players.values()) {
      p.mass = p.cells.reduce((sum, c) => sum + c.mass, 0);
      p.peak = Math.max(p.peak, p.mass);
    }
    return eaten;
  }

  // Every cell big enough splits in two, flinging the new half towards where the player is aiming.
  split(p) {
    p.lastSplit = this.time;
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);
    for (const c of [...p.cells].sort((a, b) => b.mass - a.mass)) {
      if (p.cells.length >= MAX_CELLS) break;
      if (c.mass < MIN_SPLIT_MASS) continue;
      const half = c.mass / 2;
      c.mass = half;
      const r = radiusOf(half);
      const n = this.newCell(c.x + dx * r, c.y + dy * r, half);
      n.vx = dx * SPLIT_SPEED;
      n.vy = dy * SPLIT_SPEED;
      c.mergeAt = n.mergeAt = this.time + mergeDelay(half * 2);
      p.cells.push(n);
    }
  }

  move(p, dt) {
    // All cells steer towards one point ahead of the player's centre. At zero throttle that point
    // is the centre itself, so split cells drift back together.
    const centre = centroid(p);
    const reach = STEER_REACH * p.throttle;
    const tx = centre.x + Math.cos(p.angle) * reach;
    const ty = centre.y + Math.sin(p.angle) * reach;

    p.dropTimer += dt;
    // Boosting leaves a trail of food behind each cell, so the mass spent isn't lost from the arena.
    const dropNow = p.dropTimer > 1 / BOOST_COST;
    if (dropNow) p.dropTimer = 0;
    const speedBonus = this.hasEffect(p, 'speed') ? SPEED_MULT : 1;

    for (const c of p.cells) {
      const r = radiusOf(c.mass);
      const dx = tx - c.x;
      const dy = ty - c.y;
      const d = Math.hypot(dx, dy);
      let speed = speedOf(c.mass) * Math.min(1, d / STEER_REACH) * speedBonus;
      if (p.boost && c.mass > START_MASS + 5 && d > 40) {
        speed *= BOOST_MULT;
        c.mass -= BOOST_COST * dt;
        if (dropNow) {
          this.pellets.add({ x: c.x - (dx / d) * r * 1.2, y: c.y - (dy / d) * r * 1.2, hue: p.hue });
        }
      }
      // Big cells slowly shrink so the leader is always catchable.
      if (c.mass > 300) c.mass -= c.mass * 0.003 * dt;

      if (d > 1) {
        c.x += (dx / d) * speed * dt;
        c.y += (dy / d) * speed * dt;
      }
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const friction = Math.exp(-SPLIT_FRICTION * dt);
      c.vx *= friction;
      c.vy *= friction;

      const rNow = radiusOf(c.mass);
      c.x = clamp(c.x, rNow, WORLD.w - rNow);
      c.y = clamp(c.y, rNow, WORLD.h - rNow);
    }
  }

  eatPellets(c, extraReach) {
    const r = radiusOf(c.mass) + extraReach;
    const r2 = r * r;
    this.pellets.forEachIn(c.x - r, c.y - r, c.x + r, c.y + r, (f) => {
      if ((f.x - c.x) ** 2 + (f.y - c.y) ** 2 > r2) return false;
      c.mass += 1;
      return true;
    });
  }

  // Until their merge timer runs out, a player's cells bump into each other instead of overlapping.
  pushApartOwnCells(p) {
    const cells = p.cells;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        if (this.time >= a.mergeAt && this.time >= b.mergeAt) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const overlap = radiusOf(a.mass) + radiusOf(b.mass) - d;
        if (overlap <= 0) continue;
        const push = (overlap / 2) * 0.5;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
  }

  mergeOwnCells(p) {
    const cells = p.cells;
    for (let i = 0; i < cells.length; i++) {
      for (let j = cells.length - 1; j > i; j--) {
        const a = cells[i];
        const b = cells[j];
        if (this.time < a.mergeAt || this.time < b.mergeAt) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > Math.max(radiusOf(a.mass), radiusOf(b.mass))) continue;
        const total = a.mass + b.mass;
        a.x = (a.x * a.mass + b.x * b.mass) / total;
        a.y = (a.y * a.mass + b.y * b.mass) / total;
        a.mass = total;
        cells.splice(j, 1);
      }
    }
  }

  resolveCollisions() {
    const all = [];
    for (const p of this.players.values()) for (const c of p.cells) all.push({ c, p });
    all.sort((a, b) => b.c.mass - a.c.mass); // biggest cells get first bite

    const eatenCells = new Map(); // cell id -> the player who ate it
    for (const a of all) {
      if (eatenCells.has(a.c.id)) continue;
      const ra = radiusOf(a.c.mass);
      for (const b of all) {
        if (a.p === b.p || eatenCells.has(b.c.id) || a.c.mass < b.c.mass * EAT_RATIO) continue;
        if (this.hasEffect(b.p, 'shield')) continue;
        // b must be mostly swallowed, not just touched.
        if (Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) < ra - radiusOf(b.c.mass) * 0.4) {
          a.c.mass += b.c.mass * 0.8;
          eatenCells.set(b.c.id, a.p);
        }
      }
    }

    const eaten = new Map();
    if (eatenCells.size === 0) return eaten;
    for (const p of this.players.values()) {
      const lastCell = p.cells.find((c) => eatenCells.has(c.id));
      p.cells = p.cells.filter((c) => !eatenCells.has(c.id));
      if (p.cells.length === 0) {
        const killer = eatenCells.get(lastCell.id);
        eaten.set(p.id, {
          killer: killer.name,
          killerId: killer.id,
          victim: p.name,
          score: Math.floor(p.peak),
          botsOnly: p.isBot && killer.isBot,
        });
        this.players.delete(p.id);
      }
    }
    return eaten;
  }

  balanceBots() {
    if (this.players.size < MIN_ACTORS) {
      this.spawnPlayer(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], true);
    } else if (this.players.size > MIN_ACTORS) {
      let smallest = null;
      for (const p of this.players.values()) {
        if (p.isBot && (!smallest || p.mass < smallest.mass)) smallest = p;
      }
      if (smallest) this.players.delete(smallest.id);
    }
  }

  thinkBot(p, dt) {
    p.thinkTimer -= dt;
    if (p.thinkTimer > 0) return;
    p.thinkTimer = rand(0.2, 0.4);

    const centre = centroid(p);
    let biggest = p.cells[0];
    let smallest = p.cells[0];
    for (const c of p.cells) {
      if (c.mass > biggest.mass) biggest = c;
      if (c.mass < smallest.mass) smallest = c;
    }

    let threat = null;
    let threatD = Infinity;
    let prey = null;
    let preyD = Infinity;
    for (const o of this.players.values()) {
      if (o === p) continue;
      for (const c of o.cells) {
        const d = Math.hypot(c.x - centre.x, c.y - centre.y) - radiusOf(c.mass);
        if (c.mass > smallest.mass * EAT_RATIO) {
          if (d < 300 + radiusOf(biggest.mass) && d < threatD) {
            threat = c;
            threatD = d;
          }
        } else if (biggest.mass > c.mass * EAT_RATIO && d < 450 && d < preyD) {
          prey = c;
          preyD = d;
        }
      }
    }

    p.boost = false;
    p.throttle = 1;
    if (threat) {
      p.angle = Math.atan2(centre.y - threat.y, centre.x - threat.x);
      p.boost = threatD < 120;
      return;
    }
    if (prey) {
      p.angle = Math.atan2(prey.y - centre.y, prey.x - centre.x);
      // Split-attack when half of the biggest cell could still swallow the target.
      p.splitRequested =
        preyD < 250 && p.cells.length < 4 && biggest.mass / 2 > prey.mass * EAT_RATIO && Math.random() < 0.3;
      p.boost = !p.splitRequested && preyD < 150 && Math.random() < 0.5;
      return;
    }
    for (const pu of this.powerups) {
      if (Math.hypot(pu.x - centre.x, pu.y - centre.y) < 300) {
        p.angle = Math.atan2(pu.y - centre.y, pu.x - centre.x);
        return;
      }
    }
    let food = null;
    let foodD = 400 * 400;
    this.pellets.forEachIn(centre.x - 400, centre.y - 400, centre.x + 400, centre.y + 400, (f) => {
      const d = (f.x - centre.x) ** 2 + (f.y - centre.y) ** 2;
      if (d < foodD) {
        food = f;
        foodD = d;
      }
      return false;
    });
    if (food) p.angle = Math.atan2(food.y - centre.y, food.x - centre.x);
    else p.angle += rand(-0.6, 0.6);
  }

  leaderboard() {
    return [...this.players.values()]
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 10)
      .map((p) => [p.id, p.name, Math.floor(p.mass)]);
  }

  // What one viewer sees: everything near their camera, packed into arrays to keep messages small.
  // Viewers without a live player (menu / death screen) spectate the leader.
  snapshot(viewerId, leaderboard) {
    const me = this.players.get(viewerId);
    const target = me ?? this.players.get(leaderboard[0]?.[0]);
    let focus = { x: WORLD.w / 2, y: WORLD.h / 2 };
    let spread = 0;
    if (target) {
      focus = centroid(target);
      for (const c of target.cells) {
        spread = Math.max(spread, Math.hypot(c.x - focus.x, c.y - focus.y) + radiusOf(c.mass));
      }
    }
    const half = 1100 + radiusOf(target?.mass ?? START_MASS) * 3 + spread;
    const inView = (x, y, pad) => Math.abs(x - focus.x) < half + pad && Math.abs(y - focus.y) < half + pad;

    const cells = [];
    const owners = [];
    for (const p of this.players.values()) {
      let visible = false;
      for (const c of p.cells) {
        const r = radiusOf(c.mass);
        if (!inView(c.x, c.y, r)) continue;
        cells.push([c.id, p.id, Math.round(c.x), Math.round(c.y), Math.round(r)]);
        visible = true;
      }
      if (!visible) continue;
      // Bit flags for active power-ups, in POWERUP_TYPES order, so the client can draw their effects.
      const flags = POWERUP_TYPES.reduce((bits, type, i) => bits | (this.hasEffect(p, type) ? 1 << i : 0), 0);
      owners.push([p.id, p.name, p.hue, flags]);
    }
    const powerups = [];
    for (const pu of this.powerups) {
      if (inView(pu.x, pu.y, POWERUP_RADIUS)) powerups.push(Math.round(pu.x), Math.round(pu.y), pu.type);
    }
    const pellets = [];
    this.pellets.forEachIn(focus.x - half, focus.y - half, focus.x + half, focus.y + half, (f) => {
      pellets.push(Math.round(f.x), Math.round(f.y), f.hue);
      return false;
    });
    return {
      t: 's',
      you: me ? me.id : null,
      mass: me ? Math.floor(me.mass) : 0,
      cam: [Math.round(focus.x), Math.round(focus.y)],
      c: cells,
      o: owners,
      f: pellets,
      pu: powerups,
      // Seconds left on each of my power-ups, in POWERUP_TYPES order.
      fx: me ? POWERUP_TYPES.map((type) => Math.max(0, Math.ceil(me.effects[type] - this.time))) : [],
      lb: leaderboard,
      online: this.players.size,
    };
  }
}
