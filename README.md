# Neon Arena

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

Any Node host that supports WebSockets will work. On Render's free plan, create a **Web Service**, set the build command to `npm install` and the start command to `npm start`. Free instances sleep when idle, so the first visit takes a few seconds to wake.

## Roadmap

- [ ] Binary protocol to cut bandwidth
- [ ] Splitting into several cells (the classic `.io` move)
- [ ] Skins and cosmetics, the main way to make money
- [ ] Ads between rounds through the Poki or CrazyGames SDK
- [ ] Rooms, plus "play with friends" invite links
- [ ] Analytics: session length and retention
