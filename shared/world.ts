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
// Health, and the fact that NOTHING HERE KILLS YOU
//
// Run out of pips and you are knocked flat for a couple of seconds and then get up,
// full, exactly where you fell. You are never removed from the world, never
// teleported, and never lose your place. A fight is something that happens to you
// rather than something that ends you, and the only thing at stake is standing back
// up. There is no death in this file and no respawn-on-death anywhere in the server.

/** Ten pips, because the bar shows ten pips. */
export const MAX_HP = 10;
/** How long you spend on the ground after the last pip goes. */
export const KNOCKDOWN_MS = 2400;
/** One berry, in pips. */
export const BERRY_HEAL = 3;

/*
 * The two ways to hit somebody, and they are deliberately not the same weapon.
 *
 * A thrown pebble takes ONE pip. It reaches across a clearing, but a whole bar is
 * ten of them and you can only carry six, so it is a way of BOTHERING somebody at
 * distance rather than a way of finishing them. Getting close takes three. The fight
 * anybody actually wins is the one they walked into, and the stones are for making
 * that walk expensive.
 */
export const PEBBLE_DAMAGE = 1;
export const MELEE_DAMAGE = 3;
/** How far a swing reaches from the middle of you, and how wide it is in front. */
export const MELEE_RANGE = 15;
export const MELEE_ARC = (110 * Math.PI) / 180;
/** Seconds between swings, and between throws. */
export const MELEE_COOLDOWN = 0.55;
export const THROW_COOLDOWN = 0.35;
/** How long a swing stays drawn, so everybody sees it land. */
export const SWING_MS = 220;

// ---------------------------------------------------------------------------
// Terrain

export const GRASS = 0;
export const SAND = 1;
export const WATER = 2;
export type Terrain = 0 | 1 | 2;

/**
 * How fast you move over each kind of ground.
 *
 * Water does not hurt anybody — it just takes forever. At an eighth of walking pace
 * a lake you could stroll across in two seconds is a fifteen-second slog, which is
 * its own deterrent and a much better one than damage: wading is a bad idea you can
 * change your mind about halfway through, from either direction.
 */
export const SPEED_OF: Record<Terrain, number> = { 0: 1, 1: 0.88, 2: 0.13 };

/**
 * How close two people can stand. Just under a body's width, so they touch and stop
 * rather than sliding a visible gap apart.
 */
export const PLAYER_R = 9;

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
 * The middle of the map is lifted, because everybody spawns there. Nothing here can
 * hurt you, but arriving in the middle of a lake still means the first ten seconds
 * of the game are spent wading out of one at a tenth of walking pace.
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
      if (hash(tx + 7919, ty + 104729) > (want - 0.42) * 1.0) continue;
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
// Things lying on the ground
//
// Generated the same way the trees are — a pure function of where you are, never
// sent. What IS sent is which of them have been picked up, which is a short list of
// indices rather than the whole world's worth of positions every tick.

export const BERRY = 0;
export const PEBBLE = 1;
export type ItemKind = 0 | 1;

export interface Item {
  x: number;
  y: number;
  kind: ItemKind;
}

/** Walk this close and it is yours. Generous — nobody should have to aim to pick up. */
export const PICKUP_R = 9;
/** How long before a picked spot grows back. */
export const REGROW_MS = 18_000;
/** Pebbles you can carry at once. */
export const MAX_CARRY = 6;

let itemCache: Item[] | null = null;

/**
 * Berries and pebbles, everywhere they belong.
 *
 * Berries want shade, so they grow near trees; pebbles want a shore, so they lie on
 * the sand. That is not decoration — it means the two things you need come from two
 * different places, and going to get one is a walk somewhere rather than a lap of
 * wherever you already are.
 */
export function items(): readonly Item[] {
  if (itemCache) return itemCache;
  build();
  const out: Item[] = [];
  for (let ty = 1; ty < WORLD_H - 1; ty++) {
    for (let tx = 1; tx < WORLD_W - 1; tx++) {
      const kind = terrainCache![ty * WORLD_W + tx];
      const h = hash(tx + 5772, ty + 90001);
      const x = tx * TILE + 4 + hash(tx + 1223, ty + 77) * 8;
      const y = ty * TILE + 4 + hash(tx + 88, ty + 4441) * 8;
      if (kind === GRASS) {
        // Under the canopy: a tile is berry country if it has a tree beside it.
        let shade = false;
        for (let ny = ty - 1; ny <= ty + 1 && !shade; ny++) {
          for (let nx = tx - 1; nx <= tx + 1; nx++) {
            if (treeOn(nx, ny)) {
              shade = true;
              break;
            }
          }
        }
        if (!shade || h > 0.16) continue;
        out.push({ x, y, kind: BERRY });
        continue;
      }
      if (kind !== SAND || h > 0.28) continue;
      out.push({ x, y, kind: PEBBLE });
    }
  }
  // Never inside a trunk, where nobody could reach it.
  itemCache = out.map((it) => ({ ...it, ...pushOutOfTrees(it.x, it.y) }));
  return itemCache;
}

// ---------------------------------------------------------------------------
// Thrown pebbles

/** Pixels per second, and how far one carries before it drops. */
export const PEBBLE_SPEED = 210;
export const PEBBLE_RANGE = 190;
/** How close a stone has to pass to count as a hit. */
export const PEBBLE_HIT_R = 8;

export interface Stone {
  id: number;
  /** Who threw it, so it cannot hit them in the back of the head on the way out. */
  by: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pixels still to travel. */
  left: number;
}

/**
 * Fly one stone for `dt`. Returns false once it is spent — out of range, in a tree,
 * or off the edge of the world.
 *
 * It does NOT check people; the server does that, because who got hit is the one
 * part of this that has to be decided in exactly one place.
 */
export function stepStone(s: Stone, dt: number): boolean {
  const step = Math.hypot(s.vx, s.vy) * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.left -= step;
  if (s.left <= 0) return false;
  if (s.x < 0 || s.y < 0 || s.x >= WORLD_PX_W || s.y >= WORLD_PX_H) return false;
  // Trees stop stones. A forest is cover, which is the only reason to stand in one.
  const tx = Math.floor(s.x / TILE);
  const ty = Math.floor(s.y / TILE);
  for (let ny = ty - 1; ny <= ty + 1; ny++) {
    for (let nx = tx - 1; nx <= tx + 1; nx++) {
      const tree = treeOn(nx, ny);
      if (tree && Math.hypot(s.x - tree.x, s.y - tree.y) < TREE_R) return false;
    }
  }
  return true;
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
   * Pips of health, 0..MAX_HP. Only ever written by the server — the client draws
   * what it is told rather than predicting it. Being briefly wrong about a position
   * is invisible; being briefly wrong about who just got hit is not.
   */
  hp: number;
  /** Pebbles in hand. */
  pebbles: number;
  /**
   * Seconds left flat on your back. Above zero you cannot walk, swing, throw or be
   * hit — the last one on purpose, so somebody standing over you cannot keep you
   * there while you are getting up.
   */
  down: number;
  /** Seconds left of a swing, for drawing it. Everybody sees everybody's. */
  swing: number;
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
 * Push a position out of anybody standing in it.
 *
 * Bodies are solid, but only ON THE GROUND: two people in the air pass through each
 * other, and so does somebody jumping over somebody standing. A jump that could be
 * blocked by a head would be a jump that gets you wedged, and being able to hop over
 * a person who is blocking a gap is worth far more than the realism of not.
 *
 * Only the mover is pushed. The other party runs its own step on its own tick and
 * gets pushed the other way, which is what makes two people meeting separate
 * evenly rather than one of them bulldozing the other.
 */
export function pushOutOfPlayers(
  x: number,
  y: number,
  z: number,
  others: readonly { x: number; y: number; z: number; down: number }[],
): { x: number; y: number } {
  if (z > 0) return { x, y };
  for (const o of others) {
    if (o.z > 0 || o.down > 0) continue; // in the air, or flat on the ground
    const dx = x - o.x;
    const dy = y - o.y;
    const d = Math.hypot(dx, dy);
    if (d >= PLAYER_R) continue;
    if (d < 0.0001) {
      x = o.x + PLAYER_R;
    } else {
      x = o.x + (dx / d) * PLAYER_R;
      y = o.y + (dy / d) * PLAYER_R;
    }
  }
  return { x, y };
}

/**
 * Move one step. The ONE place walking is defined, called by the server to advance
 * the world and by the client to predict its own next position.
 *
 * Diagonals are normalised — without it, holding two keys is 1.41x faster than one,
 * which players find immediately and then never walk in a straight line again.
 *
 * `others` is everybody else's body. The server passes the live ones and the client
 * passes the interpolated ones, so the client's guess is a tenth of a second stale —
 * which is exactly what reconciliation is for and is invisible at walking pace.
 */
export function step(
  p: { x: number; y: number; dir: Dir; moving: boolean; z: number; vz: number },
  inx: number,
  iny: number,
  dt: number,
  jump = false,
  others: readonly { x: number; y: number; z: number; down: number }[] = [],
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
  // People second, then trees again: being shoved out of somebody can put you in a
  // trunk, and of the two the tree is the one that must win — a person you overlap
  // slightly is a scuffle, a person inside a tree is stuck.
  const apart = pushOutOfPlayers(clear.x, clear.y, p.z, others);
  const free = pushOutOfTrees(apart.x, apart.y);
  const settled = clampToWorld(free.x, free.y);
  p.x = settled.x;
  p.y = settled.y;
  p.moving = true;
  // Face whichever axis you are pushing hardest, so a diagonal still has one face.
  if (Math.abs(nx) > Math.abs(ny)) p.dir = nx > 0 ? 'right' : 'left';
  else p.dir = ny > 0 ? 'down' : 'up';
}

/**
 * Take a hit. Server-side only.
 *
 * At zero the player goes DOWN rather than away: `down` counts off the seconds they
 * spend flat, and `getUp` puts them back on their feet with a full bar exactly where
 * they fell. There is no respawn and no teleport, because losing your place is the
 * part of dying that actually costs you something and none of this is worth that.
 */
export function hurt(p: { hp: number; down: number }, amount: number): boolean {
  if (p.down > 0) return false; // already flat; you cannot be kept there
  p.hp = Math.max(0, p.hp - amount);
  if (p.hp > 0) return false;
  p.down = KNOCKDOWN_MS / 1000;
  return true;
}

/** Count off the knockdown and the swing, and stand them back up when it runs out. */
export function stepTimers(p: { hp: number; down: number; swing: number; moving: boolean }, dt: number): void {
  if (p.swing > 0) p.swing = Math.max(0, p.swing - dt);
  if (p.down <= 0) return;
  p.down = Math.max(0, p.down - dt);
  p.moving = false;
  if (p.down === 0) p.hp = MAX_HP;
}

/**
 * Is `target` inside a swing thrown from `from` along `aim`?
 *
 * A cone rather than a circle, so where you are facing decides what you connect
 * with — otherwise a swing is an area attack and standing behind somebody is worth
 * nothing.
 */
export function inSwing(
  from: { x: number; y: number },
  aim: number,
  target: { x: number; y: number; z: number; down: number },
): boolean {
  if (target.down > 0) return false;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d > MELEE_RANGE + BODY_W / 2) return false;
  // Point blank counts whatever way you are facing; there is no behind at zero.
  if (d < 1) return true;
  // Airborne is out of reach in one direction only: a swing is at chest height, so
  // somebody at the top of a jump is over it.
  if (target.z > BODY_H) return false;
  const delta = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - aim), Math.cos(Math.atan2(dy, dx) - aim)));
  return delta <= MELEE_ARC / 2;
}

/** Eat one. Returns false if there was nothing to mend, so the berry stays put. */
export function eat(p: { hp: number }): boolean {
  if (p.hp >= MAX_HP) return false;
  p.hp = Math.min(MAX_HP, p.hp + BERRY_HEAL);
  return true;
}

/** A dry, tree-free spot near the middle of the map to arrive at. */
export function spawnPoint(rand: number): { x: number; y: number } {
  const a = rand * Math.PI * 2;
  const r = 8 + ((rand * 37) % 30);
  return clampToWorld(WORLD_PX_W / 2 + Math.cos(a) * r, WORLD_PX_H / 2 + Math.sin(a) * r);
}
