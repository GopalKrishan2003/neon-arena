import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, TICK_RATE, WORLD } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
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

const game = new Game();
const clients = new Map(); // ws -> { playerId }
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws) => {
  const client = { playerId: null };
  clients.set(ws, client);
  ws.send(JSON.stringify({ t: 'welcome', world: WORLD }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.t === 'join' && client.playerId === null) {
      client.playerId = game.spawnPlayer(cleanName(msg.name)).id;
      ws.send(JSON.stringify({ t: 'joined', id: client.playerId }));
    } else if (msg?.t === 'input' && client.playerId !== null) {
      game.setInput(client.playerId, msg);
    } else if (msg?.t === 'split' && client.playerId !== null) {
      game.requestSplit(client.playerId);
    }
  });

  ws.on('close', () => {
    if (client.playerId !== null) game.removePlayer(client.playerId);
    clients.delete(ws);
  });
});

setInterval(() => {
  const eaten = game.tick(1 / TICK_RATE);
  const leaderboard = game.leaderboard();
  for (const [ws, client] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const death = eaten.get(client.playerId);
    if (death) {
      client.playerId = null;
      ws.send(JSON.stringify({ t: 'dead', ...death }));
    }
    ws.send(JSON.stringify(game.snapshot(client.playerId, leaderboard)));
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Neon Arena running at http://localhost:${PORT}`));
