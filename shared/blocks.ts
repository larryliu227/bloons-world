/**
 * BLOONS WORLD — the block table.
 *
 * One entry per kind of block, and every question anything in the game asks about a
 * block is answered from here: can you walk through it, does light get past it, how
 * long does it take to dig, what are you holding afterwards, and which texture goes
 * on which face.
 *
 * It is shared because both ends need all of it, and they need the SAME all of it.
 * The server decides whether a dig was fast enough to be real and what it dropped;
 * the client decides how long to keep the mouse down and what to draw. Two tables
 * would eventually be two answers, and the one thing worse than a wrong world is two
 * clients that each think the other one is wrong.
 */

// ---------------------------------------------------------------------------
// Textures
//
// Every texture is one layer of a 2D ARRAY texture rather than a tile in an atlas.
// An atlas is the traditional answer and it is the wrong one here: with mipmaps on,
// bilinear filtering at a tile's edge samples the tile NEXT to it, so every distant
// block gets a one-pixel rind of its neighbour's colour. An array texture has no
// neighbours to bleed from — each layer is its own image, wrapped on its own — and
// the vertex just carries which layer to use.

export const TEX = {
  stone: 0,
  dirt: 1,
  grassTop: 2,
  grassSide: 3,
  sand: 4,
  gravel: 5,
  cobble: 6,
  logSide: 7,
  logTop: 8,
  leaves: 9,
  planks: 10,
  glass: 11,
  coal: 12,
  iron: 13,
  gold: 14,
  diamond: 15,
  lamp: 16,
  brick: 17,
  water: 18,
  bedrock: 19,
  tallGrass: 20,
  flower: 21,
  /** Ten stages of cracking, `crack + 0` through `crack + 9`. */
  crack: 22,
} as const;

export const CRACK_STAGES = 10;
/** How many layers the array texture has. Everything above must fit under this. */
export const TEX_LAYERS = 32;

// ---------------------------------------------------------------------------
// The blocks themselves

export const AIR = 0;
export const BEDROCK = 1;
export const STONE = 2;
export const DIRT = 3;
export const GRASS = 4;
export const SAND = 5;
export const GRAVEL = 6;
export const COBBLE = 7;
export const LOG = 8;
export const LEAVES = 9;
export const PLANKS = 10;
export const GLASS = 11;
export const COAL_ORE = 12;
export const IRON_ORE = 13;
export const GOLD_ORE = 14;
export const DIAMOND_ORE = 15;
export const LAMP = 16;
export const BRICK = 17;
export const WATER = 18;
export const TALL_GRASS = 19;
export const FLOWER = 20;

/**
 * How a block is put on the screen.
 *
 *  - `cube`  the ordinary case: six faces, and any face touching something solid is
 *            never built in the first place.
 *  - `cross` two quads in an X, which is how every game has drawn grass and flowers
 *            since it stopped being able to afford geometry. Drawn from both sides.
 *  - `none`  air. Nothing at all.
 */
export type Shape = 'cube' | 'cross' | 'none';

export interface BlockDef {
  id: number;
  /** What the hotbar calls it. */
  name: string;
  /** Texture layers: [top, bottom, side]. */
  tex: [number, number, number];
  shape: Shape;
  /** Stops a body. */
  solid: boolean;
  /** Fills its cell for the purposes of hiding the faces behind it. */
  opaque: boolean;
  /** You swim in it rather than standing on it. */
  liquid: boolean;
  /** Placing something here overwrites it instead of landing beside it. */
  replaceable: boolean;
  /** Light levels eaten per block. 15 is "none gets through". */
  opacity: number;
  /** Light given off, 0..15. */
  glow: number;
  /** Seconds of digging with bare hands. `Infinity` means never. */
  hardness: number;
  /** What you end up carrying. `AIR` means nothing at all. */
  drop: number;
}

function def(id: number, name: string, tex: number | [number, number, number], extra: Partial<BlockDef> = {}): BlockDef {
  const t: [number, number, number] = typeof tex === 'number' ? [tex, tex, tex] : tex;
  return {
    id,
    name,
    tex: t,
    shape: 'cube',
    solid: true,
    opaque: true,
    liquid: false,
    replaceable: false,
    opacity: 15,
    glow: 0,
    hardness: 1,
    drop: id,
    ...extra,
  };
}

/**
 * Indexed by block id, so `BLOCKS[b]` is a plain array lookup on the hot path — this
 * is read once per face per block per remesh, which is a few million times when the
 * world first appears.
 */
export const BLOCKS: BlockDef[] = [
  def(AIR, 'air', 0, {
    shape: 'none',
    solid: false,
    opaque: false,
    replaceable: true,
    opacity: 0,
    hardness: Infinity,
    drop: AIR,
  }),
  // The floor of the world. Deliberately impossible to dig: the bottom of a voxel
  // world has to be somewhere, and a hole you can fall out of the universe through
  // is a bug report rather than a feature.
  def(BEDROCK, 'bedrock', TEX.bedrock, { hardness: Infinity, drop: AIR }),
  def(STONE, 'stone', TEX.stone, { hardness: 3.0, drop: COBBLE }),
  def(DIRT, 'dirt', TEX.dirt, { hardness: 0.55 }),
  // Grass keeps its own top and sides and drops plain dirt, because a lawn is a
  // thing that grew rather than a thing you can carry.
  def(GRASS, 'grass', [TEX.grassTop, TEX.dirt, TEX.grassSide], { hardness: 0.65, drop: DIRT }),
  def(SAND, 'sand', TEX.sand, { hardness: 0.5 }),
  def(GRAVEL, 'gravel', TEX.gravel, { hardness: 0.6 }),
  def(COBBLE, 'cobble', TEX.cobble, { hardness: 3.2 }),
  def(LOG, 'log', [TEX.logTop, TEX.logTop, TEX.logSide], { hardness: 1.6 }),
  // Leaves let a little light through, which is what puts dapple under a tree
  // instead of a black disc.
  def(LEAVES, 'leaves', TEX.leaves, { opaque: false, opacity: 1, hardness: 0.25 }),
  def(PLANKS, 'planks', TEX.planks, { hardness: 1.3 }),
  def(GLASS, 'glass', TEX.glass, { opaque: false, opacity: 0, hardness: 0.4 }),
  def(COAL_ORE, 'coal', TEX.coal, { hardness: 3.6 }),
  def(IRON_ORE, 'iron', TEX.iron, { hardness: 4.4 }),
  def(GOLD_ORE, 'gold', TEX.gold, { hardness: 4.8 }),
  def(DIAMOND_ORE, 'diamond', TEX.diamond, { hardness: 5.6 }),
  // The only thing in the world that makes its own light, which is the whole reason
  // to go down a hole and come back up again.
  def(LAMP, 'lamp', TEX.lamp, { glow: 14, hardness: 0.5 }),
  def(BRICK, 'brick', TEX.brick, { hardness: 3.4 }),
  def(WATER, 'water', TEX.water, {
    solid: false,
    opaque: false,
    liquid: true,
    replaceable: true,
    // Two levels a block, so a deep lake is dim at the bottom and a puddle is not.
    opacity: 2,
    hardness: Infinity,
    drop: AIR,
  }),
  def(TALL_GRASS, 'tall grass', TEX.tallGrass, {
    shape: 'cross',
    solid: false,
    opaque: false,
    replaceable: true,
    opacity: 0,
    hardness: 0,
  }),
  def(FLOWER, 'flower', TEX.flower, {
    shape: 'cross',
    solid: false,
    opaque: false,
    replaceable: true,
    opacity: 0,
    hardness: 0,
  }),
];

/** The block, or air for anything that is not a block. Never throws, never null. */
export function blockDef(id: number): BlockDef {
  return BLOCKS[id] ?? BLOCKS[AIR];
}

/** Everything you are allowed to be holding, in the order the inventory lists it. */
export const PLACEABLE: number[] = BLOCKS.filter(
  (b) => b.id !== AIR && b.id !== WATER && b.id !== BEDROCK,
).map((b) => b.id);

/**
 * Should the face of `self` that looks at `neighbour` be built at all?
 *
 * The ordinary rule is "not if the neighbour fills its cell". The second rule is the
 * one that stops a glass wall from being a stack of visible panes: glass against
 * glass hides both faces, so a window reads as one sheet rather than as the inside
 * of an aquarium. Water does the same against water, or every lake would be a grid.
 */
export function faceVisible(self: number, neighbour: number): boolean {
  const nb = blockDef(neighbour);
  if (nb.opaque) return false;
  if (neighbour === self && (self === GLASS || self === WATER || self === LEAVES)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Making things
//
// There is no crafting grid and there is no furnace. Four recipes, each of which
// turns something you dug up into something you could not otherwise have, and one
// of which — the lamp — is the only reason the whole coal-and-glass chain exists.
// A crafting table would be a screen; this is a list you press.

export interface Recipe {
  /** [block, count] pairs consumed. */
  needs: [number, number][];
  gives: [number, number];
  /** What the button says. */
  label: string;
}

export const RECIPES: Recipe[] = [
  { needs: [[LOG, 1]], gives: [PLANKS, 4], label: 'planks' },
  { needs: [[COBBLE, 4]], gives: [BRICK, 4], label: 'brick' },
  {
    needs: [
      [SAND, 2],
      [COAL_ORE, 1],
    ],
    gives: [GLASS, 2],
    label: 'glass',
  },
  {
    needs: [
      [GLASS, 2],
      [COAL_ORE, 2],
    ],
    gives: [LAMP, 1],
    label: 'lamp',
  },
];

/** Whether a pile of blocks covers a recipe. `have` is `blockId -> count`. */
export function canCraft(have: Map<number, number>, r: Recipe): boolean {
  return r.needs.every(([id, n]) => (have.get(id) ?? 0) >= n);
}
