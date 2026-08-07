# BLOONS WORLD

A block world you dig, build and stand around in, together. One island, 128 × 64 ×
128 blocks of it, with caves and ore underneath and a sky over the top — and everybody
who opens the link is in the same one.

```
                                    ☀
        ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
       ▟ ♣♣   ♣♣♣          ♣♣               ▙
      ▟▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒~~~~~▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▙     grass, sand, sea
      ███████████░░░███████████████░░░████████     dirt
      ██▓▓███████░░░██████▒▒▒███████░░█████▓▓██     stone, ore, caves
      ███████████████████████████████████████     bedrock
```

## Play

```bash
npm install
npm run dev
```

Open **http://localhost:5174**. The title screen asks your name — it remembers it, so
that is the last time — and **ENTER WORLD** builds the island and drops you into it.

| | |
|---|---|
| **W A S D** | walk. **SHIFT** to run |
| **SPACE** | jump — a block and a quarter, so one step up and no more |
| **mouse** | look. Click once and the cursor is caught; **ESC** gives it back |
| **hold left** | dig. Harder things take longer — watch the cracks |
| **right click** | put down whatever is in the selected slot |
| **middle click** | point at something to hold that kind |
| **1 … 9**, **wheel** | choose a hotbar slot |
| **E** | everything you are carrying, and what it can be made into |
| **?** | all of the above, at any time, on any device |

On a phone, **press anywhere on the left** — that spot becomes a thumbstick for as
long as you hold it, so there is no fixed pad to find and no wrong place to put your
thumb. The right half looks around, and **DIG · PUT · JUMP** are the round buttons.

Vite binds `0.0.0.0`, so anyone on your Wi-Fi joins at `http://<your-lan-ip>:5174` and
appears next to you. There is no lobby and no room code. Nothing connects until you
press the button — opening the socket on page load would stand you in the world,
named and motionless, while you were still reading the title.

## The rules of the place

**Nothing kills you.** No falling damage, no drowning, no monsters, no night that
comes for you. Deep water is slow and dark rather than fatal, and the only thing at
stake is the walk back. What the world is *for* is building.

**Everything you put down, you dug up first.** Break a block and it goes in your
pockets; place one and it comes back out. Stone gives cobble, grass gives dirt, and
the rest give themselves. Bare hands, and the time each block takes is the whole of
the difficulty curve:

| | seconds | |
|---|---|---|
| tall grass, flowers | instant | |
| leaves, glass, lamp | ¼ – ½ | |
| dirt, sand, gravel | ½ – ⅗ | |
| planks, logs | 1¼ – 1⅗ | |
| stone, cobble, brick | 3 – 3⅖ | drops **cobble** |
| coal · iron · gold · diamond | 3⅗ – 5⅗ | deeper is rarer |
| **bedrock**, **water** | never | the floor of the world, and the sea |

**Four things can be made**, and the last one is the point of the other three:

```
1 log              →  4 planks
4 cobble           →  4 brick
2 sand + 1 coal    →  2 glass
2 glass + 2 coal   →  1 lamp     ← the only light you can carry
```

Coal is in the stone almost anywhere; sand is on the beach; so the first lamp is a
walk to the shore and a dig, and after that a cave is somewhere you can see. **E**
opens the list; a recipe you can afford is the only one that looks like a button.

**The day is twelve minutes long** and it is the same time of day for everybody. The
sun rises in the east, the stars come out properly after it has gone, and a lamp is
worth having at both ends of it.

## Deploy

Locally, or anywhere that runs Node:

```bash
npm run build
npm start          # one port serves the built client AND the WebSocket
```

On **Render**: push this repo to GitHub, then Dashboard → New → Blueprint → pick it.
`render.yaml` builds the `Dockerfile` and hands back an `https://` URL; WebSockets
work on every plan including free. The client derives its socket URL from the page
origin (`https:` → `wss:`), so there is no host to configure in dev, in production, or
on a phone.

Keep it at **one instance**. The world is this process's memory — a second instance is
a second island, and two people on the same link would not see each other.

Everything anybody digs or builds is written to `world-edits.json` every twenty
seconds and on shutdown, and read back on boot, so a restart does not flatten the
place. `WORLD_SAVE` moves the file; `WORLD_TIME=0.9` pins the clock, which is the only
way to look at the stars without waiting six minutes for them.

## How it works

```
shared/   blocks.ts   what a block IS — solid, opaque, hard, what it drops
          world.ts    generation, storage, light, raycasting, walking
          protocol.ts the wire
server/   http + ws on one port, the 20 Hz loop, the save file
client/   gl.ts     matrices, shaders, frustum          atlas.ts  the textures
          mesh.ts   blocks → triangles                  render.ts WebGL2, five programs
          input.ts  keys, mouse, thumbs                 hud.ts    hotbar, pockets, help
          main.ts   the loop and the netcode            net.ts    the socket
```

**Node + TypeScript + `ws` + Vite. One runtime dependency**, and it is the WebSocket
server. There is no graphics library, no maths library, no physics library and no
image files: the renderer is about five hundred lines of WebGL2, `mat4` is ninety
lines because a voxel world needs nine matrix operations, and every texture in the
game is drawn by a function at load time.

### The map is never sent

Terrain, caves, ore, trees and flowers are a pure function of block coordinates. The
server and every client generate the same island from nothing but the code they are
already running — a million blocks, in about a third of a second, behind the title
screen.

A megabyte is not a large download, but it is a thing that can be *stale*, and terrain
that disagrees is terrain you walk through on one screen and bump into on another.
What travels instead is the **difference**: every block anybody has changed since the
server started, as a flat `[index, block, …]`. That is a few thousand numbers instead
of a million, it is the save file as well as the join payload, and an entry is deleted
rather than written when a block goes back to what the generator would have made — so
filling a hole in makes the world forget you dug it.

### Two predictions, and one deliberate refusal

- **Walking is predicted.** The client runs the *same* `step` the server runs and
  eases the server's answer in rather than snapping to it. `shared/world.ts` is
  imported by both sides for exactly this reason: if the two ever disagreed about how
  fast a person walks, everybody would rubber-band.
- **Digging is predicted**, and that is a different bet. The block goes the instant
  the timer finishes and the server is told after; if it disagrees it sends back what
  is actually there and the block reappears. A visible correction in the rare case
  beats a round trip of lag in the common one.
- **The inventory is not predicted at all.** Being briefly wrong about a pixel is
  invisible. Being briefly wrong about whether you have four planks or three is the
  sort of thing people notice and remember.

The client sends **intent** — "forward, and to my right, looking that way" — never a
position. Clamping those three numbers is most of the anti-cheat surface of a walking
game; the rest is the server refusing digs that arrive faster than the block allows,
builds out of reach, and builds into somebody who is standing there.

### Light

Two channels in one byte: sunlight in the high nibble, lamplight in the low one. They
are kept apart because they behave differently at dusk — the sun goes out and a lamp
does not — and a renderer with a single number could not tell "this cave is dark" from
"it is night outside".

Sunlight **falls straight down at full strength** and loses a level for every step it
takes sideways. That one asymmetry is the whole look of the thing: it is what puts a
shaft of daylight down a hole you dug, and what makes the inside of a doorway darker
than the outside of it.

Changing a block does not relight the world. It runs the standard two-phase flood: one
sweep takes away everything that was lit *by* the cell that changed, collecting the
neighbours that were lit by something else as it goes, and those then pour back in.
Twelve blocks dug out of a hillside relight in a third of a millisecond. Ten thousand
blocks arriving at join time do not use it at all — they are applied raw and the whole
world is lit once, because ten thousand incremental updates is about four orders of
magnitude more work than one full pass.

### Turning blocks into triangles

A chunk is 16³ and becomes one draw call. Only faces with something see-through on the
other side are built at all, so a solid hillside costs nothing, and the shading is
baked into the vertices — the fragment shader does no lighting work.

**The vertex is sixteen bytes**: three floats of position and one packed integer
holding the texture layer, which corner of the quad this is, which way the face points,
both light levels and the corner shadow. Twenty-three bits of thirty-two. The UV is
*not* in there, because every quad is one whole texture and which corner you are tells
the shader where in the image you belong.

Every chunk in the world shares **one index buffer**. Every quad is four vertices split
the same way, so the indices are the same numbers for all of them, forever. The one
thing that varies — which diagonal a quad is cut along, which has to follow the corner
shadowing or a wall of identical blocks grows a herringbone pattern — is handled by
rotating which vertex the mesher emits first.

Faces are shaded by **which way they point and nothing else**: no normals, no light
direction, no dot products. Top full, bottom half, and the two horizontal axes
deliberately different so a corner has an edge in it. It is the oldest trick in the
genre and it is the reason a stack of identical grey cubes reads as cubes.

Textures go into a **2D array texture** rather than an atlas. With mipmapping on, an
atlas bleeds each tile into the one beside it and every distant block grows a
one-pixel rind of its neighbour's colour; an array texture has no neighbours to bleed
from. Magnification is `NEAREST`, because a block up close should be sixteen fat
pixels — but minification is mipmapped and anisotropic, because a field of grass a
hundred blocks away without it is a sheet of crawling static.

### The sky is one triangle

No geometry, no dome, no cubemap. One triangle covering the screen, and for each pixel
the ray through it is recovered by pushing the far plane back through the inverse of
the view-projection. Gradient, sun, moon, stars and clouds all fall out of that
direction — and the clouds are a real projection onto a flat sheet a long way up,
which is why they slide past overhead and pile up towards the horizon.

Underwater, the sky is painted in the water's own colour. Water only builds the faces
that touch something else, so from inside a lake there is a clear line of sight out
through the side of it, and a sunset with stars in it came through it.

## Things that were wrong, and what they taught

- **Walking into a wall was faster than walking in the open.** Stopping a body used
  `Math.ceil` where it needed `Math.floor`, which names the *far* side of the block you
  hit — so a blocked step teleported you a whole block forward, through the wall.
  Invisible in open ground, because the branch never runs there. Found by a probe that
  measured blocks-per-second against a wall.
- **Leaning on the space bar climbed into the sky.** `onGround` was only cleared when
  falling, so on the way *up* out of a jump the flag was still set from the last
  landing and the next substep launched again.
- **The jump was a different height on every machine.** `y += vy * dt` makes the peak
  depend on the frame rate: 1.35 blocks at 144 Hz, 1.20 at the server's 20 Hz. Which
  means the client predicts a jump the server never gives it. Averaging the speed
  across the step is exact for constant acceleration and identical everywhere — and
  then the impulse has to be applied *before* the average is taken, or every jump
  quietly loses its first half-step and clears 1.05 blocks instead of 1.26.
- **The island was all coastline.** Value noise piles up around its middle and almost
  never reaches 0 or 1, so every square metre came out within a few blocks of sea
  level. Stretching the distribution about its centre is one line and it is the
  difference between an island and a beach.
- **Stars came out while the sun was still setting.** Measuring nightfall from the
  horizon rather than from well below it put four fifths of a starfield above a sun
  that was visibly still up.
