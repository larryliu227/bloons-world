/**
 * BLOONS WORLD — things that are not blocks, and everything you can make.
 *
 * Until items existed, everything you could carry was a block, because everything you
 * could carry was something you had dug out of the ground and could put back. That
 * works exactly as long as the game is about moving the landscape around, and stops
 * the moment it is about MAKING things: a stick is not a block, an iron ingot is not
 * a block, and neither is a rifle.
 *
 * So there are two kinds of thing, and one id space covering both:
 *
 *     0 … 255     blocks. Unchanged, because the world is a Uint8Array of these and
 *                 every saved world is a list of them.
 *     256 …       items. Only ever in somebody's hands or pockets.
 *
 * One number for both is what keeps the inventory, the wire, the hotbar and the save
 * file from each needing to know which kind they are holding. `thingDef` answers for
 * either, and `isBlock` is the only place the difference matters.
 *
 * THERE ARE NO AGES AND NO STAGES. A recipe is a list of things you need and a thing
 * you get, and if you have the things you can make it. The only wall anywhere is the
 * pickaxe ladder — wood reaches stone, stone reaches iron, iron reaches diamond —
 * and that is a property of the rock, not a gate somebody put in front of you.
 */

import {
  AIR,
  BERRY_BUSH,
  BLOCKS,
  COAL_ORE,
  COBBLE,
  DIAMOND_ORE,
  BRICK,
  BRICK_SLAB,
  BRICK_STAIRS,
  COBBLE_SLAB,
  COBBLE_STAIRS,
  LADDER,
  SAPLING,
  DIAMOND_BLOCK,
  PLANK_SLAB,
  PLANK_STAIRS,
  SANDSTONE_SLAB,
  SANDSTONE_STAIRS,
  DIRT,
  FLOWER,
  FURNACE,
  GLASS,
  GOLD_BLOCK,
  GOLD_ORE,
  GRASS,
  IRON_BLOCK,
  IRON_ORE,
  LAMP,
  LEAVES,
  LOG,
  MOSSY_COBBLE,
  MUSHROOM,
  NITRE_ORE,
  PEBBLES,
  PLANKS,
  SAND,
  SANDSTONE,
  STICKS,
  STONE,
  SULFUR_ORE,
  TALL_GRASS,
  TEX,
  THATCH,
  blockDef,
} from './blocks.js';

/** Ids below this are blocks; ids at or above it are items. */
export const ITEM_BASE = 256;

export function isBlock(id: number): boolean {
  return id > AIR && id < ITEM_BASE;
}

export function isItem(id: number): boolean {
  return id >= ITEM_BASE;
}

// ---------------------------------------------------------------------------
// Tools
//
// Three kinds and four materials. A block names the kind that suits it and the lowest
// material that can touch it at all — and for almost everything that is NOTHING, so
// your hands work and the tool is simply faster.
//
// Rock is the exception and the only one: a pickaxe or nothing, and a better pickaxe
// for better rock. That ladder is the best-tuned thing in the game it is borrowed
// from, because each rung is exactly one trip underground away from the next.

export type ToolKind = 'none' | 'axe' | 'pick' | 'shovel';

export const TIER_HAND = 0;
export const TIER_WOOD = 1;
export const TIER_STONE = 2;
export const TIER_IRON = 3;
export const TIER_DIAMOND = 4;

export const TIER_NAMES = ['your hands', 'wooden', 'stone', 'iron', 'diamond'];

export interface ToolSpec {
  kind: ToolKind;
  tier: number;
  /** How many times faster than bare hands this gets through its own material. */
  speed: number;
  /** How many blocks it survives. Everything wears out. */
  uses: number;
}

/** A gun. Hitscan, because a musket ball does not have a travel time worth modelling. */
export interface GunSpec {
  damage: number;
  /** Seconds between shots. */
  reload: number;
  /** Blocks. Beyond this the ball has gone. */
  range: number;
  /** How far off the crosshair a shot can wander, in radians. */
  spread: number;
  /** Which ammunition it eats. */
  ammo: number;
  /** True if holding the trigger keeps it firing. */
  auto: boolean;
}

export interface ItemDef {
  id: number;
  name: string;
  /** The atlas layer its icon is drawn from. Items are flat pictures, not cubes. */
  tex: number;
  stack: number;
  tool?: ToolSpec;
  /** Points of hunger this restores, and health if it is good for you. */
  food?: { fills: number; heals: number };
  /** Thrown by hand. */
  throwable?: { damage: number; speed: number };
  /** Fired. Needs shot in your pockets. */
  gun?: GunSpec;
}

// ---------------------------------------------------------------------------
// What there is

let next = ITEM_BASE;
const id = () => next++;

export const STICK = id();
export const COAL = id();
export const IRON_INGOT = id();
export const GOLD_INGOT = id();
export const DIAMOND = id();
export const PEBBLE = id();
export const BERRIES = id();
export const ROOT = id();
export const MUSHROOM_ITEM = id();

export const WOOD_PICK = id();
export const WOOD_AXE = id();
export const WOOD_SHOVEL = id();
export const STONE_PICK = id();
export const STONE_AXE = id();
export const STONE_SHOVEL = id();
export const IRON_PICK = id();
export const IRON_AXE = id();
export const IRON_SHOVEL = id();
export const DIAMOND_PICK = id();
export const DIAMOND_AXE = id();
export const DIAMOND_SHOVEL = id();

export const SULFUR = id();
export const NITRE = id();
export const GUNPOWDER = id();
/**
 * Two kinds of ammunition, and the split is the whole of what separates the old guns
 * from the new ones.
 *
 * A BALL is a lead sphere and a measure of loose powder: cheap, and you ram it down
 * the barrel one at a time. A CARTRIDGE is the ball, the powder and the primer in one
 * brass case — twice the powder to make, and the only reason a gun can reload itself,
 * because there is nothing left to do between shots but throw the empty case away.
 */
export const BALL = id();
export const CARTRIDGE = id();
export const MUSKET = id();
export const RIFLE = id();
export const REVOLVER = id();
export const AUTORIFLE = id();
export const MACHINEGUN = id();
export const RAW_MEAT = id();
export const COOKED_MEAT = id();

function item(itemId: number, name: string, tex: number, extra: Partial<ItemDef> = {}): ItemDef {
  return { id: itemId, name, tex, stack: 99, ...extra };
}

/**
 * One tool, by kind and material.
 *
 * Twelve of these are generated from four rows of numbers rather than written out,
 * because twelve hand-written tool definitions is twelve places for a typo that makes
 * exactly one of them mysteriously bad.
 */
function tool(itemId: number, material: string, kind: ToolKind, tier: number, speed: number, uses: number): ItemDef {
  const noun = kind === 'pick' ? 'pickaxe' : kind;
  return {
    id: itemId,
    name: `${material} ${noun}`,
    tex: (kind === 'pick' ? TEX.itemPick : kind === 'axe' ? TEX.itemAxe : TEX.itemShovel) + (tier - 1),
    stack: 1,
    tool: { kind, tier, speed, uses },
  };
}

export const ITEMS: ItemDef[] = [
  item(STICK, 'stick', TEX.itemStick),
  item(COAL, 'coal', TEX.itemCoal),
  item(IRON_INGOT, 'iron ingot', TEX.itemIron),
  item(GOLD_INGOT, 'gold ingot', TEX.itemGold),
  item(DIAMOND, 'diamond', TEX.itemDiamond),
  // Still the first thing anybody picks up, and still the only thing you can throw.
  item(PEBBLE, 'pebble', TEX.itemPebble, { throwable: { damage: 2, speed: 24 } }),
  item(BERRIES, 'berries', TEX.itemBerries, { food: { fills: 2, heals: 0 } }),
  item(ROOT, 'root', TEX.itemRoot, { food: { fills: 3, heals: 0 } }),
  item(MUSHROOM_ITEM, 'mushroom', TEX.itemMushroom, { food: { fills: 2, heals: 0 } }),

  //    id             material     kind      tier  speed  uses
  tool(WOOD_PICK, 'wooden', 'pick', TIER_WOOD, 2, 60),
  tool(WOOD_AXE, 'wooden', 'axe', TIER_WOOD, 2, 60),
  tool(WOOD_SHOVEL, 'wooden', 'shovel', TIER_WOOD, 2, 60),
  tool(STONE_PICK, 'stone', 'pick', TIER_STONE, 4, 132),
  tool(STONE_AXE, 'stone', 'axe', TIER_STONE, 4, 132),
  tool(STONE_SHOVEL, 'stone', 'shovel', TIER_STONE, 4, 132),
  tool(IRON_PICK, 'iron', 'pick', TIER_IRON, 6, 251),
  tool(IRON_AXE, 'iron', 'axe', TIER_IRON, 6, 251),
  tool(IRON_SHOVEL, 'iron', 'shovel', TIER_IRON, 6, 251),
  tool(DIAMOND_PICK, 'diamond', 'pick', TIER_DIAMOND, 9, 1562),
  tool(DIAMOND_AXE, 'diamond', 'axe', TIER_DIAMOND, 9, 1562),
  tool(DIAMOND_SHOVEL, 'diamond', 'shovel', TIER_DIAMOND, 9, 1562),

  item(SULFUR, 'sulfur', TEX.itemSulfur),
  item(NITRE, 'saltpetre', TEX.itemNitre),
  item(GUNPOWDER, 'gunpowder', TEX.itemPowder),
  item(BALL, 'lead ball', TEX.itemBall),
  item(CARTRIDGE, 'cartridge', TEX.itemCartridge),
  /*
   * Five guns, and the ladder through them is ammunition rather than damage.
   *
   * A musket is a tube you pour powder into: it hits like a truck and then you are a
   * spectator for two seconds. Everything above it burns CARTRIDGES, which cost twice
   * the powder — and the last two fire for as long as you hold the trigger, which is
   * the only thing here that can empty your pockets faster than it empties somebody.
   */
  item(RAW_MEAT, 'raw meat', TEX.itemMeat, { food: { fills: 2, heals: 0 } }),
  // Cooking triples what it is worth, which is the whole reason a furnace is not
  // only for smelting.
  item(COOKED_MEAT, 'cooked meat', TEX.itemCooked, { food: { fills: 7, heals: 1 } }),
  item(MUSKET, 'musket', TEX.itemMusket, {
    stack: 1,
    gun: { damage: 14, reload: 2.2, range: 60, spread: 0.035, ammo: BALL, auto: false },
  }),
  item(RIFLE, 'rifle', TEX.itemRifle, {
    stack: 1,
    gun: { damage: 9, reload: 0.75, range: 110, spread: 0.006, ammo: CARTRIDGE, auto: false },
  }),
  item(REVOLVER, 'revolver', TEX.itemRevolver, {
    stack: 1,
    gun: { damage: 6, reload: 0.34, range: 45, spread: 0.02, ammo: CARTRIDGE, auto: false },
  }),
  item(AUTORIFLE, 'automatic rifle', TEX.itemAutoRifle, {
    stack: 1,
    gun: { damage: 5, reload: 0.11, range: 90, spread: 0.016, ammo: CARTRIDGE, auto: true },
  }),
  item(MACHINEGUN, 'machine gun', TEX.itemMachineGun, {
    stack: 1,
    gun: { damage: 4.5, reload: 0.075, range: 120, spread: 0.028, ammo: CARTRIDGE, auto: true },
  }),
];

const BY_ID = new Map<number, ItemDef>(ITEMS.map((i) => [i.id, i]));

export function itemDef(itemId: number): ItemDef | null {
  return BY_ID.get(itemId) ?? null;
}

/** Name, icon and stack size for a block or an item, without the caller caring which. */
export function thingDef(thingId: number): { id: number; name: string; tex: number; stack: number } {
  const it = BY_ID.get(thingId);
  if (it) return { id: it.id, name: it.name, tex: it.tex, stack: it.stack };
  const b = blockDef(thingId);
  return { id: b.id, name: b.name, tex: b.tex[0], stack: 99 };
}

/** Everything there is, blocks then items, for the inventory to list in order. */
export const ALL_THINGS: number[] = [
  ...BLOCKS.filter((b) => b.id !== AIR).map((b) => b.id),
  ...ITEMS.map((i) => i.id),
];

// ---------------------------------------------------------------------------
// What breaking a block gives you

const DROPS = new Map<number, [number, number]>();

function drops(block: number, thing: number, count = 1): void {
  DROPS.set(block, [thing, count]);
}

/** What a block gives when broken: `[thing, count]`, or null for nothing at all. */
export function dropOf(block: number): [number, number] | null {
  const explicit = DROPS.get(block);
  if (explicit) return explicit[0] === AIR ? null : explicit;
  const def = blockDef(block);
  // Anything not listed gives itself back, which is the ordinary case for everything
  // you built out of a block in the first place.
  return def.id === AIR ? null : [def.id, 1];
}

// Rock breaks into rubble and turf comes up as soil.
drops(STONE, COBBLE, 1);
drops(GRASS, DIRT, 1);
// Ore gives the thing in it, not the rock around it.
drops(COAL_ORE, COAL, 1);
drops(DIAMOND_ORE, DIAMOND, 1);
drops(SULFUR_ORE, SULFUR, 2);
drops(NITRE_ORE, NITRE, 2);
// Iron and gold come out as rock and have to be smelted, which is the entire reason
// a furnace is worth eight cobble.
drops(IRON_ORE, IRON_ORE, 1);
drops(GOLD_ORE, GOLD_ORE, 1);
// Things lying about, and what they are actually worth.
drops(PEBBLES, PEBBLE, 2);
drops(STICKS, STICK, 2);
drops(BERRY_BUSH, BERRIES, 2);
drops(MUSHROOM, MUSHROOM_ITEM, 1);
drops(FLOWER, ROOT, 1);
/*
 * Leaves give saplings, sometimes.
 *
 * There is no randomness in a drop table — the same block must always give the same
 * thing on both machines — so "sometimes" is a hash of WHERE the leaf was. Which is
 * better than random anyway: the same tree always gives the same saplings, so
 * stripping one is a known quantity rather than a slot machine.
 */
drops(LEAVES, SAPLING, 1);
drops(TALL_GRASS, AIR, 0);
// All four rotations of a ladder come back as the same one, or your pockets fill up
// with three kinds of ladder that are the same ladder.
for (let f = 0; f < 4; f++) drops(LADDER + f, LADDER, 1);

// ---------------------------------------------------------------------------
// Recipes
//
// A flat list. No ages, no tiers of menu, no unlocks: if you have the things, you can
// make the thing. The only ordering here is the order it is convenient to read in.
//
// Anything with `near` has to be done beside that block — which is only ever the
// furnace, and only ever for smelting, because melting rock beside no fire at all is
// the one thing that would look silly.

export interface Recipe {
  /**
   * The pattern, as rows. `0` is an empty cell.
   *
   * A pickaxe is three of something across the top and two sticks down the middle,
   * and that SHAPE is the recipe — not a list of amounts. It is the thing everybody
   * already knows how to do and the reason a crafting grid is a grid at all.
   */
  shape?: number[][];
  /** Or, for the ones where arrangement is meaningless, just a bag of ingredients. */
  needs?: [number, number][];
  gives: [number, number];
  /** A block you must be standing near. Only smelting uses it. */
  near?: number;
  verb: string;
}

/** How close you have to be to a furnace. Generous — you should not have to hug it. */
export const NEAR_RADIUS = 4;

export const RECIPES: Recipe[] = [
  // --- shapeless: things where the arrangement means nothing.
  { verb: 'make', needs: [[LOG, 1]], gives: [PLANKS, 4] },

  // --- shaped. The patterns are Minecraft's, because they are the ones people's
  // hands already know and inventing new ones would be a puzzle nobody asked for.
  { verb: 'make', shape: [[PLANKS], [PLANKS]], gives: [STICK, 4] },
  {
    verb: 'build',
    shape: [
      [COBBLE, COBBLE, COBBLE],
      [COBBLE, 0, COBBLE],
      [COBBLE, COBBLE, COBBLE],
    ],
    gives: [FURNACE, 1],
  },

  ...toolSet(PLANKS, WOOD_PICK, WOOD_AXE, WOOD_SHOVEL),
  ...toolSet(COBBLE, STONE_PICK, STONE_AXE, STONE_SHOVEL),
  ...toolSet(IRON_INGOT, IRON_PICK, IRON_AXE, IRON_SHOVEL),
  ...toolSet(DIAMOND, DIAMOND_PICK, DIAMOND_AXE, DIAMOND_SHOVEL),

  // --- the other way up. Minecraft's H of seven sticks, and worth every one.
  {
    verb: 'make',
    shape: [
      [STICK, 0, STICK],
      [STICK, STICK, STICK],
      [STICK, 0, STICK],
    ],
    gives: [LADDER, 3],
  },

  // --- stairs and slabs, in every material worth building with.
  ...stairSet(COBBLE, COBBLE_SLAB, COBBLE_STAIRS),
  ...stairSet(PLANKS, PLANK_SLAB, PLANK_STAIRS),
  ...stairSet(BRICK, BRICK_SLAB, BRICK_STAIRS),
  ...stairSet(SANDSTONE, SANDSTONE_SLAB, SANDSTONE_STAIRS),

  // --- smelting
  { verb: 'smelt', near: FURNACE, needs: [[IRON_ORE, 1], [COAL, 1]], gives: [IRON_INGOT, 1] },
  { verb: 'smelt', near: FURNACE, needs: [[GOLD_ORE, 1], [COAL, 1]], gives: [GOLD_INGOT, 1] },
  { verb: 'smelt', near: FURNACE, needs: [[SAND, 1], [COAL, 1]], gives: [GLASS, 1] },
  { verb: 'cook', near: FURNACE, needs: [[RAW_MEAT, 1], [COAL, 1]], gives: [COOKED_MEAT, 1] },

  // --- building material
  { verb: 'make', shape: [[COAL], [STICK]], gives: [LAMP, 4] },
  { verb: 'make', shape: [[SAND, SAND], [SAND, SAND]], gives: [SANDSTONE, 4] },
  { verb: 'make', shape: [[COBBLE, COBBLE], [COBBLE, COBBLE]], gives: [BRICK, 4] },
  { verb: 'make', needs: [[COBBLE, 4], [LEAVES, 1]], gives: [MOSSY_COBBLE, 4] },
  { verb: 'make', shape: [[STICK, STICK], [STICK, STICK]], gives: [THATCH, 2] },
  { verb: 'make', shape: fill3(IRON_INGOT), gives: [IRON_BLOCK, 1] },
  { verb: 'make', shape: fill3(GOLD_INGOT), gives: [GOLD_BLOCK, 1] },
  { verb: 'make', shape: fill3(DIAMOND), gives: [DIAMOND_BLOCK, 1] },

  /*
   * --- and the far end of it.
   *
   * Sulfur and saltpetre are worth nothing on their own and are only ever found deep,
   * which is the whole design of them: the reason to dig past iron is that three
   * useless powders are gunpowder.
   */
  { verb: 'mill', needs: [[NITRE, 1], [SULFUR, 1], [COAL, 1]], gives: [GUNPOWDER, 3] },
  { verb: 'cast', needs: [[IRON_INGOT, 1], [GUNPOWDER, 1]], gives: [BALL, 8] },
  {
    verb: 'cast',
    needs: [[IRON_INGOT, 1], [GUNPOWDER, 2]],
    gives: [CARTRIDGE, 8],
  },
  {
    verb: 'build',
    shape: [
      [0, 0, IRON_INGOT],
      [0, IRON_INGOT, PLANKS],
      [PLANKS, PLANKS, 0],
    ],
    gives: [MUSKET, 1],
  },
  {
    verb: 'build',
    shape: [
      [0, IRON_INGOT, IRON_INGOT],
      [0, IRON_INGOT, PLANKS],
      [PLANKS, PLANKS, 0],
    ],
    gives: [RIFLE, 1],
  },
  {
    verb: 'build',
    shape: [
      [0, IRON_INGOT, IRON_INGOT],
      [IRON_INGOT, IRON_INGOT, PLANKS],
      [PLANKS, GOLD_INGOT, 0],
    ],
    gives: [REVOLVER, 1],
  },
  {
    verb: 'build',
    shape: [
      [IRON_INGOT, IRON_INGOT, IRON_INGOT],
      [DIAMOND, IRON_INGOT, PLANKS],
      [PLANKS, PLANKS, GOLD_INGOT],
    ],
    gives: [AUTORIFLE, 1],
  },
  {
    verb: 'build',
    shape: [
      [IRON_INGOT, IRON_INGOT, IRON_INGOT],
      [DIAMOND, IRON_INGOT, DIAMOND],
      [IRON_BLOCK, PLANKS, IRON_BLOCK],
    ],
    gives: [MACHINEGUN, 1],
  },
];

/** A pickaxe, an axe and a shovel in one material. Minecraft's three patterns. */
function toolSet(m: number, pick: number, axe: number, shovel: number): Recipe[] {
  return [
    { verb: 'make', shape: [[m, m, m], [0, STICK, 0], [0, STICK, 0]], gives: [pick, 1] },
    { verb: 'make', shape: [[m, m], [m, STICK], [0, STICK]], gives: [axe, 1] },
    { verb: 'make', shape: [[m], [STICK], [STICK]], gives: [shovel, 1] },
  ];
}

/** Three across is a slab; a staircase down the diagonal is stairs. */
function stairSet(m: number, slab: number, stairs: number): Recipe[] {
  return [
    { verb: 'cut', shape: [[m, m, m]], gives: [slab, 6] },
    { verb: 'cut', shape: [[m, 0, 0], [m, m, 0], [m, m, m]], gives: [stairs, 4] },
  ];
}

function fill3(m: number): number[][] {
  return [[m, m, m], [m, m, m], [m, m, m]];
}

/**
 * Does a 3x3 grid make this?
 *
 * The pattern is compared against the grid's BOUNDING BOX rather than its corner, so
 * a recipe laid out in the middle of the grid works exactly as well as one pushed
 * into the top left — which is what everybody expects and what nobody would ever
 * think to report as a bug if it were missing. Mirrored layouts count too, because a
 * left-handed axe is still an axe.
 */
export function matchGrid(r: Recipe, grid: number[], counts: number[]): boolean {
  if (r.needs) {
    // Shapeless: the grid has to hold exactly the ingredients, nothing else.
    const want = new Map<number, number>();
    for (const [t, n] of r.needs) want.set(t, (want.get(t) ?? 0) + n);
    const got = new Map<number, number>();
    for (let i = 0; i < 9; i++) if (grid[i]) got.set(grid[i], (got.get(grid[i]) ?? 0) + counts[i]);
    if (got.size !== want.size) return false;
    for (const [t, n] of want) if ((got.get(t) ?? 0) < n) return false;
    return true;
  }
  if (!r.shape) return false;

  let minX = 3;
  let minY = 3;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      if (!grid[y * 3 + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return false;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (h !== r.shape.length) return false;
  const pw = Math.max(...r.shape.map((row) => row.length));
  if (w !== pw) return false;

  for (const mirrored of [false, true]) {
    let ok = true;
    for (let y = 0; y < h && ok; y++) {
      for (let x = 0; x < w; x++) {
        const row = r.shape[y];
        const want = (mirrored ? row[w - 1 - x] : row[x]) ?? 0;
        if (grid[(minY + y) * 3 + (minX + x)] !== want) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Could this be made from a pile, ignoring arrangement?
 *
 * Used for the "what can I make" hint list rather than for actually crafting — the
 * grid is what decides that. A shaped recipe is flattened to its ingredient counts
 * here, which is deliberately generous: the list is answering "have you got the
 * makings", not "have you laid it out right".
 */
export function canCraft(have: Map<number, number>, r: Recipe): boolean {
  for (const [thing, n] of ingredientsOf(r)) {
    if ((have.get(thing) ?? 0) < n) return false;
  }
  return true;
}

/** A recipe's ingredients as counts, whichever way it was written. */
export function ingredientsOf(r: Recipe): [number, number][] {
  if (r.needs) return r.needs;
  const tally = new Map<number, number>();
  for (const row of r.shape ?? []) {
    for (const cell of row) {
      if (cell) tally.set(cell, (tally.get(cell) ?? 0) + 1);
    }
  }
  return [...tally];
}

// ---------------------------------------------------------------------------
// Digging

/**
 * How long a block takes with what is in your hand, or `null` if it cannot be done.
 *
 * Tier 0 — which is almost everything — means your hands work and the right tool is
 * simply faster. You punch a tree and you get wood. Tier 1 and up is a real wall, and
 * rock is the only thing behind one.
 */
export function digSeconds(block: number, held: number): number | null {
  const def = blockDef(block);
  if (!Number.isFinite(def.hardness)) return null;
  if (def.tool === 'none') return def.hardness;
  const tool = itemDef(held)?.tool;
  const suits = !!tool && tool.kind === def.tool;
  if (def.tier > 0 && (!suits || tool!.tier < def.tier)) return null;
  return def.hardness / (suits ? tool!.speed : 1);
}

/** What you would need, in words, for the message when you have not got it. */
export function toolNeeded(block: number): string | null {
  const def = blockDef(block);
  if (def.tier <= 0 || !Number.isFinite(def.hardness)) return null;
  const noun = def.tool === 'pick' ? 'pickaxe' : def.tool;
  return `a ${TIER_NAMES[def.tier]} ${noun} or better`;
}

/** The id→name table for the save file, covering both kinds of thing. */
export function thingNames(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const b of BLOCKS) out[b.id] = b.name;
  for (const i of ITEMS) out[i.id] = i.name;
  return out;
}

/**
 * Names that USED to mean something, and what they mean now.
 *
 * A saved world is migrated by name, which works perfectly until somebody renames a
 * block — and then every one of them in every world quietly becomes air, with a
 * warning nobody reads. Renaming is a normal thing to want to do, so the answer is a
 * list of the old names rather than a rule against changing them.
 */
const RENAMED: Record<string, string> = {
  coal: 'coal ore',
  iron: 'iron ore',
  gold: 'gold ore',
  diamond: 'diamond ore',
  // The stone-age chain that was tried and taken out again. Anything anybody was
  // holding becomes the nearest thing that still exists rather than nothing at all.
  'stone axe': 'stone axe',
  'stone pick': 'stone pickaxe',
  'flint flake': 'pebble',
  'plant fibre': 'stick',
  cord: 'stick',
  shot: 'lead ball',
};

export function thingByName(name: string): number | null {
  const wanted = RENAMED[name] ?? name;
  const b = BLOCKS.find((x) => x.name === wanted);
  if (b) return b.id;
  const i = ITEMS.find((x) => x.name === wanted);
  return i ? i.id : null;
}
