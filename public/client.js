const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('menu');
const joinForm = document.getElementById('join');
const nameInput = document.getElementById('name');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const leaderboardEl = document.getElementById('leaderboard');
const scoreEl = document.getElementById('score');
const effectsEl = document.getElementById('effects');
const onlineEl = document.getElementById('online');
const feedEl = document.getElementById('feed');
const toastEl = document.getElementById('toast');
const splitBtn = document.getElementById('split-btn');
const boostBtn = document.getElementById('boost-btn');

// Same order as POWERUP_TYPES on the server.
const POWERUPS = [
  { icon: '⚡', name: 'Speed', color: '#ffd23f' },
  { icon: '🛡️', name: 'Shield', color: '#4dd2ff' },
  { icon: '🧲', name: 'Magnet', color: '#c77dff' },
];
const MAGNET_REACH = 140;
const JOY_RADIUS = 60;

const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

let ws;
let world = { w: 4000, h: 4000 };
let myId = null;
let latest = null; // last snapshot from the server
let lastEffects = [0, 0, 0];
const blobs = new Map(); // cell id -> smoothed render state
const camera = { x: 2000, y: 2000, scale: 1 };
const input = { mx: 0, my: 0, boost: false, angle: 0 };
// The joystick appears wherever the thumb lands on the canvas and follows it until release.
const joy = { id: null, bx: 0, by: 0, kx: 0, ky: 0 };
let cw = 0;
let ch = 0;
let dpr = 1;

try {
  nameInput.value = localStorage.getItem('name') ?? '';
} catch {}

const vibrate = (pattern) => navigator.vibrate?.(pattern);

// ---- networking -----------------------------------------------------------

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    playBtn.disabled = false;
    playBtn.textContent = 'PLAY';
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    myId = null;
    playBtn.disabled = true;
    playBtn.textContent = 'Connecting…';
    showMenu('Connection lost, reconnecting…');
    setTimeout(connect, 1500);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      world = msg.world;
      break;
    case 'joined':
      myId = msg.id;
      lastEffects = [0, 0, 0];
      menu.hidden = true;
      document.body.classList.add('playing');
      break;
    case 'dead':
      myId = null;
      vibrate([80, 60, 160]);
      showMenu(`Eaten by ${msg.killer} · score ${msg.score}`);
      break;
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
  const owners = new Map(s.o.map(([id, name, hue, flags]) => [id, { name, hue, flags }]));
  const seen = new Set();
  for (const [id, owner, x, y, r] of s.c) {
    seen.add(id);
    const { name, hue, flags } = owners.get(owner);
    const b = blobs.get(id);
    if (b) {
      b.tx = x;
      b.ty = y;
      b.tr = r;
      b.flags = flags;
      continue;
    }
    // A freshly split cell starts inside its sibling, so it visibly shoots out instead of popping in.
    let start = { x, y };
    let nearest = Infinity;
    for (const o of blobs.values()) {
      const d = o.owner === owner ? Math.hypot(o.x - x, o.y - y) : Infinity;
      if (d < nearest && d < o.r * 3) {
        nearest = d;
        start = o;
      }
    }
    blobs.set(id, { x: start.x, y: start.y, r, tx: x, ty: y, tr: r, owner, hue, name, flags });
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);

  scoreEl.textContent = myId ? `Mass ${s.mass}` : '';
  onlineEl.textContent = `${s.online} in arena`;
  renderLeaderboard(s.lb);
  renderEffects(s.fx);
}

function renderLeaderboard(lb) {
  leaderboardEl.replaceChildren(
    ...lb.map(([id, name, mass]) => {
      const li = document.createElement('li');
      li.textContent = name;
      li.classList.toggle('me', id === myId);
      const m = document.createElement('span');
      m.textContent = mass;
      li.append(m);
      return li;
    }),
  );
}

function renderEffects(fx) {
  fx.forEach((secs, i) => {
    if (secs > 0 && lastEffects[i] === 0) {
      vibrate(25);
      toast(`${POWERUPS[i].icon} ${POWERUPS[i].name}!`, POWERUPS[i].color);
    }
  });
  lastEffects = fx.length ? fx : [0, 0, 0];
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

function showMenu(message) {
  statusEl.textContent = message;
  menu.hidden = false;
  document.body.classList.remove('playing');
  input.boost = false;
  joy.id = null;
  if (!isTouch) nameInput.focus();
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  try {
    localStorage.setItem('name', name);
  } catch {}
  nameInput.blur(); // closes the on-screen keyboard
  send({ t: 'join', name });
});

// ---- input ----------------------------------------------------------------

function split() {
  if (myId === null) return;
  send({ t: 'split' });
  vibrate(15);
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

// ---- rendering ------------------------------------------------------------

function resize() {
  dpr = window.devicePixelRatio || 1;
  cw = window.innerWidth;
  ch = window.innerHeight;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  input.mx = cw / 2;
  input.my = ch / 2;
}
window.addEventListener('resize', resize);
resize();

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

  ctx.strokeStyle = '#ff3ea5';
  ctx.lineWidth = 6;
  ctx.shadowColor = '#ff3ea5';
  ctx.shadowBlur = 20;
  ctx.strokeRect(0, 0, world.w, world.h);
  ctx.shadowBlur = 0;
}

function drawPellets() {
  const f = latest?.f ?? [];
  for (let i = 0; i < f.length; i += 3) {
    ctx.fillStyle = `hsl(${f[i + 2]} 100% 65%)`;
    ctx.beginPath();
    ctx.arc(f[i], f[i + 1], 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPowerups(now) {
  const pu = latest?.pu ?? [];
  const pulse = 1 + Math.sin(now / 200) * 0.12;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '18px system-ui, sans-serif';
  for (let i = 0; i < pu.length; i += 3) {
    const style = POWERUPS[pu[i + 2]];
    ctx.shadowColor = style.color;
    ctx.shadowBlur = 25;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(5, 6, 15, 0.8)';
    ctx.beginPath();
    ctx.arc(pu[i], pu[i + 1], 18 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillText(style.icon, pu[i], pu[i + 1] + 1);
  }
}

function drawBlobs(now) {
  const sorted = [...blobs.values()].sort((a, b) => a.r - b.r);
  for (const b of sorted) {
    if (b.flags & 4) {
      // Magnet: show the pickup range.
      ctx.fillStyle = 'rgba(199, 125, 255, 0.08)';
      ctx.strokeStyle = 'rgba(199, 125, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r + MAGNET_REACH, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.shadowColor = b.flags & 1 ? '#ffd23f' : `hsl(${b.hue} 100% 60%)`;
    ctx.shadowBlur = b.flags & 1 ? 45 : 25;
    ctx.fillStyle = `hsl(${b.hue} 85% 45%)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
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
  const size = isTouch ? 84 : Math.min(140, cw * 0.28);
  const x = isTouch ? 16 : cw - size - 16;
  const y = isTouch ? 56 : ch - size - 16;
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
  const bx = active ? joy.bx : 90;
  const by = active ? joy.by : ch - 110;
  const kx = active ? joy.kx : bx;
  const ky = active ? joy.ky : by;
  ctx.globalAlpha = active ? 0.9 : 0.45;
  ctx.fillStyle = 'rgba(54, 241, 205, 0.08)';
  ctx.strokeStyle = 'rgba(54, 241, 205, 0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(bx, by, JOY_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(54, 241, 205, 0.55)';
  ctx.beginPath();
  ctx.arc(kx, ky, 26, 0, Math.PI * 2);
  ctx.fill();
  if (!active) {
    ctx.fillStyle = '#e8ecff';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MOVE', bx, by);
  }
  ctx.globalAlpha = 1;
}

// Area-weighted centre of my cells and how far they reach from it, or null if none are visible.
function myCentre() {
  let x = 0;
  let y = 0;
  let w = 0;
  for (const b of blobs.values()) {
    if (b.owner !== myId) continue;
    x += b.x * b.r * b.r;
    y += b.y * b.r * b.r;
    w += b.r * b.r;
  }
  if (w === 0) return null;
  const centre = { x: x / w, y: y / w, spread: 0 };
  for (const b of blobs.values()) {
    if (b.owner === myId) centre.spread = Math.max(centre.spread, Math.hypot(b.x - centre.x, b.y - centre.y) + b.r);
  }
  return centre;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // Snapshots arrive 30x a second; ease towards them so motion looks smooth at any frame rate.
  const k = 1 - Math.exp(-dt * 12);
  for (const b of blobs.values()) {
    b.x += (b.tx - b.x) * k;
    b.y += (b.ty - b.y) * k;
    b.r += (b.tr - b.r) * k;
  }

  const me = myId !== null ? myCentre() : null;
  if (me) {
    camera.x = me.x;
    camera.y = me.y;
  } else if (latest) {
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

  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);
  drawGrid(cw / 2 / camera.scale, ch / 2 / camera.scale);
  drawPellets();
  drawPowerups(now);
  drawBlobs(now);
  ctx.restore();

  drawMinimap(me);
  if (isTouch && myId !== null) drawJoystick();
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
