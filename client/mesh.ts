/**
 * BLOONS WORLD — turning blocks into triangles.
 *
 * A chunk is sixteen blocks cubed. This walks it, builds a quad for every face that
 * somebody could actually see, and bakes the lighting and the corner shadowing into
 * the vertices — so the shader does no lighting work at all and a chunk is one draw
 * call however complicated it is.
 *
 * THE VERTEX IS SIXTEEN BYTES: three floats of position and one packed integer
 * holding the texture layer, which corner of the quad this is, which way the face
 * points, both light levels and the corner shadow. Twenty-three bits of the thirty-two
 * are used. The alternative — a float per attribute — is fifty-six bytes and three
 * times the memory bandwidth for a picture nobody could tell apart, and bandwidth is
 * the whole cost of drawing a voxel world.
 *
 * The UV is NOT in there. Every quad is one whole texture, so which corner you are
 * tells the vertex shader everything it needs to work out where in the image you are.
 */

import { AIR, BLOCKS, WALL_DIRS, WATER, boxesOf, faceVisible } from '../shared/blocks.js';
import { CHUNK, WORLD_X, WORLD_Y, WORLD_Z, blockArray, lightArray } from '../shared/world.js';

/** Bytes per vertex, and vertices per quad. */
export const VERTEX_BYTES = 16;
export const QUAD_VERTICES = 4;
/** Six faces on 4096 blocks: the most quads a chunk could ever want. */
export const MAX_QUADS = CHUNK * CHUNK * CHUNK * 6;

export interface ChunkMesh {
  /** Interleaved vertex data, ready for `bufferData`. Null when there is nothing. */
  opaque: ArrayBuffer | null;
  opaqueQuads: number;
  water: ArrayBuffer | null;
  waterQuads: number;
}

/**
 * The six faces, each with the direction it points and the two axes across it.
 *
 * `u` is the face's rightward axis and `v` its upward axis when you are outside the
 * block looking at it. Everything else — corner positions, which cells to sample for
 * shadow, the winding order — falls out of those three vectors, which is why this
 * table exists instead of six hand-written blocks of coordinates. The winding comes
 * out counter-clockwise from outside for all six, which is what lets back-face
 * culling stay on and throw away half the triangles for free.
 */
const FACES: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // -X
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // +Y, the top
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // -Y, the bottom
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, // +Z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }, // -Z
];

/** Which texture of the three a face uses: top, bottom, or side. */
const FACE_TEX = [2, 2, 0, 1, 2, 2];

/** Corner order: bottom-left, bottom-right, top-right, top-left, as (du, dv). */
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function pack(layer: number, corner: number, face: number, sky: number, blk: number, ao: number): number {
  return (
    (layer & 255) | ((corner & 3) << 8) | ((face & 7) << 10) | ((sky & 15) << 13) | ((blk & 15) << 17) | ((ao & 3) << 21)
  );
}

/** A growable interleaved vertex buffer. */
class Builder {
  private cap = 2048;
  private buf = new ArrayBuffer(this.cap * VERTEX_BYTES);
  private f32 = new Float32Array(this.buf);
  private u32 = new Uint32Array(this.buf);
  private n = 0;

  vertex(x: number, y: number, z: number, data: number): void {
    if (this.n === this.cap) this.grow();
    const o = this.n * 4;
    this.f32[o] = x;
    this.f32[o + 1] = y;
    this.f32[o + 2] = z;
    this.u32[o + 3] = data;
    this.n += 1;
  }

  private grow(): void {
    this.cap *= 2;
    const next = new ArrayBuffer(this.cap * VERTEX_BYTES);
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.f32 = new Float32Array(next);
    this.u32 = new Uint32Array(next);
  }

  get quads(): number {
    return this.n / QUAD_VERTICES;
  }

  take(): ArrayBuffer | null {
    return this.n === 0 ? null : this.buf.slice(0, this.n * VERTEX_BYTES);
  }
}

/**
 * Build the mesh for one chunk.
 *
 * Positions come out CHUNK-LOCAL, in the range 0..16, and the renderer adds the
 * chunk's corner in the vertex shader. Absolute positions would work too, right up
 * until a float ran out of precision somewhere out past the edge of a big world and
 * the geometry started to shimmer.
 */
export function buildChunk(cx: number, cy: number, cz: number): ChunkMesh {
  const blocks = blockArray();
  const light = lightArray();
  const solid = new Builder();
  const liquid = new Builder();

  const bx0 = cx * CHUNK;
  const by0 = cy * CHUNK;
  const bz0 = cz * CHUNK;

  /* Local, so the hot loop is array reads rather than calls across a module boundary. */
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return AIR;
    return blocks[(x * WORLD_Z + z) * WORLD_Y + y];
  };
  const lit = (x: number, y: number, z: number): number => {
    // Outside the world is full daylight, so the cliff face at the edge of the island
    // is lit rather than a black wall.
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return 0xf0;
    return light[(x * WORLD_Z + z) * WORLD_Y + y];
  };

  for (let lx = 0; lx < CHUNK; lx++) {
    const bx = bx0 + lx;
    for (let lz = 0; lz < CHUNK; lz++) {
      const bz = bz0 + lz;
      for (let ly = 0; ly < CHUNK; ly++) {
        const by = by0 + ly;
        const self = blocks[(bx * WORLD_Z + bz) * WORLD_Y + by];
        if (self === AIR) continue;
        const def = BLOCKS[self];
        if (def.shape === 'none') continue;

        if (def.shape === 'cross') {
          cross(solid, lx, ly, lz, def.tex[0], lit(bx, by, bz));
          continue;
        }

        /*
         * Slabs and stairs are drawn as their COLLISION BOXES, which is the only way
         * the thing you can see and the thing you bump into stay the same shape. Every
         * face of every box is built — no culling against the neighbours — because a
         * half-height face against a full block leaves a real gap that has to be
         * filled, and working out which parts of which faces are covered costs more
         * than the handful of quads it would save.
         */
        if (def.shape === 'ladder') {
          ladder(solid, lx, ly, lz, def.tex[0], def.facing, lit(bx, by, bz));
          continue;
        }

        if (def.shape === 'slab' || def.shape === 'stair') {
          for (const box of boxesOf(self)) {
            cuboid(solid, lx, ly, lz, box, def.tex, lit(bx, by, bz), bx, by, bz, at, lit);
          }
          continue;
        }

        const target = def.liquid ? liquid : solid;
        /*
         * Water sits a notch below the top of its cell unless there is more water
         * above it. Which is a small thing that does a large amount of work: it puts
         * a visible surface on a lake, it lets you see the shoreline from in the
         * water, and it means the top of the sea is a plane you can stand at rather
         * than a colour the world turns.
         */
        const top = def.liquid && at(bx, by + 1, bz) !== WATER ? 0.875 : 1;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = bx + face.n[0];
          const ny = by + face.n[1];
          const nz = bz + face.n[2];
          if (!faceVisible(self, at(nx, ny, nz))) continue;

          const layer = def.tex[FACE_TEX[f]];
          const neighbourLight = lit(nx, ny, nz);
          const px: number[] = [];
          const py: number[] = [];
          const pz: number[] = [];
          const data: number[] = [];
          const ao: number[] = [];

          for (let c = 0; c < 4; c++) {
            const [du, dv] = CORNERS[c];
            /*
             * The three cells that can shade this corner, all of them on the OUTSIDE
             * of the face: one along each tangent axis and the one diagonally
             * between them. This is the whole of ambient occlusion in a voxel world
             * — no rays, no passes, just "how many of the three blocks tucked into
             * this corner are there".
             */
            const s1x = nx + face.u[0] * du, s1y = ny + face.u[1] * du, s1z = nz + face.u[2] * du;
            const s2x = nx + face.v[0] * dv, s2y = ny + face.v[1] * dv, s2z = nz + face.v[2] * dv;
            const crx = s1x + face.v[0] * dv, cry = s1y + face.v[1] * dv, crz = s1z + face.v[2] * dv;

            const o1 = BLOCKS[at(s1x, s1y, s1z)].opaque ? 1 : 0;
            const o2 = BLOCKS[at(s2x, s2y, s2z)].opaque ? 1 : 0;
            const oc = BLOCKS[at(crx, cry, crz)].opaque ? 1 : 0;
            // Two solid sides means the corner is closed regardless of the diagonal,
            // and is the darkest step there is.
            const shade = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);

            /*
             * Smooth lighting: average the light of the same four cells, skipping any
             * that are solid. Flat lighting — one value for the whole face — is one
             * line shorter and makes every wall a flat card; this is what puts a
             * gradient across the floor as it leaves a doorway.
             */
            let sky = neighbourLight >> 4;
            let blk = neighbourLight & 15;
            let n = 1;
            if (!o1) {
              const l = lit(s1x, s1y, s1z);
              sky += l >> 4;
              blk += l & 15;
              n += 1;
            }
            if (!o2) {
              const l = lit(s2x, s2y, s2z);
              sky += l >> 4;
              blk += l & 15;
              n += 1;
            }
            if (!oc && !(o1 && o2)) {
              const l = lit(crx, cry, crz);
              sky += l >> 4;
              blk += l & 15;
              n += 1;
            }

            let vy = by + 0.5 + face.n[1] * 0.5 + face.u[1] * du * 0.5 + face.v[1] * dv * 0.5;
            // Pull the water surface down. Any corner sitting at the top of the cell
            // belongs at the waterline instead.
            if (def.liquid && vy > by + 0.999) vy = by + top;

            px.push(bx + 0.5 + face.n[0] * 0.5 + face.u[0] * du * 0.5 + face.v[0] * dv * 0.5 - bx0);
            py.push(vy - by0);
            pz.push(bz + 0.5 + face.n[2] * 0.5 + face.u[2] * du * 0.5 + face.v[2] * dv * 0.5 - bz0);
            data.push(pack(layer, c, f, Math.round(sky / n), Math.round(blk / n), shade));
            ao.push(shade);
          }

          /*
           * Which way to cut the quad in half.
           *
           * A quad is two triangles and the diagonal between them is a choice. Made
           * badly, a corner with one dark vertex bleeds its darkness across the whole
           * face along the split — the notorious voxel "anisotropy", where a wall of
           * identical blocks grows a herringbone pattern. Splitting along the pair of
           * corners that agree, rather than the pair that disagree, hides it.
           *
           * The index buffer is shared by every chunk and always says 0-1-2, 0-2-3,
           * so the flip is done by rotating which corner goes first. The corner
           * NUMBER travels in the vertex data, so the texture does not rotate with it.
           */
          const flip = ao[0] + ao[2] > ao[1] + ao[3];
          for (let k = 0; k < 4; k++) {
            const c = flip ? (k + 1) % 4 : k;
            target.vertex(px[c], py[c], pz[c], data[c]);
          }
        }
      }
    }
  }

  return {
    opaque: solid.take(),
    opaqueQuads: solid.quads,
    water: liquid.take(),
    waterQuads: liquid.quads,
  };
}

/**
 * One box of a block that is not a whole block: a slab, or half a staircase.
 *
 * Lit from the cell OUTSIDE each face rather than from the block's own cell, the same
 * way a full cube is, so a slab set into a wall is shaded like the wall around it
 * rather than glowing at one flat brightness.
 */
function cuboid(
  b: Builder,
  lx: number, ly: number, lz: number,
  box: [number, number, number, number, number, number],
  tex: [number, number, number],
  own: number,
  bx: number, by: number, bz: number,
  at: (x: number, y: number, z: number) => number,
  lit: (x: number, y: number, z: number) => number,
): void {
  const [ax, ay, az, cx, cy, cz] = box;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    // Only ask the neighbour about light if this face is actually on the block's
    // boundary; an internal face of a stair step is lit by the cell it faces into.
    const flush =
      (f === 0 && cx >= 1) || (f === 1 && ax <= 0) ||
      (f === 2 && cy >= 1) || (f === 3 && ay <= 0) ||
      (f === 4 && cz >= 1) || (f === 5 && az <= 0);
    const nx = bx + face.n[0];
    const ny = by + face.n[1];
    const nz = bz + face.n[2];
    if (flush && BLOCKS[at(nx, ny, nz)].opaque) continue;
    const light = flush ? lit(nx, ny, nz) : own;
    const sky = light >> 4;
    const blk = light & 15;
    const layer = tex[FACE_TEX[f]];
    for (let c = 0; c < 4; c++) {
      const [du, dv] = CORNERS[c];
      // The corner of the BOX, not of the cell: pick the low or high end of each axis
      // according to which way this face and this corner point.
      const pick = (axis: number, lo: number, hi: number): number => {
        const n = face.n[axis];
        const u = face.u[axis];
        const v = face.v[axis];
        if (n !== 0) return n > 0 ? hi : lo;
        if (u !== 0) return u * du > 0 ? hi : lo;
        if (v !== 0) return v * dv > 0 ? hi : lo;
        return lo;
      };
      b.vertex(
        lx + pick(0, ax, cx),
        ly + pick(1, ay, cy),
        lz + pick(2, az, cz),
        pack(layer, c, f, sky, blk, 3),
      );
    }
  }
}

/**
 * A ladder: one flat panel against the wall it is nailed to, drawn from both sides.
 *
 * Both sides because you climb THROUGH the cell — you are standing inside it for the
 * whole ascent — and a ladder that vanished the moment your eyes passed the plane of
 * it would leave you climbing an invisible one.
 */
function ladder(b: Builder, lx: number, ly: number, lz: number, layer: number, facing: number, light: number): void {
  const sky = light >> 4;
  const blk = light & 15;
  const [wx, , wz] = WALL_DIRS[facing];
  // A sixteenth of a block off the wall, which is the thickness of a real one and
  // is also just enough to stop it fighting the wall for the same depth value.
  const d = 1 / 16;
  const at = (t: number, u: number): [number, number, number] => {
    // `t` runs across the panel and `u` up it; which world axis "across" is depends
    // on which wall this is.
    const off = wx !== 0 ? d + (wx > 0 ? 1 - 2 * d : 0) : 0;
    if (wx !== 0) return [lx + (wx > 0 ? 1 - d : d), ly + u, lz + t];
    void off;
    return [lx + t, ly + u, lz + (wz > 0 ? 1 - d : d)];
  };
  for (const back of [false, true]) {
    const corners: [number, number, number][] = back
      ? [at(1, 0), at(0, 0), at(0, 1), at(1, 1)]
      : [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    corners.forEach(([x, y, z], c) => b.vertex(x, y, z, pack(layer, c, 4, sky, blk, 3)));
  }
}

/**
 * Grass and flowers: two quads in an X, each drawn from both sides.
 *
 * Both sides because back-face culling is on for everything else and a plant that
 * vanished when you walked past it would be worse than no plants. Four quads for a
 * tuft of grass sounds expensive and is not — there are a few thousand of them and
 * they are the cheapest thing in the frame.
 */
function cross(b: Builder, lx: number, ly: number, lz: number, layer: number, light: number): void {
  const sky = light >> 4;
  const blk = light & 15;
  const a = 0.1;
  const z = 0.9;
  // Faces 2 and 3 would be the top and bottom; a plant uses the "side" shade, and
  // face 4 is a side. Nothing about a cross has a real normal anyway.
  const planes: [number, number, number, number][] = [
    [a, a, z, z],
    [a, z, z, a],
  ];
  for (const [x0, z0, x1, z1] of planes) {
    for (const back of [false, true]) {
      const corners: [number, number, number, number][] = back
        ? [
            [x1, 0, z1, 0],
            [x0, 0, z0, 1],
            [x0, 1, z0, 2],
            [x1, 1, z1, 3],
          ]
        : [
            [x0, 0, z0, 0],
            [x1, 0, z1, 1],
            [x1, 1, z1, 2],
            [x0, 1, z0, 3],
          ];
      for (const [px, py, pz, c] of corners) {
        b.vertex(lx + px, ly + py, lz + pz, pack(layer, c, 4, sky, blk, 3));
      }
    }
  }
}
