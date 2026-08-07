/**
 * BLOONS WORLD — wire protocol.
 *
 * JSON over one WebSocket. Three rules:
 *
 * 1. The client sends INTENT, never position. It says "I am pushing forward and
 *    looking north-east"; the server decides where that puts you. A client that
 *    could post its own coordinates could stand anywhere it liked, including inside
 *    the rock.
 * 2. The server ships the whole player list every tick. There are tens of players,
 *    not thousands, so a delta protocol would be optimising the wrong thing and
 *    buying desync bugs with the savings.
 * 3. The MAP IS NEVER SENT. It is generated from shared code on both ends. What
 *    travels is the list of blocks somebody has changed since the server started —
 *    a few thousand numbers instead of a million, and the only part of the world
 *    that could not have been worked out from first principles.
 */

import type { Player } from './world.js';

export type ClientMsg =
  /** First message on the socket. Nothing else is accepted before it. */
  | { t: 'hello'; name: string; version: string }
  /**
   * Where you want to go and where you are looking, roughly INPUT_RATE times a
   * second. `f` and `s` are forward and rightward in [-1, 1] and are clamped
   * server-side; a hostile client cannot walk faster by sending 9.
   *
   * The AIM is on the wire because movement is relative to it — "forward" means
   * nothing until you know which way the head is pointed — and because everybody
   * else needs to see which way you are facing.
   */
  | { t: 'input'; f: number; s: number; yaw: number; pitch: number; jump?: boolean; sprint?: boolean }
  /**
   * Dig a block out (`b` is 0) or put one down.
   *
   * The client decides WHEN, because it is the thing holding the mouse button and
   * counting; the server decides IF. It checks that you were close enough, that you
   * were holding one of those, and that you did not finish a five-second block in
   * half a second. Everything a client is allowed to assert here is a coordinate.
   */
  | { t: 'edit'; x: number; y: number; z: number; b: number }
  /** Turn some of what you are carrying into something else. Index into RECIPES. */
  | { t: 'craft'; r: number }
  /** Change your name mid-session. The tag over your head updates for everyone. */
  | { t: 'rename'; name: string }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  /**
   * You are in. `edits` is how many changed blocks are about to arrive, so the
   * loading bar on the title screen can be a real fraction rather than a spinner.
   */
  | { t: 'welcome'; id: string; version: string; edits: number }
  /**
   * A slice of the world's changes, as a flat `[index, block, index, block, …]`.
   *
   * Flat rather than an array of objects because at ten thousand edits the difference
   * between `[8123456,4]` and `{"i":8123456,"b":4}` is a factor of three on the wire,
   * and this is the one message that is ever big.
   */
  | { t: 'edits'; d: number[]; sync?: boolean }
  /** Every edit has landed; the world you have is the world the server has. */
  | { t: 'ready' }
  | { t: 'error'; code: string; message: string }
  /** Everybody, every tick, plus where the sun is. `day` is 0..1 across a whole day. */
  | { t: 'state'; tick: number; day: number; players: Player[] }
  /**
   * What YOU are carrying, as a flat `[block, count, …]`. Sent only to you and only
   * when it changes — everybody else's pockets are nobody's business and would be
   * three quarters of the bandwidth if they were.
   */
  | { t: 'inv'; d: number[] }
  | { t: 'pong'; ts: number };

/**
 * A voxel world is not the game this used to be, so this is a new number rather than
 * a bump. Terrain, caves, ore and trees are NOT in it — they are generated from
 * shared code rather than sent, so they cannot be stale and cannot disagree. What
 * this version covers is the shape of the messages and the meaning of a block id.
 */
export const PROTOCOL_VERSION = 'blocks-1.0.0';

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T extends ClientMsg | ServerMsg>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null && typeof v.t === 'string' ? (v as T) : null;
  } catch {
    return null;
  }
}
