/**
 * BLOONS WORLD — the world, and the rules of standing in it.
 *
 * Everything in here is imported by BOTH the server and the client, because the
 * client predicts its own movement locally and the server integrates the same
 * numbers authoritatively. If the two ever disagree about how fast a person walks or
 * how high a jump goes, every player rubber-bands. One file, one answer.
 *
 * That includes the LAND, and it is the single most important decision in the
 * project. The map is not data and is never sent: it is a pure function of block
 * coordinates, so the server and every client generate the same hills, the same
 * caves, the same ore and the same trees from nothing but the code they are already
 * running. A million blocks is a megabyte and a megabyte is a download people wait
 * for; it is also a thing that can be out of date, and terrain that disagrees is
 * terrain you walk through on one screen and bump into on another.
 *
 * What DOES travel is the difference: every block anybody has dug out or put down
 * since the server started. That is a few thousand numbers rather than a million,
 * and it is the only part of the world that could not have been worked out from
 * first principles.
 */

import {
  AIR,
  BEDROCK,
  BLOCKS,
  COAL_ORE,
  DIAMOND_ORE,
  DIRT,
  FLOWER,
  GOLD_ORE,
  GRASS,
  GRAVEL,
  IRON_ORE,
  LEAVES,
  NITRE_ORE,
  SULFUR_ORE,
  LOG,
  SAND,
  STONE,
  TALL_GRASS,
  WATER,
  PEBBLES,
  STICKS,
  BERRY_BUSH,
  MUSHROOM,
  blockDef,
  boxesOf,
} from './blocks.js';

// ---------------------------------------------------------------------------
// How big it is
//
// A FIXED world rather than an endless one, and that is a choice rather than a
// shortcut. Endless terrain means streaming, which means chunk requests, which means
// the map becomes something the server sends after all — and it means you never meet
// anybody, because two people in an infinite world are two people alone. This is an
// island. You can walk to the edge of it in ninety seconds and everybody you can see
// is in the same square kilometre of blocks as you.

/** Blocks along a chunk's edge. Sixteen, for the same reason everybody uses sixteen. */
export const CHUNK = 16;

export const WORLD_X = 128;
export const WORLD_Y = 64;
export const WORLD_Z = 128;

export const CHUNKS_X = WORLD_X / CHUNK;
export const CHUNKS_Y = WORLD_Y / CHUNK;
export const CHUNKS_Z = WORLD_Z / CHUNK;
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z;

/** Where the sea stops. Everything below this that can see the sky is wet. */
export const SEA_LEVEL = 26;

const CELLS = WORLD_X * WORLD_Y * WORLD_Z;

/**
 * Cells are stored COLUMN-major: y varies fastest, then z, then x.
 *
 * Which is unusual, and deliberate. The two loops that touch every cell in the world
 * — generating the terrain and pouring sunlight down it — both walk a column at a
 * time, top to bottom. In this order a column is sixty-four consecutive bytes and
 * both loops run down a cache line instead of across a megabyte.
 */
export function idx(x: number, y: number, z: number): number {
  return (x * WORLD_Z + z) * WORLD_Y + y;
}

export function inWorld(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_X && y < WORLD_Y && z < WORLD_Z;
}

/** Pull a packed index apart again. Used on the wire and nowhere hot. */
export function unpackIndex(i: number): { x: number; y: number; z: number } {
  const y = i % WORLD_Y;
  const rest = (i - y) / WORLD_Y;
  return { x: (rest / WORLD_Z) | 0, y, z: rest % WORLD_Z };
}

// ---------------------------------------------------------------------------
// Noise
//
// A 32-bit integer hash and value noise on top of it. `Math.imul` rather than `*` on
// purpose: plain multiplication of two 32-bit numbers overflows past what a double
// holds exactly, and terrain that depends on rounding is terrain that could differ
// between two machines. This stays exact 32-bit arithmetic everywhere, which is what
// lets the map be generated rather than sent.

function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise2(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

function noise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const fz = smoothstep(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n000 = hash3(x0, y0, z0);
  const n100 = hash3(x0 + 1, y0, z0);
  const n010 = hash3(x0, y0 + 1, z0);
  const n110 = hash3(x0 + 1, y0 + 1, z0);
  const n001 = hash3(x0, y0, z0 + 1);
  const n101 = hash3(x0 + 1, y0, z0 + 1);
  const n011 = hash3(x0, y0 + 1, z0 + 1);
  const n111 = hash3(x0 + 1, y0 + 1, z0 + 1);
  const a = lerp(lerp(n000, n100, fx), lerp(n010, n110, fx), fy);
  const b = lerp(lerp(n001, n101, fx), lerp(n011, n111, fx), fy);
  return lerp(a, b, fz);
}

// ---------------------------------------------------------------------------
// The blocks

/** One byte per cell. This is the world. */
const blocks = new Uint8Array(CELLS);
/**
 * The world as it came out of the generator, before anybody touched it.
 *
 * Kept so that reconnecting is `blocks.set(pristine)` and then replaying the
 * server's edit list, rather than a minute of regeneration. It also means a client
 * that reconnects to a RESTARTED server — one whose edits are gone — ends up with
 * exactly the world the server has, instead of keeping ghosts of the old one.
 */
const pristine = new Uint8Array(CELLS);
/** High nibble is skylight, low nibble is light from lamps. See the lighting note. */
const light = new Uint8Array(CELLS);

let generated = false;

/** Ground height for a column: the y of the topmost solid block the generator makes. */
export function heightAt(x: number, z: number): number {
  /*
   * Value noise piles up around its middle — a lattice of random numbers with a
   * smooth ramp between them almost never gets near 0 or 1. Left alone that makes
   * every square metre of the map within a few blocks of sea level: all coastline,
   * no ocean and no highland. Stretching the distribution about its centre is one
   * line and it is the difference between an island and a beach.
   */
  const raw = noise2(x / 70 + 11.3, z / 70 + 3.7);
  const cont = Math.max(0, Math.min(1, (raw - 0.5) * 1.9 + 0.5));
  const hills = noise2(x / 26 + 77.1, z / 26 + 41.9);
  const fine = noise2(x / 9 + 5.5, z / 9 + 91.2);
  // Only the very top of the continent field becomes mountains, so peaks are rare
  // and the rest of the map stays walkable rather than being a field of spikes.
  const peak = Math.max(0, cont - 0.72) * 26;
  const h = 10 + cont * 24 + hills * 7 + fine * 3 + peak;
  return Math.max(2, Math.min(WORLD_Y - 9, Math.round(h)));
}

/** True where the generator hollows the rock out. */
function isCave(x: number, y: number, z: number): boolean {
  if (y < 2) return false;
  /*
   * Two ridged noise fields, and a cave only where BOTH are near their middle. One
   * field on its own carves sheets — great swiss-cheese planes you fall through for
   * ten seconds. The intersection of two of them is a tunnel: a line rather than a
   * surface, which is what a cave actually is.
   */
  const a = noise3(x / 17, y / 11, z / 17);
  const b = noise3(x / 17 + 31.1, y / 11 + 7.3, z / 17 + 13.9);
  return Math.abs(a - 0.5) < 0.058 && Math.abs(b - 0.5) < 0.075;
}

/** What ore, if any, belongs in the stone at this cell. */
function oreAt(x: number, y: number, z: number): number {
  // Blobs rather than single cells: a vein you can follow is worth digging toward,
  // and a lone speck of diamond in a wall is just noise you happen to have found.
  if (y < 13 && noise3(x / 2.4 + 401, y / 2.4 + 17, z / 2.4 + 55) > 0.895) return DIAMOND_ORE;
  /*
   * Sulfur and saltpetre, deep and in small pockets.
   *
   * Rarer than iron and shallower than diamond, so the trip that gets you gunpowder
   * is the same trip that gets you a diamond pickaxe — which is the point. They are
   * worth nothing on their own; the only reason to pick either up is the other one.
   */
  if (y < 24 && noise3(x / 2.2 + 613, y / 2.2 + 41, z / 2.2 + 87) > 0.888) return SULFUR_ORE;
  if (y < 28 && noise3(x / 2.2 + 727, y / 2.2 + 93, z / 2.2 + 31) > 0.886) return NITRE_ORE;
  if (y < 22 && noise3(x / 2.6 + 211, y / 2.6 + 63, z / 2.6 + 9) > 0.872) return GOLD_ORE;
  if (y < 36 && noise3(x / 2.8 + 97, y / 2.8 + 5, z / 2.8 + 143) > 0.845) return IRON_ORE;
  if (noise3(x / 3.1 + 19, y / 3.1 + 71, z / 3.1 + 233) > 0.815) return COAL_ORE;
  return AIR;
}

/**
 * Build the world. Idempotent and lazy — whoever needs a block first pays for it.
 *
 * On a laptop this is about a third of a second, once, and it happens behind the
 * title screen on the client and before the first socket on the server. It is not
 * fast code and it does not need to be: it runs exactly once per process.
 */
export function generate(): void {
  if (generated) return;
  generated = true;

  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const h = heightAt(x, z);
      // A beach is a surface that is barely above the water, not a surface that is
      // near the water — which is why this is a height test and not a distance one.
      const beach = h <= SEA_LEVEL + 2;
      const col = (x * WORLD_Z + z) * WORLD_Y;
      for (let y = 0; y <= h; y++) {
        let b: number;
        if (y === 0) b = BEDROCK;
        else if (isCave(x, y, z)) b = AIR;
        else if (y === h) b = beach ? SAND : GRASS;
        else if (y > h - 4) b = beach ? SAND : DIRT;
        else {
          const ore = oreAt(x, y, z);
          b = ore !== AIR ? ore : STONE;
        }
        blocks[col + y] = b;
      }
      /*
       * The sea. Only ABOVE the generated surface, which is what keeps the ocean out
       * of the caves: a cavern forty blocks inland is below sea level too, and
       * filling every air cell under y=26 would drown the entire underground.
       */
      for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[col + y] = WATER;
      // Sand under the shallows, so a lake bottom is not a grass lawn seen through
      // two metres of blue.
      if (h < SEA_LEVEL && blocks[col + h] === GRASS) blocks[col + h] = SAND;
      // A little gravel where the water is deepest, for something to find down there.
      if (h < SEA_LEVEL - 4 && hash2(x + 5501, z + 991) < 0.22) blocks[col + h] = GRAVEL;
    }
  }

  plantTrees();
  scatterPlants();
  pristine.set(blocks);
  relightAll();
}

/**
 * Trees, in stands rather than sprinkled evenly.
 *
 * The world is walked in five-by-five cells and each cell grows at most one tree, at
 * a spot inside itself chosen by hash. That guarantees the spacing — no two trunks
 * can ever end up adjacent — without the generator having to look at what it already
 * planted, which is the thing that makes tree placement quadratic. A second, much
 * coarser noise field decides how much of a forest this part of the map wants to be,
 * so there are thickets and clearings instead of an orchard.
 */
function plantTrees(): void {
  for (let cx = 0; cx * 5 < WORLD_X; cx++) {
    for (let cz = 0; cz * 5 < WORLD_Z; cz++) {
      const density = noise2(cx / 3.4 + 61, cz / 3.4 + 29);
      if (hash2(cx + 7919, cz + 104729) > density * 0.85) continue;
      const x = cx * 5 + Math.floor(hash2(cx + 13, cz + 91) * 5);
      const z = cz * 5 + Math.floor(hash2(cx + 57, cz + 7) * 5);
      if (x < 3 || z < 3 || x >= WORLD_X - 3 || z >= WORLD_Z - 3) continue;
      const h = heightAt(x, z);
      // Only on real grass: not on a beach, not in a lake, and not on the roof of a
      // cave the terrain pass happened to open under the surface.
      if (h <= SEA_LEVEL + 2) continue;
      if (blocks[idx(x, h, z)] !== GRASS) continue;

      const trunk = 4 + Math.floor(hash2(x + 331, z + 733) * 3);
      const top = h + trunk;
      if (top + 2 >= WORLD_Y) continue;
      for (let y = h + 1; y <= top; y++) blocks[idx(x, y, z)] = LOG;
      /*
       * The canopy. Wide at the bottom, narrow at the top, and with its corners
       * knocked off by hash so no two crowns are the same square.
       */
      for (let dy = -2; dy <= 2; dy++) {
        const y = top + dy;
        if (y <= h || y >= WORLD_Y) continue;
        const r = dy >= 1 ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx === 0 && dz === 0 && y <= top) continue; // never bury the trunk
            if (Math.abs(dx) === r && Math.abs(dz) === r && hash2(x + dx * 71 + y, z + dz * 37) < 0.55) continue;
            const i = idx(x + dx, y, z + dz);
            if (blocks[i] === AIR) blocks[i] = LEAVES;
          }
        }
      }
    }
  }
}

/**
 * Everything lying about on the surface, and it is now the most important pass in the
 * generator rather than a decorative one.
 *
 * A player starts with nothing and no way to dig anything, so what is scattered here
 * IS the opening of the game: pebbles on the shore and the bare rock, sticks and
 * berries under the trees, fibre in the long grass. Where they are is a real design
 * decision — the two halves of a stone axe are deliberately in two different places,
 * so the first five minutes are a walk between the beach and the wood rather than a
 * lap of wherever you happened to land.
 */
function scatterPlants(): void {
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const h = heightAt(x, z);
      if (h + 1 >= WORLD_Y) continue;
      const ground = blocks[idx(x, h, z)];
      const above = idx(x, h + 1, z);
      if (blocks[above] !== AIR) continue;
      let r = hash2(x + 15485863, z + 32452843);
      /*
       * A thicker scatter around the middle, where everybody arrives.
       *
       * Without it the opening of the game is a wall: you cannot dig soil, you cannot
       * fell a tree, and if there is nothing lying within sight then there is nothing
       * you can do at all and no way to find out what you were supposed to do. The
       * first thirty seconds have to contain a pebble.
       */
      const fromSpawn = Math.hypot(x - WORLD_X / 2, z - WORLD_Z / 2);
      if (fromSpawn < 14) r *= 0.35;

      // Loose stone, on the shore and anywhere the rock is bare. The first weapon and
      // the raw material for every edge in the game.
      if (ground === SAND || ground === GRAVEL || ground === STONE) {
        if (r < 0.14) blocks[above] = PEBBLES;
        continue;
      }
      if (ground !== GRASS) continue;

      // Under a canopy: fallen wood and something to eat. A wood is where a person
      // with nothing can still get something, which is why the sticks are there and
      // not in the open.
      let shade = false;
      for (let dx = -2; dx <= 2 && !shade; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (blocks[idx(clampX(x + dx), h + 4, clampZ(z + dz))] === LEAVES) {
            shade = true;
            break;
          }
        }
      }
      if (fromSpawn < 14 && r < 0.05) {
        // Stones do not lie about on a lawn in reality, and a player who cannot find
        // two of them in the first minute has no game at all. This is the one place
        // the world is arranged rather than grown.
        blocks[above] = PEBBLES;
        continue;
      }
      if (shade) {
        if (r < 0.13) blocks[above] = STICKS;
        else if (r < 0.20) blocks[above] = BERRY_BUSH;
        else if (r < 0.44) blocks[above] = TALL_GRASS;
        continue;
      }
      if (r < 0.03) blocks[above] = FLOWER;
      else if (r < 0.30) blocks[above] = TALL_GRASS;
    }
  }
  scatterUnderground();
}

function clampX(x: number): number {
  return Math.max(0, Math.min(WORLD_X - 1, x));
}
function clampZ(z: number): number {
  return Math.max(0, Math.min(WORLD_Z - 1, z));
}

/**
 * Mushrooms on cave floors, and more loose stone down there than up here.
 *
 * Both are reasons to go into a hole other than the ore, which matters when the ore
 * needs a pick you do not have yet: the first trip underground should be worth making
 * with nothing but your hands.
 */
function scatterUnderground(): void {
  for (let x = 1; x < WORLD_X - 1; x++) {
    for (let z = 1; z < WORLD_Z - 1; z++) {
      const surface = heightAt(x, z);
      const col = (x * WORLD_Z + z) * WORLD_Y;
      for (let y = 2; y < surface - 2; y++) {
        if (blocks[col + y] !== AIR || blocks[col + y - 1] === AIR) continue;
        const floor = blocks[col + y - 1];
        if (floor !== STONE && floor !== DIRT && floor !== GRAVEL) continue;
        const r = hash2(x + 777767, z * 31 + y * 7919);
        if (r < 0.035) blocks[col + y] = MUSHROOM;
        else if (r < 0.09) blocks[col + y] = PEBBLES;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reading and writing blocks

/**
 * The block at a position, or AIR anywhere outside the world.
 *
 * Air outside, rather than stone, so the edge of the island shows its cross-section
 * — dirt over stone over bedrock, hanging in the sky. Stone would have been the
 * cheaper answer (every outward face gets culled) and it would have looked like a
 * bug: the ground would simply stop, with sky where the soil should be.
 */
export function getBlock(x: number, y: number, z: number): number {
  if (!inWorld(x, y, z)) return AIR;
  return blocks[idx(x, y, z)];
}

/** The raw store, for the mesher, which cannot afford a function call per neighbour. */
export function blockArray(): Uint8Array {
  return blocks;
}

export function lightArray(): Uint8Array {
  return light;
}

/** Sunlight at a cell, 0..15. Out of the world counts as full daylight. */
export function skyLight(x: number, y: number, z: number): number {
  if (!inWorld(x, y, z)) return 15;
  return light[idx(x, y, z)] >> 4;
}

/** Lamplight at a cell, 0..15. */
export function blockLight(x: number, y: number, z: number): number {
  if (!inWorld(x, y, z)) return 0;
  return light[idx(x, y, z)] & 0x0f;
}

// ---------------------------------------------------------------------------
// Which chunks need rebuilding
//
// A chunk's mesh depends on its own blocks AND on the ring of blocks around it —
// a face is only built when the block beside it is see-through, and the corner
// shading of every face reads the eight cells around it. So a change on a chunk's
// boundary dirties the chunk next door as well, and forgetting that leaves a
// one-block seam of stale geometry along every edge you dig at.

const dirty = new Set<number>();

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return (cy * CHUNKS_Z + cz) * CHUNKS_X + cx;
}

export function chunkCoords(ci: number): { cx: number; cy: number; cz: number } {
  const cx = ci % CHUNKS_X;
  const rest = (ci - cx) / CHUNKS_X;
  return { cx, cy: (rest / CHUNKS_Z) | 0, cz: rest % CHUNKS_Z };
}

function markDirty(x: number, y: number, z: number): void {
  const cx = x >> 4;
  const cy = y >> 4;
  const cz = z >> 4;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        // Only the chunks actually touched: the one the block is in, plus a
        // neighbour for each face of the chunk the block is sitting against.
        if (ox !== 0 && (x & 15) !== (ox < 0 ? 0 : 15)) continue;
        if (oy !== 0 && (y & 15) !== (oy < 0 ? 0 : 15)) continue;
        if (oz !== 0 && (z & 15) !== (oz < 0 ? 0 : 15)) continue;
        const nx = cx + ox;
        const ny = cy + oy;
        const nz = cz + oz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= CHUNKS_X || ny >= CHUNKS_Y || nz >= CHUNKS_Z) continue;
        dirty.add(chunkIndex(nx, ny, nz));
      }
    }
  }
}

export function markAllDirty(): void {
  for (let i = 0; i < CHUNK_COUNT; i++) dirty.add(i);
}

/** Every chunk that has changed since the last time this was asked. Clears as it goes. */
export function takeDirtyChunks(): number[] {
  if (dirty.size === 0) return EMPTY_CHUNKS;
  const out = [...dirty];
  dirty.clear();
  return out;
}

const EMPTY_CHUNKS: number[] = [];

// ---------------------------------------------------------------------------
// Light
//
// Two channels in one byte: sunlight in the high nibble, lamplight in the low one.
// They are kept apart rather than added together because they behave differently at
// dusk — the sun goes out and a lamp does not — and a renderer that only had a
// single number could not tell "this cave is dark" from "it is night outside".
//
// Sunlight falls straight down at full strength through anything see-through and
// loses a level for every step it takes sideways. That one asymmetry is the whole
// look of the thing: it is what puts a shaft of daylight down a hole you dug, and
// what makes the inside of a doorway darker than the outside of it.

const SKY_CHANNEL = 0;
const BLOCK_CHANNEL = 1;

/**
 * A flat growable queue of ints.
 *
 * `Array.shift()` on a BFS queue is O(n) and turns a light update into a visible
 * hitch the first time somebody digs into a cave. This walks a read cursor down a
 * typed array instead, which never moves anything.
 */
class IntQueue {
  private buf = new Int32Array(4096);
  private len = 0;
  private head = 0;

  push(v: number): void {
    if (this.len === this.buf.length) {
      const grown = new Int32Array(this.len * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = v;
  }

  push3(a: number, b: number, c: number): void {
    this.push(a);
    this.push(b);
    this.push(c);
  }

  push4(a: number, b: number, c: number, d: number): void {
    this.push3(a, b, c);
    this.push(d);
  }

  get done(): boolean {
    return this.head >= this.len;
  }

  pop(): number {
    return this.buf[this.head++];
  }
}

/** The six directions, as [dx, dy, dz]. */
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Whether light changes should dirty chunks.
 *
 * Off while the whole world is being lit from scratch, because at that point every
 * chunk is going to be rebuilt anyway and marking each of a million cells would cost
 * more than the lighting did.
 */
let trackLightDirty = true;

function getLevel(i: number, channel: number): number {
  return channel === SKY_CHANNEL ? light[i] >> 4 : light[i] & 0x0f;
}

function setLevel(i: number, channel: number, v: number): void {
  light[i] = channel === SKY_CHANNEL ? (light[i] & 0x0f) | (v << 4) : (light[i] & 0xf0) | v;
}

/** Push light outward from everything already in `q` until it runs out. */
function spread(q: IntQueue, channel: number): void {
  while (!q.done) {
    const x = q.pop();
    const y = q.pop();
    const z = q.pop();
    const level = getLevel(idx(x, y, z), channel);
    if (level <= 1) continue;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inWorld(nx, ny, nz)) continue;
      const ni = idx(nx, ny, nz);
      const opacity = BLOCKS[blocks[ni]].opacity;
      if (opacity >= 15) continue;
      // Straight down, at full strength, through anything perfectly clear. See the
      // note at the top of this section — this line is the shaft of daylight.
      const next =
        channel === SKY_CHANNEL && dy === -1 && level === 15 && opacity === 0
          ? 15
          : level - Math.max(1, opacity);
      if (next <= getLevel(ni, channel)) continue;
      setLevel(ni, channel, next);
      if (trackLightDirty) markDirty(nx, ny, nz);
      q.push3(nx, ny, nz);
    }
  }
}

/**
 * Take light AWAY, which is the hard half.
 *
 * When a block is placed in a lit cell, every cell that was lit BY that cell has to
 * go dark too, and every cell that was lit by something else has to stay. The trick
 * is that those are distinguishable: a neighbour dimmer than you was lit by you, a
 * neighbour at least as bright as you was lit by something else and becomes a source
 * to refill the hole from. So one sweep does both, collecting the survivors as it
 * goes, and then the survivors pour back in.
 */
function unspread(q: IntQueue, channel: number): void {
  const refill = new IntQueue();
  while (!q.done) {
    const x = q.pop();
    const y = q.pop();
    const z = q.pop();
    const level = q.pop();
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inWorld(nx, ny, nz)) continue;
      const ni = idx(nx, ny, nz);
      const nl = getLevel(ni, channel);
      if (nl === 0) continue;
      // The downward case again, mirrored: a cell below a full-strength sky cell was
      // lit by it at the same level, so "dimmer than me" never catches it.
      const litByUs = nl < level || (channel === SKY_CHANNEL && dy === -1 && level === 15 && nl === 15);
      if (litByUs) {
        setLevel(ni, channel, 0);
        if (trackLightDirty) markDirty(nx, ny, nz);
        q.push4(nx, ny, nz, nl);
      } else {
        refill.push3(nx, ny, nz);
      }
    }
  }
  spread(refill, channel);
}

/** Light the entire world from nothing. Runs once at startup and once per reconnect. */
export function relightAll(): void {
  trackLightDirty = false;
  light.fill(0);

  // Sunlight, straight down every column, stopping when the ground eats it.
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const col = (x * WORLD_Z + z) * WORLD_Y;
      let level = 15;
      for (let y = WORLD_Y - 1; y >= 0; y--) {
        const i = col + y;
        level = Math.max(0, level - BLOCKS[blocks[i]].opacity);
        if (level === 0) break;
        light[i] = level << 4;
      }
    }
  }

  /*
   * Now spread it sideways — but seed the queue with the FRONTIER rather than with
   * every lit cell. Half a million cells of open sky are all at 15 with nothing to
   * give each other; the only cells that can still light anything are the ones next
   * to something darker. Finding them is one extra pass over the array and it turns
   * a queue of a million entries into one of a few thousand.
   */
  spread(frontier(SKY_CHANNEL), SKY_CHANNEL);

  // Lamps. Few enough that there is no frontier trick to play.
  const lamps = new IntQueue();
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const col = (x * WORLD_Z + z) * WORLD_Y;
      for (let y = 0; y < WORLD_Y; y++) {
        const glow = BLOCKS[blocks[col + y]].glow;
        if (glow === 0) continue;
        light[col + y] |= glow;
        lamps.push3(x, y, z);
      }
    }
  }
  spread(lamps, BLOCK_CHANNEL);

  trackLightDirty = true;
  markAllDirty();
}

function frontier(channel: number): IntQueue {
  const q = new IntQueue();
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const col = (x * WORLD_Z + z) * WORLD_Y;
      for (let y = 0; y < WORLD_Y; y++) {
        const level = getLevel(col + y, channel);
        if (level <= 1) continue;
        for (const [dx, dy, dz] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!inWorld(nx, ny, nz)) continue;
          const ni = idx(nx, ny, nz);
          if (BLOCKS[blocks[ni]].opacity >= 15) continue;
          if (getLevel(ni, channel) < level - 1) {
            q.push3(x, y, z);
            break;
          }
        }
      }
    }
  }
  return q;
}

/** Redo the light around one changed cell, in both channels. */
function relightAround(x: number, y: number, z: number, placed: number): void {
  for (const channel of [SKY_CHANNEL, BLOCK_CHANNEL]) {
    const i = idx(x, y, z);
    const had = getLevel(i, channel);
    if (had > 0) {
      setLevel(i, channel, 0);
      const remove = new IntQueue();
      remove.push4(x, y, z, had);
      unspread(remove, channel);
    }
    const add = new IntQueue();
    // A lamp is its own source.
    if (channel === BLOCK_CHANNEL) {
      const glow = blockDef(placed).glow;
      if (glow > 0) {
        setLevel(i, channel, glow);
        add.push3(x, y, z);
      }
    }
    // And whatever is around the hole pours into it. This is the case that matters
    // when a block is DUG rather than placed: the cell had no light of its own to
    // remove, and everything it gets comes from its neighbours.
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inWorld(nx, ny, nz)) continue;
      if (getLevel(idx(nx, ny, nz), channel) > 0) add.push3(nx, ny, nz);
    }
    spread(add, channel);
  }
  markDirty(x, y, z);
}

// ---------------------------------------------------------------------------
// Changing the world

/**
 * Put a block somewhere, and fix the light and the meshes it affected.
 *
 * Returns false when nothing changed, so a duplicate edit arriving from the server
 * for a block the client already predicted correctly costs nothing at all — which is
 * the common case, since every edit you make comes back to you.
 */
export function setBlock(x: number, y: number, z: number, b: number): boolean {
  if (!inWorld(x, y, z)) return false;
  const i = idx(x, y, z);
  if (blocks[i] === b) return false;
  blocks[i] = b;
  markDirty(x, y, z);
  relightAround(x, y, z, b);
  return true;
}

/**
 * Apply an edit without touching the light. For replaying a whole world's worth of
 * them at join time, where one relight at the end is cheaper than ten thousand
 * incremental ones — by about four orders of magnitude.
 */
export function setBlockRaw(index: number, b: number): void {
  if (index >= 0 && index < CELLS) blocks[index] = b;
}

/** Throw away every change anybody has made and go back to the generated world. */
export function resetToPristine(): void {
  generate();
  blocks.set(pristine);
}

/**
 * What the generator would have put at a cell, whatever is there now.
 *
 * The server uses this to decide whether a change is still a change: fill a hole
 * back in and the edit is forgotten rather than recorded as "dirt, where dirt would
 * have been anyway". Otherwise the save file only ever grows, and a world where
 * everybody has been tidying up would be bigger than one nobody had touched.
 */
export function pristineBlock(index: number): number {
  return index >= 0 && index < CELLS ? pristine[index] : AIR;
}

// ---------------------------------------------------------------------------
// Looking at things

export interface Hit {
  /** The block that was hit. */
  x: number;
  y: number;
  z: number;
  /** The face it was hit on, as a unit normal. New blocks go on this side. */
  nx: number;
  ny: number;
  nz: number;
  /** Distance along the ray. */
  dist: number;
}

/** Blocks you can point at. Water is not one of them; neither is air. */
export function targetable(b: number): boolean {
  return b !== AIR && !blockDef(b).liquid;
}

/**
 * March a ray through the grid and return the first block it meets.
 *
 * Amanatides and Woo, which visits every cell the ray passes through in order and
 * never misses one — as opposed to sampling along the ray every tenth of a block,
 * which is the version everybody writes first and which lets you shoot diagonally
 * through the corner between two blocks.
 */
export function raycast(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): Hit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);

  let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? x + 1 - ox : ox - x) / Math.abs(dx));
  let tMaxY = stepY === 0 ? Infinity : ((stepY > 0 ? y + 1 - oy : oy - y) / Math.abs(dy));
  let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? z + 1 - oz : oz - z) / Math.abs(dz));

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  // Standing inside something already — the only way to get here is by placing a
  // block on your own head, and pointing at it from the inside has no face to speak of.
  if (inWorld(x, y, z) && targetable(blocks[idx(x, y, z)])) {
    return { x, y, z, nx: 0, ny: 0, nz: 0, dist: 0 };
  }

  while (t <= maxDist) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxDist) return null;
    // Out of the world sideways or out the top: keep going, because the world is an
    // island and a ray can leave it and come back. Out the bottom, it is gone.
    if (y < 0) return null;
    if (!inWorld(x, y, z)) continue;
    if (targetable(blocks[idx(x, y, z)])) return { x, y, z, nx, ny, nz, dist: t };
  }
  return null;
}

// ---------------------------------------------------------------------------
// People
//
// A body is a box six-tenths of a block across and one and four-fifths tall, with
// its eyes just under the top of it. Those are Minecraft's numbers and they are
// Minecraft's numbers for a good reason: a body narrower than a block fits down a
// one-block hole, and eyes below the top of the body mean a two-block-high tunnel
// does not clip through your head.

export const PLAYER_W = 0.6;
export const PLAYER_H = 1.8;
export const EYE_H = 1.62;

/** How far you can reach to dig or build. */
export const REACH = 5;

export const WALK_SPEED = 4.4;
export const SPRINT_SPEED = 6.1;
export const SWIM_SPEED = 2.9;

/**
 * Jumping. Tuned as a pair rather than separately: peak height is v²/2g, so these
 * two numbers mean "one and a quarter blocks", which is the number that matters —
 * it is exactly enough to get up a single step and nowhere near enough for two.
 */
export const JUMP_V = 8.4;
export const GRAVITY = 28;
export const TERMINAL_V = 38;

/**
 * A ladder: up while you hold jump, and a slow slide otherwise.
 *
 * Not "climb by pushing into it", which is what Minecraft does — that rule needs to
 * know which way the ladder faces AND which way you are walking, and it strands
 * anybody who approaches from the wrong side. One key that means up is the same key
 * that already meant up in the water, and it works from every direction.
 */
export const CLIMB_UP = 3.4;
export const CLIMB_SLIDE = 2.2;

/** In water you sink slowly, rise slowly, and everything takes longer. */
export const WATER_GRAVITY = 7;
export const WATER_SINK_MAX = 2.4;
export const SWIM_UP_V = 3.6;

/** Authoritative ticks per second, and how often the client posts its input. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const INPUT_RATE = 20;

/**
 * How far behind the newest snapshot other people are drawn.
 *
 * Rendering them at the very latest position means stuttering every time a packet is
 * late. Holding them a tenth of a second in the past means there is always a pair of
 * snapshots to interpolate between, and the cost is 100ms of lag on somebody else's
 * position — which nobody can perceive and everybody prefers to jitter.
 */
export const INTERP_DELAY_MS = 100;

/** A whole day, in milliseconds. Twelve minutes: long enough to build something in. */
export const DAY_MS = 12 * 60 * 1000;

// ---------------------------------------------------------------------------
// Health, and the fact that NOTHING HERE KILLS YOU
//
// Twenty points, drawn as ten hearts, so half a heart is a unit and a small fall can
// cost one. Run out and you are flat on your back for a couple of seconds and then
// get up, full, EXACTLY WHERE YOU FELL. You are never removed from the world, never
// teleported, never sent back to spawn, and you never drop what you were carrying.
//
// That is a deliberate line and it is worth being explicit about. Losing your place —
// and the stack of stone you walked half the island to dig — is the part of dying
// that actually costs something, and a game about building does not need it. What
// health buys is a reason to care which way down you take, and that is all it is
// for. There is no death in this file and no respawn-on-death anywhere in the server.

export const MAX_HP = 20;

/**
 * How far you can drop for free, and what every block past that costs.
 *
 * Five blocks free and two-fifths of a point after — a tenth of a heart per block.
 * Which is very little on purpose: a twenty-block fall onto stone is three hearts,
 * and the tallest drop on the island is survivable at full health with room to spare.
 * The number is small enough that fall damage is a thing you notice rather than a
 * thing you plan around, and that is the intended weight of it.
 *
 * What it is multiplied by is the SOFTNESS of whatever you landed on, so where you
 * land matters far more than how far you fell. Sand is worth about twelve times a
 * stone floor and thatch is worth thirty.
 */
export const SAFE_FALL = 5;
export const FALL_DAMAGE_PER_BLOCK = 0.4;

/** Quiet seconds before you start mending, and seconds per point after that. */
export const REGEN_DELAY = 4;
export const REGEN_PERIOD = 1.5;

/**
 * How long you lie there before the world puts you back. Ten seconds.
 *
 * Dying costs you EVERYTHING YOU WERE CARRYING, and that is not a flourish — it is
 * what stops death from being the fastest way to heal. Sections below only come back
 * on death, so without a price attached, the optimal play for a wounded player would
 * be to walk off a cliff. The price is your pockets.
 */
export const RESPAWN_MS = 10_000;

// ---------------------------------------------------------------------------
// Health in sections
//
// Twenty points in FIVE SECTIONS of four, which is five bands of two hearts. You mend
// on your own — but only up to the top of the section you are currently in, and that
// ceiling only ever goes DOWN. Drop from nine hearts to seven and you are in the
// fourth band for good: rest all day and you will reach eight, never ten.
//
// The ceiling comes back when you die and at no other time. Which makes a wound a
// thing you carry for the rest of the session rather than a thing you wait out, and
// makes "should I go home" a real question instead of a rhetorical one.

export const SECTIONS = 5;
export const SECTION_SIZE = MAX_HP / SECTIONS;

/** The top of whichever section this much health falls in. */
export function sectionCap(hp: number): number {
  if (hp <= 0) return 0;
  return Math.min(MAX_HP, Math.ceil(hp / SECTION_SIZE) * SECTION_SIZE);
}

// ---------------------------------------------------------------------------
// Hunger
//
// Twenty points, drawn as ten. It goes down on its own and faster for everything you
// do, it will not kill you outright — it stops you mending, and then it starts taking
// points off — and it is the reason you cannot simply live underground.

export const MAX_HUNGER = 20;
/**
 * Points a second, standing still, and what moving and working add to it.
 *
 * Tuned against the twelve-minute day rather than against a spreadsheet. A full
 * stomach is about forty minutes of standing about, fifteen of walking, six of
 * sprinting flat out, or eight of solid digging — so a day's building costs you a
 * meal and a day's sprinting costs you three. The first numbers here were twenty
 * times these and emptied the bar in three minutes, which does not make a game
 * harder, it makes it a game about eating.
 */
export const HUNGER_IDLE = 0.008;
export const HUNGER_WALK = 0.014;
export const HUNGER_SPRINT = 0.05;
export const HUNGER_WORK = 0.034;
/** Below this you stop mending. At zero you start losing points. */
export const HUNGER_TO_HEAL = 8;
export const STARVE_RATE = 0.35;

export interface Player {
  id: string;
  name: string;
  /** The middle of the feet. */
  x: number;
  y: number;
  z: number;
  /** Vertical speed, blocks per second. Positive is up. */
  vy: number;
  /** Where they are looking. Radians; yaw 0 is +x, pitch is up-positive. */
  yaw: number;
  pitch: number;
  onGround: boolean;
  inWater: boolean;
  /** True while actually walking, which is what drives the arms and legs. */
  moving: boolean;
  sprinting: boolean;
  /** Chosen at join and never changed, so everyone renders you the same colour. */
  hue: number;
  /**
   * Points of health, 0..MAX_HP. Only ever written by the SERVER — the client draws
   * what it is told rather than predicting it. Being briefly wrong about a position
   * is invisible; being briefly wrong about whether that drop hurt is not, and a bar
   * that flickered down and back on every mispredicted landing would be worse than
   * one that answers a round trip late.
   */
  hp: number;
  /**
   * Seconds until the world puts you back. Above zero you are dead: no walking, no
   * jumping, no digging — the same rule on both sides, so the client does not predict
   * a step the server is going to refuse.
   */
  respawn: number;
  /**
   * The top of the health section you are in. Never rises except on death.
   * See the note by `SECTIONS`.
   */
  cap: number;
  /** Points of hunger, 0..MAX_HUNGER. Server's alone, like health. */
  hunger: number;
  /**
   * How far the last landing was, in blocks, on the tick it happened, and zero
   * otherwise. Pure kinematics: `step` works it out identically on both machines and
   * the SERVER alone decides what it costs. That split is what lets the physics be
   * shared and the damage stay authoritative.
   */
  fell: number;
  /** The highest this body has been since it last touched the ground. */
  peakY: number;
}

/**
 * Anything with a body: a player, a zombie, a pig.
 *
 * The movement code takes one of these rather than a `Player`, and that is what lets
 * a zombie be stopped by the fence you built. A creature with its own idea of how
 * walls work is a creature that will eventually walk through one.
 */
export interface Body {
  x: number;
  y: number;
  z: number;
  vy: number;
  yaw: number;
  onGround: boolean;
  inWater: boolean;
  moving: boolean;
  sprinting: boolean;
  fell: number;
  peakY: number;
  /** Box size. Absent means player-sized. */
  bw?: number;
  bh?: number;
}

export interface MoveInput {
  /** Forward, in [-1, 1], relative to where the player is facing. */
  fwd: number;
  /** To the player's right, in [-1, 1]. */
  strafe: number;
  jump: boolean;
  sprint: boolean;
}

/** A hair of slack, so a body resting against a wall is not also inside it. */
const SKIN = 1e-4;

/**
 * How high a step you walk up without jumping. Exactly a slab.
 *
 * This is what makes stairs worth building. Without it a staircase is a column of
 * jumps and there is no reason to cut one — you would put a ramp of full blocks in
 * and hop up it, which is what everybody did before slabs existed.
 */
export const STEP_HEIGHT = 0.5 + 1e-3;

/**
 * Does a body here overlap anything solid?
 *
 * Every block is a LIST of boxes rather than one, which is what lets a slab be half a
 * block and a stair be a slab with a step on it. A full cube is a one-entry list and
 * costs one extra comparison, which is nothing against being able to build a
 * staircase you can actually walk up.
 */
function solidBoxAt(x: number, y: number, z: number, bw = PLAYER_W, bh = PLAYER_H): boolean {
  const h = bw / 2;
  const x0 = Math.floor(x - h);
  const x1 = Math.floor(x + h);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + bh - SKIN);
  const z0 = Math.floor(z - h);
  const z1 = Math.floor(z + h);
  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        const b = getBlock(bx, by, bz);
        if (!BLOCKS[b].solid) continue;
        for (const [ax, ay, az, cx, cy, cz] of boxesOf(b)) {
          if (
            x + h > bx + ax && x - h < bx + cx &&
            y + bh - SKIN > by + ay && y < by + cy &&
            z + h > bz + az && z - h < bz + cz
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * The highest thing under the feet in this column, for standing on top of it.
 *
 * Only used by the step-up: to know whether a step is small enough to walk up, you
 * have to know how high it actually is, and "the top of the block" is wrong for
 * everything that is not a full cube.
 */
function surfaceUnder(x: number, y: number, z: number, bw = PLAYER_W): number {
  const h = bw / 2;
  let top = -Infinity;
  for (let bx = Math.floor(x - h); bx <= Math.floor(x + h); bx++) {
    for (let bz = Math.floor(z - h); bz <= Math.floor(z + h); bz++) {
      for (let by = Math.floor(y + STEP_HEIGHT); by >= Math.floor(y) - 1; by--) {
        const b = getBlock(bx, by, bz);
        if (!BLOCKS[b].solid) continue;
        for (const [ax, ay, az, cx, cy, cz] of boxesOf(b)) {
          if (x + h <= bx + ax || x - h >= bx + cx) continue;
          if (z + h <= bz + az || z - h >= bz + cz) continue;
          if (by + cy > y + STEP_HEIGHT + SKIN) continue;
          top = Math.max(top, by + cy);
        }
      }
    }
  }
  return top;
}

/**
 * Is any part of this body inside a ladder?
 *
 * Any part, deliberately: at the very top of a climb your feet have already cleared
 * the last rung while your chest has not, and a test that only looked at the feet
 * would drop you back down the shaft from the lip of the hole every time.
 */
function onLadder(p: { x: number; y: number; z: number }): boolean {
  const h = PLAYER_W / 2;
  for (let bx = Math.floor(p.x - h); bx <= Math.floor(p.x + h); bx++) {
    for (let by = Math.floor(p.y); by <= Math.floor(p.y + PLAYER_H - SKIN); by++) {
      for (let bz = Math.floor(p.z - h); bz <= Math.floor(p.z + h); bz++) {
        if (BLOCKS[getBlock(bx, by, bz)].shape === 'ladder') return true;
      }
    }
  }
  return false;
}

/** True when a box at this spot would be standing in water up to its waist. */
function inLiquid(x: number, y: number, z: number): boolean {
  return BLOCKS[getBlock(Math.floor(x), Math.floor(y + 0.5), Math.floor(z))].liquid;
}

/**
 * Move one player one step.
 *
 * The ONE place walking is defined, called by the server to advance the world and by
 * the client to predict its own next position.
 *
 * Movement is resolved one axis at a time, which is the whole trick: try the move,
 * and if the box now overlaps something solid, put it back against the face it hit
 * and forget that axis. Doing all three at once and then trying to work out which
 * one to undo is the version that lets you slide diagonally into corners.
 */
export function step(p: Player, inp: MoveInput, dt: number): void {
  // Flat on your back, nothing you press does anything — here rather than in two
  // places, so the client cannot predict a step the server is going to refuse.
  if (p.respawn > 0) inp = FLAT;
  // Cleared each frame and set by whichever substep lands. The server reads it once,
  // straight after this returns.
  p.fell = 0;
  /*
   * Cut the frame into pieces small enough that nothing moves further than a third
   * of a block in one go. Terminal velocity is thirty-eight blocks a second and a
   * server tick is a twentieth of one, which is nearly two whole blocks of falling —
   * enough to start a step above a floor and finish below it, having touched
   * nothing. Substepping is what makes the axis resolution above safe.
   */
  const water = inLiquid(p.x, p.y, p.z);
  const horizontal = water ? SWIM_SPEED : inp.sprint && inp.fwd > 0 ? SPRINT_SPEED : WALK_SPEED;
  const fastest = Math.max(horizontal, Math.abs(p.vy) + GRAVITY * dt);
  const parts = Math.max(1, Math.min(8, Math.ceil((fastest * dt) / 0.34)));
  const slice = dt / parts;
  for (let i = 0; i < parts; i++) substep(p, inp, slice, horizontal);
}

/**
 * Move a creature. The same walking a player gets, at its own speed and size.
 *
 * Shared on purpose and not as a convenience: a zombie that used its own movement
 * would eventually be a zombie that walks through your wall, and you would only find
 * out from somebody who lost a house.
 */
export function stepMob(b: Body, inp: MoveInput, dt: number, speed: number): void {
  b.fell = 0;
  const fastest = Math.max(speed, Math.abs(b.vy) + GRAVITY * dt);
  const parts = Math.max(1, Math.min(8, Math.ceil((fastest * dt) / 0.34)));
  const slice = dt / parts;
  for (let i = 0; i < parts; i++) substep(b as Player, inp, slice, speed);
}

function substep(p: Player, inp: MoveInput, dt: number, horizontal: number): void {
  const bw = (p as Body).bw ?? PLAYER_W;
  const bh = (p as Body).bh ?? PLAYER_H;
  unwedge(p, bw, bh);
  p.inWater = inLiquid(p.x, p.y, p.z);
  const climbing = !p.inWater && onLadder(p);

  if (climbing) {
    /*
     * Vertical speed is SET rather than accumulated, so there is no momentum on a
     * ladder at all: you go up while you hold the key, you slide down when you do
     * not, and you stop the instant you step off onto a floor. A ladder with
     * acceleration on it overshoots the top and drops you back down the shaft.
     */
    p.vy = inp.jump ? CLIMB_UP : -CLIMB_SLIDE;
    // Nothing about a ladder is a fall, however far down it goes.
    p.peakY = p.y;
  } else if (p.inWater) {
    /*
     * Swimming. Holding jump climbs, letting go sinks — slowly, and to a floor
     * rather than to a drowning. Nothing in this world kills you, so deep water is
     * a place that is slow and dark rather than a place that ends you; the cost of
     * going in is the ninety seconds it takes to get out.
     */
    if (inp.jump) p.vy = SWIM_UP_V;
  } else if (inp.jump && p.onGround) {
    p.vy = JUMP_V;
  }
  /*
   * The launch is an INSTANT change of speed and the fall is a gradual one, so the
   * jump is applied first and the averaging below starts from the speed it left you
   * with. Averaging across the impulse instead — which is what happens if the two
   * are done in one expression — throws away the first half-step of every jump, and
   * a jump missing its first half-step clears 1.05 blocks instead of 1.26. That is
   * the difference between stepping up onto a block and bouncing off the side of it,
   * and it is invisible in the code that caused it.
   */
  const launched = p.vy;
  if (!climbing) {
    const pull = p.inWater ? WATER_GRAVITY : GRAVITY;
    const floor = p.inWater ? -WATER_SINK_MAX : -TERMINAL_V;
    p.vy = Math.max(floor, p.vy - pull * dt);
  }

  /*
   * Move by the AVERAGE of the speed at both ends of the step rather than by the
   * speed at the end of it. It is exact for constant acceleration and — much more
   * importantly — it is the same answer at every frame rate.
   *
   * Taking `vy * dt` is the version everybody writes, and it makes the height of a
   * jump depend on how fast your computer is: a 144 Hz screen cleared a block and a
   * third, a 20 Hz server tick a block and a fifth. Which means the client predicts
   * a jump the server never gives it, and every hop ends in a snap back down. The
   * whole point of `step` living in a shared file is that both sides get the same
   * number, and a frame-rate-dependent integrator quietly gives that up.
   */
  const wasGrounded = p.onGround;
  moveY(p, (launched + p.vy) * 0.5 * dt, bw, bh);

  /*
   * Bookkeeping for the fall, and only the bookkeeping — how far, not what it costs.
   *
   * Measured from the highest point since the feet last left something, not from
   * where the fall started, so stepping off a ledge and jumping off one give the
   * same answer plus the height of the jump. Water zeroes it outright: swimming down
   * is not falling, and a lake has been the safe way off a cliff in every game that
   * has ever had one.
   */
  if (p.inWater) {
    p.peakY = p.y;
  } else if (p.onGround) {
    if (!wasGrounded && p.peakY > p.y) p.fell = Math.max(p.fell, p.peakY - p.y);
    p.peakY = p.y;
  } else if (p.y > p.peakY) {
    p.peakY = p.y;
  }

  const len = Math.hypot(inp.fwd, inp.strafe);
  if (len < 0.01) {
    p.moving = false;
  } else {
    // Normalised, because otherwise holding two keys is 1.41x faster than one and
    // players find that out immediately and then never walk in a straight line again.
    const fwd = inp.fwd / len;
    const strafe = inp.strafe / len;
    const cos = Math.cos(p.yaw);
    const sin = Math.sin(p.yaw);
    // Forward is where the face points; right is a quarter turn clockwise from it.
    const dx = (fwd * cos - strafe * sin) * horizontal * dt;
    const dz = (fwd * sin + strafe * cos) * horizontal * dt;
    moveX(p, dx, bw, bh);
    moveZ(p, dz, bw, bh);
    p.moving = true;
  }
  p.sprinting = inp.sprint && inp.fwd > 0 && !p.inWater && p.moving;

  clampToWorld(p, bw);
}

/**
 * Never leave a body inside a block. Push it up until it is out.
 *
 * The server refuses any build that overlaps somebody, but "somebody" is where the
 * server last heard they were, and that is a tick stale — so two people building in
 * the same doorway can, rarely, wall one of them in. Without this that player is
 * wedged for good: gravity pulls them down, the floor pushes them back to exactly
 * where they were, and no key does anything.
 *
 * Upward, in eighths, and never more than a body's height. Up rather than sideways
 * because up is where the open sky is, and a limit because somebody genuinely buried
 * under a mountain should stay buried rather than be launched through it.
 */
function unwedge(p: Player, bw: number, bh: number): void {
  if (!solidBoxAt(p.x, p.y, p.z, bw, bh)) return;
  for (let i = 0; i < 16; i++) {
    p.y += 0.125;
    if (!solidBoxAt(p.x, p.y, p.z, bw, bh)) break;
  }
  // Whatever was happening vertically is over; they were not falling, they were stuck.
  if (p.vy < 0) p.vy = 0;
  p.peakY = p.y;
}

function moveY(p: Player, dy: number, bw: number, bh: number): void {
  if (dy === 0) return;
  const ny = p.y + dy;
  if (!solidBoxAt(p.x, ny, p.z, bw, bh)) {
    p.y = ny;
    /*
     * Any vertical move that succeeds means you are not standing on anything —
     * INCLUDING an upward one. This used to only clear the flag when falling, which
     * looks harmless and is not: on the way up out of a jump the flag was still set
     * from the landing before it, so the next substep saw "jump held, on the ground"
     * and launched again. Leaning on the space bar climbed into the sky at walking
     * pace and straight over any wall you cared to name.
     */
    p.onGround = false;
    return;
  }
  if (dy < 0) {
    // Feet ended up inside the block at floor(ny); stand on its top face.
    p.y = Math.floor(ny) + 1;
    p.onGround = true;
  } else {
    // Head first into a ceiling: the head is inside floor(ny + height), so the face
    // it hit is the BOTTOM of that block, which is floor(ny + height) itself.
    p.y = Math.floor(ny + bh) - bh - SKIN;
  }
  p.vy = 0;
}

/*
 * Being stopped is `floor`, not `ceil`, in both directions, and getting that wrong is
 * not a small error — it is a teleport.
 *
 * Walking east, the box's leading edge ends up somewhere inside block
 * `floor(x + halfWidth)`, and the face it ran into is that block's WEST side, which
 * is at exactly that integer. Rounding UP instead names the far side of the block it
 * hit, which puts the body a whole block further along than it was trying to go —
 * so walking into a wall shot you through it, faster than walking in the open. It
 * took a probe that measured blocks-per-second against a wall to see it, because on
 * open ground the branch never runs at all.
 */
function moveX(p: Player, dx: number, bw: number, bh: number): void {
  if (dx === 0) return;
  const nx = p.x + dx;
  if (!solidBoxAt(nx, p.y, p.z, bw, bh)) {
    p.x = nx;
    return;
  }
  if (stepUp(p, nx, p.z, bw, bh)) return;
  const h = bw / 2;
  p.x = dx > 0 ? Math.floor(nx + h) - h - SKIN : Math.floor(nx - h) + 1 + h + SKIN;
}

function moveZ(p: Player, dz: number, bw: number, bh: number): void {
  if (dz === 0) return;
  const nz = p.z + dz;
  if (!solidBoxAt(p.x, p.y, nz, bw, bh)) {
    p.z = nz;
    return;
  }
  if (stepUp(p, p.x, nz, bw, bh)) return;
  const h = bw / 2;
  p.z = dz > 0 ? Math.floor(nz + h) - h - SKIN : Math.floor(nz - h) + 1 + h + SKIN;
}

/**
 * Walk up a step rather than into it, if it is small enough.
 *
 * Only from the ground, and only up to half a block: in the air it would be a
 * mid-jump ledge grab, and any higher and every wall becomes climbable. The body is
 * lifted onto the surface and then the move is retried — if it still does not fit
 * (there is a ceiling over the step, say) nothing happens and the caller stops you
 * against the wall as usual.
 */
function stepUp(p: Player, nx: number, nz: number, bw: number, bh: number): boolean {
  if (!p.onGround) return false;
  const top = surfaceUnder(nx, p.y, nz, bw);
  if (!Number.isFinite(top) || top <= p.y + SKIN || top - p.y > STEP_HEIGHT) return false;
  if (solidBoxAt(nx, top + SKIN, nz, bw, bh)) return false;
  p.x = nx;
  p.z = nz;
  p.y = top + SKIN;
  // A step is not a fall and is not a jump. Reset the reckoning so walking up three
  // stairs and off the end does not read as having fallen off the top of them.
  p.peakY = p.y;
  return true;
}

/** Keep a body inside the island. The edge is a wall you cannot fall off. */
export function clampToWorld(p: Body, bw = PLAYER_W): void {
  const h = bw / 2;
  p.x = Math.min(WORLD_X - h, Math.max(h, p.x));
  p.z = Math.min(WORLD_Z - h, Math.max(h, p.z));
  if (p.y < 0) {
    p.y = 0;
    p.vy = 0;
    p.onGround = true;
  }
  if (p.y > WORLD_Y) p.y = WORLD_Y;
}

/** Nothing pressed. One frozen object rather than a fresh one per knocked-down tick. */
const FLAT: MoveInput = { fwd: 0, strafe: 0, jump: false, sprint: false };

// ---------------------------------------------------------------------------
// What a landing costs
//
// Server-side decisions, every one of them, but they live here because they are
// rules of the world rather than rules of the network — and because the client wants
// the same numbers to write the help text with.

/**
 * The softest thing under this body's feet.
 *
 * The SOFTEST, out of everything the box overlaps, rather than the one under the
 * middle of it: landing with one foot on the sand should count as landing on sand.
 * It is a generous reading and generosity is right here — the alternative is a
 * player who lands on the edge of the beach they aimed for and takes the stone
 * number, which reads as the game lying to them.
 */
export function softestUnder(p: { x: number; y: number; z: number }): number {
  const h = PLAYER_W / 2;
  const y = Math.floor(p.y - 0.05);
  let softest = 1;
  for (let bx = Math.floor(p.x - h); bx <= Math.floor(p.x + h); bx++) {
    for (let bz = Math.floor(p.z - h); bz <= Math.floor(p.z + h); bz++) {
      const d = BLOCKS[getBlock(bx, y, bz)];
      if (!d.solid) continue;
      if (d.softness < softest) softest = d.softness;
    }
  }
  return softest;
}

/** What the landing recorded in `p.fell` should cost, in points. Zero most of the time. */
export function fallDamage(p: Player): number {
  if (p.fell <= SAFE_FALL) return 0;
  return (p.fell - SAFE_FALL) * FALL_DAMAGE_PER_BLOCK * softestUnder(p);
}

/**
 * Take some damage. Returns true if that was the point that put them down.
 *
 * At zero the player goes DOWN rather than away: `down` counts off the seconds they
 * spend flat, and standing back up gives them a full bar exactly where they fell.
 */
export function hurt(p: Player, amount: number): boolean {
  if (p.respawn > 0 || amount <= 0) return false;
  p.hp = Math.max(0, p.hp - amount);
  /*
   * The ceiling follows you down and never follows you back up. One line, and it is
   * the whole mechanic: `Math.min` is what makes an injury permanent.
   */
  p.cap = Math.min(p.cap, sectionCap(p.hp));
  if (p.hp > 0) return false;
  p.respawn = RESPAWN_MS / 1000;
  return true;
}

/**
 * Count off the knockdown and mend anything that has been quiet long enough.
 *
 * Called by the SERVER only. `quiet` is seconds since this player last took a hit;
 * the caller keeps that, because it is bookkeeping rather than state anybody else
 * needs to see and it has no business on the wire.
 */
export function stepHealth(p: Player, dt: number, quiet: number): void {
  if (p.respawn > 0) {
    p.respawn = Math.max(0, p.respawn - dt);
    p.moving = false;
    return;
  }
  /*
   * Starving takes points off; being merely hungry only stops you mending. Two
   * different thresholds because they are two different feelings — one is "find
   * something to eat soon" and the other is "find something to eat NOW".
   */
  if (p.hunger <= 0) {
    p.hp = Math.max(0.5, p.hp - STARVE_RATE * dt);
    p.cap = Math.min(p.cap, sectionCap(p.hp));
    return;
  }
  if (p.hunger < HUNGER_TO_HEAL) return;
  if (quiet < REGEN_DELAY) return;
  // Up to the ceiling of the section you are in, and no further. Ever.
  if (p.hp >= p.cap) return;
  p.hp = Math.min(p.cap, p.hp + dt / REGEN_PERIOD);
}

/** Burn hunger for whatever this player has just spent a tick doing. */
export function stepHunger(p: Player, dt: number, working: boolean): void {
  if (p.respawn > 0) return;
  let rate = HUNGER_IDLE;
  if (p.moving) rate += p.sprinting ? HUNGER_SPRINT : HUNGER_WALK;
  if (working) rate += HUNGER_WORK;
  p.hunger = Math.max(0, p.hunger - rate * dt);
}

/** Eat something. Returns false if there was no room, so the food is not wasted. */
export function feed(p: Player, fills: number, heals: number): boolean {
  if (p.hunger >= MAX_HUNGER - 0.001) return false;
  p.hunger = Math.min(MAX_HUNGER, p.hunger + fills);
  if (heals > 0) p.hp = Math.min(p.cap, p.hp + heals);
  return true;
}

/**
 * Put somebody back at the beginning: whole, fed, and with every section restored.
 *
 * The caller empties their pockets. That is deliberately not done here — this
 * function is about a body, and losing what you were carrying is a rule about a game.
 */
export function revive(p: Player, at: { x: number; y: number; z: number }): void {
  p.hp = MAX_HP;
  p.cap = MAX_HP;
  p.hunger = MAX_HUNGER;
  p.respawn = 0;
  p.vy = 0;
  p.x = at.x;
  p.y = at.y;
  p.z = at.z;
  p.peakY = at.y;
  p.fell = 0;
}

/** Is there one of these within `radius` blocks? Used for "must be near a furnace". */
export function blockNear(x: number, y: number, z: number, block: number, radius: number): boolean {
  const r = Math.ceil(radius);
  for (let bx = Math.floor(x) - r; bx <= Math.floor(x) + r; bx++) {
    for (let by = Math.floor(y) - r; by <= Math.floor(y) + r; by++) {
      for (let bz = Math.floor(z) - r; bz <= Math.floor(z) + r; bz++) {
        if (getBlock(bx, by, bz) === block) return true;
      }
    }
  }
  return false;
}

/** Would a body fit here, standing? Used when putting somebody back where they left. */
export function canStandAt(x: number, y: number, z: number): boolean {
  return (
    y >= 0 &&
    y < WORLD_Y - 1 &&
    x >= 0 &&
    z >= 0 &&
    x < WORLD_X &&
    z < WORLD_Z &&
    !solidBoxAt(x, y, z)
  );
}

/** Would a body at this spot be inside a block? Used to refuse a build under someone. */
export function bodyOverlapsBlock(px: number, py: number, pz: number, bx: number, by: number, bz: number): boolean {
  const h = PLAYER_W / 2;
  return (
    px + h > bx && px - h < bx + 1 && py + PLAYER_H > by && py < by + 1 && pz + h > bz && pz - h < bz + 1
  );
}

/**
 * Somewhere to arrive.
 *
 * Near the middle of the island, on top of whatever is there, and never in the sea —
 * a first ten seconds spent swimming out of the ocean is a bad opening. Different
 * people get slightly different spots so a busy world does not stack everybody on
 * one block.
 */
export function spawnPoint(rand: number): { x: number; y: number; z: number } {
  generate();
  const cx = WORLD_X / 2;
  const cz = WORLD_Z / 2;
  for (let r = 0; r < 48; r++) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = (rand * 360 + attempt * 47 + r * 13) * (Math.PI / 180);
      const x = Math.floor(cx + Math.cos(a) * r);
      const z = Math.floor(cz + Math.sin(a) * r);
      if (x < 2 || z < 2 || x >= WORLD_X - 2 || z >= WORLD_Z - 2) continue;
      const y = surfaceY(x, z);
      if (y <= SEA_LEVEL) continue;
      /*
       * And it has to be able to see the sky.
       *
       * `surfaceY` finds the highest block in a column, which is not the same thing:
       * where a cave has broken through to the surface, the highest block is at the
       * bottom of the hole and standing on it is standing in a pitch-dark room with
       * a ceiling. Which is a memorable first ten seconds of a game and not in a good
       * way. Full daylight overhead is the whole test, and it costs one array read.
       */
      if (skyLight(x, y, z) < 15) continue;
      return { x: x + 0.5, y, z: z + 0.5 };
    }
  }
  return { x: cx, y: WORLD_Y - 2, z: cz };
}

/** The first empty y above the ground in a column — where a body would stand. */
export function surfaceY(x: number, z: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    const b = getBlock(x, y, z);
    if (BLOCKS[b].solid || BLOCKS[b].liquid) return y + 1;
  }
  return 1;
}
