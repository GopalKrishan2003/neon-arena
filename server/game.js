export const WORLD = { w: 4000, h: 4000 };
export const TICK_RATE = 30;

const PELLET_COUNT = 900;
const MIN_ACTORS = 14; // bots fill the arena up to this many so it never feels empty
const START_MASS = 20;
const EAT_RATIO = 1.25; // you must be 25% heavier to eat someone
const BOOST_COST = 10; // mass per second
const BOOST_MULT = 1.8;

const BOT_NAMES = [
  'Nova', 'Pixel', 'Blip', 'Orbit', 'Zed', 'Echo', 'Volt', 'Rune',
  'Comet', 'Glitch', 'Byte', 'Flux', 'Neon', 'Quark', 'Drift', 'Sable',
];

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const radiusOf = (mass) => 6 * Math.sqrt(mass);
const speedOf = (mass) => 340 * Math.pow(mass, -0.18);

export class Game {
  constructor() {
    this.players = new Map();
    this.pellets = [];
    this.nextId = 1;
    for (let i = 0; i < PELLET_COUNT; i++) this.pellets.push(this.randomPellet());
  }

  randomPellet() {
    return { x: rand(0, WORLD.w), y: rand(0, WORLD.h), hue: Math.floor(rand(0, 360)) };
  }

  // Picks the spawn point (out of a few tries) farthest from anyone big enough to eat a newcomer.
  safeSpawnPoint() {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const x = rand(200, WORLD.w - 200);
      const y = rand(200, WORLD.h - 200);
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (p.mass < START_MASS * EAT_RATIO) continue;
        nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y) - radiusOf(p.mass));
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
      x,
      y,
      mass: START_MASS,
      peak: START_MASS,
      hue: Math.floor(rand(0, 360)),
      angle: rand(0, Math.PI * 2),
      throttle: isBot ? 1 : 0,
      boost: false,
      dropTimer: 0,
      thinkTimer: 0,
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

  // Advances the simulation by dt seconds. Returns the players eaten this tick, keyed by id.
  tick(dt) {
    this.balanceBots();
    for (const p of this.players.values()) {
      if (p.isBot) this.thinkBot(p, dt);
      this.move(p, dt);
      this.eatPellets(p);
    }
    return this.resolveCollisions();
  }

  move(p, dt) {
    const r = radiusOf(p.mass);
    let speed = speedOf(p.mass) * p.throttle;
    if (p.boost && p.mass > START_MASS + 5 && p.throttle > 0.1) {
      speed *= BOOST_MULT;
      p.mass -= BOOST_COST * dt;
      p.dropTimer += dt;
      // Boosting leaves a trail of food behind you, so the mass spent isn't lost from the arena.
      if (p.dropTimer > 1 / BOOST_COST) {
        p.dropTimer = 0;
        this.pellets.push({
          x: p.x - Math.cos(p.angle) * r * 1.2,
          y: p.y - Math.sin(p.angle) * r * 1.2,
          hue: p.hue,
        });
      }
    }
    // Big players slowly shrink so the leader is always catchable.
    if (p.mass > 300) p.mass -= p.mass * 0.003 * dt;
    p.x = clamp(p.x + Math.cos(p.angle) * speed * dt, r, WORLD.w - r);
    p.y = clamp(p.y + Math.sin(p.angle) * speed * dt, r, WORLD.h - r);
  }

  eatPellets(p) {
    const r = radiusOf(p.mass);
    const r2 = r * r;
    for (let i = this.pellets.length - 1; i >= 0; i--) {
      const f = this.pellets[i];
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      p.mass += 1;
      // Boost trails push the count above PELLET_COUNT; shrink back to it before respawning new food.
      if (this.pellets.length > PELLET_COUNT) {
        this.pellets[i] = this.pellets[this.pellets.length - 1];
        this.pellets.pop();
      } else {
        this.pellets[i] = this.randomPellet();
      }
    }
    p.peak = Math.max(p.peak, p.mass);
  }

  resolveCollisions() {
    const eaten = new Map();
    const list = [...this.players.values()];
    for (const a of list) {
      if (eaten.has(a.id)) continue;
      const ra = radiusOf(a.mass);
      for (const b of list) {
        if (a === b || eaten.has(b.id) || a.mass < b.mass * EAT_RATIO) continue;
        // b must be mostly swallowed, not just touched.
        if (Math.hypot(a.x - b.x, a.y - b.y) < ra - radiusOf(b.mass) * 0.4) {
          a.mass += b.mass * 0.8;
          eaten.set(b.id, { killer: a.name, score: Math.floor(b.peak) });
          this.players.delete(b.id);
        }
      }
      a.peak = Math.max(a.peak, a.mass);
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

    const r = radiusOf(p.mass);
    let threat = null;
    let threatD = Infinity;
    let prey = null;
    let preyD = Infinity;
    for (const o of this.players.values()) {
      if (o === p) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y) - radiusOf(o.mass);
      if (o.mass > p.mass * EAT_RATIO) {
        if (d < 300 + r && d < threatD) {
          threat = o;
          threatD = d;
        }
      } else if (p.mass > o.mass * EAT_RATIO && d < 450 && d < preyD) {
        prey = o;
        preyD = d;
      }
    }

    p.boost = false;
    if (threat) {
      p.angle = Math.atan2(p.y - threat.y, p.x - threat.x);
      p.boost = threatD < 120;
      return;
    }
    if (prey) {
      p.angle = Math.atan2(prey.y - p.y, prey.x - p.x);
      p.boost = preyD < 150 && Math.random() < 0.5;
      return;
    }
    let food = null;
    let foodD = 400 * 400;
    for (const f of this.pellets) {
      const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2;
      if (d < foodD) {
        food = f;
        foodD = d;
      }
    }
    if (food) p.angle = Math.atan2(food.y - p.y, food.x - p.x);
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
    const focus = me ??
      this.players.get(leaderboard[0]?.[0]) ?? { x: WORLD.w / 2, y: WORLD.h / 2, mass: START_MASS };
    const half = 1100 + radiusOf(focus.mass) * 3;
    const inView = (x, y, pad) => Math.abs(x - focus.x) < half + pad && Math.abs(y - focus.y) < half + pad;

    const players = [];
    for (const p of this.players.values()) {
      const r = radiusOf(p.mass);
      if (inView(p.x, p.y, r)) players.push([p.id, Math.round(p.x), Math.round(p.y), Math.round(r), p.hue, p.name]);
    }
    const pellets = [];
    for (const f of this.pellets) {
      if (inView(f.x, f.y, 0)) pellets.push(Math.round(f.x), Math.round(f.y), f.hue);
    }
    return {
      t: 's',
      you: me ? me.id : null,
      mass: me ? Math.floor(me.mass) : 0,
      cam: [Math.round(focus.x), Math.round(focus.y)],
      p: players,
      f: pellets,
      lb: leaderboard,
      online: this.players.size,
    };
  }
}
