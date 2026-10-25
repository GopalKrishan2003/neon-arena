# Neon Arena

**▶ Play now: https://neon-arena-jeej.onrender.com** (on the free plan, the first load can take up to a minute while the server wakes up)

A real-time multiplayer `.io` browser game. Eat glowing pellets to grow, swallow smaller players, and avoid bigger ones. Boosting makes you faster but costs mass, and it leaves a trail of food that others can grab.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Open a second tab to play against yourself. Bots keep the arena busy when few people are online.

## How it works

- **Server** (`server/`): Node.js and [`ws`](https://github.com/websockets/ws). The server runs the whole simulation 30 times a second and decides every move and every kill, so players can't cheat by editing the client. Each player only gets the part of the world near their camera.
- **Client** (`public/`): plain JavaScript and Canvas 2D, with no build step. It smooths between server updates, zooms out as you grow, and works on desktop and mobile.

| File | Purpose |
|---|---|
| `server/game.js` | Game rules: movement, eating, boosting, bot AI, per-player views |
| `server/index.js` | HTTP static server, WebSocket connections, game loop |
| `public/client.js` | Networking, input, rendering |

## Deploy for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/GopalKrishan2003/neon-arena)

`render.yaml` sets up a free Render web service. Any other Node host that supports WebSockets also works. Free instances sleep when idle, so the first visit after a quiet spell takes about 30–60 seconds to wake.

## Roadmap

- [ ] Binary protocol to cut bandwidth
- [ ] Splitting into several cells (the classic `.io` move)
- [ ] Skins and cosmetics, the main way to make money
- [ ] Ads between rounds through the Poki or CrazyGames SDK
- [ ] Rooms, plus "play with friends" invite links
- [ ] Analytics: session length and retention
