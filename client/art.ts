/**
 * BLOONS WORLD — the art, shared by both views.
 *
 * The land and the things standing on it are the same pixels whether you are looking
 * down at the world or standing in it. They live here rather than in either renderer
 * so there is exactly one grass texture and one tree in the program: the top-down
 * view blits them at 1x, and the first-person view samples and scales the very same
 * pixels. Two copies would drift, and then the two views would be two worlds.
 *
 * Nothing here is loaded. Every sprite is a handful of `fillRect` calls at 1x, which
 * is what actually makes something look like pixel art — there are no assets and no
 * half-pixels anywhere.
 */

import { GRASS, SAND, TILE, WATER, WORLD_H, WORLD_PX_H, WORLD_PX_W, WORLD_W, terrainGrid } from '../shared/world.js';
import type { Dir, Terrain } from '../shared/world.js';

/** The colour of the wall around the world, and of the stripe baked into the grass. */
export const EDGE_RGB = { r: 36, g: 48, b: 68 };

/** A tree's sprite box, in world pixels. The trunk stands at the bottom centre. */
export const TREE_W = 18;
export const TREE_H = 30;

let groundCache: HTMLCanvasElement | null = null;
let pixelCache: Uint32Array | null = null;
let treeCache: HTMLCanvasElement[] | null = null;

/**
 * The whole map, baked once.
 *
 * Redrawing four thousand tiles every frame is pointless when none of them ever
 * change — bake it into an offscreen canvas at world size and blit the visible part.
 * The terrain itself comes from `shared/world.ts`, so what is painted here is
 * exactly what you can walk on and exactly what the server thinks you are standing
 * in. There is no second map.
 */
export function groundCanvas(): HTMLCanvasElement {
  if (groundCache) return groundCache;
  const c = document.createElement('canvas');
  c.width = WORLD_PX_W;
  c.height = WORLD_PX_H;
  const g = c.getContext('2d')!;
  const grid = terrainGrid();
  const at = (tx: number, ty: number): Terrain =>
    tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H ? WATER : (grid[ty * WORLD_W + tx] as Terrain);

  /*
   * How open the water is around each tile, 0 at the shore and 1 out in the middle.
   *
   * Averaged over a 5x5 neighbourhood and then read back BILINEARLY below, which is
   * the whole point: shade a lake per tile and every lake is a checkerboard, because
   * the eye finds a 16-pixel grid instantly and then cannot stop seeing it. Sampled
   * smoothly, the same numbers become a gradient from the shallows out to the deep.
   */
  const open = new Float32Array(WORLD_W * WORLD_H);
  for (let ty = 0; ty < WORLD_H; ty++) {
    for (let tx = 0; tx < WORLD_W; tx++) {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (at(tx + dx, ty + dy) === WATER) n++;
      open[ty * WORLD_W + tx] = n / 25;
    }
  }
  const openAt = (fx: number, fy: number): number => {
    const x = Math.min(WORLD_W - 1.001, Math.max(0, fx - 0.5));
    const y = Math.min(WORLD_H - 1.001, Math.max(0, fy - 0.5));
    const x0 = x | 0;
    const y0 = y | 0;
    const ax = x - x0;
    const ay = y - y0;
    const a = open[y0 * WORLD_W + x0];
    const b = open[y0 * WORLD_W + x0 + 1];
    const cc = open[(y0 + 1) * WORLD_W + x0];
    const d = open[(y0 + 1) * WORLD_W + x0 + 1];
    return a + (b - a) * ax + (cc + (d - cc) * ax - (a + (b - a) * ax)) * ay;
  };

  /*
   * The ground is painted in 8-pixel blocks, not 16-pixel tiles, and its shade comes
   * from a smooth noise field rather than from a per-tile hash. Same reason as the
   * water: a tile-sized patchwork reads as a grid, and a grid reads as a spreadsheet.
   * Four blocks per tile with a wavelength of about three tiles gives meadows and
   * shallows instead.
   */
  const B = 8;
  const bw = WORLD_PX_W / B;
  const bh = WORLD_PX_H / B;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const px = bx * B;
      const py = by * B;
      const tx = (px / TILE) | 0;
      const ty = (py / TILE) | 0;
      const kind = at(tx, ty);
      const h = ((bx * 73856093) ^ (by * 19349663)) >>> 0;
      // A broad soft field, plus a pinch of per-block grain so it is not glassy.
      const soft = softNoise(bx / 6.5, by / 6.5) - 0.5;
      const grain = ((h >>> 8) % 3) - 1;

      if (kind === WATER) {
        const deep = openAt(px / TILE + 0.25, py / TILE + 0.25);
        // Shallow water is lighter and greener; the deep is darker and bluer.
        const light = 41 - deep * 15 + soft * 5 + grain * 0.6;
        g.fillStyle = `hsl(${198 + deep * 8} ${44 + deep * 8}% ${light}%)`;
        g.fillRect(px, py, B, B);
        // One short dash per few blocks, so still water still has a surface.
        if (h % 5 === 0) {
          g.fillStyle = `hsl(192 46% ${light + 15}%)`;
          g.fillRect(px + (h % 3), py + ((h >> 3) % B), 4 + ((h >> 5) % 3), 1);
        }
        continue;
      }

      if (kind === SAND) {
        const light = 57 + soft * 6 + grain * 0.8;
        g.fillStyle = `hsl(${42 + ((h >> 4) % 4)} 30% ${light}%)`;
        g.fillRect(px, py, B, B);
        if (h % 7 === 0) {
          g.fillStyle = `hsl(38 26% ${light - 8}%)`;
          g.fillRect(px + (h % 6), py + ((h >> 6) % 6), 2, 1);
        }
        continue;
      }

      const light = 29 + soft * 7 + grain * 0.7;
      g.fillStyle = `hsl(${104 + ((h >> 4) % 6)} 26% ${light}%)`;
      g.fillRect(px, py, B, B);
      // A few blades, so walking across it reads as movement.
      if (h % 6 === 0) {
        g.fillStyle = `hsl(96 30% ${light + 9}%)`;
        g.fillRect(px + (h % 7), py + ((h >> 3) % 6), 1, 2);
      }
      if (h % 29 === 0) {
        g.fillStyle = `hsl(30 22% ${light + 5}%)`;
        g.fillRect(px + ((h >> 8) % 5) + 1, py + ((h >> 12) % 5) + 1, 2, 2);
      }
    }
  }

  /*
   * Foam, last and per TILE, because unlike shading this one SHOULD follow the tile
   * edges: it traces the boundary the simulation actually uses, so the bright line is
   * exactly where the water starts hurting you.
   */
  g.fillStyle = 'hsl(190 44% 66%)';
  for (let ty = 0; ty < WORLD_H; ty++) {
    for (let tx = 0; tx < WORLD_W; tx++) {
      if (at(tx, ty) !== WATER) continue;
      const px = tx * TILE;
      const py = ty * TILE;
      if (at(tx, ty - 1) !== WATER) g.fillRect(px, py, TILE, 1);
      if (at(tx, ty + 1) !== WATER) g.fillRect(px, py + TILE - 1, TILE, 1);
      if (at(tx - 1, ty) !== WATER) g.fillRect(px, py, 1, TILE);
      if (at(tx + 1, ty) !== WATER) g.fillRect(px + TILE - 1, py, 1, TILE);
    }
  }

  // A border so the edge of the world is visible rather than an invisible wall.
  // From eye level the wall stands on top of this stripe; from above it IS the edge.
  g.fillStyle = `rgb(${EDGE_RGB.r} ${EDGE_RGB.g} ${EDGE_RGB.b})`;
  g.fillRect(0, 0, WORLD_PX_W, 2);
  g.fillRect(0, WORLD_PX_H - 2, WORLD_PX_W, 2);
  g.fillRect(0, 0, 2, WORLD_PX_H);
  g.fillRect(WORLD_PX_W - 2, 0, 2, WORLD_PX_H);
  groundCache = c;
  return c;
}

/**
 * The same ground as a flat array of packed pixels, for the first-person view.
 *
 * Floor casting reads one texel per screen pixel; going through `getImageData` for
 * each would be thousands of calls a frame. Pulled once and kept — it is 4 MB, and
 * only ever paid for by somebody who actually presses V.
 *
 * Packed 0xAABBGGRR, which is what a `Uint32Array` over canvas bytes gives on every
 * little-endian machine — i.e. all of them. Nothing here authors a colour in that
 * layout by hand except `pack` below, so the two agree by construction.
 */
export function groundPixels(): Uint32Array {
  if (pixelCache) return pixelCache;
  const g = groundCanvas().getContext('2d')!;
  const img = g.getImageData(0, 0, WORLD_PX_W, WORLD_PX_H);
  pixelCache = new Uint32Array(img.data.buffer.slice(0));
  return pixelCache;
}

/** Pack an opaque colour the way `groundPixels` stores one. */
export function pack(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Smooth value noise, for shading only.
 *
 * Deliberately its own copy rather than the one in `shared/world.ts`: that one
 * decides where the lakes are and both sides have to agree on it to the bit. This
 * one decides whether a patch of grass is a shade lighter, which nobody has to agree
 * on and which must never become a reason to touch the file that they do.
 */
function softNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number): number => {
    let v = Math.imul(i, 2654435761) ^ Math.imul(j, 2246822519);
    v = Math.imul(v ^ (v >>> 15), 2135587861);
    return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
  };
  const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const bot = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return top + (bot - top) * sy;
}

/**
 * The four tree sprites, painted once each into their own canvas.
 *
 * Trees are the most-drawn thing in the game — a forest can be four hundred
 * billboards in one first-person frame — so they are rasterised once at 1x and then
 * only ever blitted. Four of them, two shapes in two shades, is enough that a stand
 * does not read as wallpaper and few enough that they are all still the same forest.
 */
export function treeSprites(): HTMLCanvasElement[] {
  if (treeCache) return treeCache;
  treeCache = [0, 1, 2, 3].map((i) => {
    const c = document.createElement('canvas');
    c.width = TREE_W;
    c.height = TREE_H;
    paintTree(c.getContext('2d')!, i);
    return c;
  });
  return treeCache;
}

/** Which sprite a tree uses. Stable per tree, because `vary` is. */
export function treeVariant(vary: number): number {
  return Math.min(3, Math.floor(vary * 4));
}

/**
 * One tree, filling a TREE_W x TREE_H box with the trunk standing at the bottom.
 *
 * Variants 0 and 1 are broadleaves — a round canopy in two bands, lit from the top
 * left. Variants 2 and 3 are conifers, three stacked tiers. Both are drawn dark
 * along the bottom of every band, which is the only shading a thirty-pixel tree has
 * room for and the only cue that the canopy is round rather than flat.
 */
function paintTree(ctx: CanvasRenderingContext2D, variant: number): void {
  const conifer = variant >= 2;
  const hue = conifer ? 138 : 104;
  const tone = variant % 2 === 0 ? 0 : 5;
  const lit = `hsl(${hue + tone} 34% ${conifer ? 30 : 34}%)`;
  const mid = `hsl(${hue + tone} 32% ${conifer ? 24 : 27}%)`;
  const dark = `hsl(${hue + tone} 30% ${conifer ? 18 : 20}%)`;

  // Trunk first, so the canopy always sits on top of it.
  ctx.fillStyle = '#4a3626';
  ctx.fillRect(TREE_W / 2 - 2, TREE_H - 10, 4, 10);
  ctx.fillStyle = '#38271b';
  ctx.fillRect(TREE_W / 2 - 2, TREE_H - 10, 1, 10);

  const band = (y: number, h: number, inset: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(inset, y, TREE_W - inset * 2, h);
  };

  if (conifer) {
    band(0, 5, 6, lit);
    band(3, 4, 4, mid);
    band(6, 5, 3, lit);
    band(10, 4, 2, mid);
    band(13, 5, 1, lit);
    band(17, 4, 0, mid);
    band(20, 2, 2, dark);
    return;
  }
  band(1, 5, 5, lit);
  band(4, 7, 2, lit);
  band(8, 7, 0, mid);
  band(14, 4, 1, mid);
  band(17, 3, 3, dark);
  band(19, 2, 6, dark);
  // One highlight up on the top left, so the whole canopy has a light source.
  ctx.fillStyle = `hsl(${hue + tone} 36% ${42}%)`;
  ctx.fillRect(4, 3, 4, 2);
}

/**
 * Which of the two walk frames a person is on: +1 and -1 swap the legs, 0 stands
 * still. A 5 Hz square wave while walking is all a 12-pixel person needs.
 *
 * Airborne the legs tuck together instead of walking — a running-man in mid-air
 * reads as a bug, and it is one line to not do it.
 */
export function walkFrame(p: { moving: boolean; z: number }, time: number): number {
  if (p.z > 0.5 || !p.moving) return 0;
  return Math.floor(time * 5) % 2 === 0 ? 1 : -1;
}

/**
 * One person: a 10x12 body, drawn out of rectangles with `x, y` its top-left corner.
 *
 * Just the body — no shadow and no ring. Those are placed differently by each view
 * (on the ground under the sprite from above, projected onto the floor plane from
 * eye level), so they belong to the renderer that knows where the ground is.
 */
export function paintPerson(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hue: number,
  dir: Dir,
  frame: number,
): void {
  const body = `hsl(${hue} 62% 56%)`;
  const dark = `hsl(${hue} 55% 38%)`;
  const BODY_W = 10;

  ctx.fillStyle = dark;
  ctx.fillRect(x + 2, y + 9 + (frame > 0 ? 1 : 0), 2, 3);
  ctx.fillRect(x + BODY_W - 4, y + 9 + (frame < 0 ? 1 : 0), 2, 3);

  ctx.fillStyle = body;
  ctx.fillRect(x + 1, y + 4, BODY_W - 2, 6);
  ctx.fillStyle = '#f0c9a0';
  ctx.fillRect(x + 2, y, BODY_W - 4, 5);
  // Hair, so `up` reads as the back of a head rather than a blank face.
  ctx.fillStyle = dark;
  ctx.fillRect(x + 2, y, BODY_W - 4, 2);

  ctx.fillStyle = '#1b2430';
  if (dir === 'up') return; // back of the head — no eyes
  if (dir === 'down') {
    ctx.fillRect(x + 3, y + 3, 1, 1);
    ctx.fillRect(x + BODY_W - 4, y + 3, 1, 1);
    return;
  }
  // Facing sideways: one eye, pushed to the side you are looking.
  ctx.fillRect(dir === 'right' ? x + BODY_W - 4 : x + 3, y + 3, 1, 1);
}
