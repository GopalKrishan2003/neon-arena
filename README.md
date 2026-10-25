# Neon Arena

**▶ Play now: https://neon-arena-jeej.onrender.com** (on the free plan, the first load can take up to a minute while the server wakes up)

A real-time multiplayer `.io` browser game. Eat glowing pellets to grow, swallow smaller players, and avoid bigger ones. **Split** to fling half of each cell forward and catch fleeing prey. Your cells rejoin after a cooldown, but small split cells are easy targets. Boosting makes you faster but costs mass, and it leaves a trail of food that others can grab.

Grab **power-ups** scattered around the arena: ⚡ **Speed** (50% faster for 6s), 🛡️ **Shield** (can't be eaten for 5s) and 🧲 **Magnet** (pulls in food from afar for 8s). A live kill feed and "You ate X!" pop-ups show what's happening, and phones vibrate on kills, power-ups and death.

**Difficulty levels:** each level is its own arena, and you only meet players who picked the same one. A 3-second spawn shield protects newcomers on every level.

| | Easy | Medium | Hard |
|---|---|---|---|
| Players and bots in the arena | 8 | 14 | 20 |
| Your starting mass | 30 | 20 | 20 |
| Food | lots | normal | scarce |
| Bots | slow, react late, never split | chase and sometimes split-attack | quick, see far, split-attack often and hunt humans first |

**Private rooms:** tap **Create private room** to get a 5-character code, such as `R2H65`, and share the invite link (`/?room=R2H65`). Friends can open the link or type the code to join. A room uses the difficulty you had selected and closes after a minute with nobody in it.

**Dropped connections:** if your connection drops mid-game (a network blip, or switching apps on your phone), the game reconnects on its own and puts you back on your own cells. The server holds them for 30 seconds.

**Controls:** steer with the mouse · **Space** to split · click or **Shift** to boost. On phones: a virtual joystick under your left thumb, plus **BOOST** (hold) and **SPLIT** (tap) buttons on the right.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Open a second tab to play against yourself. Bots keep the arena busy when few people are online.

## How it works

- **Server** (`server/`): Node.js and [`ws`](https://github.com/websockets/ws). The server runs the whole simulation 30 times a second and decides every move and every kill, so players can't cheat by editing the client. Each player only gets the part of the world near their camera.
- **Client** (`public/`): plain JavaScript and Canvas 2D, with no build step. Works on desktop and mobile.
- **Smooth over slow connections:**
  - Your own cells move instantly on your screen (client-side prediction), then quietly correct towards the server's position.
  - Other players are drawn 100 ms in the past and blended between updates, which hides uneven network timing.
  - Food goes out 5 times a second instead of 30, which cuts traffic by about 75%.
  - Glows are pre-drawn images instead of slow canvas shadows.

| File | Purpose |
|---|---|
| `server/game.js` | Game rules: movement, splitting and merging, eating, boosting, bot AI, per-player views |
| `server/index.js` | HTTP static server, WebSocket connections, game loop |
| `public/client.js` | Networking, input, rendering |

## Deploy for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/GopalKrishan2003/neon-arena)

`render.yaml` sets up a free Render web service. Any other Node host that supports WebSockets also works. Free instances sleep when idle, so the first visit after a quiet spell takes about 30–60 seconds to wake.

## Roadmap

- [ ] Binary protocol to cut bandwidth
- [x] Splitting into several cells (the classic `.io` move)
- [ ] Skins and cosmetics, the main way to make money
- [ ] Ads between rounds through the Poki or CrazyGames SDK
- [ ] Rooms, plus "play with friends" invite links
- [ ] Analytics: session length and retention
