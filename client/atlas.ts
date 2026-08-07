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
  layers[TEX.coal] = ore(stone(103), 34, 32, 36);
  layers[TEX.iron] = ore(stone(107), 198, 158, 122);
  layers[TEX.gold] = ore(stone(109), 236, 198, 74);
  layers[TEX.diamond] = ore(stone(113), 106, 224, 226);
  layers[TEX.lamp] = lamp();
  layers[TEX.brick] = brick();
  layers[TEX.water] = water();
  layers[TEX.bedrock] = bedrock();
  layers[TEX.tallGrass] = tallGrass();
  layers[TEX.flower] = flower();
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
