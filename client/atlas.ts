/**
 * BLOONS WORLD — the textures, drawn in code.
 *
 * Every surface in the game is sixteen pixels square and is generated here at load
 * time. There are no image files anywhere in the project, and that is not
 * asceticism: a texture that is a function is a texture that can be changed by
 * changing a number, cannot be missing, cannot 404, cannot be the wrong size, and
 * costs nothing to download. The whole set is about two hundred lines and a
 * millisecond.
 *
 * They all go into one 2D ARRAY texture rather than an atlas. See the note in
 * `shared/blocks.ts`: a tiled atlas bleeds neighbouring tiles into each other the
 * moment mipmapping is on, and the fix — padding every tile with a copy of its own
 * edge — is more code than this and still wrong at the smallest mip level.
 */

import { CRACK_STAGES, TEX, TEX_LAYERS } from '../shared/blocks.js';

export const TEX_SIZE = 16;

/**
 * A tiny deterministic random source.
 *
 * Seeded per texture, so stone looks the same on every machine and in every session.
 * `Math.random()` would give each player a slightly different world to look at, which
 * nobody would notice and which would make every screenshot un-reproducible.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One 16×16 RGBA image, with the handful of drawing verbs the textures need. */
class Tile {
  readonly px = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  readonly rand: () => number;

  constructor(seed: number) {
    this.rand = rng(seed);
  }

  set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || y < 0 || x >= TEX_SIZE || y >= TEX_SIZE) return;
    const i = (y * TEX_SIZE + x) * 4;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
    this.px[i + 3] = a;
  }

  fill(r: number, g: number, b: number, a = 255): this {
    for (let i = 0; i < this.px.length; i += 4) {
      this.px[i] = r;
      this.px[i + 1] = g;
      this.px[i + 2] = b;
      this.px[i + 3] = a;
    }
    return this;
  }

  /**
   * Jitter every pixel's brightness. This one call is most of what makes a flat
   * colour read as a material rather than as a rectangle of paint.
   */
  noise(amount: number, colourAmount = 0): this {
    for (let i = 0; i < this.px.length; i += 4) {
      const n = (this.rand() * 2 - 1) * amount;
      for (let c = 0; c < 3; c++) {
        const tint = colourAmount ? (this.rand() * 2 - 1) * colourAmount : 0;
        this.px[i + c] = clamp(this.px[i + c] + n + tint);
      }
    }
    return this;
  }

  /** Scattered blobs of another colour: ore in stone, pebbles in gravel. */
  blobs(count: number, radius: number, r: number, g: number, b: number, jitter = 12): this {
    for (let i = 0; i < count; i++) {
      const cx = this.rand() * TEX_SIZE;
      const cy = this.rand() * TEX_SIZE;
      const rad = radius * (0.6 + this.rand() * 0.8);
      for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
        for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rad) continue;
          const n = (this.rand() * 2 - 1) * jitter;
          this.set(x & 15, y & 15, clamp(r + n), clamp(g + n), clamp(b + n));
        }
      }
    }
    return this;
  }

  /** Darken or lighten a pixel that is already there, keeping its hue. */
  shade(x: number, y: number, by: number): void {
    const i = ((y & 15) * TEX_SIZE + (x & 15)) * 4;
    this.px[i] = clamp(this.px[i] + by);
    this.px[i + 1] = clamp(this.px[i + 1] + by);
    this.px[i + 2] = clamp(this.px[i + 2] + by);
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

// ---------------------------------------------------------------------------
// The textures themselves

function stone(seed = 1): Tile {
  const t = new Tile(seed).fill(126, 126, 128).noise(16);
  // A few dark seams, so a stone wall has some direction in it rather than being TV
  // static. Short and mostly horizontal, which is how rock actually breaks.
  for (let i = 0; i < 5; i++) {
    let x = Math.floor(t.rand() * 16);
    let y = Math.floor(t.rand() * 16);
    for (let n = 0; n < 4 + t.rand() * 5; n++) {
      t.shade(x, y, -22);
      x += t.rand() < 0.72 ? 1 : 0;
      y += t.rand() < 0.3 ? (t.rand() < 0.5 ? 1 : -1) : 0;
    }
  }
  return t;
}

function ore(base: Tile, r: number, g: number, b: number): Tile {
  base.blobs(4, 2.1, r, g, b, 18);
  return base;
}

function dirt(seed = 7): Tile {
  return new Tile(seed).fill(122, 86, 58).noise(20, 8);
}

function grassTop(): Tile {
  const t = new Tile(21).fill(96, 152, 62).noise(22, 12);
  t.blobs(6, 1.4, 108, 168, 66, 14);
  return t;
}

/**
 * The side of a grass block: dirt, with the lawn hanging over the top edge.
 *
 * The overhang is RAGGED rather than a straight line three pixels down, because a
 * straight line reads as a painted stripe and a ragged one reads as grass. It is
 * three pixels of variation and it is the single most recognisable texture in the
 * genre.
 */
function grassSide(): Tile {
  const t = dirt(31);
  for (let x = 0; x < TEX_SIZE; x++) {
    const depth = 2 + Math.floor(t.rand() * 3);
    for (let y = 0; y < depth; y++) {
      const n = (t.rand() * 2 - 1) * 18;
      t.set(x, y, clamp(96 + n), clamp(152 + n), clamp(62 + n));
    }
  }
  return t;
}

function sand(): Tile {
  return new Tile(41).fill(216, 202, 148).noise(13, 5);
}

function gravel(): Tile {
  const t = new Tile(47).fill(122, 118, 116).noise(14);
  t.blobs(10, 1.7, 148, 142, 138, 20);
  t.blobs(6, 1.3, 92, 88, 86, 16);
  return t;
}

/** Cobble: rounded stones with dark mortar between them, on a 4×4 grid, jittered. */
function cobble(): Tile {
  const t = new Tile(53).fill(78, 78, 80);
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const ox = gx * 4 + (gy % 2 ? 2 : 0);
      const light = 118 + t.rand() * 34;
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          if (t.rand() < 0.08) continue;
          const n = (t.rand() * 2 - 1) * 14 - (y === 2 ? 16 : 0) + (y === 0 ? 10 : 0);
          t.set((ox + x) & 15, gy * 4 + y, clamp(light + n), clamp(light + n), clamp(light + 2 + n));
        }
      }
    }
  }
  return t;
}

function brick(): Tile {
  const t = new Tile(59).fill(88, 88, 92);
  for (let gy = 0; gy < 4; gy++) {
    const ox = gy % 2 ? 4 : 0;
    for (let gx = 0; gx < 2; gx++) {
      const light = 132 + t.rand() * 20;
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 7; x++) {
          const n = (t.rand() * 2 - 1) * 9;
          t.set((ox + gx * 8 + x) & 15, gy * 4 + y, clamp(light + n), clamp(light + n), clamp(light + 4 + n));
        }
      }
    }
  }
  return t;
}

/** Bark: vertical streaks, because a log is the one block with a grain direction. */
function logSide(): Tile {
  const t = new Tile(61).fill(102, 74, 44);
  for (let x = 0; x < TEX_SIZE; x++) {
    const shade = (t.rand() * 2 - 1) * 26;
    for (let y = 0; y < TEX_SIZE; y++) {
      const n = (t.rand() * 2 - 1) * 10;
      t.set(x, y, clamp(102 + shade + n), clamp(74 + shade * 0.8 + n), clamp(44 + shade * 0.5 + n));
    }
  }
  return t;
}

/** The cut end: rings around the middle. */
function logTop(): Tile {
  const t = new Tile(67).fill(158, 122, 76).noise(10);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 7.2) {
        // The bark, still on the outside of the cut.
        const n = (t.rand() * 2 - 1) * 12;
        t.set(x, y, clamp(102 + n), clamp(74 + n), clamp(44 + n));
      } else if (Math.abs((d % 2.6) - 1.3) < 0.55) {
        t.shade(x, y, -28);
      }
    }
  }
  return t;
}

/** Leaves: dark green with real holes in it, which is what the alpha is for. */
function leaves(): Tile {
  const t = new Tile(71).fill(58, 108, 44).noise(30, 16);
  for (let i = 0; i < t.px.length; i += 4) {
    if (t.rand() < 0.14) t.px[i + 3] = 0;
  }
  return t;
}

function planks(): Tile {
  const t = new Tile(73).fill(162, 126, 76);
  for (let y = 0; y < TEX_SIZE; y++) {
    const board = Math.floor(y / 4);
    const shade = [0, -8, 6, -4][board];
    for (let x = 0; x < TEX_SIZE; x++) {
      const n = (t.rand() * 2 - 1) * 9;
      t.set(x, y, clamp(162 + shade + n), clamp(126 + shade + n), clamp(76 + shade + n));
    }
    // The seam between two boards, and the nail line down the middle of each.
    if (y % 4 === 3) for (let x = 0; x < TEX_SIZE; x++) t.shade(x, y, -34);
  }
  for (let y = 0; y < TEX_SIZE; y++) t.shade(board(y) % 2 ? 7 : 8, y, -18);
  return t;
}

function board(y: number): number {
  return Math.floor(y / 4);
}

/** Glass: nothing at all, with a bright frame and one highlight streak. */
function glass(): Tile {
  const t = new Tile(79).fill(0, 0, 0, 0);
  for (let i = 0; i < TEX_SIZE; i++) {
    t.set(i, 0, 226, 240, 248, 190);
    t.set(i, TEX_SIZE - 1, 208, 224, 236, 170);
    t.set(0, i, 226, 240, 248, 190);
    t.set(TEX_SIZE - 1, i, 208, 224, 236, 170);
  }
  for (let i = 0; i < 5; i++) {
    t.set(3 + i, 4 + i, 255, 255, 255, 120);
    t.set(4 + i, 4 + i, 255, 255, 255, 60);
  }
  return t;
}

function water(): Tile {
  const t = new Tile(83).fill(48, 104, 190).noise(9, 6);
  // A couple of lighter bands, so the surface has something for the wobble in the
  // shader to move around.
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const w = Math.sin((x + y * 0.6) * 0.7) * 0.5 + 0.5;
      t.shade(x, y, (w - 0.5) * 22);
    }
  }
  return t;
}

function bedrock(): Tile {
  const t = new Tile(89).fill(66, 64, 68).noise(30);
  t.blobs(9, 1.9, 34, 32, 36, 10);
  t.blobs(5, 1.5, 104, 100, 106, 10);
  return t;
}

/** The lamp: bright, and obviously the thing in the room that is making the light. */
function lamp(): Tile {
  const t = new Tile(97).fill(214, 176, 96).noise(10);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d < 5.5) t.shade(x, y, 42 - d * 4);
      if (d > 6.6) t.shade(x, y, -34);
    }
  }
  t.blobs(5, 1.3, 255, 246, 208, 6);
  return t;
}

/** Blades of grass on nothing: a cross-shaped block is mostly hole. */
function tallGrass(): Tile {
  const t = new Tile(101).fill(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const x = 1 + Math.floor(t.rand() * 14);
    const h = 6 + Math.floor(t.rand() * 8);
    const tint = t.rand() * 26;
    for (let y = 0; y < h; y++) {
      const bend = Math.floor((y / h) * (t.rand() < 0.5 ? 1 : -1));
      t.set(x + bend, TEX_SIZE - 1 - y, clamp(86 + tint), clamp(142 + tint), clamp(56 + tint), 255);
    }
  }
  return t;
}

function flower(): Tile {
  const t = tallGrass();
  // One stem straight up the middle and a head on top of it, so it reads as a flower
  // from ten blocks away rather than as greener grass.
  for (let y = 4; y < TEX_SIZE; y++) t.set(8, y, 74, 128, 52, 255);
  const petal: [number, number][] = [
    [7, 2], [8, 2], [9, 2],
    [6, 3], [7, 3], [8, 3], [9, 3], [10, 3],
    [7, 4], [8, 4], [9, 4],
  ];
  for (const [x, y] of petal) t.set(x, y, 226, 78, 74, 255);
  t.set(8, 3, 246, 214, 96, 255);
  return t;
}

/** Sandstone, cut from a beach: pale, and layered the way sedimentary rock is. */
function sandstoneTop(): Tile {
  return new Tile(127).fill(222, 208, 158).noise(9, 4);
}

function sandstoneSide(): Tile {
  const t = new Tile(131).fill(222, 208, 158).noise(7, 3);
  // A darker seam a quarter of the way down and a lighter one below it, so a wall of
  // it has a horizon in it and does not read as a flat wash of cream.
  for (let x = 0; x < TEX_SIZE; x++) {
    for (const [y, by] of [[3, -22], [4, -14], [11, 10], [15, -18]] as [number, number][]) t.shade(x, y, by);
  }
  return t;
}

/**
 * A block of refined metal: flat colour, a lighter top-left and a darker
 * bottom-right, and a bevelled edge. Almost no texture at all, which is the point —
 * next to stone and dirt, the thing that reads as manufactured is the thing with no
 * grain in it.
 */
function metal(seed: number, r: number, g: number, b: number): Tile {
  const t = new Tile(seed).fill(r, g, b).noise(5);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const edge = Math.min(x, y, TEX_SIZE - 1 - x, TEX_SIZE - 1 - y);
      if (edge === 0) t.shade(x, y, -30);
      else if (edge === 1) t.shade(x, y, x < 8 && y < 8 ? 26 : -12);
      // A soft diagonal sheen, so it catches the light like a polished face.
      else t.shade(x, y, (1 - (x + y) / 30) * 14);
    }
  }
  return t;
}

/** Cobble with the damp bits gone green. */
function mossyCobble(): Tile {
  const t = cobble();
  const r = rng(137);
  for (let i = 0; i < 6; i++) {
    const cx = r() * 16;
    const cy = r() * 16;
    const rad = 1.6 + r() * 2.2;
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rad) continue;
        if (r() < 0.25) continue;
        const i2 = ((y & 15) * TEX_SIZE + (x & 15)) * 4;
        // Tint rather than paint: the stone underneath still shows through, which is
        // what makes it look grown-on instead of spilled-on.
        t.px[i2] = clamp(t.px[i2] * 0.45 + 46);
        t.px[i2 + 1] = clamp(t.px[i2 + 1] * 0.7 + 62);
        t.px[i2 + 2] = clamp(t.px[i2 + 2] * 0.4 + 34);
      }
    }
  }
  return t;
}

/** Thatch: bundled straw, and the softest thing in the world to land on. */
function thatch(): Tile {
  const t = new Tile(139).fill(198, 164, 78).noise(12, 8);
  for (let y = 0; y < TEX_SIZE; y++) {
    // Horizontal strands with a hard shadow under each bundle, so it reads as
    // something bound rather than something poured.
    const band = y % 4;
    for (let x = 0; x < TEX_SIZE; x++) {
      t.shade(x, y, band === 3 ? -34 : band === 0 ? 14 : 0);
      if (t.rand() < 0.2) t.shade(x, y, -16);
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Things lying on the ground, and the things they turn into
//
// Item icons are flat pictures rather than cube faces, because a pickaxe is not a
// cube. They are drawn small and centred, which is the whole of what makes a
// sixteen-pixel picture readable at hotbar size.

/** Draw a line of pixels between two points. The only drawing verb icons need. */
function stroke(t: Tile, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, w = 1): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) t.set(x + dx, y + dy, r, g, b, 255);
  }
}

function blob(t: Tile, cx: number, cy: number, rad: number, r: number, g: number, b: number): void {
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > rad) continue;
      const n = (t.rand() * 2 - 1) * 14;
      t.set(x, y, clamp(r + n), clamp(g + n), clamp(b + n), 255);
    }
  }
}

function pebblesBlock(): Tile {
  const t = new Tile(211).fill(0, 0, 0, 0);
  blob(t, 5, 12.5, 2.2, 132, 128, 126);
  blob(t, 10, 13.5, 1.8, 112, 108, 108);
  blob(t, 12.5, 11, 1.4, 148, 144, 142);
  return t;
}

function sticksBlock(): Tile {
  const t = new Tile(213).fill(0, 0, 0, 0);
  stroke(t, 2, 13, 12, 11, 104, 76, 44);
  stroke(t, 3, 10, 13, 14, 122, 92, 54);
  stroke(t, 6, 14, 11, 8, 88, 64, 38);
  return t;
}

function berryBushBlock(): Tile {
  const t = new Tile(217).fill(0, 0, 0, 0);
  for (let i = 0; i < 26; i++) {
    const x = 2 + Math.floor(t.rand() * 12);
    const y = 5 + Math.floor(t.rand() * 10);
    const n = t.rand() * 30;
    blob(t, x, y, 1.4, clamp(52 + n), clamp(104 + n), clamp(44 + n));
  }
  for (const [x, y] of [[5, 8], [9, 7], [11, 11], [6, 12], [8, 10]] as [number, number][]) {
    blob(t, x, y, 1.1, 214, 46, 52);
  }
  return t;
}

function mushroomBlock(): Tile {
  const t = new Tile(223).fill(0, 0, 0, 0);
  for (let y = 8; y < 14; y++) for (let x = 7; x <= 8; x++) t.set(x, y, 226, 216, 196, 255);
  blob(t, 7.5, 7, 4, 178, 58, 48);
  for (const [x, y] of [[5, 6], [9, 5], [7, 8]] as [number, number][]) blob(t, x, y, 0.9, 236, 226, 210);
  return t;
}

/** The furnace: cobble with a mouth in it. Front and side differ only by the mouth. */
function furnace(front: boolean): Tile {
  const t = cobble();
  if (!front) return t;
  for (let y = 6; y < 13; y++) {
    for (let x = 4; x < 12; x++) {
      const heat = y > 9 ? 1 : 0;
      t.set(x, y, heat ? 60 : 26, heat ? 34 : 22, heat ? 18 : 20, 255);
    }
  }
  for (let x = 5; x < 11; x++) t.set(x, 12, 44, 30, 22, 255);
  return t;
}

// ---- item icons

function iconPebble(): Tile {
  const t = new Tile(227).fill(0, 0, 0, 0);
  blob(t, 6, 9, 3.2, 138, 134, 132);
  blob(t, 10.5, 6.5, 2.4, 116, 112, 112);
  return t;
}

function iconStick(): Tile {
  const t = new Tile(233).fill(0, 0, 0, 0);
  stroke(t, 4, 12, 11, 4, 128, 94, 54, 2);
  stroke(t, 9, 6, 12, 7, 106, 78, 44);
  return t;
}

function iconBerries(): Tile {
  const t = new Tile(251).fill(0, 0, 0, 0);
  stroke(t, 8, 13, 8, 8, 86, 128, 56);
  for (const [x, y] of [[5, 6], [9, 5], [7, 9], [11, 8]] as [number, number][]) blob(t, x, y, 1.9, 208, 44, 50);
  return t;
}

function iconRoot(): Tile {
  const t = new Tile(257).fill(0, 0, 0, 0);
  for (let y = 2; y < 13; y++) {
    const w = Math.max(0, 3 - Math.floor((y - 2) / 4));
    for (let x = 8 - w; x <= 8 + w; x++) t.set(x, y, 208, 186, 142, 255);
  }
  stroke(t, 8, 12, 5, 14, 176, 156, 118);
  stroke(t, 8, 11, 11, 13, 176, 156, 118);
  return t;
}

function iconMushroom(): Tile {
  const t = new Tile(263).fill(0, 0, 0, 0);
  for (let y = 8; y < 14; y++) for (let x = 7; x <= 9; x++) t.set(x, y, 228, 218, 198, 255);
  blob(t, 8, 6.5, 4.6, 178, 58, 48);
  for (const [x, y] of [[5, 6], [10, 5], [8, 8]] as [number, number][]) blob(t, x, y, 1, 238, 228, 212);
  return t;
}

/** A lump of something: coal, sulfur, saltpetre. One shape, three colours. */
function lump(seed: number, r: number, g: number, b: number): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  blob(t, 8, 8.5, 4.4, r, g, b);
  blob(t, 6, 6.5, 2.2, clamp(r + 34), clamp(g + 34), clamp(b + 34));
  blob(t, 11, 11, 1.6, clamp(r - 26), clamp(g - 26), clamp(b - 26));
  return t;
}

/** An ingot: a truncated wedge seen from slightly above, with a bright top face. */
function ingot(seed: number, r: number, g: number, b: number): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  for (let y = 6; y < 11; y++) {
    const inset = y < 8 ? 8 - y : 0;
    for (let x = 3 + inset; x < 13 - inset; x++) {
      const top = y < 8;
      const n = (t.rand() * 2 - 1) * 8;
      t.set(x, y, clamp(r + (top ? 40 : -10) + n), clamp(g + (top ? 40 : -10) + n), clamp(b + (top ? 40 : -10) + n), 255);
    }
  }
  for (let x = 3; x < 13; x++) t.set(x, 11, clamp(r - 50), clamp(g - 50), clamp(b - 50), 255);
  return t;
}

/** A cut gem: a flat table with facets falling away from it. */
function gem(seed: number, r: number, g: number, b: number): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  for (let y = 4; y < 13; y++) {
    const w = y < 7 ? 2 + y - 4 : Math.max(0, 5 - (y - 7));
    for (let x = 8 - w; x <= 8 + w; x++) {
      const lit = x < 8 ? 34 : -18;
      t.set(x, y, clamp(r + lit), clamp(g + lit), clamp(b + lit), 255);
    }
  }
  for (let x = 6; x <= 9; x++) t.set(x, 5, 255, 255, 255, 255);
  return t;
}

/**
 * A tool: a wooden shaft with a head on it, in one of four materials.
 *
 * All twelve are this one function. The head shape says what it does and the colour
 * says what it is made of, which is the entire visual language of a tool bar and is
 * why nobody has ever needed a label on one.
 */
function toolIcon(seed: number, kind: 'pick' | 'axe' | 'shovel', r: number, g: number, b: number): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  const put = (x: number, y: number, lift = 0) => {
    const n = (t.rand() * 2 - 1) * 10 + lift;
    t.set(x, y, clamp(r + n), clamp(g + n), clamp(b + n), 255);
  };
  // The handle runs corner to corner in every one of them.
  stroke(t, 4, 13, 11, 6, 124, 90, 52, 2);
  stroke(t, 5, 13, 11, 7, 96, 68, 38);

  if (kind === 'pick') {
    // A curved head: high in the middle, tapering to two points.
    for (let i = 0; i < 11; i++) {
      const x = 2 + i;
      const y = 5 - Math.round(Math.sin((i / 10) * Math.PI) * 3);
      put(x, y, 10);
      put(x, y + 1);
      if (i > 1 && i < 9) put(x, y + 2, -14);
    }
  } else if (kind === 'axe') {
    // A wedge on one side only, which is what makes an axe read as an axe.
    for (let y = 2; y < 9; y++) {
      const w = y < 5 ? y - 1 : 8 - y;
      for (let x = 8; x < 8 + Math.max(1, w) + 2; x++) put(x, y, x > 11 ? 18 : 0);
    }
    for (let y = 2; y < 9; y++) put(8, y, -18);
  } else {
    // A flat blade, wider than it is deep.
    for (let y = 2; y < 7; y++) for (let x = 7; x < 13; x++) put(x, y, y < 4 ? 14 : -6);
    for (let x = 7; x < 13; x++) put(x, 7, -22);
  }
  return t;
}

/** Milled black powder, in a heap. */
function iconPowder(): Tile {
  const t = new Tile(311).fill(0, 0, 0, 0);
  for (let y = 7; y < 14; y++) {
    const w = Math.round((y - 6) * 0.9) + 1;
    for (let x = 8 - w; x <= 8 + w; x++) {
      const n = t.rand() * 40;
      t.set(x, y, clamp(38 + n), clamp(34 + n), clamp(40 + n), 255);
    }
  }
  for (let i = 0; i < 5; i++) t.set(4 + Math.floor(t.rand() * 9), 6 + Math.floor(t.rand() * 3), 96, 92, 100, 255);
  return t;
}

/** Lead balls. Three of them, so it reads as a count rather than one marble. */
function iconShot(): Tile {
  const t = new Tile(313).fill(0, 0, 0, 0);
  blob(t, 6, 7, 2.6, 122, 122, 132);
  blob(t, 10.5, 6, 2.2, 104, 104, 116);
  blob(t, 8.5, 11, 2.4, 138, 138, 148);
  t.set(5, 6, 200, 200, 212, 255);
  t.set(10, 5, 190, 190, 202, 255);
  return t;
}

/**
 * A gun, drawn along the diagonal like every other tool so the hotbar stays legible.
 *
 * The musket has a fat barrel and a big wooden stock; the rifle is slimmer with a
 * longer barrel and a sight on top. Two silhouettes, twelve pixels apart, and you can
 * tell which one you are holding at a glance — which matters, because one of them
 * takes three seconds to reload.
 */
/** A brass cartridge: a case with a lead nose. Three of them, like the balls. */
function iconCartridge(): Tile {
  const t = new Tile(337).fill(0, 0, 0, 0);
  const one = (ox: number, oy: number) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 3; x++) {
      t.set(ox + x, oy + y, y < 2 ? 150 : 198, y < 2 ? 128 : 168, y < 2 ? 96 : 70, 255);
    }
    t.set(ox + 1, oy - 1, 172, 148, 112, 255);
  };
  one(3, 5); one(7, 4); one(11, 6);
  return t;
}

function gun(seed: number, rifle: boolean): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  // Stock: wood, at the low end.
  stroke(t, 2, 13, 7, 8, 108, 74, 42, 3);
  stroke(t, 2, 12, 6, 8, 138, 98, 56);
  // Barrel: iron, running away to the high corner.
  stroke(t, 6, 9, rifle ? 14 : 12, rifle ? 1 : 3, 96, 98, 108, rifle ? 2 : 3);
  stroke(t, 6, 8, rifle ? 13 : 11, rifle ? 1 : 3, 152, 156, 168);
  // Lock and trigger, which is most of what makes it read as a firearm.
  blob(t, 7, 9, 1.6, 70, 72, 80);
  t.set(6, 11, 60, 62, 70, 255);
  t.set(6, 12, 60, 62, 70, 255);
  if (rifle) {
    t.set(11, 2, 210, 214, 226, 255);
    t.set(12, 2, 210, 214, 226, 255);
  }
  return t;
}

/**
 * The later guns: a revolver, an automatic rifle and a machine gun.
 *
 * Each is a silhouette rather than a portrait — a stubby one with a cylinder, a long
 * one with a magazine hanging under it, and a long one with a bipod. At hotbar size
 * that is all you get and all you need, because the only question you ever ask of the
 * picture is "is this the one that fires by itself".
 */
function gun2(seed: number, kind: 'revolver' | 'auto' | 'mg'): Tile {
  const t = new Tile(seed).fill(0, 0, 0, 0);
  if (kind === 'revolver') {
    stroke(t, 4, 12, 7, 9, 104, 72, 42, 3);        // grip
    stroke(t, 6, 8, 13, 5, 108, 110, 120, 2);      // barrel
    stroke(t, 6, 7, 12, 4, 164, 168, 180);
    blob(t, 7.5, 8.5, 2.1, 84, 86, 96);            // cylinder
    t.set(7, 8, 150, 152, 164, 255);
    t.set(8, 9, 150, 152, 164, 255);
    return t;
  }
  const mg = kind === 'mg';
  stroke(t, 1, 13, 6, 9, 96, 66, 38, 2);           // stock
  stroke(t, 4, 10, 15, mg ? 3 : 4, 92, 94, 104, 2);// receiver and barrel
  stroke(t, 4, 9, 14, mg ? 2 : 3, 150, 154, 166);
  // The magazine, which is the whole tell that it feeds itself.
  for (let y = 10; y < 14; y++) for (let x = 7; x < 10; x++) t.set(x, y, 70, 72, 82, 255);
  if (mg) {
    stroke(t, 12, 6, 10, 13, 78, 80, 90);          // bipod
    stroke(t, 12, 6, 14, 13, 78, 80, 90);
  } else {
    t.set(11, 3, 196, 200, 212, 255);              // sight
  }
  return t;
}

/** A ladder: two rails and the rungs between them, and nothing else at all. */
function ladderTile(): Tile {
  const t = new Tile(367).fill(0, 0, 0, 0);
  const wood = (x: number, y: number, lift: number) => {
    const n = (t.rand() * 2 - 1) * 10 + lift;
    t.set(x, y, clamp(146 + n), clamp(108 + n), clamp(62 + n), 255);
  };
  for (let y = 0; y < TEX_SIZE; y++) {
    for (const x of [2, 3, 12, 13]) wood(x, y, x === 2 || x === 12 ? 14 : -12);
  }
  for (const y of [2, 3, 7, 8, 12, 13]) {
    for (let x = 4; x < 12; x++) wood(x, y, y % 2 === 0 ? 8 : -14);
  }
  return t;
}

function saplingTile(): Tile {
  const t = new Tile(373).fill(0, 0, 0, 0);
  for (let y = 8; y < 15; y++) t.set(8, y, 104, 76, 44, 255);
  for (const [x, y] of [[8, 5], [6, 6], [10, 6], [7, 8], [9, 8], [8, 7]] as [number, number][]) {
    blob(t, x, y, 1.8, 68, 132, 52);
  }
  return t;
}

function iconMeat(cooked: boolean): Tile {
  const t = new Tile(cooked ? 379 : 383).fill(0, 0, 0, 0);
  const [r, g, b] = cooked ? [148, 96, 54] : [204, 92, 96];
  blob(t, 7.5, 8, 4.4, r, g, b);
  blob(t, 6, 6.5, 2, clamp(r + 32), clamp(g + 28), clamp(b + 28));
  // The bone sticking out of it, which is the whole of what makes it read as meat.
  for (let i = 0; i < 4; i++) t.set(11 + i, 12 - i, 234, 228, 212, 255);
  return t;
}

/**
 * The cracks, ten stages of them, drawn once and reused over every block.
 *
 * They are transparent everywhere they are not cracked, and are drawn OVER the block
 * being dug rather than replacing its texture — which is why they are one set rather
 * than one set per material.
 */
function cracks(): Tile[] {
  const out: Tile[] = [];
  const r = rng(4242);
  // One fixed set of crack lines, revealed a few at a time. Growing the same cracks
  // rather than drawing new random ones each stage is what makes it read as a
  // block breaking instead of as static.
  const lines: [number, number][][] = [];
  for (let i = 0; i < 12; i++) {
    const line: [number, number][] = [];
    let x = Math.floor(r() * 16);
    let y = Math.floor(r() * 16);
    const dx = r() < 0.5 ? 1 : -1;
    const dy = r() < 0.5 ? 1 : -1;
    for (let n = 0; n < 5 + r() * 9; n++) {
      line.push([x, y]);
      if (r() < 0.75) x += dx;
      if (r() < 0.6) y += dy;
    }
    lines.push(line);
  }
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const t = new Tile(1000 + stage).fill(0, 0, 0, 0);
    const shown = Math.ceil(((stage + 1) / CRACK_STAGES) * lines.length);
    const grow = (stage + 1) / CRACK_STAGES;
    for (let i = 0; i < shown; i++) {
      const line = lines[i];
      const upto = Math.ceil(line.length * Math.min(1, grow * 1.6));
      for (let n = 0; n < upto; n++) {
        const [x, y] = line[n];
        t.set(x & 15, y & 15, 0, 0, 0, 190);
        if (n % 3 === 0) t.set((x + 1) & 15, y & 15, 0, 0, 0, 110);
      }
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Build every layer, in the order `TEX` names them. */
export function buildAtlas(): Uint8Array {
  const layers: Tile[] = [];
  layers[TEX.stone] = stone();
  layers[TEX.dirt] = dirt();
  layers[TEX.grassTop] = grassTop();
  layers[TEX.grassSide] = grassSide();
  layers[TEX.sand] = sand();
  layers[TEX.gravel] = gravel();
  layers[TEX.cobble] = cobble();
  layers[TEX.logSide] = logSide();
  layers[TEX.logTop] = logTop();
  layers[TEX.leaves] = leaves();
  layers[TEX.planks] = planks();
  layers[TEX.glass] = glass();
  layers[TEX.coalOre] = ore(stone(103), 34, 32, 36);
  layers[TEX.ironOre] = ore(stone(107), 198, 158, 122);
  layers[TEX.goldOre] = ore(stone(109), 236, 198, 74);
  layers[TEX.diamondOre] = ore(stone(113), 106, 224, 226);
  layers[TEX.sulfurOre] = ore(stone(117), 226, 208, 66);
  layers[TEX.nitreOre] = ore(stone(119), 232, 232, 226);
  layers[TEX.lamp] = lamp();
  layers[TEX.brick] = brick();
  layers[TEX.water] = water();
  layers[TEX.bedrock] = bedrock();
  layers[TEX.tallGrass] = tallGrass();
  layers[TEX.flower] = flower();
  layers[TEX.sandstoneTop] = sandstoneTop();
  layers[TEX.sandstoneSide] = sandstoneSide();
  layers[TEX.ironBlock] = metal(149, 214, 214, 218);
  layers[TEX.goldBlock] = metal(151, 238, 206, 84);
  layers[TEX.diamondBlock] = metal(157, 120, 226, 226);
  layers[TEX.mossy] = mossyCobble();
  layers[TEX.thatch] = thatch();
  layers[TEX.pebbles] = pebblesBlock();
  layers[TEX.sticks] = sticksBlock();
  layers[TEX.berryBush] = berryBushBlock();
  layers[TEX.mushroom] = mushroomBlock();
  layers[TEX.furnaceFront] = furnace(true);
  layers[TEX.furnaceSide] = furnace(false);
  layers[TEX.furnaceTop] = cobble();
  layers[TEX.itemPebble] = iconPebble();
  layers[TEX.itemStick] = iconStick();
  layers[TEX.itemBerries] = iconBerries();
  layers[TEX.itemRoot] = iconRoot();
  layers[TEX.itemMushroom] = iconMushroom();
  layers[TEX.itemCoal] = lump(283, 40, 38, 44);
  layers[TEX.itemSulfur] = lump(287, 222, 202, 70);
  layers[TEX.itemNitre] = lump(289, 228, 228, 222);
  layers[TEX.itemIron] = ingot(293, 208, 208, 214);
  layers[TEX.itemGold] = ingot(297, 236, 198, 74);
  layers[TEX.itemDiamond] = gem(307, 96, 214, 220);
  layers[TEX.itemPowder] = iconPowder();
  layers[TEX.itemShot] = iconShot();
  layers[TEX.itemMusket] = gun(317, false);
  layers[TEX.itemRifle] = gun(331, true);
  layers[TEX.itemBall] = iconShot();
  layers[TEX.itemCartridge] = iconCartridge();
  layers[TEX.itemRevolver] = gun2(347, 'revolver');
  layers[TEX.itemAutoRifle] = gun2(349, 'auto');
  layers[TEX.itemMachineGun] = gun2(353, 'mg');
  layers[TEX.ladder] = ladderTile();
  layers[TEX.sapling] = saplingTile();
  layers[TEX.itemMeat] = iconMeat(false);
  layers[TEX.itemCooked] = iconMeat(true);
  /*
   * Twelve tools from one function and four colours, laid out so that
   * `itemPick + tier - 1` is the pickaxe of that tier. Writing them out by hand is
   * twelve chances to give the iron shovel a wooden head and never notice.
   */
  const MATERIALS: [number, number, number][] = [
    [150, 112, 66],   // wood
    [128, 128, 132],  // stone
    [206, 206, 214],  // iron
    [96, 214, 220],   // diamond
  ];
  MATERIALS.forEach(([r, g, b], i) => {
    layers[TEX.itemPick + i] = toolIcon(401 + i * 7, 'pick', r, g, b);
    layers[TEX.itemAxe + i] = toolIcon(431 + i * 7, 'axe', r, g, b);
    layers[TEX.itemShovel + i] = toolIcon(461 + i * 7, 'shovel', r, g, b);
  });
  const crackTiles = cracks();
  for (let i = 0; i < CRACK_STAGES; i++) layers[TEX.crack + i] = crackTiles[i];

  const stride = TEX_SIZE * TEX_SIZE * 4;
  const data = new Uint8Array(stride * TEX_LAYERS);
  for (let i = 0; i < TEX_LAYERS; i++) {
    // Any layer nobody named is magenta, which is the traditional and correct
    // colour for "you forgot one".
    const tile = layers[i] ?? new Tile(i).fill(255, 0, 220);
    data.set(tile.px, i * stride);
  }
  return data;
}
