const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const menu = $('menu');
const joinForm = $('join');
const nameInput = $('name');
const playBtn = $('play');
const statusEl = $('status');
const leaderboardEl = $('leaderboard');
const scoreEl = $('score');
const effectsEl = $('effects');
const onlineEl = $('online');
const feedEl = $('feed');
const toastEl = $('toast');
const splitBtn = $('split-btn');
const boostBtn = $('boost-btn');
const modeButtons = [...document.querySelectorAll('.mode')];
const connEl = $('conn');
const roomChip = $('room-chip');
const createRoomBtn = $('create-room');
const roomInput = $('room-input');
const joinRoomBtn = $('join-room');
const roomCurrent = $('room-current');
const roomCodeEl = $('room-code');
const roomModeEl = $('room-mode');
const shareRoomBtn = $('share-room');
const leaveRoomBtn = $('leave-room');

// Mirrors of server/game.js rules, used to predict my own movement without waiting for the server.
const BOOST_FLOOR = 25;
const BOOST_MULT = 1.8;
const SPEED_MULT = 1.5;
const STEER_REACH = 400;
const MIN_SPLIT_MASS = 36;
const MAX_CELLS = 16;
const MAGNET_REACH = 140;
const speedOf = (mass) => 340 * Math.pow(mass, -0.18);
const massOf = (r) => (r / 6) ** 2;

// Other players are drawn this far in the past, so there are always two updates to blend between.
const INTERP_DELAY = 100;
const JOY_RADIUS = 64;

// Same order as POWERUP_TYPES on the server.
const POWERUPS = [
  { icon: '⚡', name: 'Speed', color: '#ffd23f' },
  { icon: '🛡️', name: 'Shield', color: '#4dd2ff' },
  { icon: '🧲', name: 'Magnet', color: '#c77dff' },
];
const MODE_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let ws;
let world = { w: 4000, h: 4000 };
let myId = null;
let mode = MODE_LABELS[store.get('mode')] ? store.get('mode') : 'medium';
// Private room I'm in or watching (its code), and that room's difficulty.
let room = null;
let roomMode = null;
let pendingRoom = new URLSearchParams(location.search).get('room'); // from a shared ?room= link
let resumeToken = null; // lets me reclaim my cells if the connection drops mid-game
let retries = 0;
let reconnectTimer = null;
const best = store.get('best', { easy: 0, medium: 0, hard: 0 });
let pellets = [];
let powerups = [];
let latest = null; // last snapshot from the server
let lastEffects = [0, 0, 0];
let rtt = 150; // ms, measured with pings
let clockOffset = null; // local Date.now() minus server timestamp, at its lowest (least delayed)
const blobs = new Map(); // cell id -> render state
const camera = { x: 2000, y: 2000, scale: 1 };
const input = { mx: 0, my: 0, boost: false, angle: 0 };
// The joystick appears wherever the thumb lands on the canvas and follows it until release.
const joy = { id: null, bx: 0, by: 0, kx: 0, ky: 0 };
let cw = 0;
let ch = 0;
let dpr = 1;

nameInput.value = store.get('name', '');
// Browsers refuse to vibrate before the first tap, and log an error if you try.
const vibrate = (pattern) => navigator.userActivation?.hasBeenActive && navigator.vibrate?.(pattern);

// ---- networking -----------------------------------------------------------

function connect() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    retries = 0;
    playBtn.disabled = false;
    updatePlayLabel();
    if (statusEl.textContent.startsWith('Connection lost')) statusEl.textContent = '';
    if (myId !== null && resumeToken) {
      send({ t: 'resume', token: resumeToken });
    } else {
      watch();
    }
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    playBtn.disabled = true;
    playBtn.textContent = 'Connecting…';
    if (myId !== null) {
      // Mid-game: keep the game on screen and quietly reconnect. The server holds my cells for 30s.
      connEl.hidden = false;
    } else {
      showMenu('Connection lost, reconnecting…');
    }
    // Retry fast at first, then back off so a dead server isn't hammered.
    reconnectTimer = setTimeout(connect, Math.min(500 * 2 ** retries++, 8000));
  };
}

// Cell and player ids restart in every arena, so drop everything drawn from the previous one.
function resetWorld() {
  blobs.clear();
  pellets = [];
  powerups = [];
}

// The menu spectates whatever PLAY would join: a private room if I'm in one, else the chosen level.
function watch() {
  resetWorld();
  if (pendingRoom) send({ t: 'watch', room: pendingRoom });
  else if (room) send({ t: 'watch', room });
  else send({ t: 'watch', mode });
}

// Phones often kill the connection while the app is in the background; reconnect as soon as it's back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws?.readyState === WebSocket.CLOSED) connect();
});

// Render's free plan sleeps after 15 minutes without web requests, and game traffic doesn't count.
setInterval(() => fetch('/health', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      world = msg.world;
      break;
    case 'pong':
      rtt = rtt * 0.7 + (performance.now() - msg.c) * 0.3;
      break;
    case 'counts':
      for (const btn of modeButtons) {
        const n = msg[btn.dataset.mode] ?? 0;
        btn.querySelector('.count').textContent = n === 1 ? '1 player' : `${n} players`;
      }
      break;
    case 'joined':
      if (!msg.resumed) resetWorld();
      myId = msg.id;
      resumeToken = msg.token;
      connEl.hidden = true;
      setRoom(msg.room, msg.mode);
      if (!msg.resumed) lastEffects = [0, 0, 0];
      menu.hidden = true;
      document.body.classList.add('playing');
      if (msg.room && !msg.resumed && createRoomBtn.dataset.creating) {
        delete createRoomBtn.dataset.creating;
        toast(`Room ${msg.room} created!`, '#36f1cd');
        shareRoom(true);
      }
      break;
    case 'resume-failed':
      myId = null;
      resumeToken = null;
      connEl.hidden = true;
      showMenu('You were away too long, so your cell was removed.');
      watch();
      break;
    case 'room':
      pendingRoom = null;
      setRoom(msg.code, msg.mode);
      break;
    case 'error':
      delete createRoomBtn.dataset.creating;
      if (msg.code === 'no-room') {
        pendingRoom = null;
        setRoom(null);
        watch();
      }
      statusEl.textContent = msg.message;
      break;
    case 'dead': {
      myId = null;
      resumeToken = null;
      vibrate([80, 60, 160]);
      const previous = best[msg.mode] ?? 0;
      if (msg.score > previous) {
        best[msg.mode] = msg.score;
        store.set('best', best);
        renderBest();
      }
      const record = previous > 0 && msg.score > previous;
      showMenu(`Eaten by ${msg.killer} · score ${msg.score}${record ? ' · new best!' : ''}`);
      break;
    }
    case 'kill':
      vibrate(40);
      toast(`You ate ${msg.victim}!`, '#36f1cd');
      break;
    case 'feed':
      for (const [killer, victim] of msg.kills) addFeed(killer, victim);
      break;
    case 's':
      applySnapshot(msg);
      break;
  }
}

function applySnapshot(s) {
  latest = s;
  if (s.f) pellets = s.f;
  powerups = s.pu;

  // Track the smallest offset seen: that's the update that travelled fastest. Let it creep up slowly
  // in case the clocks drift.
  const offset = Date.now() - s.ts;
  clockOffset = clockOffset === null || offset < clockOffset ? offset : clockOffset + (offset - clockOffset) * 0.02;

  const owners = new Map(s.o.map(([id, name, hue, flags]) => [id, { name, hue, flags }]));
  const seen = new Set();
  for (const [id, owner, x, y, r] of s.c) {
    seen.add(id);
    const { name, hue, flags } = owners.get(owner);
    let b = blobs.get(id);
    // Cell ids are only unique within one arena, so after switching arenas an id can come back
    // belonging to someone else. Treat that as a brand-new cell.
    if (b && b.owner !== owner) b = null;
    if (!b) {
      // A freshly split cell starts inside its sibling, so it visibly shoots out instead of popping in.
      let start = { x, y, r };
      let nearest = Infinity;
      for (const o of blobs.values()) {
        const d = o.owner === owner ? Math.hypot(o.x - x, o.y - y) : Infinity;
        if (d < nearest && d < o.r * 3) {
          nearest = d;
          start = o;
        }
      }
      b = { owner, hue, name, x: start.x, y: start.y, r, px: start.x, py: start.y, born: performance.now(), samples: [] };
      blobs.delete(id); // re-insert so a reused id doesn't keep its old place in draw order
      b.samples.push({ t: s.ts - 50, x: start.x, y: start.y, r });
      blobs.set(id, b);
    }
    b.flags = flags;
    b.sx = x;
    b.sy = y;
    b.sr = r;
    b.samples.push({ t: s.ts, x, y, r });
    if (b.samples.length > 8) b.samples.shift();
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);

  setText(scoreEl, myId ? `${s.mass}` : '');
  // Phones already show the room in its own chip, and the top bar has no room to spare.
  const roomLabel = room && !isTouch ? `Room ${room} · ` : '';
  setText(onlineEl, `${roomLabel}${MODE_LABELS[roomMode ?? mode]} · ${s.online}${isTouch ? '' : ' in arena'}`);
  renderLeaderboard(s.lb);
  renderEffects(s.fx);
}

// DOM writes are slow on phones, so only touch the page when something actually changed.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

let leaderboardKey = '';
function renderLeaderboard(lb) {
  const key = JSON.stringify(lb) + myId;
  if (key === leaderboardKey) return;
  leaderboardKey = key;
  leaderboardEl.replaceChildren(
    ...lb.map(([id, name, mass], i) => {
      const li = document.createElement('li');
      li.classList.toggle('me', id === myId);
      const rank = document.createElement('i');
      rank.textContent = i + 1;
      const m = document.createElement('span');
      m.textContent = mass;
      li.append(rank, name, m);
      return li;
    }),
  );
}

let effectsKey = '';
function renderEffects(fx) {
  fx.forEach((secs, i) => {
    if (secs > 0 && lastEffects[i] === 0) {
      vibrate(25);
      toast(`${POWERUPS[i].icon} ${POWERUPS[i].name}!`, POWERUPS[i].color);
    }
  });
  lastEffects = fx.length ? fx : [0, 0, 0];
  const key = fx.join();
  if (key === effectsKey) return;
  effectsKey = key;
  effectsEl.replaceChildren(
    ...fx.flatMap((secs, i) => {
      if (secs <= 0) return [];
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.borderColor = POWERUPS[i].color;
      chip.textContent = `${POWERUPS[i].icon} ${secs}s`;
      return [chip];
    }),
  );
}

let toastTimer;
function toast(text, color) {
  toastEl.textContent = text;
  toastEl.style.color = color;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth; // restart the CSS animation
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function addFeed(killer, victim) {
  const li = document.createElement('li');
  const k = document.createElement('b');
  k.textContent = killer;
  const v = document.createElement('b');
  v.textContent = victim;
  li.append(k, ' ate ', v);
  feedEl.prepend(li);
  while (feedEl.children.length > 4) feedEl.lastChild.remove();
  setTimeout(() => li.remove(), 6000);
}

// ---- menu -----------------------------------------------------------------

function renderBest() {
  for (const btn of modeButtons) {
    const score = best[btn.dataset.mode] ?? 0;
    btn.querySelector('.best').textContent = score ? `Best ${score}` : 'No best yet';
  }
}

function selectMode(next) {
  mode = next;
  store.set('mode', mode);
  for (const btn of modeButtons) btn.setAttribute('aria-checked', btn.dataset.mode === mode);
  if (!room) {
    document.body.dataset.mode = mode;
    watch();
  }
}

// ---- private rooms --------------------------------------------------------

function updatePlayLabel() {
  if (!playBtn.disabled) playBtn.textContent = room ? `PLAY IN ROOM ${room}` : 'PLAY';
}

function setRoom(code, codeMode) {
  room = code ?? null;
  roomMode = room ? codeMode : null;
  document.body.classList.toggle('in-room', !!room);
  document.body.dataset.mode = roomMode ?? mode;
  roomCurrent.hidden = !room;
  updatePlayLabel();
  roomChip.hidden = !room;
  if (room) {
    roomCodeEl.textContent = room;
    roomModeEl.textContent = MODE_LABELS[roomMode];
    roomChip.querySelector('b').textContent = room;
  }
  // Keep the address bar shareable: it always points at the room I'm in.
  const url = new URL(location.href);
  if (room) url.searchParams.set('room', room);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

async function shareRoom(quiet = false) {
  if (!room) return;
  const url = `${location.origin}/?room=${room}`;
  if (!quiet && navigator.share) {
    try {
      await navigator.share({ title: 'Neon Arena', text: `Join my Neon Arena room: ${room}`, url });
      return;
    } catch {
      // Cancelled, or sharing isn't allowed here; fall back to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(quiet ? `Room ${room} · link copied` : 'Invite link copied!', '#36f1cd');
  } catch {
    if (!quiet) toast(`Room code: ${room}`, '#36f1cd');
  }
}

createRoomBtn.addEventListener('click', () => {
  createRoomBtn.dataset.creating = '1';
  store.set('name', nameInput.value.trim());
  send({ t: 'create', name: nameInput.value.trim(), mode });
});

function joinRoom() {
  const code = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) {
    statusEl.textContent = 'Room codes are 5 letters or numbers.';
    return;
  }
  store.set('name', nameInput.value.trim());
  send({ t: 'join', name: nameInput.value.trim(), room: code });
}
joinRoomBtn.addEventListener('click', joinRoom);
roomInput.addEventListener('input', () => (roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    joinRoom();
  }
});
shareRoomBtn.addEventListener('click', () => shareRoom());
roomChip.addEventListener('click', () => shareRoom());
leaveRoomBtn.addEventListener('click', () => {
  setRoom(null);
  statusEl.textContent = '';
  watch();
});

for (const btn of modeButtons) btn.addEventListener('click', () => selectMode(btn.dataset.mode));
selectMode(mode);
renderBest();

function showMenu(message) {
  statusEl.textContent = message;
  menu.hidden = false;
  document.body.classList.remove('playing');
  input.boost = false;
  boostBtn.classList.remove('held');
  joy.id = null;
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  store.set('name', name);
  nameInput.blur(); // closes the on-screen keyboard
  send(room ? { t: 'join', name, room } : { t: 'join', name, mode });
});

// ---- input ----------------------------------------------------------------

function split() {
  if (myId === null || splitBtn.disabled) return;
  send({ t: 'split' });
  vibrate(15);
  splitBtn.classList.remove('fired');
  void splitBtn.offsetWidth;
  splitBtn.classList.add('fired');
}

canvas.addEventListener('mousemove', (e) => {
  input.mx = e.clientX;
  input.my = e.clientY;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) input.boost = true;
});
window.addEventListener('mouseup', () => (input.boost = false));
window.addEventListener('keydown', (e) => {
  if (e.target === nameInput) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) split();
  } else if (e.key === 'Shift') {
    input.boost = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') input.boost = false;
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (joy.id !== null) return;
  const t = e.changedTouches[0];
  joy.id = t.identifier;
  joy.bx = joy.kx = t.clientX;
  joy.by = joy.ky = t.clientY;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier !== joy.id) continue;
    const dx = t.clientX - joy.bx;
    const dy = t.clientY - joy.by;
    const d = Math.hypot(dx, dy);
    const k = d > JOY_RADIUS ? JOY_RADIUS / d : 1;
    joy.kx = joy.bx + dx * k;
    joy.ky = joy.by + dy * k;
  }
}, { passive: false });

function endJoystick(e) {
  for (const t of e.changedTouches) if (t.identifier === joy.id) joy.id = null;
}
canvas.addEventListener('touchend', endJoystick);
canvas.addEventListener('touchcancel', endJoystick);

splitBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  split();
}, { passive: false });
boostBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  input.boost = true;
  boostBtn.classList.add('held');
  vibrate(10);
}, { passive: false });
for (const type of ['touchend', 'touchcancel']) {
  boostBtn.addEventListener(type, () => {
    input.boost = false;
    boostBtn.classList.remove('held');
  });
}

// Touch steers with the joystick (and stops when released); mouse steers by distance from centre.
function steering() {
  if (isTouch) {
    if (joy.id === null) return { angle: input.angle, throttle: 0 };
    const dx = joy.kx - joy.bx;
    const dy = joy.ky - joy.by;
    const d = Math.hypot(dx, dy);
    if (d > 4) input.angle = Math.atan2(dy, dx);
    return { angle: input.angle, throttle: Math.min(1, d / JOY_RADIUS) };
  }
  const dx = input.mx - cw / 2;
  const dy = input.my - ch / 2;
  input.angle = Math.atan2(dy, dx);
  return { angle: input.angle, throttle: Math.min(1, Math.hypot(dx, dy) / (Math.min(cw, ch) * 0.2)) };
}

setInterval(() => {
  if (myId === null) return;
  send({ t: 'input', ...steering(), boost: input.boost });
}, 50);

// ---- simulation -----------------------------------------------------------

// Places another player's cell where it was INTERP_DELAY ago, blending the two updates around that time.
function interpolate(b, renderT) {
  const s = b.samples;
  let i = s.length - 1;
  while (i > 0 && s[i - 1].t > renderT) i--;
  const a = s[Math.max(0, i - 1)];
  const c = s[i];
  const span = c.t - a.t;
  const k = span > 0 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 1;
  b.x = a.x + (c.x - a.x) * k;
  b.y = a.y + (c.y - a.y) * k;
  b.r = a.r + (c.r - a.r) * k;
}

// Moves my cells the way the server will, right away, then nudges them towards the server's answer.
function predictMine(dt, now) {
  const { angle, throttle } = steering();
  let cx = 0;
  let cy = 0;
  let w = 0;
  for (const b of blobs.values()) {
    if (b.owner !== myId) continue;
    cx += b.px * b.r * b.r;
    cy += b.py * b.r * b.r;
    w += b.r * b.r;
  }
  if (w === 0) return;
  const tx = cx / w + Math.cos(angle) * STEER_REACH * throttle;
  const ty = cy / w + Math.sin(angle) * STEER_REACH * throttle;
  const speedy = latest?.fx?.[0] > 0 ? SPEED_MULT : 1;
  const lead = rtt / 1000; // our latest input reaches the server about one round trip after the state we hold

  for (const b of blobs.values()) {
    if (b.owner !== myId) continue;
    b.r += (b.sr - b.r) * (1 - Math.exp(-dt * 12));
    const mass = massOf(b.sr);
    const dx = tx - b.px;
    const dy = ty - b.py;
    const d = Math.hypot(dx, dy);
    let speed = speedOf(mass) * Math.min(1, d / STEER_REACH) * speedy;
    if (input.boost && mass > BOOST_FLOOR && d > 40) speed *= BOOST_MULT;
    const vx = d > 1 ? (dx / d) * speed : 0;
    const vy = d > 1 ? (dy / d) * speed : 0;
    b.px += vx * dt;
    b.py += vy * dt;

    const gx = b.sx + vx * lead;
    const gy = b.sy + vy * lead;
    const err = Math.hypot(gx - b.px, gy - b.py);
    if (err > 300) {
      b.px = gx;
      b.py = gy;
    } else {
      // Freshly split cells are flung by the server, so follow it closely for a moment.
      const rate = now - b.born < 700 ? 14 : 5;
      const k = 1 - Math.exp(-dt * rate);
      b.px += (gx - b.px) * k;
      b.py += (gy - b.py) * k;
    }
    b.px = Math.max(b.r, Math.min(world.w - b.r, b.px));
    b.py = Math.max(b.r, Math.min(world.h - b.r, b.py));
    b.x = b.px;
    b.y = b.py;
  }
}

// Area-weighted centre of my cells and how far they reach from it, or null if none are visible.
function myCentre() {
  let x = 0;
  let y = 0;
  let w = 0;
  let count = 0;
  let canSplit = false;
  for (const b of blobs.values()) {
    if (b.owner !== myId) continue;
    x += b.x * b.r * b.r;
    y += b.y * b.r * b.r;
    w += b.r * b.r;
    count++;
    if (massOf(b.sr) >= MIN_SPLIT_MASS) canSplit = true;
  }
  if (w === 0) return null;
  const centre = { x: x / w, y: y / w, spread: 0, canSplit: canSplit && count < MAX_CELLS };
  for (const b of blobs.values()) {
    if (b.owner === myId) centre.spread = Math.max(centre.spread, Math.hypot(b.x - centre.x, b.y - centre.y) + b.r);
  }
  return centre;
}

// ---- rendering ------------------------------------------------------------

function resize() {
  // Phones report up to 3x pixel density; 2x looks the same and draws far fewer pixels.
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cw = window.innerWidth;
  ch = window.innerHeight;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  input.mx = cw / 2;
  input.my = ch / 2;
}
window.addEventListener('resize', resize);
resize();

// Canvas shadows are very slow on phones, so glows and pellets are pre-drawn once and stamped.
const sprites = new Map();
function sprite(key, size, draw) {
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement('canvas');
    s.width = s.height = size;
    draw(s.getContext('2d'), size);
    sprites.set(key, s);
  }
  return s;
}
const glowSprite = (color) =>
  sprite(`glow:${color}`, 128, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, n * 0.25, n / 2, n / 2, n / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.55;
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  });
const pelletSprite = (hue) =>
  sprite(`pellet:${hue}`, 32, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, `hsl(${hue} 100% 75%)`);
    grad.addColorStop(0.35, `hsl(${hue} 100% 62%)`);
    grad.addColorStop(0.45, `hsla(${hue}, 100%, 60%, 0.35)`);
    grad.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  });

function drawGrid(halfW, halfH) {
  const step = 50;
  const x0 = Math.max(0, Math.floor((camera.x - halfW) / step) * step);
  const x1 = Math.min(world.w, camera.x + halfW);
  const y0 = Math.max(0, Math.floor((camera.y - halfH) / step) * step);
  const y1 = Math.min(world.h, camera.y + halfH);
  ctx.strokeStyle = 'rgba(80, 100, 255, 0.12)';
  ctx.lineWidth = 1 / camera.scale;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (let y = y0; y <= y1; y += step) {
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 62, 165, 0.25)';
  ctx.lineWidth = 24;
  ctx.strokeRect(0, 0, world.w, world.h);
  ctx.strokeStyle = '#ff3ea5';
  ctx.lineWidth = 5;
  ctx.strokeRect(0, 0, world.w, world.h);
}

function drawPellets(halfW, halfH) {
  const list = [...blobs.values()];
  for (let i = 0; i < pellets.length; i += 3) {
    const x = pellets[i];
    const y = pellets[i + 1];
    if (Math.abs(x - camera.x) > halfW + 10 || Math.abs(y - camera.y) > halfH + 10) continue;
    // Pellets only refresh 5x a second, so hide any a cell is already covering.
    let covered = false;
    for (const b of list) {
      if ((b.x - x) ** 2 + (b.y - y) ** 2 < b.r * b.r) {
        covered = true;
        break;
      }
    }
    if (!covered) ctx.drawImage(pelletSprite(Math.round(pellets[i + 2] / 15) * 15), x - 12, y - 12, 24, 24);
  }
}

function drawPowerups(now) {
  const pulse = 1 + Math.sin(now / 200) * 0.12;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '18px system-ui, sans-serif';
  for (let i = 0; i < powerups.length; i += 3) {
    const x = powerups[i];
    const y = powerups[i + 1];
    const style = POWERUPS[powerups[i + 2]];
    const r = 18 * pulse;
    ctx.drawImage(glowSprite(style.color), x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
    ctx.fillStyle = 'rgba(5, 6, 15, 0.85)';
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillText(style.icon, x, y + 1);
  }
}

function drawBlobs(now) {
  const sorted = [...blobs.values()].sort((a, b) => a.r - b.r);
  for (const b of sorted) {
    if (b.flags & 4) {
      // Magnet: show the pickup range.
      ctx.fillStyle = 'rgba(199, 125, 255, 0.07)';
      ctx.strokeStyle = 'rgba(199, 125, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + MAGNET_REACH, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    const glow = b.flags & 1 ? '#ffd23f' : `hsl(${Math.round(b.hue / 10) * 10} 100% 60%)`;
    const g = b.r * (b.flags & 1 ? 1.9 : 1.55);
    ctx.drawImage(glowSprite(glow), b.x - g, b.y - g, g * 2, g * 2);
    ctx.fillStyle = `hsl(${b.hue} 85% 45%)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(3, b.r * 0.08);
    ctx.strokeStyle = `hsl(${b.hue} 100% 70%)`;
    ctx.stroke();

    if (b.flags & 2) {
      // Shield: a spinning dashed ring.
      ctx.save();
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -now / 30;
      ctx.strokeStyle = '#4dd2ff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Names too small to read on screen aren't worth the cost of drawing text.
    if (b.r * camera.scale < 9) continue;
    const size = Math.max(12, b.r * 0.38);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.15;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(b.name, b.x, b.y);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.name, b.x, b.y);
  }
}

function drawMinimap(me) {
  // On phones the bottom corners belong to the thumbs, so the map moves to the top-left.
  const size = isTouch ? 76 : Math.min(140, cw * 0.28);
  const x = isTouch ? 12 : cw - size - 16;
  const y = isTouch ? 52 : ch - size - 16;
  ctx.fillStyle = 'rgba(12, 14, 32, 0.72)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = 'rgba(255, 62, 165, 0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, size, size);
  const focus = me ?? { x: camera.x, y: camera.y };
  ctx.fillStyle = me ? '#36f1cd' : '#8a90b8';
  ctx.beginPath();
  ctx.arc(x + (focus.x / world.w) * size, y + (focus.y / world.h) * size, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawJoystick() {
  // Until the thumb lands, a faint joystick sits bottom-left to show where to steer.
  const active = joy.id !== null;
  const bx = active ? joy.bx : 96;
  const by = active ? joy.by : ch - 120;
  const kx = active ? joy.kx : bx;
  const ky = active ? joy.ky : by;
  const pull = Math.hypot(kx - bx, ky - by) / JOY_RADIUS;

  ctx.globalAlpha = active ? 1 : 0.55;
  const ring = ctx.createRadialGradient(bx, by, JOY_RADIUS * 0.4, bx, by, JOY_RADIUS);
  ring.addColorStop(0, 'rgba(54, 241, 205, 0.02)');
  ring.addColorStop(1, 'rgba(54, 241, 205, 0.16)');
  ctx.fillStyle = ring;
  ctx.strokeStyle = 'rgba(54, 241, 205, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(bx, by, JOY_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (active && pull > 0.1) {
    // Arc on the rim showing which way you're heading, brighter the harder you push.
    const a = Math.atan2(ky - by, kx - bx);
    ctx.strokeStyle = `rgba(54, 241, 205, ${0.4 + pull * 0.6})`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(bx, by, JOY_RADIUS + 6, a - 0.45, a + 0.45);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  ctx.drawImage(glowSprite('#36f1cd'), kx - 44, ky - 44, 88, 88);
  ctx.fillStyle = '#36f1cd';
  ctx.beginPath();
  ctx.arc(kx, ky, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(4, 19, 26, 0.35)';
  ctx.beginPath();
  ctx.arc(kx, ky, 12, 0, Math.PI * 2);
  ctx.fill();
  if (!active) {
    ctx.fillStyle = '#e8ecff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DRAG TO MOVE', bx, by + JOY_RADIUS + 18);
  }
  ctx.globalAlpha = 1;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const renderT = Date.now() - (clockOffset ?? 0) - INTERP_DELAY;
  for (const b of blobs.values()) if (b.owner !== myId) interpolate(b, renderT);
  if (myId !== null) predictMine(dt, now);

  const me = myId !== null ? myCentre() : null;
  if (me) {
    camera.x = me.x;
    camera.y = me.y;
    splitBtn.disabled = !me.canSplit;
    boostBtn.disabled = latest.mass <= BOOST_FLOOR;
  } else if (latest) {
    const k = 1 - Math.exp(-dt * 4);
    camera.x += (latest.cam[0] - camera.x) * k;
    camera.y += (latest.cam[1] - camera.y) * k;
  }
  // Zoom out as you grow or spread out. The server sends a slightly wider area, so edges never pop in.
  const viewHalf = me ? 800 + 2.5 * 6 * Math.sqrt(latest.mass) + me.spread : 950;
  const targetScale = Math.max(cw, ch) / 2 / viewHalf;
  camera.scale += (targetScale - camera.scale) * (1 - Math.exp(-dt * 3));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, cw, ch);

  const halfW = cw / 2 / camera.scale;
  const halfH = ch / 2 / camera.scale;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);
  drawGrid(halfW, halfH);
  drawPellets(halfW, halfH);
  drawPowerups(now);
  drawBlobs(now);
  ctx.restore();

  drawMinimap(me);
  if (isTouch && myId !== null) drawJoystick();
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
