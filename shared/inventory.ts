/**
 * BLOONS WORLD — pockets, and the grid you make things in.
 *
 * This replaces a `Map<thing, count>`, which was a perfectly good way to record what
 * somebody owns and a hopeless way to let them ARRANGE it. A map has no order, no
 * empty spaces and no room for two half-stacks of the same thing — so there is
 * nowhere to put a crafting grid, nothing for a cursor to pick up, and no way to
 * say "that one, there". Slots have all of those for free.
 *
 * The layout, all in one array, because every click is "move a stack from one number
 * to another" and a single array makes that one function instead of six:
 *
 *      0 …  8   the hotbar, which is also the bottom row of the inventory screen
 *      9 … 35   the main pockets, three rows of nine
 *     36 … 44   the crafting grid, three by three
 *          45   what the grid currently makes. Taking it consumes the ingredients.
 *
 * ALL OF IT LIVES ON THE SERVER. The client draws slots and sends clicks; it never
 * decides what a click did. Anything else is an invitation to duplicate a stack by
 * clicking twice before the answer comes back, which is the oldest bug in the genre.
 */

import { RECIPES, canCraft, matchGrid, thingDef } from './items.js';

export const HOTBAR = 9;
export const MAIN_START = 9;
export const MAIN_SLOTS = 27;
export const GRID_START = 36;
export const GRID_SIZE = 9;
export const OUTPUT = 45;
export const SLOT_COUNT = 46;

/** One stack. `n` is never zero — an empty slot is null. */
export interface Stack {
  t: number;
  n: number;
}

export type Slot = Stack | null;

export function emptySlots(): Slot[] {
  return new Array(SLOT_COUNT).fill(null);
}

function capacity(thing: number): number {
  return thingDef(thing).stack;
}

/**
 * Put things in, filling part-used stacks before starting new ones, and never
 * touching the crafting grid.
 *
 * Returns what would not fit, so the caller can decide whether that is a dropped
 * pickaxe or a dig that should not have counted.
 */
export function give(slots: Slot[], thing: number, count: number): number {
  let left = count;
  const max = capacity(thing);
  // Top up what is already open first. Anything else scatters a stack across the
  // whole inventory one at a time.
  for (let i = 0; i < GRID_START && left > 0; i++) {
    const s = slots[i];
    if (!s || s.t !== thing || s.n >= max) continue;
    const room = Math.min(max - s.n, left);
    s.n += room;
    left -= room;
  }
  for (let i = 0; i < GRID_START && left > 0; i++) {
    if (slots[i]) continue;
    const put = Math.min(max, left);
    slots[i] = { t: thing, n: put };
    left -= put;
  }
  return left;
}

/** How many of a thing are in the pockets, hotbar and grid together. */
export function countOf(slots: Slot[], thing: number): number {
  let n = 0;
  for (let i = 0; i < OUTPUT; i++) if (slots[i]?.t === thing) n += slots[i]!.n;
  return n;
}

/** Everything carried, as a map, for the recipe checks that want one. */
export function asMap(slots: Slot[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < GRID_START; i++) {
    const s = slots[i];
    if (s) out.set(s.t, (out.get(s.t) ?? 0) + s.n);
  }
  return out;
}

/** Take some out, wherever they are. Returns how many were actually found. */
export function take(slots: Slot[], thing: number, count: number): number {
  let left = count;
  // From the smallest stacks first, so the tidy big ones survive.
  const order = [];
  for (let i = 0; i < GRID_START; i++) if (slots[i]?.t === thing) order.push(i);
  order.sort((a, b) => slots[a]!.n - slots[b]!.n);
  for (const i of order) {
    if (left <= 0) break;
    const s = slots[i]!;
    const got = Math.min(s.n, left);
    s.n -= got;
    left -= got;
    if (s.n === 0) slots[i] = null;
  }
  return count - left;
}

// ---------------------------------------------------------------------------
// Clicking
//
// Minecraft's rules exactly, because they are the ones everybody's hands already
// know: left picks up all and puts down all, right picks up half and puts down one,
// and the same button on a stack of the same thing merges instead of swapping.

export interface ClickResult {
  /** True if anything actually moved, so the caller knows whether to send an update. */
  changed: boolean;
}

/**
 * One click on one slot, with whatever the cursor is holding.
 *
 * `cursor` is a one-element array so it can be written through — the alternative is
 * returning a tuple and threading it back, which every caller would then get wrong
 * exactly once.
 */
export function click(slots: Slot[], cursor: Slot[], slot: number, right: boolean): boolean {
  if (slot < 0 || slot >= SLOT_COUNT) return false;
  if (slot === OUTPUT) return takeOutput(slots, cursor, right);

  const held = cursor[0];
  const there = slots[slot];

  if (!held) {
    if (!there) return false;
    if (right) {
      // Half, rounded up, which is what leaves one behind when you split a pair.
      const half = Math.ceil(there.n / 2);
      cursor[0] = { t: there.t, n: half };
      there.n -= half;
      if (there.n === 0) slots[slot] = null;
    } else {
      cursor[0] = there;
      slots[slot] = null;
    }
    return true;
  }

  if (!there) {
    if (right) {
      slots[slot] = { t: held.t, n: 1 };
      held.n -= 1;
      if (held.n === 0) cursor[0] = null;
    } else {
      slots[slot] = held;
      cursor[0] = null;
    }
    return true;
  }

  if (there.t === held.t) {
    const room = capacity(there.t) - there.n;
    if (room <= 0) return false;
    const moved = right ? Math.min(1, room, held.n) : Math.min(room, held.n);
    there.n += moved;
    held.n -= moved;
    if (held.n === 0) cursor[0] = null;
    return moved > 0;
  }

  // Two different things: swap, but never into the output slot and never a
  // right-click swap, which in every game that allows it is an accident.
  if (right) return false;
  slots[slot] = held;
  cursor[0] = there;
  return true;
}

/**
 * Shift-click: send a stack to the other half of the window.
 *
 * From the grid or the pockets it goes to the hotbar and then the pockets; from the
 * hotbar it goes to the pockets. Taking the OUTPUT this way crafts as many times as
 * the ingredients allow, which is the single most useful thing the modifier does.
 */
export function shiftClick(slots: Slot[], slot: number): boolean {
  if (slot === OUTPUT) {
    let any = false;
    // Bounded, so a grid full of logs cannot spend a second in this loop.
    for (let i = 0; i < 64; i++) {
      const made = refreshOutput(slots);
      if (!made) break;
      const room = wouldFit(slots, made.t, made.n, 0, GRID_START);
      if (!room) break;
      consumeGrid(slots);
      give(slots, made.t, made.n);
      any = true;
    }
    refreshOutput(slots);
    return any;
  }
  const s = slots[slot];
  if (!s) return false;
  const [from, to] = slot < HOTBAR ? [MAIN_START, GRID_START] : [0, HOTBAR];
  const left = giveInto(slots, s.t, s.n, from, to);
  if (left === s.n) return false;
  s.n = left;
  if (s.n === 0) slots[slot] = null;
  return true;
}

function giveInto(slots: Slot[], thing: number, count: number, from: number, to: number): number {
  let left = count;
  const max = capacity(thing);
  for (let i = from; i < to && left > 0; i++) {
    const s = slots[i];
    if (!s || s.t !== thing || s.n >= max) continue;
    const room = Math.min(max - s.n, left);
    s.n += room;
    left -= room;
  }
  for (let i = from; i < to && left > 0; i++) {
    if (slots[i]) continue;
    const put = Math.min(max, left);
    slots[i] = { t: thing, n: put };
    left -= put;
  }
  return left;
}

function wouldFit(slots: Slot[], thing: number, count: number, from: number, to: number): boolean {
  let room = 0;
  const max = capacity(thing);
  for (let i = from; i < to; i++) {
    const s = slots[i];
    if (!s) room += max;
    else if (s.t === thing) room += max - s.n;
    if (room >= count) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The grid

/** What the grid currently makes, written into the output slot. Null if nothing. */
export function refreshOutput(slots: Slot[]): Stack | null {
  const grid: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const s = slots[GRID_START + i];
    grid.push(s ? s.t : 0);
    counts.push(s ? s.n : 0);
  }
  for (const r of RECIPES) {
    if (!matchGrid(r, grid, counts)) continue;
    slots[OUTPUT] = { t: r.gives[0], n: r.gives[1] };
    return slots[OUTPUT];
  }
  slots[OUTPUT] = null;
  return null;
}

/** Spend one of everything in the grid. Called when the output is actually taken. */
function consumeGrid(slots: Slot[]): void {
  for (let i = GRID_START; i < GRID_START + GRID_SIZE; i++) {
    const s = slots[i];
    if (!s) continue;
    s.n -= 1;
    if (s.n === 0) slots[i] = null;
  }
}

function takeOutput(slots: Slot[], cursor: Slot[], right: boolean): boolean {
  const made = refreshOutput(slots);
  if (!made) return false;
  const held = cursor[0];
  // You cannot take half a crafted thing, and you cannot take one onto a cursor that
  // is holding something else.
  if (held && (held.t !== made.t || held.n + made.n > capacity(made.t))) return false;
  void right;
  consumeGrid(slots);
  if (held) held.n += made.n;
  else cursor[0] = { t: made.t, n: made.n };
  refreshOutput(slots);
  return true;
}

/**
 * Tip the crafting grid back into the pockets.
 *
 * Called when the window closes. Minecraft drops them on the floor; there is nothing
 * on the floor here to drop them onto, and silently eating somebody's three diamonds
 * because they pressed escape would be unforgivable.
 */
export function clearGrid(slots: Slot[], cursor: Slot[]): void {
  for (let i = GRID_START; i < GRID_START + GRID_SIZE; i++) {
    const s = slots[i];
    if (!s) continue;
    slots[i] = null;
    give(slots, s.t, s.n);
  }
  const held = cursor[0];
  if (held) {
    cursor[0] = null;
    give(slots, held.t, held.n);
  }
  slots[OUTPUT] = null;
}

// ---------------------------------------------------------------------------
// The wire
//
// Flat `[thing, count, …]`, two numbers per slot, zeros for empty. Forty-six slots is
// ninety-two numbers, which is small enough to send whole every time it changes and
// saves every question about what a partial update means.

export function packSlots(slots: Slot[]): number[] {
  const out: number[] = [];
  for (const s of slots) out.push(s ? s.t : 0, s ? s.n : 0);
  return out;
}

export function unpackSlots(flat: number[]): Slot[] {
  const out = emptySlots();
  for (let i = 0; i < SLOT_COUNT && i * 2 + 1 < flat.length; i++) {
    const t = flat[i * 2];
    const n = flat[i * 2 + 1];
    out[i] = t > 0 && n > 0 ? { t, n } : null;
  }
  return out;
}

// Re-exported so the server can check "have I got the makings" without importing
// two modules to answer one question.
export { canCraft };
