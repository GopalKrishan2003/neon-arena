import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, MODES, TICK_RATE, WORLD } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PELLET_EVERY = 6; // pellets don't move, so they go out every 6th tick (5x a second)
const HEARTBEAT_MS = 15_000; // ping idle sockets so proxies keep them open, and drop dead ones
const RESUME_GRACE_MS = 30_000; // how long a dropped player's cells wait for them to reconnect
const SLOW_CLIENT_BYTES = 64 * 1024; // skip snapshots while this much is still queued for a client
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mix up
const ROOM_CODE_LENGTH = 5;
const MAX_ROOMS = 30;
const ROOM_IDLE_MS = 60_000; // an empty private room closes after this
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/health') {
    // Polled by open pages so Render's free plan doesn't put the server to sleep mid-game.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const cleanName = (name) =>
  String(name ?? '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 16) || 'Player';
const modeOrDefault = (mode) => (Object.hasOwn(MODES, mode) ? mode : 'medium');
const cleanCode = (code) =>
  String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);

// Every arena: the three public ones keyed by difficulty, plus private rooms keyed by their code.
const arenas = new Map();
for (const mode of Object.keys(MODES)) {
  arenas.set(mode, { key: mode, mode, code: null, game: new Game(MODES[mode]), emptySince: null });
}

function createRoom(mode) {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (arenas.has(code));
  const room = { key: code, mode, code, game: new Game(MODES[mode]), emptySince: Date.now() };
  arenas.set(code, room);
  return room;
}

const roomCount = () => [...arenas.values()].filter((a) => a.code).length;

const clients = new Map(); // ws -> { arena, playerId, token, tick }
const sessions = new Map(); // token -> { arena, playerId, expires } for players whose connection dropped
const wss = new WebSocketServer({ server, maxPayload: 1024 });

const sendTo = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

function enterGame(ws, client, arena, name) {
  client.arena = arena.key;
  client.playerId = arena.game.spawnPlayer(cleanName(name)).id;
  client.token = randomUUID();
  client.tick = 0; // send pellets straight away
  sendTo(ws, { t: 'joined', id: client.playerId, mode: arena.mode, room: arena.code, token: client.token });
}

wss.on('connection', (ws) => {
  const client = { arena: 'medium', playerId: null, token: null, tick: 0 };
  clients.set(ws, client);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  sendTo(ws, { t: 'welcome', world: WORLD });

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const game = arenas.get(client.arena)?.game;
    const playing = client.playerId !== null;
    switch (msg?.t) {
      case 'watch': {
        // The menu spectates the selected arena or room.
        if (playing) break;
        if (msg.room) {
          const room = arenas.get(cleanCode(msg.room));
          if (!room?.code) {
            sendTo(ws, { t: 'error', code: 'no-room', message: 'That room code does not exist (or the room has closed).' });
            break;
          }
          client.arena = room.key;
          sendTo(ws, { t: 'room', code: room.code, mode: room.mode });
        } else {
          client.arena = modeOrDefault(msg.mode);
        }
        client.tick = 0;
        break;
      }
      case 'join': {
        if (playing) break;
        const arena = msg.room ? arenas.get(cleanCode(msg.room)) : arenas.get(modeOrDefault(msg.mode));
        if (!arena || (msg.room && !arena.code)) {
          sendTo(ws, { t: 'error', code: 'no-room', message: 'That room code does not exist (or the room has closed).' });
          break;
        }
        enterGame(ws, client, arena, msg.name);
        break;
      }
      case 'create': {
        if (playing) break;
        if (roomCount() >= MAX_ROOMS) {
          sendTo(ws, { t: 'error', code: 'full', message: 'Too many private rooms right now. Try again in a minute.' });
          break;
        }
        enterGame(ws, client, createRoom(modeOrDefault(msg.mode)), msg.name);
        break;
      }
      case 'resume': {
        // Reattach to the cells left behind when this player's connection dropped.
        if (playing) break;
        const session = sessions.get(msg.token);
        sessions.delete(msg.token);
        const arena = session && arenas.get(session.arena);
        if (!arena?.game.players.has(session.playerId)) {
          sendTo(ws, { t: 'resume-failed' });
          break;
        }
        client.arena = arena.key;
        client.playerId = session.playerId;
        client.token = msg.token;
        client.tick = 0;
        sendTo(ws, { t: 'joined', id: client.playerId, mode: arena.mode, room: arena.code, token: client.token, resumed: true });
        break;
      }
      case 'input':
        if (playing) game?.setInput(client.playerId, msg);
        break;
      case 'split':
        if (playing) game?.requestSplit(client.playerId);
        break;
      case 'ping':
        // Lets the client measure its round-trip time for movement prediction.
        sendTo(ws, { t: 'pong', c: msg.c });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (client.playerId === null) return;
    // Keep the cells parked for a while in case this was a network blip or the app was backgrounded.
    arenas.get(client.arena)?.game.setInput(client.playerId, { throttle: 0, boost: false });
    sessions.set(client.token, { arena: client.arena, playerId: client.playerId, expires: Date.now() + RESUME_GRACE_MS });
  });
});

// Browsers answer pings automatically; a socket that misses one is dead and gets closed.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

// Once a second: drop players who never came back, and close private rooms nobody is using.
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expires > now) continue;
    arenas.get(s.arena)?.game.removePlayer(s.playerId);
    sessions.delete(token);
  }
  const watched = new Set([...clients.values()].map((c) => c.arena));
  for (const [key, arena] of arenas) {
    if (!arena.code) continue;
    if (arena.game.humanCount() > 0 || watched.has(key)) {
      arena.emptySince = null;
    } else {
      arena.emptySince ??= now;
      if (now - arena.emptySince > ROOM_IDLE_MS) arenas.delete(key);
    }
  }
}, 1000);

let ticks = 0;
setInterval(() => {
  ticks++;
  const results = new Map();
  for (const [key, arena] of arenas) {
    try {
      const eaten = arena.game.tick(1 / TICK_RATE);
      // Bots eating bots would flood the kill feed, so only kills involving a human are announced.
      const feed = [...eaten.values()].filter((d) => !d.botsOnly).map((d) => [d.killer, d.victim]);
      results.set(key, { arena, eaten, feed, leaderboard: arena.game.leaderboard() });
    } catch (err) {
      // One broken arena must not take the whole server (and everyone's connection) down with it.
      console.error(`tick failed in ${key}:`, err);
    }
  }
  // Live human counts for the public level picker, refreshed once a second.
  const counts =
    ticks % TICK_RATE === 0
      ? JSON.stringify({ t: 'counts', ...Object.fromEntries(Object.keys(MODES).map((m) => [m, arenas.get(m).game.humanCount()])) })
      : null;

  for (const [ws, client] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const result = results.get(client.arena);
    if (!result) continue;
    const { arena, eaten, feed, leaderboard } = result;
    if (counts) ws.send(counts);
    if (feed.length) sendTo(ws, { t: 'feed', kills: feed });
    for (const d of eaten.values()) {
      if (d.killerId === client.playerId) sendTo(ws, { t: 'kill', victim: d.victim, score: d.score });
    }
    const death = eaten.get(client.playerId);
    if (death) {
      client.playerId = null;
      sendTo(ws, { t: 'dead', killer: death.killer, score: death.score, mode: arena.mode });
    }
    // On a slow phone connection, piling up snapshots only adds lag; skip until the queue drains.
    if (ws.bufferedAmount > SLOW_CLIENT_BYTES) continue;
    const withPellets = client.tick++ % PELLET_EVERY === 0;
    ws.send(JSON.stringify(arena.game.snapshot(client.playerId, leaderboard, withPellets)));
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Neon Arena running at http://localhost:${PORT}`));
