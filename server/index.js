import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, MODES, TICK_RATE, WORLD } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PELLET_EVERY = 6; // pellets don't move, so they go out every 6th tick (5x a second)
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

const games = Object.fromEntries(Object.entries(MODES).map(([key, mode]) => [key, new Game(mode)]));
const modeOrDefault = (mode) => (Object.hasOwn(games, mode) ? mode : 'medium');

const clients = new Map(); // ws -> { mode, playerId, tick }
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws) => {
  const client = { mode: 'medium', playerId: null, tick: 0 };
  clients.set(ws, client);
  ws.send(JSON.stringify({ t: 'welcome', world: WORLD }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const game = games[client.mode];
    switch (msg?.t) {
      case 'watch':
        // The menu spectates whichever arena is selected.
        if (client.playerId === null) {
          client.mode = modeOrDefault(msg.mode);
          client.tick = 0;
        }
        break;
      case 'join':
        if (client.playerId !== null) break;
        client.mode = modeOrDefault(msg.mode);
        client.playerId = games[client.mode].spawnPlayer(cleanName(msg.name)).id;
        client.tick = 0; // send pellets straight away
        ws.send(JSON.stringify({ t: 'joined', id: client.playerId, mode: client.mode }));
        break;
      case 'input':
        if (client.playerId !== null) game.setInput(client.playerId, msg);
        break;
      case 'split':
        if (client.playerId !== null) game.requestSplit(client.playerId);
        break;
      case 'ping':
        // Lets the client measure its round-trip time for movement prediction.
        ws.send(JSON.stringify({ t: 'pong', c: msg.c }));
        break;
    }
  });

  ws.on('close', () => {
    if (client.playerId !== null) games[client.mode].removePlayer(client.playerId);
    clients.delete(ws);
  });
});

let ticks = 0;
setInterval(() => {
  ticks++;
  const results = {};
  for (const [key, game] of Object.entries(games)) {
    const eaten = game.tick(1 / TICK_RATE);
    // Bots eating bots would flood the kill feed, so only kills involving a human are announced.
    const feed = [...eaten.values()].filter((d) => !d.botsOnly).map((d) => [d.killer, d.victim]);
    results[key] = { eaten, feed, leaderboard: game.leaderboard() };
  }
  // Live human counts for the level picker, refreshed once a second.
  const counts =
    ticks % TICK_RATE === 0
      ? JSON.stringify({ t: 'counts', ...Object.fromEntries(Object.entries(games).map(([k, g]) => [k, g.humanCount()])) })
      : null;

  for (const [ws, client] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const { eaten, feed, leaderboard } = results[client.mode];
    if (counts) ws.send(counts);
    if (feed.length) ws.send(JSON.stringify({ t: 'feed', kills: feed }));
    for (const d of eaten.values()) {
      if (d.killerId === client.playerId) ws.send(JSON.stringify({ t: 'kill', victim: d.victim, score: d.score }));
    }
    const death = eaten.get(client.playerId);
    if (death) {
      client.playerId = null;
      ws.send(JSON.stringify({ t: 'dead', killer: death.killer, score: death.score, mode: client.mode }));
    }
    const withPellets = client.tick++ % PELLET_EVERY === 0;
    ws.send(JSON.stringify(games[client.mode].snapshot(client.playerId, leaderboard, withPellets)));
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Neon Arena running at http://localhost:${PORT}`));
