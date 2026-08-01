/**
 * BLOONS WORLD — wire protocol.
 *
 * JSON over one WebSocket. Two rules, both borrowed from BLOOM because they earned
 * it there:
 *
 * 1. The client sends INTENT, never position. It says "I am pushing north-east";
 *    the server decides where that puts you. A client that could post its own
 *    coordinates could stand anywhere it liked.
 * 2. The server ships the whole player list every tick. There are tens of players,
 *    not thousands, so a delta protocol would be optimising the wrong thing and
 *    buying desync bugs with the savings.
 */

import type { Player, Stone } from './world.js';

export type ClientMsg =
  /** First message on the socket. Nothing else is accepted before it. */
  | { t: 'hello'; name: string; version: string }
  /**
   * The input vector, roughly INPUT_RATE times a second. Components are clamped to
   * [-1, 1] server-side; a hostile client cannot walk faster by sending 9.
   */
  | { t: 'input'; x: number; y: number; jump?: boolean }
  /**
   * Swing, or throw a stone, along the bearing `a` in radians.
   *
   * The AIM is on the wire because the four-way facing is not enough to point with —
   * from eye level you are looking wherever the mouse put you, and that direction
   * lives only on your machine. Everything else about the attack is decided by the
   * server: whether the cooldown has passed, whether there is a stone left, who was
   * standing in it, and what it cost them. All the client gets to say is "that way".
   */
  | { t: 'hit'; a: number }
  | { t: 'throw'; a: number }
  /** Change your name mid-session. The tag over your head updates for everyone. */
  | { t: 'rename'; name: string }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  | { t: 'welcome'; id: string; version: string }
  | { t: 'error'; code: string; message: string }
  /**
   * The whole world, every tick: everybody, every stone in the air, and `gone` —
   * the indices of the berries and pebbles currently picked. The items themselves
   * are generated from shared code, so what travels is a handful of numbers rather
   * than three hundred positions twenty times a second.
   */
  | { t: 'state'; tick: number; players: Player[]; stones: Stone[]; gone: number[] }
  | { t: 'pong'; ts: number };

/**
 * Bumped for fighting: players carry stones and can be knocked down, and there are
 * stones in the air. The map is NOT in this number — terrain, trees and where the
 * berries grow are generated from shared code rather than sent, so they cannot be
 * stale and cannot disagree.
 */
export const PROTOCOL_VERSION = 'world-3.0.0';

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
