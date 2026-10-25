const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('menu');
const joinForm = document.getElementById('join');
const nameInput = document.getElementById('name');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const leaderboardEl = document.getElementById('leaderboard');
const scoreEl = document.getElementById('score');
const onlineEl = document.getElementById('online');

let ws;
let world = { w: 4000, h: 4000 };
let myId = null;
let latest = null; // last snapshot from the server
const blobs = new Map(); // id -> smoothed render state
const camera = { x: 2000, y: 2000, scale: 1 };
const input = { mx: 0, my: 0, boost: false };
let cw = 0;
let ch = 0;
let dpr = 1;

try {
  nameInput.value = localStorage.getItem('name') ?? '';
} catch {}

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
      menu.hidden = true;
      break;
    case 'dead':
      myId = null;
      showMenu(`Eaten by ${msg.killer} · score ${msg.score}`);
      break;
    case 's':
      applySnapshot(msg);
      break;
  }
}

function applySnapshot(s) {
  latest = s;
  const seen = new Set();
  for (const [id, x, y, r, hue, name] of s.p) {
    seen.add(id);
    const b = blobs.get(id);
    if (b) {
      b.tx = x;
      b.ty = y;
      b.tr = r;
    } else {
      blobs.set(id, { x, y, r, tx: x, ty: y, tr: r, hue, name });
    }
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);

  scoreEl.textContent = myId ? `Mass ${s.mass}` : '';
  onlineEl.textContent = `${s.online} in arena`;
  renderLeaderboard(s.lb);
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

function showMenu(message) {
  statusEl.textContent = message;
  menu.hidden = false;
  input.boost = false;
  nameInput.focus();
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  try {
    localStorage.setItem('name', name);
  } catch {}
  send({ t: 'join', name });
});

// ---- input ----------------------------------------------------------------

canvas.addEventListener('mousemove', (e) => {
  input.mx = e.clientX;
  input.my = e.clientY;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) input.boost = true;
});
window.addEventListener('mouseup', () => (input.boost = false));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target !== nameInput) {
    input.boost = true;
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') input.boost = false;
});

function onTouch(e) {
  e.preventDefault();
  const t = e.touches[0];
  if (t) {
    input.mx = t.clientX;
    input.my = t.clientY;
  }
  input.boost = e.touches.length > 1;
}
canvas.addEventListener('touchstart', onTouch, { passive: false });
canvas.addEventListener('touchmove', onTouch, { passive: false });
canvas.addEventListener('touchend', onTouch, { passive: false });

setInterval(() => {
  if (myId === null) return;
  const dx = input.mx - cw / 2;
  const dy = input.my - ch / 2;
  // Distance from the screen centre sets speed, so you can stop by hovering over yourself.
  const throttle = Math.min(1, Math.hypot(dx, dy) / (Math.min(cw, ch) * 0.2));
  send({ t: 'input', angle: Math.atan2(dy, dx), throttle, boost: input.boost });
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

function drawBlobs() {
  const sorted = [...blobs.values()].sort((a, b) => a.r - b.r);
  for (const b of sorted) {
    ctx.shadowColor = `hsl(${b.hue} 100% 60%)`;
    ctx.shadowBlur = 25;
    ctx.fillStyle = `hsl(${b.hue} 85% 45%)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(3, b.r * 0.08);
    ctx.strokeStyle = `hsl(${b.hue} 100% 70%)`;
    ctx.stroke();

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
  const size = Math.min(140, cw * 0.28);
  const pad = 16;
  const x = cw - size - pad;
  const y = ch - size - pad;
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

  const me = myId !== null ? blobs.get(myId) : null;
  if (me) {
    camera.x = me.x;
    camera.y = me.y;
  } else if (latest) {
    camera.x += (latest.cam[0] - camera.x) * k;
    camera.y += (latest.cam[1] - camera.y) * k;
  }
  // Zoom out as you grow. The server sends a slightly wider area than this, so edges never pop in.
  const targetScale = Math.max(cw, ch) / 2 / (800 + 2.5 * (me ? me.r : 60));
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
  drawBlobs();
  ctx.restore();

  drawMinimap(me);
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
