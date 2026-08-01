/**
 * BLOONS WORLD — the shared rules of the place.
 *
 * Everything in here is imported by BOTH the server and the client, because the
 * client predicts its own movement locally and the server integrates the same
 * numbers authoritatively. If the two ever disagree about how fast a person walks,
 * every player rubber-bands. One file, one answer.
 *
 * That now includes the LAND. The map is not data and is never sent: it is a pure
 * function of tile coordinates, so the server and every client generate the same
 * lakes and the same forests from nothing but the code they are already running.
 * A 64x64 map would be a small download, but it would also be a thing that can be
 * out of date, and terrain that disagrees is terrain you walk through on one screen
 * and bump into on another.
 */

/** Pixels per world tile. The art is drawn at this scale and never smoothed. */
export const TILE = 16;

/** World size in tiles. Small enough to run into each other, big enough to wander. */
export const WORLD_W = 64;
export const WORLD_H = 64;

export const WORLD_PX_W = WORLD_W * TILE;
export const WORLD_PX_H = WORLD_H * TILE;

/** Walking speed, pixels per second. */
export const WALK_SPEED = 78;

/**
 * Jumping. Up at JUMP_SPEED, pulled back down at GRAVITY.
 *
 * Tuned together rather than separately: peak height is v^2/2g and airtime is 2v/g,
 * so these two numbers mean "about 23 pixels up, in about six-tenths of a second" —
 * roughly twice a person's own height, and slow enough to see at the top.
 *
 * You keep full control of your feet in the air. A jump you cannot steer reads as a
 * stumble rather than a hop.
 */
export const JUMP_SPEED = 150;
export const GRAVITY = 480;

/** How wide a person is, for keeping them inside the world. */
export const BODY_W = 10;
export const BODY_H = 12;

/** Authoritative ticks per second, and how often the client posts its input. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const INPUT_RATE = 20;

/**
 * How far behind the newest snapshot remote players are drawn.
 *
 * Rendering other people at the very latest position means stuttering every time a
 * packet is late. Holding them one tick in the past means there is always a pair of
 * snapshots to interpolate between, and the cost is 50ms of lag on somebody else's
 * position — which nobody can perceive and everybody prefers to jitter.
 */
export const INTERP_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Health

/** Ten pips, because the bar shows ten pips. */
export const MAX_HP = 10;
/** Pips per second lost standing in deep water, and gained back on dry land. */
export const DROWN_RATE = 1.5;
export const HEAL_RATE = 0.7;
/** Dry land heals, but not the instant you climb out of the lake. */
export const HEAL_DELAY_MS = 1400;

// ---------------------------------------------------------------------------
// Terrain

export const GRASS = 0;
export const SAND = 1;
export const WATER = 2;
export type Terrain = 0 | 1 | 2;

/**
 * How fast you move over each kind of ground, and whether it hurts.
 *
 * Water is the only thing in the world that can hurt you, which is the whole reason
 * the health bar means anything: a bar that can never go down is decoration. It is
 * deliberately survivable — six seconds of swimming to lose it all, and you can
 * always turn around — so a lake is a decision rather than a wall.
 */
export const SPEED_OF: Record<Terrain, number> = { 0: 1, 1: 0.88, 2: 0.42 };

/** Trunk radius. Wide enough to be a real obstacle, narrow enough to slip between. */
export const TREE_R = 5;

/**
 * How far apart two trunks must stand. Slightly more than two bodies' worth of
 * clearance, so there is always a position that satisfies every tree at once —
 * see the note where it is enforced.
 */
export const MIN_TREE_GAP = 2 * (TREE_R + BODY_W / 2 - 1) + 0.5;

export interface Tree {
  /** Pixel position of the base of the trunk. */
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** 0..1, so no two trees in a stand are quite the same size. */
  vary: number;
}

/**
 * A 32-bit integer hash. `Math.imul` rather than `*` on purpose: plain
 * multiplication of two 32-bit numbers overflows past what a double holds exactly,
 * and terrain that depends on rounding is terrain that could differ between two
 * machines. This stays exact 32-bit arithmetic everywhere.
 */
function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise: a lattice of hashes with a smooth ramp between them. */
function noise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
  const bot = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
  return top + (bot - top) * fy;
}

/**
 * Ground height, 0..1ish. Two octaves: the coarse one decides where the lakes are,
 * the fine one keeps their shorelines from being smooth blobs.
 *
 * The middle of the map is lifted, because everybody spawns there. Arriving in a
 * lake, drowning, and respawning in the same lake is the one terrain outcome that
 * is not a story about exploring.
 */
function elevation(tx: number, ty: number): number {
  const base = noise(tx / 13, ty / 13) * 0.68 + noise(tx / 5.5, ty / 5.5) * 0.32;
  const d = Math.hypot(tx - WORLD_W / 2, ty - WORLD_H / 2);
  return base + Math.max(0, 1 - d / 8) * 0.4;
}

let terrainCache: Uint8Array | null = null;
let treeCache: Tree[] | null = null;
let treeAtTile: Int32Array | null = null;

function build(): void {
  if (terrainCache) return;
  const t = new Uint8Array(WORLD_W * WORLD_H);
  for (let ty = 0; ty < WORLD_H; ty++) {
    for (let tx = 0; tx < WORLD_W; tx++) {
      const e = elevation(tx, ty);
      t[ty * WORLD_W + tx] = e < 0.3 ? WATER : e < 0.36 ? SAND : GRASS;
    }
  }
  terrainCache = t;

  /*
   * Trees, in stands rather than sprinkled evenly. A second noise field decides
   * where a forest wants to be and a per-tile hash decides which tiles in it
   * actually grow one, so the map has clearings and thickets instead of an orchard.
   */
  const list: Tree[] = [];
  const index = new Int32Array(WORLD_W * WORLD_H).fill(-1);
  for (let ty = 1; ty < WORLD_H - 1; ty++) {
    for (let tx = 1; tx < WORLD_W - 1; tx++) {
      if (t[ty * WORLD_W + tx] !== GRASS) continue;
      // Keep the spawn clearing clear — you should be able to see who else is here.
      if (Math.hypot(tx - WORLD_W / 2, ty - WORLD_H / 2) < 5) continue;
      const want = noise(tx / 8 + 91, ty / 8 + 57);
      if (hash(tx + 7919, ty + 104729) > (want - 0.42) * 4.0) continue;
      const h1 = hash(tx + 31337, ty + 7777);
      const h2 = hash(tx + 999983, ty + 24593);
      const x = tx * TILE + 3 + h1 * 10;
      const y = ty * TILE + 3 + h2 * 10;
      /*
       * No two trunks closer than this.
       *
       * Trees are placed anywhere within their tile, so two in neighbouring tiles
       * can land six pixels apart — and then their no-walk circles overlap so hard
       * that a body squeezed between them cannot satisfy both, and `pushOutOfTrees`
       * spends its passes shoving it back and forth. Thinning those pairs out at
       * GENERATION is the fix; trying to solve an impossible position at run time is
       * not. It costs a handful of trees out of seven hundred.
       */
      let crowded = false;
      for (let ny = ty - 1; ny <= ty && !crowded; ny++) {
        for (let nx = tx - 1; nx <= tx + 1; nx++) {
          const j = ny * WORLD_W + nx;
          if (j < 0 || j >= index.length || index[j] < 0) continue;
          const other = list[index[j]];
          if (Math.hypot(other.x - x, other.y - y) < MIN_TREE_GAP) {
            crowded = true;
            break;
          }
        }
      }
      if (crowded) continue;
      index[ty * WORLD_W + tx] = list.length;
      list.push({ x, y, tx, ty, vary: hash(tx + 60013, ty + 15485863) });
    }
  }
  // Sorted by y once, so the top-down view can draw them back-to-front without
  // sorting four thousand tiles every frame.
  list.sort((a, b) => a.y - b.y);
  for (let i = 0; i < list.length; i++) index[list[i].ty * WORLD_W + list[i].tx] = i;
  treeCache = list;
  treeAtTile = index;
}

/** The whole terrain grid, one byte per tile. Built once, on first use. */
export function terrainGrid(): Uint8Array {
  build();
  return terrainCache!;
}

/** Every tree in the world, sorted by y. Built once, on first use. */
export function trees(): readonly Tree[] {
  build();
  return treeCache!;
}

/** The tree on a tile, or null. */
export function treeOn(tx: number, ty: number): Tree | null {
  build();
  if (tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H) return null;
  const i = treeAtTile![ty * WORLD_W + tx];
  return i < 0 ? null : treeCache![i];
}

/** What kind of ground is under a world-pixel position. */
export function terrainAt(x: number, y: number): Terrain {
  build();
  const tx = Math.min(WORLD_W - 1, Math.max(0, Math.floor(x / TILE)));
  const ty = Math.min(WORLD_H - 1, Math.max(0, Math.floor(y / TILE)));
  return terrainCache![ty * WORLD_W + tx] as Terrain;
}

// ---------------------------------------------------------------------------
// People

export type Dir = 'down' | 'up' | 'left' | 'right';

export interface Player {
  id: string;
  name: string;
  /** Pixel position of the player's feet, in world space. */
  x: number;
  y: number;
  dir: Dir;
  /** True while they are actually moving, which is what drives the walk cycle. */
  moving: boolean;
  /**
   * Height above the ground in pixels. The FEET stay at (x, y) whatever this is —
   * a jump lifts the drawing, not the position, so the shadow and everyone's sense
   * of where you are standing stay honest.
   */
  z: number;
  /** Vertical speed, pixels per second. Positive is upward. */
  vz: number;
  /** Chosen at join and never changed, so everyone renders you the same colour. */
  hue: number;
  /**
   * Pips of health, 0..MAX_HP. Fractional between pips, and only ever written by
   * the server — the client draws what it is told rather than predicting it. Being
   * briefly wrong about a position is invisible; being briefly wrong about whether
   * somebody drowned is not.
   */
  hp: number;
}

/** Clamp a position to the walkable world. */
export function clampToWorld(x: number, y: number): { x: number; y: number } {
  const halfW = BODY_W / 2;
  return {
    x: Math.min(WORLD_PX_W - halfW, Math.max(halfW, x)),
    y: Math.min(WORLD_PX_H - 1, Math.max(BODY_H, y)),
  };
}

/**
 * Push a position out of any tree it has ended up inside.
 *
 * Only the nine tiles around the point are checked, which is every tree that could
 * possibly reach: a trunk is five pixels and a tile is sixteen.
 *
 * Several passes, because coming out of one trunk can put you inside the next, and
 * the second push has to see where the first one left you. It converges rather than
 * oscillating only because `MIN_TREE_GAP` guarantees an answer exists — with trunks
 * closer than two bodies there is no position that satisfies both and no number of
 * passes would find one. It stops early the moment a pass moves nothing, which is
 * almost every step, since almost every step is in the open.
 */
export function pushOutOfTrees(x: number, y: number): { x: number; y: number } {
  const reach = TREE_R + BODY_W / 2 - 1;
  for (let pass = 0; pass < 4; pass++) {
    const tx0 = Math.floor((x - reach) / TILE);
    const tx1 = Math.floor((x + reach) / TILE);
    const ty0 = Math.floor((y - reach) / TILE);
    const ty1 = Math.floor((y + reach) / TILE);
    let moved = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tree = treeOn(tx, ty);
        if (!tree) continue;
        const dx = x - tree.x;
        const dy = y - tree.y;
        const d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        if (d < 0.0001) {
          // Dead centre, so there is no direction to be pushed. Any one will do.
          x = tree.x + reach;
        } else {
          x = tree.x + (dx / d) * reach;
          y = tree.y + (dy / d) * reach;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, y };
}

/**
 * Move one step. The ONE place walking is defined, called by the server to advance
 * the world and by the client to predict its own next position.
 *
 * Diagonals are normalised — without it, holding two keys is 1.41x faster than one,
 * which players find immediately and then never walk in a straight line again.
 */
export function step(
  p: { x: number; y: number; dir: Dir; moving: boolean; z: number; vz: number },
  inx: number,
  iny: number,
  dt: number,
  jump = false,
): void {
  /*
   * Jump first, and only from the ground — holding the key must not let you climb.
   * `z <= 0` is the whole grounded test; there is nothing to stand on but the floor.
   */
  if (jump && p.z <= 0) p.vz = JUMP_SPEED;
  const airborne = p.z > 0 || p.vz !== 0;
  if (airborne) {
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;
    if (p.z <= 0) {
      p.z = 0;
      p.vz = 0;
    }
  }

  const len = Math.hypot(inx, iny);
  if (len < 0.01) {
    p.moving = false;
    return;
  }
  const nx = inx / len;
  const ny = iny / len;
  /*
   * Ground slows you down; air does not. Wading through a lake is meant to be a
   * decision, but a jump is over the water rather than in it — which is also what
   * makes a narrow inlet something you can clear instead of something you swim.
   */
  const speed = WALK_SPEED * (p.z > 0 ? 1 : SPEED_OF[terrainAt(p.x, p.y)]);
  const next = clampToWorld(p.x + nx * speed * dt, p.y + ny * speed * dt);
  // Trees stop you at any height. They are taller than you can jump, and a canopy
  // you can hop through would make every forest a lie.
  const clear = pushOutOfTrees(next.x, next.y);
  const settled = clampToWorld(clear.x, clear.y);
  p.x = settled.x;
  p.y = settled.y;
  p.moving = true;
  // Face whichever axis you are pushing hardest, so a diagonal still has one face.
  if (Math.abs(nx) > Math.abs(ny)) p.dir = nx > 0 ? 'right' : 'left';
  else p.dir = ny > 0 ? 'down' : 'up';
}

/**
 * Advance one player's health by `dt` seconds. Server-side only.
 *
 * Returns true if they just ran out, which is the caller's cue to put them back at
 * the spawn clearing — drowning has to move you somewhere dry, or you drown again
 * on the next tick forever.
 */
export function stepHealth(
  p: { x: number; y: number; z: number; hp: number },
  dt: number,
  msSinceWet: number,
): boolean {
  if (p.z <= 0 && terrainAt(p.x, p.y) === WATER) {
    p.hp = Math.max(0, p.hp - DROWN_RATE * dt);
    return p.hp <= 0;
  }
  // A pause before healing, so wading in and straight back out is not free.
  if (msSinceWet >= HEAL_DELAY_MS) p.hp = Math.min(MAX_HP, p.hp + HEAL_RATE * dt);
  return false;
}

/** A dry, tree-free spot near the middle of the map to arrive at. */
export function spawnPoint(rand: number): { x: number; y: number } {
  const a = rand * Math.PI * 2;
  const r = 8 + (rand * 37) % 30;
  return clampToWorld(WORLD_PX_W / 2 + Math.cos(a) * r, WORLD_PX_H / 2 + Math.sin(a) * r);
}
