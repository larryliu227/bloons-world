# BLOONS WORLD

A 2D pixel world you walk around in, together. Right now that is all it is: walking,
and other people — from above, or from inside it.

```
        ┌──────────────────────────┐                ▁▁▁▁▁▁▁▁▁▁▁▁▁▁
        │  · ·  ▮        · ·    ·  │   ▮ else          ▟▙
        │    ·      ▮ you     ·    │        press V   ▝▀▀▘
        │  ·    · ·        ·    ·  │   ───────────▶  ░░░░░░░░░░░░░░
        └──────────────────────────┘                ▒▒▒▒▒▒▒▒▒▒▒▒▒▒
             64 x 64 tiles of grass                   eye level
```

## Play

```bash
npm install
npm run dev
```

Open **http://localhost:5174**. The title screen asks your name — it remembers it, so
that is the last time — and **ENTER WORLD** drops you in.

- **WASD** or **arrow keys** to walk, **SPACE** to jump.
- **V** to stand in the world instead of looking down at it. Then **mouse** to look
  (click once for pointer lock; drag if the browser refuses it), **W/S** forward and
  back, **A/D** to strafe, **←/→** or **Q/E** to turn.
- On a phone, **press anywhere** — that spot becomes a thumbstick for as long as you
  hold it, so there is no fixed pad to find and no wrong place to put your thumb. At
  eye level the screen splits: left thumb walks, right thumb looks, and the round
  button above JUMP switches back.

Vite binds `0.0.0.0`, so anyone on your Wi-Fi joins at `http://<your-lan-ip>:5174`
and appears next to you. There is no lobby and no room code — one world, everybody
in it.

Nothing connects until you press the button. Opening the socket on page load would
stand you at spawn, named and motionless, while you were still reading the title.

## Deploy

Locally, or anywhere that runs Node:

```bash
npm run build
npm start          # one port serves the built client AND the WebSocket
```

On **Render**: push this repo to GitHub, then Dashboard → New → Blueprint → pick it.
`render.yaml` builds the `Dockerfile` and hands back an `https://` URL; WebSockets
work on every plan including free. The client derives its socket URL from the page
origin (`https:` → `wss:`), so there is no host to configure in dev, in production,
or on a phone.

Keep it at one instance. The world is this process's memory — a second instance is a
second, invisible world, and two people on the same link would not see each other.

## How it works

Authoritative server at 20 Hz. The client sends **intent** — "I am pushing
north-east" — never a position, so a client cannot put itself somewhere the server
disagrees with, and clamping that vector is the whole anti-cheat surface of a
walking game.

```
shared/   world.ts (the rules of walking), protocol.ts (the wire)
server/   http + ws on one port, the 20 Hz loop
client/   the title screen, two renderers, input, the socket
```

Two pieces of netcode carry the feel:

- **You are predicted locally.** Waiting a round trip to start walking feels broken
  on any connection, so the client runs the *same* `step` the server runs and eases
  the server's answer in rather than snapping to it. A disagreement over 24 pixels is
  accepted outright; anything smaller closes over a few frames and is invisible.
- **Everyone else is interpolated**, held 100 ms behind the newest snapshot so there
  is always a pair of frames to interpolate between. Drawing them at the very latest
  position instead means stuttering on every late packet.

`shared/world.ts` is imported by both sides on purpose. If the two ever disagreed
about how fast a person walks, every player would rubber-band.

## The two views

**First person is a camera and a control mapping, and nothing else.** There is no
second simulation and no second protocol. `main` folds "forward, and to my right"
back into the same world-space intent vector the top-down view sends, so both views
put identical traffic on the wire — the server cannot tell them apart, and neither
can anybody else's screen. Which view you are in is not even a thing the game knows
about you.

The picture is made cheaply, in `client/fp.ts`:

- **The floor is cast, not projected.** Every screen row below the horizon is a fixed
  distance away, so one divide gives that distance and the world position then steps
  linearly across the row — the ground is a texture read per pixel with no geometry
  at all. It samples the *same* baked grass the top-down view blits.
- **The wall around the world is four segments**, and the camera is always inside
  them, so a column's wall distance is one slab test. No DDA, no grid march. Jump and
  your eye clears it, which is the only way to find out there is nothing out there.
- **People are billboards.** Nobody can hide behind the wall — everyone is inside it,
  always — so drawing them far-to-near is the entire depth test. No z-buffer.

Sky and fog are the same colour on purpose, so the far edge of the world dissolves
instead of ending.

The one thing it gives up: your look direction is not on the wire. Only the four-way
facing the simulation already sets from movement is, so standing still and turning on
the spot is invisible to everybody else. Putting a yaw in `Player` would fix that and
buy a versioned protocol and a new desync surface for a detail on a 10-pixel sprite.

## Art

There are no assets. Every sprite is a dozen `fillRect` calls at 1x, scaled up by a
whole number with smoothing off — which is what actually makes something look like
pixel art. The ground is baked once into an offscreen canvas rather than redrawn
four thousand tiles a frame, and `client/art.ts` hands the same canvas to both views
so there is exactly one grass texture and one person in the program.

Stack: Node + TypeScript + `ws` + Vite + Canvas2D. One runtime dependency.
