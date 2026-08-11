/**
 * BLOONS WORLD — the animals.
 *
 * The world has two other kinds of thing in it: blocks, which never move, and
 * players, which are driven by somebody at a keyboard. These are the third — a body
 * the server moves on its own — and it is the same body a player has, deliberately:
 * the same box, the same gravity, the same step-up onto a slab, the same refusal to
 * walk through a wall.
 *
 * That sharing is the whole design. An animal with its own movement code would
 * eventually be an animal that walks through a fence you built, and you would only
 * find out from somebody who lost their livestock to it.
 *
 * Nothing here is hostile. There was a whole night-time siege built on top of this
 * file — hordes, nests, mutation — and it is gone; what is left is the part that
 * makes the island feel inhabited rather than the part that made it dangerous.
 */

export const PIG = 0;
export const COW = 1;
export const CHICKEN = 2;

export type MobKind = 0 | 1 | 2;

export interface MobStats {
  kind: MobKind;
  name: string;
  /** Box, in blocks. Animals use the same AABB rules a player does. */
  width: number;
  height: number;
  hp: number;
  speed: number;
  /** How far it notices you, for backing away. */
  sight: number;
  /** What it leaves behind. */
  drop: { thing: number; count: number } | null;
}

export const MOBS: Record<number, MobStats> = {
  [PIG]: { kind: PIG, name: 'pig', width: 0.8, height: 0.9, hp: 10, speed: 2.1, sight: 12, drop: { thing: 0, count: 2 } },
  [COW]: { kind: COW, name: 'cow', width: 0.9, height: 1.3, hp: 14, speed: 1.9, sight: 12, drop: { thing: 0, count: 3 } },
  [CHICKEN]: { kind: CHICKEN, name: 'chicken', width: 0.4, height: 0.7, hp: 5, speed: 1.6, sight: 10, drop: { thing: 0, count: 1 } },
};

export function mobStats(kind: number): MobStats {
  return MOBS[kind] ?? MOBS[PIG];
}

/**
 * What each animal leaves, filled in from `items.ts` at load.
 *
 * Late-bound because this file cannot import `items.ts` — items import blocks, blocks
 * are imported by the world, and the world is imported by the code that moves these
 * around. One assignment breaks the cycle without either module having to know about
 * the other's ids.
 */
export function setMeat(thing: number): void {
  for (const k of [PIG, COW, CHICKEN]) {
    const d = MOBS[k].drop;
    if (d) d.thing = thing;
  }
}

/** What an animal is doing, so the client can animate it without being told how. */
export const IDLE = 0;
export const WALK = 1;
/** Backing away from somebody who just hit it. */
export const FLEE = 2;

/** One live creature, exactly as it goes on the wire. */
export interface Mob {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: number;
}
