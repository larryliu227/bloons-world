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
import type { Mob } from './mobs.js';

export type ClientMsg =
  /**
   * First message on the socket. Nothing else is accepted before it.
   *
   * `token` is a long random string the browser made up the first time it ran and
   * has kept in local storage ever since. It is how the server recognises somebody
   * coming back: what they were carrying, how hurt they were and where they were
   * standing are all filed under it. It is a bearer credential and nothing more —
   * anybody holding it is you — which is the right amount of security for a world
   * where the worst thing that can happen is somebody spends your cobble.
   */
  | { t: 'hello'; name: string; version: string; token?: string }
  /**
   * Where you want to go and where you are looking, roughly INPUT_RATE times a
   * second. `f` and `s` are forward and rightward in [-1, 1] and are clamped
   * server-side; a hostile client cannot walk faster by sending 9.
   *
   * The AIM is on the wire because movement is relative to it — "forward" means
   * nothing until you know which way the head is pointed — and because everybody
   * else needs to see which way you are facing.
   */
  | {
      t: 'input';
      f: number;
      s: number;
      yaw: number;
      pitch: number;
      jump?: boolean;
      sprint?: boolean;
      /**
       * The thing in the selected hotbar slot.
       *
       * On the wire because the server has to know what is in your hand before it can
       * decide whether you may dig that block at all, how long it should take, and
       * what to blunt afterwards. It is a CLAIM and is checked against your pockets
       * before it is believed — the hotbar is a client-side arrangement, but what is
       * in it is not.
       */
      held?: number;
    }
  /**
   * Dig a block out (`b` is 0) or put one down.
   *
   * The client decides WHEN, because it is the thing holding the mouse button and
   * counting; the server decides IF. It checks that you were close enough, that you
   * were holding one of those, and that you did not finish a five-second block in
   * half a second. Everything a client is allowed to assert here is a coordinate.
   */
  | {
      t: 'edit';
      x: number;
      y: number;
      z: number;
      b: number;
      /**
       * Which face was clicked, as a unit normal. Only meaningful for placing.
       *
       * On the wire because some blocks care which way round they go and the server
       * cannot work it out afterwards: a ladder hangs on the wall you pointed at, and
       * from a position alone there is no way to tell which of the four that was.
       */
      nx?: number;
      ny?: number;
      nz?: number;
    }
  /** Make one straight from the pockets, without laying it out. Index into RECIPES. */
  | { t: 'craft'; r: number }
  /**
   * A click in the inventory window: which slot, and which button.
   *
   * That is ALL the client says. What the click did — pick up, put down, split,
   * swap, merge, craft — is worked out by the server against its own copy of the
   * slots, because a client that decided its own moves could put a diamond in an
   * empty slot and keep the one it came from.
   */
  | { t: 'click'; slot: number; right?: boolean; shift?: boolean }
  /** The window closed: tip the crafting grid and the cursor back into the pockets. */
  | { t: 'closepack' }
  /** Eat whatever is in the selected slot. */
  | { t: 'eat'; b: number }
  /**
   * Fire what you are holding, along the bearing you are looking.
   *
   * The AIM is all the client gets to say. Whether the gun was loaded, whether the
   * reload had finished, what the ball hit and what it cost them are every one of
   * them the server's — a client that could report its own hits could report all of
   * them, and a health bar that flickered on a mispredicted shot would be worse than
   * one that answers a round trip late.
   */
  | { t: 'fire'; yaw: number; pitch: number }
  /** Swing at whatever is in front of you. Same deal: the aim, and nothing else. */
  | { t: 'melee'; yaw: number; pitch: number }
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
  | {
      t: 'state';
      tick: number;
      day: number;
      players: Player[];
      /** Every creature alive, same as the players: whole list, every tick. */
      mobs: Mob[];
    }
  /**
   * What YOU are carrying: forty-six slots as a flat `[thing, count, …]`, with zeros
   * for empty, plus whatever the cursor is holding.
   *
   * Sent WHOLE every time anything changes rather than as a delta. Ninety-two numbers
   * is nothing, and it removes every question about what a partial update means when
   * two of them cross on the wire. Only to you — everybody else's pockets are nobody's
   * business and would be three quarters of the bandwidth if they were.
   */
  | { t: 'inv'; d: number[]; cur: number[] }
  /**
   * Somebody fired. Sent to everyone so the tracer and the smoke are drawn on every
   * screen, not just the shooter's — a shot you cannot see coming from anywhere is a
   * shot you cannot learn to avoid.
   */
  | { t: 'shot'; x: number; y: number; z: number; hx: number; hy: number; hz: number; hit: boolean }
  /** Something happened somewhere: a sound to play, positioned in the world. */
  | { t: 'noise'; what: string; x: number; y: number; z: number }
  | { t: 'pong'; ts: number };

/**
 * `craft-` is a new line again: there are ITEMS now as well as blocks, a pickaxe
 * decides what rock you can touch, and there is hunger, death and gunfire to report.
 * The old `blocks-` clients could not usefully talk to this at all.
 * Terrain, caves, ore and trees are NOT in it — they are generated from
 * shared code rather than sent, so they cannot be stale and cannot disagree. What
 * this version covers is the shape of the messages and the meaning of a block id.
 *
 * Bumping it disconnects every client with "reload the page", which is correct and
 * cheap. It does NOT throw the world away: the save file carries its own format
 * number and its own id→name table, so a world written by an older version is
 * migrated rather than discarded. See `loadWorld` in the server.
 */
export const PROTOCOL_VERSION = 'alive-1.0.0';

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
