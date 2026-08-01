/**
 * BLOONS WORLD — the art, shared by both views.
 *
 * The grass and the people are the same pixels whether you are looking down at the
 * world or standing in it. They live here rather than in either renderer so there is
 * exactly one grass texture and one 10x12 person in the program: the top-down view
 * blits them at 1x, and the first-person view samples and scales the very same
 * pixels. Two copies would drift, and then the two views would be two worlds.
 */

import { BODY_W, TILE, WORLD_H, WORLD_PX_H, WORLD_PX_W, WORLD_W } from '../shared/world.js';
import type { Dir } from '../shared/world.js';

/** The colour of the wall around the world, and of the stripe baked into the grass. */
export const EDGE_RGB = { r: 36, g: 48, b: 68 };

let groundCache: HTMLCanvasElement | null = null;
let pixelCache: Uint32Array | null = null;

/**
 * The ground, baked once.
 *
 * Redrawing four thousand tiles every frame is pointless when none of them ever
 * change — bake it into an offscreen canvas at world size and blit the visible part.
 */
export function groundCanvas(): HTMLCanvasElement {
  if (groundCache) return groundCache;
  const c = document.createElement('canvas');
  c.width = WORLD_PX_W;
  c.height = WORLD_PX_H;
  const g = c.getContext('2d')!;
  for (let ty = 0; ty < WORLD_H; ty++) {
    for (let tx = 0; tx < WORLD_W; tx++) {
      // Cheap deterministic hash so the grass has variety but never flickers.
      const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const shade = 26 + (h % 5) * 3;
      g.fillStyle = `hsl(${104 + (h % 7)} 26% ${shade}%)`;
      g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      // A few blades, so walking across it reads as movement.
      if (h % 11 === 0) {
        g.fillStyle = `hsl(96 30% ${shade + 8}%)`;
        g.fillRect(tx * TILE + (h % 12), ty * TILE + ((h >> 4) % 12), 1, 2);
      }
      if (h % 37 === 0) {
        g.fillStyle = `hsl(30 22% ${shade + 4}%)`;
        g.fillRect(tx * TILE + ((h >> 8) % 10) + 2, ty * TILE + ((h >> 12) % 10) + 2, 2, 2);
      }
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
