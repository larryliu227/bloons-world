# BLOONS WORLD

A pixel world you walk around in, together — grass, lakes and forests, seen from
above or from inside it. There are berries to eat and stones to throw at each other,
and nothing in it can kill you.

```
        ┌──────────────────────────┐                ▁▁▁▁▁☀▁▁▁▁▁▁▁▁
        │ ♣•  ~~~~~   ▮      ♣♣•   │   ▮ else         ♣ ▟▙ ♣♣
        │ ♣    ~~~~ ▮ you  ·  ♣♣   │        press V   ▝▀▀▘
        │      ~~~~~~~~·    ♣      │   ───────────▶  ░░░░░░░░░░░░░░
        └──────────────────────────┘                ▒▒▒▒▒▒▒▒▒▒▒▒▒▒
       • berries  · stones  ~ very slow                eye level
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
- **F** or **left click** to swing, **R** or **right click** to throw a stone. From
  above you aim with the mouse; standing in the world you aim where you look.
- **?**, or the button in the corner, lists all of it at any time. It is the same
  list on every device and it names both views, so nothing is discoverable only by
  having read this file.

## The rules of the place

**Nothing here kills you.** Run out of pips and you are flat on your back for two
seconds and then get up, full, exactly where you fell — never removed, never
teleported, never sent back to spawn. A fight is something that happens to you rather
than something that ends you, and the only thing it costs is standing back up.

The two ways to hit somebody are deliberately not the same weapon:

|  | reach | damage | ten pips is |
|---|---|---|---|
| **swing** | right there | 3 | four swings |
| **thrown stone** | across a clearing | 1 | ten stones, and you carry six |

So a stone is for *bothering* somebody at distance and the swing is what actually
wins — which means the fight anybody wins is the one they walked into, and the stones
are for making that walk expensive. Trees stop thrown stones, so a wood is cover.

**Berries** grow in the shade of trees; walk over one and you eat it for three pips,
and it grows back after a while. **Stones** lie on the sand at the water's edge. The
two things you need are in two different places on purpose: going to get one is a
walk somewhere rather than a lap of wherever you already are.

**Water is harmless and desperately slow** — about a tenth of walking pace, so a lake
you could stroll across in two seconds is a fifteen-second slog. That is its own
deterrent and a better one than damage: wading is a bad idea you can change your mind
about halfway through, from either direction. **Bodies are solid**, so you stop at
each other, but only on the ground — you can jump over somebody, and you can walk
over somebody who is down. **Trees are solid** at any height.

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
shared/   world.ts (walking, terrain, trees, health), protocol.ts (the wire)
server/   http + ws on one port, the 20 Hz loop
client/   the title screen, two renderers, the art, input, the HUD, the socket
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

**The map is never sent.** Terrain, trees and where the berries grow are a pure
function of tile coordinates, so the server and every client generate the same lakes
and the same forests from the code they are already running. A 64x64 map would be a
small download, but it would also be a thing that can be stale — and terrain that
disagrees is terrain you walk through on one screen and bump into on another. What
*does* travel is which items have been picked: a short list of indices rather than
three hundred positions twenty times a second.

**Fighting is not predicted at all.** The client sends which way it is pointing and
nothing else — not whether it may attack, not who was in range, not what it cost
them. A client that could report its own hits could report all of them, and a health
bar that flickered down and back on every mispredicted swing would be worse than one
that answers a round trip late. Position is predicted because being briefly wrong
about a pixel is invisible. Nothing else here is.

## What was making it shimmer

Three separate things, none of which was the frame rate:

- **The camera was rounded to whole world pixels.** Walking is 78 px/s and a world
  pixel is four or five screen pixels, so the entire scene lurched sideways five
  pixels at a time, about sixteen times a second. Now the scene is drawn at the
  whole-pixel camera and the canvas *element* is slid by the leftover, rounded to
  whole **device** pixels — every texel still lands exactly on the screen grid, and
  the step shrinks by the scale times the pixel ratio. Measured: 1 CSS pixel per step
  instead of 3 on a 1x display, and a third of that on a phone.
- **Reconciliation was per frame, not per second.** A flat 12% of the error each
  frame meant a 144 Hz screen corrected two and a half times faster than a 60 Hz one,
  and a dropped frame corrected less. It is exponential decay over real elapsed time
  now, so every machine gets the same curve.
- **Remote players were interpolated against packet arrival times**, which are
  exactly as jittery as the network. There is a render clock now: it advances at real
  time and is only gently pulled toward what the snapshots say, so a late packet
  spends a moment being a few milliseconds wrong instead of being right in a way you
  can see.

The resolution went up at the same time, which shrinks whatever is left: the view is
whatever fits the window inside 460x300 world pixels, at the largest whole scale that
does it. Both axes come from the window, so a phone in portrait gets a portrait
viewport rather than black bars.

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
- **Trees, people, berries and stones are billboards**, in one list that sorts
  together — a person behind a tree has to be behind that tree. Nothing can hide
  behind the wall, since everything is inside it always, so far-to-near IS the depth
  test. No z-buffer. Trees are pre-tinted at eight fog strengths and then only ever
  blitted, because a forest is a couple of hundred of them in a frame.
- **Nothing is drawn as though it were nearer than 21 world pixels.** Bodies stop
  each other at nine, so the moment you close to swinging distance the true
  projection magnifies a ten-pixel sprite about thirty times — and that is not a
  person, it is a flat field of one colour across a third of the screen with the head
  and the feet both out of frame. Size and height are computed as if anything nearer
  were exactly at that distance, while its position across the screen stays true. It
  is a lie, and it is a smaller lie than the alternative.

Sky and fog are the same colour on purpose, so the far edge of the world dissolves
instead of ending — and since the horizon end of that gradient is the pale one,
distance washes things out rather than dimming them, which is what haze does and the
only version of it that agrees with there being a sun up there. The sun is the one
fixed thing in a world with no landmarks; without something in the sky to steer by,
turning around at eye level loses you completely.

The one thing it gives up: your look direction is not on the wire. Only the four-way
facing the simulation already sets from movement is, so standing still and turning on
the spot is invisible to everybody else. Putting a yaw in `Player` would fix that and
buy a versioned protocol and a new desync surface for a detail on a 10-pixel sprite.

## Art

There are no assets. Every sprite is a handful of `fillRect` calls at 1x, scaled up
by a whole number with smoothing off — which is what actually makes something look
like pixel art. The whole map is baked once into an offscreen canvas rather than
redrawn four thousand tiles a frame, and `client/art.ts` hands the same canvas to
both views, so there is exactly one grass texture and one tree in the program. Two
copies would drift, and then the two views would be two worlds.

The ground is painted in **8-pixel blocks shaded from a smooth noise field**, not in
16-pixel tiles shaded from a per-tile hash. That is not a detail: the eye finds a
tile-sized patchwork instantly and then cannot stop seeing it, and a lake shaded
per tile is a checkerboard. Water depth is likewise averaged over a 5x5 neighbourhood
and read back bilinearly, which turns the same numbers into a gradient from the
shallows out to the deep. Foam is the one thing drawn per tile, because it *should*
follow the tile edge — that bright line is exactly where the water starts hurting.

Trees have a minimum spacing enforced at generation, which is a collision decision
rather than an aesthetic one. Two trunks closer together than two bodies' clearance
give a squeezed player no position that satisfies both, and the push-out solver then
spends its passes shoving them back and forth. Thinning those pairs out when the
forest is grown is the fix; solving an impossible position at run time is not.

Stack: Node + TypeScript + `ws` + Vite + Canvas2D. One runtime dependency.
