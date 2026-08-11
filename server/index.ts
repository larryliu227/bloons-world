/**
 * BLOONS WORLD — server.
 *
 * One HTTP server, one WebSocket riding its upgrade, one 20 Hz loop that walks
 * everybody and ships the result. In production the same port serves the built
 * client, so deploying is `npm run build && npm start` and nothing else.
 *
 * There are no rooms. There is one world and everybody is in it, and because the
 * terrain is generated from shared code rather than stored, the only thing this
 * process actually owns is the DIFFERENCE: every block anybody has dug out or put
 * down since it started. That list is the save file, it is what a joining client is
 * sent, and it is small enough that both of those are true at once.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { PROTOCOL_VERSION, decode, encode } from '../shared/protocol.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { AIR, BERRY_BUSH, LADDER, LEAVES, LOG, MUSHROOM, PEBBLES, SAPLING, STICKS, TALL_GRASS, blockDef, ladderFor, orientFor } from '../shared/blocks.js';
import {
  NEAR_RADIUS,
  RECIPES,
  RAW_MEAT,
  ingredientsOf,
  canCraft,
  digSeconds,
  dropOf,
  isBlock,
  itemDef,
  thingByName,
  thingDef,
  thingNames,
} from '../shared/items.js';
import {
  GRID_START,
  OUTPUT,
  SLOT_COUNT,
  asMap,
  clearGrid,
  click,
  countOf,
  emptySlots,
  give as giveInto,
  packSlots,
  refreshOutput,
  shiftClick,
  take as takeFrom,
} from '../shared/inventory.js';
import type { Slot } from '../shared/inventory.js';
import {
  DAY_MS,
  EYE_H,
  MAX_HP,
  MAX_HUNGER,
  PLAYER_H,
  PLAYER_W,
  REACH,
  TICK_MS,
  TICK_RATE,
  blockNear,
  bodyOverlapsBlock,
  canStandAt,
  raycast,
  fallDamage,
  generate,
  getBlock,
  hurt,
  idx,
  pristineBlock,
  relightAll,
  setBlock,
  setBlockRaw,
  feed,
  revive,
  spawnPoint,
  step,
  stepHealth,
  stepHunger,
  unpackIndex,
} from '../shared/world.js';
import type { Player } from '../shared/world.js';
import { Mobs } from './mobs.js';
import type { LiveMob } from './mobs.js';
import { mobStats, setMeat } from '../shared/mobs.js';

const PORT = readPort();
const PRODUCTION = process.env.NODE_ENV === 'production';
const CLIENT_DIR = resolve(process.cwd(), 'dist');
const SAVE_PATH = resolve(process.cwd(), process.env.WORLD_SAVE ?? 'world-edits.json');
/** How many previous worlds to keep beside the live one, oldest dropped. */
const BACKUPS = 3;
const MAX_SOCKETS = 256;
const MAX_MSG_BYTES = 2048;
/** A socket that never says `hello` is dropped rather than held open forever. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const NAME_MAX = 16;
/**
 * Edits per message when a joining client is being caught up.
 *
 * Two thousand pairs is about 30KB of JSON, which arrives as one frame without
 * making the socket's buffer somebody's problem, and lets the title screen show a
 * real fraction instead of a spinner.
 */
const SYNC_BATCH = 2000;

/**
 * How far a felled tree may reach.
 *
 * Generous enough for the tallest thing the generator makes, tight enough that a
 * forest whose canopies touch comes down one tree at a time.
 */
const TREE_MAX_LOGS = 90;
const TREE_MAX_HEIGHT = 14;
const TREE_MAX_SPREAD = 4;
const TREE_LEAF_REACH = 2;
/** Below this many leaves it is not a tree, it is a wall, and it stays up. */
const TREE_MIN_LEAVES = 6;

/** How much of a block's dig time a client is allowed to be early by. */
const DIG_LENIENCE = 0.72;
/** The fastest anybody may put blocks down, in milliseconds between them. */
const PLACE_COOLDOWN = 120;
/**
 * How long a silent client keeps walking.
 *
 * Half a second is ten input frames — long enough that ordinary jitter and a dropped
 * packet or two never stutter anybody, short enough that a tab which has stopped
 * being drawn stops moving before it has gone anywhere. A browser throttles
 * `requestAnimationFrame` to nothing in a background tab, so this is not an edge case:
 * it is what happens every time somebody switches to another window mid-stride.
 */
const INPUT_TIMEOUT_MS = 500;

interface Session {
  socket: WebSocket;
  player: Player;
  /** Latest intent from this client. Applied every tick until it changes. */
  fwd: number;
  strafe: number;
  sprint: boolean;
  /**
   * A jump waiting to be spent on the next tick.
   *
   * Edge-triggered, not level-triggered: the client sets it once per press and the
   * tick consumes it. Holding the key would otherwise re-fire every tick, and while
   * `step` refuses to launch you off the ground twice, the flag would still be true
   * the instant you landed — so you would bunny-hop forever by leaning on space.
   */
  jump: boolean;
  /**
   * When this client last said anything about where it wants to go.
   *
   * Input is a LEVEL, not an event: "I am pushing forward" stays true until a later
   * message says otherwise. Which is right, and it means a client that stops talking
   * leaves its last intent standing — so backgrounding the tab mid-stride walks you
   * out to sea, and so does a network stall, and so does closing the laptop. Nobody
   * moves who has not said something recently. See `INPUT_TIMEOUT_MS`.
   */
  heardAt: number;
  helloDone: boolean;
  /**
   * Who this is across sessions, or '' for somebody who arrived without one.
   *
   * Everything a player accumulates is filed under this rather than under the socket,
   * which is what makes closing the tab a pause instead of a wipe.
   */
  token: string;
  /** Forty-six slots: hotbar, pockets, the crafting grid and its output. */
  slots: Slot[];
  /** What the mouse is holding, as a one-element array so it can be written through. */
  cursor: Slot[];
  /**
   * How many uses have been spent on the tool of each kind they are holding.
   *
   * Tools wear out, and a worn one is not a different item — it is the same item with
   * a number beside it. Keeping the wear per KIND rather than per instance means the
   * inventory stays a simple count, at the cost of "which of my two axes is the
   * blunt one" being unanswerable. Nobody has ever wanted to answer that.
   */
  wear: Map<number, number>;
  /** The thing in their selected slot, as last reported. Validated before it is used. */
  held: number;
  /** Digging this tick, for the hunger it costs. */
  working: boolean;
  /**
   * When they last took damage, for the regeneration delay.
   *
   * Kept here rather than on `Player` because it is the server's bookkeeping and
   * nobody else has any business knowing it — putting it on the wire would ship
   * twenty players' worth of a number that only ever feeds one `if`.
   */
  hurtAt: number;
  /** Rate limits. These ARE the anti-cheat for building. */
  digReadyAt: number;
  placeReadyAt: number;
  /** When the gun in their hand has finished reloading. */
  fireReadyAt: number;
  /** And when they may swing at something again. */
  swingReadyAt: number;
}

const sessions = new Map<string, Session>();
let tick = 0;

/** Everything alive that is not a person. */
const mobs = new Mobs();

/**
 * Which generator made the terrain a save file is a difference from.
 *
 * `island-2` scattered the gatherables — pebbles, sticks, berries, mushrooms — through
 * a world that previously had none, so a save from `island-1` is a set of differences
 * from a landscape with nothing to pick up in it. The differences still apply; the
 * ground under them has changed.
 *
 * Bumped by hand when `shared/world.ts` changes what the land looks like. Nothing
 * checks it to refuse a load — the edits are absolute positions and are kept
 * regardless — but a world of holes dug in a hillside that no longer exists is worth
 * one loud line in the log rather than a silent afternoon of confusion.
 */
const GEN_VERSION = 'island-3';

/*
 * Every block that differs from the generated world, as index -> block id.
 *
 * An entry is DELETED rather than written when a block goes back to what the
 * generator would have made — fill a hole back in and the world forgets you dug it.
 * Without that the save file only ever grows, and a world where everybody has been
 * tidying up would be as big as one nobody had.
 */
const edits = new Map<number, number>();
/** Edits made this tick, flat as [index, block, …], sent to everybody at the end of it. */
let pending: number[] = [];

/**
 * Loose things that have been picked up, and when they come back.
 *
 * Pebbles, sticks, berries and mushrooms are the only way anybody with nothing can
 * start, so if they were finite the island would be stripped in an afternoon and the
 * next person to arrive would find a world they could not play. They regrow where
 * they were, after a few minutes, and only if nobody has built over the spot.
 */
const regrowing = new Map<number, { at: number; block: number }>();
const REGROW_MS = 4 * 60 * 1000;

/**
 * Saplings, and when each becomes a tree.
 *
 * Three to six minutes, which is a quarter to a half of a day. Long enough that
 * planting one is an act of faith and short enough that you can come back and find
 * you were right — and the spread stops a row of them all becoming a wall of trunks
 * at the same instant.
 */
const growing = new Map<number, number>();
const GROW_MIN_MS = 3 * 60 * 1000;
const GROW_SPREAD_MS = 3 * 60 * 1000;
let saveDirty = false;

/**
 * Everybody who has ever been here, by token.
 *
 * This is the other half of "your progress is saved": the world remembers the holes,
 * and this remembers who dug them and what they got for it. Close the tab, update the
 * game, come back a week later — same pockets, same place, same name.
 *
 * Declared up here with the rest of the module's state rather than down beside the
 * code that writes it, because `loadWorld()` runs during boot — above — and a `const`
 * is not hoisted the way a function is. Putting it next to its own section read
 * better and crashed on startup.
 */
const profiles = new Map<string, SavedPlayer>();
/** A cap, so a public server cannot be made to remember a million strangers. */
const MAX_PROFILES = 2048;

// ---------------------------------------------------------------------------
// Boot

generate();
setMeat(RAW_MEAT);
loadWorld();

// ---------------------------------------------------------------------------
// HTTP

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round(process.uptime()),
      players: sessions.size,
      edits: edits.size,
      tick,
    });
    return;
  }
  if (!PRODUCTION) {
    sendText(res, 200, `BLOONS WORLD — protocol ${PROTOCOL_VERSION}\nRun the client with: npm run dev\n`);
    return;
  }
  serveStatic(url.pathname, req, res).catch(() => sendText(res, 500, 'Internal error'));
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (socket: WebSocket) => {
  if (sessions.size >= MAX_SOCKETS) {
    socket.close(1013, 'world full');
    return;
  }
  const id = `w_${randomBytes(6).toString('base64url')}`;
  const at = spawnPoint(Math.random());
  const session: Session = {
    socket,
    fwd: 0,
    strafe: 0,
    sprint: false,
    jump: false,
    heardAt: 0,
    helloDone: false,
    token: '',
    slots: emptySlots(),
    cursor: [null],
    wear: new Map(),
    held: AIR,
    working: false,
    hurtAt: -1e9,
    digReadyAt: 0,
    placeReadyAt: 0,
    fireReadyAt: 0,
    swingReadyAt: 0,
    player: {
      id,
      name: 'wanderer',
      x: at.x,
      y: at.y,
      z: at.z,
      vy: 0,
      yaw: Math.random() * Math.PI * 2,
      pitch: 0,
      onGround: false,
      inWater: false,
      moving: false,
      sprinting: false,
      hue: Math.floor(Math.random() * 360),
      hp: MAX_HP,
      cap: MAX_HP,
      hunger: MAX_HUNGER,
      respawn: 0,
      fell: 0,
      peakY: at.y,
    },
  };

  const handshake = setTimeout(() => {
    if (!session.helloDone) socket.close(4008, 'handshake timeout');
  }, HANDSHAKE_TIMEOUT_MS);
  handshake.unref?.();

  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    if (text.length > MAX_MSG_BYTES) return;
    const msg = decode<ClientMsg>(text);
    if (!msg) return;
    route(session, msg);
  });

  socket.on('close', () => {
    clearTimeout(handshake);
    // File everything they were carrying before the session goes, so closing a tab
    // is a pause rather than a wipe.
    remember(session);
    sessions.delete(id);
    console.log(`[world] ${session.player.name} left — ${sessions.size} here`);
  });
  socket.on('error', () => socket.terminate());
});

function route(s: Session, msg: ClientMsg): void {
  if (!s.helloDone) {
    if (msg.t !== 'hello') return;
    if (msg.version !== PROTOCOL_VERSION) {
      send(s.socket, {
        t: 'error',
        code: 'version_mismatch',
        message: `Server speaks ${PROTOCOL_VERSION}. Reload the page.`,
      });
      s.socket.close(1002, 'version mismatch');
      return;
    }
    s.player.name = sanitizeName(msg.name);
    s.token = sanitizeToken(msg.token);
    const returning = restore(s);
    s.helloDone = true;
    sessions.set(s.player.id, s);
    send(s.socket, { t: 'welcome', id: s.player.id, version: PROTOCOL_VERSION, edits: edits.size });
    syncWorld(s);
    sendInventory(s);
    console.log(
      `[world] ${s.player.name} ${returning ? 'came back' : 'arrived'} — ${sessions.size} here, ${edits.size} blocks changed`,
    );
    return;
  }

  switch (msg.t) {
    case 'input':
      /*
       * Clamped, because these are the numbers a client controls and the whole
       * anti-cheat surface of walking: unclamped, `{f: 50}` is a speed hack.
       */
      s.fwd = clamp1(msg.f);
      s.strafe = clamp1(msg.s);
      s.player.yaw = finite(msg.yaw);
      s.player.pitch = Math.max(-1.55, Math.min(1.55, finite(msg.pitch)));
      s.sprint = msg.sprint === true;
      // What they say they are holding, believed only as far as their pockets go.
      const claim = int(msg.held);
      s.held = claim !== null && countOf(s.slots, claim) > 0 ? claim : AIR;
      s.heardAt = performance.now();
      // Latched. The tick clears it, so one press is one jump however many input
      // frames carry the flag.
      if (msg.jump === true) s.jump = true;
      return;

    case 'edit':
      applyEdit(s, msg.x, msg.y, msg.z, msg.b, msg.nx, msg.ny, msg.nz);
      return;

    case 'craft':
      craft(s, msg.r);
      return;

    case 'click':
      slotClick(s, msg.slot, msg.right === true, msg.shift === true);
      return;

    case 'closepack':
      // Tip the grid and the cursor back into the pockets rather than eating them.
      clearGrid(s.slots, s.cursor);
      sendInventory(s);
      return;

    case 'eat':
      eat(s, msg.b);
      return;

    case 'fire':
      fire(s, msg.yaw, msg.pitch);
      return;

    case 'melee':
      melee(s, msg.yaw, msg.pitch);
      return;

    case 'rename':
      s.player.name = sanitizeName(msg.name);
      return;
    case 'ping':
      send(s.socket, { t: 'pong', ts: msg.ts });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Catching a new arrival up
//
// They already have the terrain — they generated it from the same code this process
// did. All they are missing is what everybody has done to it since.

function syncWorld(s: Session): void {
  let batch: number[] = [];
  for (const [index, b] of edits) {
    batch.push(index, b);
    if (batch.length >= SYNC_BATCH * 2) {
      send(s.socket, { t: 'edits', d: batch, sync: true });
      batch = [];
    }
  }
  if (batch.length > 0) send(s.socket, { t: 'edits', d: batch, sync: true });
  send(s.socket, { t: 'ready' });
}

// ---------------------------------------------------------------------------
// Digging and building
//
// Every one of these decisions is the server's. The client says which block and what
// to make it; the server decides whether that was possible. A client that could
// assert its own edits could rewrite the world, and a client that could assert its
// own inventory could build a mountain out of nothing.

function applyEdit(
  s: Session,
  rx: unknown, ry: unknown, rz: unknown, rb: unknown,
  rnx: unknown, rny: unknown, rnz: unknown,
): void {
  const x = int(rx);
  const y = int(ry);
  const z = int(rz);
  const b = int(rb);
  const nx = int(rnx) ?? 0;
  const ny = int(rny) ?? 0;
  const nz = int(rnz) ?? 0;
  if (x === null || y === null || z === null || b === null) return;
  // Only a BLOCK can go into the world. A stone axe is not scenery.
  if (b !== AIR && !isBlock(b)) return;

  const p = s.player;
  // Reach, measured from the eye to the middle of the block, with a block of slack
  // for the fact that the position the server has is a moment behind the one the
  // client aimed from.
  const dist = Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + EYE_H), z + 0.5 - p.z);
  if (dist > REACH + 1.2) return correct(s, x, y, z);

  const now = performance.now();
  const existing = getBlock(x, y, z);

  if (b === AIR) {
    if (existing === AIR) return correct(s, x, y, z);
    /*
     * THE TOOL GATE. `digSeconds` returns null when the thing in their hand cannot
     * touch this block at all — no axe, no tree — and that is a refusal rather than a
     * delay. It is the same function the client used to decide whether to even start
     * counting, so the two agree about what is possible; the server checks it again
     * because a client that could assert its own capabilities could assert all of them.
     */
    const seconds = digSeconds(existing, s.held);
    if (seconds === null) return correct(s, x, y, z);
    /*
     * Was there time to dig it? The client is the thing counting — it is holding the
     * button and drawing the cracks — but a client that reports its own dig times
     * could report all of them, so the server keeps its own clock and refuses
     * anything that arrives faster than the block allows. The lenience is for
     * latency and for the client's frame rate, not for the player.
     */
    if (now < s.digReadyAt) return correct(s, x, y, z);
    /*
     * The world is changed BEFORE anybody is paid for it, and the payment only
     * happens if it actually changed. The other order looks identical and is not:
     * placing tall grass onto tall grass is a legal-looking edit that changes
     * nothing, and charging for it first means the block leaves your pockets and
     * does not arrive anywhere. Every accounting bug in a game like this is some
     * version of taking the money before delivering the goods.
     */
    if (!setBlock(x, y, z, AIR)) return;
    s.digReadyAt = now + seconds * 1000 * DIG_LENIENCE;
    s.working = true;
    const dropped = dropOf(existing);
    if (dropped) give(s, dropped[0], dropped[1]);
    // Cut a trunk and the whole tree comes down. See `fellTree`.
    if (existing === LOG) fellTree(s, x, y, z);
    wearTool(s);
    // Loose things grow back, or the island is stripped bare in an afternoon and
    // there is no way for the next person to start at all.
    scheduleRegrow(x, y, z, existing);
  } else {
    if (now < s.placeReadyAt) return correct(s, x, y, z);
    if (!blockDef(existing).replaceable) return correct(s, x, y, z);
    if (countOf(s.slots, b) <= 0) return correct(s, x, y, z);
    // Never build a block into somebody — including yourself, which is the common
    // case: aim at your own feet and the block would land where you are standing.
    for (const other of sessions.values()) {
      const o = other.player;
      if (bodyOverlapsBlock(o.x, o.y, o.z, x, y, z)) return correct(s, x, y, z);
    }
    /*
     * Which way round it goes is not the client's to decide.
     *
     * Stairs turn to face the way the player is standing; a LADDER turns to face the
     * wall it was clicked onto, which is why the face normal is on the wire at all.
     * A ladder with no wall behind it is refused rather than dropped in mid-air.
     */
    let facing = orientFor(b, s.player.yaw);
    if (b === LADDER) {
      const nailed = ladderFor(nx, ny, nz);
      if (nailed === null) return correct(s, x, y, z);
      facing = nailed;
    }
    if (!setBlock(x, y, z, facing)) return correct(s, x, y, z);
    s.placeReadyAt = now + PLACE_COOLDOWN;
    take(s, b, 1);
    // A planted sapling starts its clock. See `growing`.
    if (b === SAPLING) growing.set(idx(x, y, z), now + GROW_MIN_MS + Math.random() * GROW_SPREAD_MS);
    if (facing !== b) {
      const index = idx(x, y, z);
      if (facing === pristineBlock(index)) edits.delete(index);
      else edits.set(index, facing);
      pending.push(index, facing);
      saveDirty = true;
      return;
    }
  }

  const index = idx(x, y, z);
  // Back to what the generator would have made? Then it is not an edit any more.
  if (b === pristineBlock(index)) edits.delete(index);
  else edits.set(index, b);
  pending.push(index, b);
  saveDirty = true;
}

/**
 * Tell one client what a block ACTUALLY is.
 *
 * The client applies its own digs and builds the instant you click, because waiting
 * a round trip to see a block break feels like a broken game. That means a refusal
 * has to be undone, and the honest way to undo it is to state the truth rather than
 * to send a "no" the client has to interpret.
 */
/**
 * Swing whatever is in your hand at whatever is in front of you.
 *
 * Bare hands do one point, a tool does more or less depending on what it is for — an
 * axe is a bad weapon and a good axe, and a pickaxe is worse at both. Nothing here is
 * a sword, because there is no sword; the best weapon in the game is a gun and that is
 * the point of the gun.
 */
function melee(s: Session, rawYaw: unknown, rawPitch: unknown): void {
  const p = s.player;
  if (p.respawn > 0) return;
  const now = performance.now();
  if (now < s.swingReadyAt) return;
  s.swingReadyAt = now + 480;
  const yaw = finite(rawYaw);
  const pitch = Math.max(-1.55, Math.min(1.55, finite(rawPitch)));
  const cp = Math.cos(pitch);
  const hit = mobs.hitScan(p.x, p.y + EYE_H, p.z, Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp, REACH);
  if (!hit) return;
  const tool = itemDef(s.held)?.tool;
  const damage = tool ? (tool.kind === 'axe' ? 3 + tool.tier * 1.5 : 2 + tool.tier) : 1;
  strike(s, hit.mob, damage);
}

/**
 * Fire the gun in somebody's hand.
 *
 * Hitscan: a musket ball crosses sixty blocks in about a twentieth of a second, so
 * modelling its flight would buy nothing but a frame of lead and a lot of code. The
 * ball goes where the barrel pointed, the WORLD stops it first, and whoever is
 * standing in what is left of the line takes it.
 *
 * Every part of that is decided here. The client sends a bearing and nothing else.
 */
function fire(s: Session, rawYaw: unknown, rawPitch: unknown): void {
  const p = s.player;
  if (p.respawn > 0) return;
  const gun = itemDef(s.held)?.gun;
  if (!gun) return;
  const now = performance.now();
  if (now < s.fireReadyAt) return;
  if (countOf(s.slots, gun.ammo) <= 0) return;
  s.fireReadyAt = now + gun.reload * 1000;
  take(s, gun.ammo, 1);

  /*
   * Spread, decided by the SERVER from a seed nobody controls.
   *
   * A client that rolled its own scatter would roll zero every time, and a musket
   * that never misses is not a musket. The rifle's spread is a sixth of it, which is
   * the entire point of paying a diamond for one.
   */
  const yaw = finite(rawYaw) + (Math.random() * 2 - 1) * gun.spread;
  const pitch = Math.max(-1.55, Math.min(1.55, finite(rawPitch))) + (Math.random() * 2 - 1) * gun.spread;
  const cp = Math.cos(pitch);
  const dx = Math.cos(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = Math.sin(yaw) * cp;
  const ox = p.x;
  const oy = p.y + EYE_H;
  const oz = p.z;

  // The world stops it first: you cannot shoot through a hill.
  const wall = raycast(ox, oy, oz, dx, dy, dz, gun.range);
  let reach = wall ? wall.dist : gun.range;

  let struck: Session | null = null;
  for (const other of sessions.values()) {
    if (other === s || !other.helloDone || other.player.respawn > 0) continue;
    const t = hitBody(ox, oy, oz, dx, dy, dz, other.player, reach);
    if (t === null) continue;
    reach = t;
    struck = other;
  }
  // Creatures are checked against whatever is left of the line, so a zombie standing
  // in front of somebody takes the ball meant for them — which is the entire reason
  // to stand behind one.
  const beast = mobs.hitScan(ox, oy, oz, dx, dy, dz, reach);
  if (beast) {
    reach = beast.t;
    struck = null;
    strike(s, beast.mob, gun.damage);
  } else if (struck) {
    struck.hurtAt = now;
    if (hurt(struck.player, gun.damage)) died(struck, `was shot by ${p.name}`);
  }
  broadcast({
    t: 'shot',
    x: ox, y: oy, z: oz,
    hx: ox + dx * reach, hy: oy + dy * reach, hz: oz + dz * reach,
    hit: !!struck,
  });
}

/**
 * Where a ray crosses somebody's body, or null.
 *
 * A slab test against the box, which is the standard thing and is exact — as opposed
 * to stepping along the ray and asking "am I inside anybody yet", which misses
 * whenever the step is bigger than the target and is how you get a gun that shoots
 * through people at close range.
 */
function hitBody(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  p: Player, maxT: number,
): number | null {
  const h = PLAYER_W / 2;
  const lo = [p.x - h, p.y, p.z - h];
  const hi = [p.x + h, p.y + PLAYER_H, p.z + h];
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let near = 0;
  let far = maxT;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-8) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
      continue;
    }
    let t1 = (lo[a] - o[a]) / d[a];
    let t2 = (hi[a] - o[a]) / d[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near >= 0 && near <= maxT ? near : null;
}

/**
 * Hurt a creature, and deal with what that turns it into.
 *
 * The drop goes straight into the pockets of whoever swung rather than onto the
 * floor, because there is nothing on the floor here to drop it onto — no item
 * entities, no pickups. It is a simplification and it is a visible one, but the
 * alternative is meat you can see and cannot pick up.
 */
function strike(s: Session, m: LiveMob, damage: number): void {
  const out = mobs.hurt(m, damage);
  noise(out.died ? 'mob-die' : 'mob-hurt', m.x, m.y, m.z);
  if (!out.died) return;
  const drop = mobStats(m.kind).drop;
  if (drop) give(s, drop.thing, drop.count);
}

/** Tell everybody a sound happened somewhere. The client decides how loud. */
function noise(what: string, x: number, y: number, z: number): void {
  broadcast({ t: 'noise', what, x, y, z });
}

function broadcast(msg: ServerMsg): void {
  const frame = encode(msg);
  for (const s of sessions.values()) {
    if (s.helloDone && s.socket.readyState === WebSocket.OPEN) s.socket.send(frame);
  }
}

/**
 * The end of a life, and the price of it.
 *
 * EVERYTHING YOU WERE CARRYING IS GONE. That is not cruelty for its own sake: dying
 * puts every health section back, so if death were free then the fastest way to heal
 * a wounded player would be to jump off something. The pockets are what stops that,
 * and they are what makes the choice — push on hurt, or start again clean — an actual
 * choice rather than an obvious one.
 */
function died(s: Session, how: string): void {
  s.slots = emptySlots();
  s.cursor = [null];
  s.wear.clear();
  s.held = AIR;
  sendInventory(s);
  console.log(`[world] ${s.player.name} ${how}, and dropped everything`);
}

function correct(s: Session, x: number, y: number, z: number): void {
  send(s.socket, { t: 'edits', d: [idx(x, y, z), getBlock(x, y, z)] });
}

/**
 * Bring a whole tree down from one cut.
 *
 * Chopping the bottom of a trunk and then having to climb the stump to reach the next
 * eight logs is the single most tedious thing in this genre, and it is tedious because
 * it is not how trees work. One cut fells it.
 *
 * The hard part is not the flood fill — it is telling a TREE from a LOG WALL, because
 * somebody who builds a cabin out of logs must not lose the whole thing to one
 * misplaced click. The test is leaves: a natural tree has a canopy attached and a
 * wall does not, so the group has to be wearing enough leaves to be a tree before any
 * of it comes down. It is the same heuristic every mod that does this settled on, and
 * it is right for the same reason.
 */
function fellTree(s: Session, x: number, y: number, z: number): void {
  const logs: [number, number, number][] = [];
  const leaves: [number, number, number][] = [];
  const seen = new Set<number>();
  const queue: [number, number, number][] = [[x, y, z]];
  seen.add(idx(x, y, z));

  /*
   * Upward and outward only, and bounded on every axis. A trunk grows up, so the cut
   * never travels DOWN into a floor somebody laid — and the caps mean a forest whose
   * canopies happen to touch comes down one tree at a time rather than all at once.
   */
  while (queue.length > 0 && logs.length < TREE_MAX_LOGS) {
    const [cx, cy, cz] = queue.shift()!;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          const nz = cz + dz;
          if (ny < y || ny > y + TREE_MAX_HEIGHT) continue;
          if (Math.abs(nx - x) > TREE_MAX_SPREAD || Math.abs(nz - z) > TREE_MAX_SPREAD) continue;
          const key = idx(nx, ny, nz);
          if (seen.has(key)) continue;
          const b = getBlock(nx, ny, nz);
          if (b !== LOG) continue;
          seen.add(key);
          logs.push([nx, ny, nz]);
          queue.push([nx, ny, nz]);
        }
      }
    }
  }

  // The canopy: leaves touching any of it, including the block that was just cut.
  const nearLogs = [[x, y, z] as [number, number, number], ...logs];
  const leafSeen = new Set<number>();
  for (const [lx, ly, lz] of nearLogs) {
    for (let dx = -TREE_LEAF_REACH; dx <= TREE_LEAF_REACH; dx++) {
      for (let dy = -1; dy <= TREE_LEAF_REACH; dy++) {
        for (let dz = -TREE_LEAF_REACH; dz <= TREE_LEAF_REACH; dz++) {
          const nx = lx + dx;
          const ny = ly + dy;
          const nz = lz + dz;
          /*
           * Bounded against the ORIGINAL cut, not against the log it is hanging off.
           *
           * Without this the canopy search walks two blocks past the outermost branch
           * and starts eating the next tree along — so felling one oak in a wood
           * stripped the leaves off its neighbour and left a bald trunk standing
           * beside the stump.
           */
          if (Math.abs(nx - x) > TREE_MAX_SPREAD + 1 || Math.abs(nz - z) > TREE_MAX_SPREAD + 1) continue;
          const key = idx(nx, ny, nz);
          if (leafSeen.has(key)) continue;
          if (getBlock(nx, ny, nz) !== LEAVES) continue;
          leafSeen.add(key);
          leaves.push([nx, ny, nz]);
        }
      }
    }
  }

  // Not a tree. A stack of logs somebody built with, and it stays where it is.
  if (leaves.length < TREE_MIN_LEAVES) return;

  for (const [lx, ly, lz] of logs) {
    if (!setBlock(lx, ly, lz, AIR)) continue;
    record(lx, ly, lz, AIR);
    give(s, LOG, 1);
  }
  for (const [lx, ly, lz] of leaves) {
    if (!setBlock(lx, ly, lz, AIR)) continue;
    record(lx, ly, lz, AIR);
    /*
     * A sapling from about one leaf in eight, chosen by WHERE the leaf was rather
     * than by chance. A whole canopy paying out one sapling each would be forty of
     * them from one tree; and hashing the position rather than rolling a die means
     * the same tree always gives the same number, which is a thing you can learn.
     */
    if (leafHash(lx, ly, lz) < 0.13) give(s, SAPLING, 1);
  }
  noise('break', x, y, z);
  console.log(`[world] ${s.player.name} felled a tree: ${logs.length + 1} logs, ${leaves.length} leaves`);
}

/** Deterministic, so the same tree always gives the same saplings. */
function leafHash(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Note a block change in the edit list and on the wire. */
function record(x: number, y: number, z: number, block: number): void {
  const i = idx(x, y, z);
  if (block === pristineBlock(i)) edits.delete(i);
  else edits.set(i, block);
  pending.push(i, block);
  saveDirty = true;
}

/**
 * Blunt whatever they just dug with, and throw it away when it is finished.
 *
 * Wear is per KIND, so "the axe you are using" is the only one with a number beside
 * it. When it runs out the count drops by one and the next one starts fresh, which
 * is what somebody with two axes would expect to happen without ever thinking about
 * it. Bare hands wear out at exactly the rate hands do.
 */
/** Put a gathered thing on the list to come back. Only the loose ones regrow. */
function scheduleRegrow(x: number, y: number, z: number, block: number): void {
  if (block !== PEBBLES && block !== STICKS && block !== BERRY_BUSH && block !== MUSHROOM && block !== TALL_GRASS) {
    return;
  }
  regrowing.set(idx(x, y, z), { at: performance.now() + REGROW_MS, block });
}

/** Turn any sapling whose time has come into a tree. */
function stepGrowth(now: number): void {
  for (const [index, at] of growing) {
    if (now < at) continue;
    growing.delete(index);
    const { x, y, z } = unpackIndex(index);
    if (getBlock(x, y, z) !== SAPLING) continue;
    // Needs headroom and something to stand in. A sapling under a ceiling stays a
    // sapling rather than growing a tree through somebody's floor.
    let clear = true;
    for (let dy = 0; dy < 7 && clear; dy++) {
      for (let dx = -2; dx <= 2 && clear; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = getBlock(x + dx, y + dy, z + dz);
          if (b !== AIR && b !== SAPLING && b !== LEAVES) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) {
      growing.set(index, now + 60_000);
      continue;
    }
    const trunk = 4 + Math.floor(Math.random() * 3);
    for (let dy = 0; dy < trunk; dy++) placeGrown(x, y + dy, z, LOG);
    for (let dy = -2; dy <= 2; dy++) {
      const ly = y + trunk + dy - 1;
      const r = dy >= 1 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (Math.abs(dx) === r && Math.abs(dz) === r && Math.random() < 0.5) continue;
          if (getBlock(x + dx, ly, z + dz) === AIR) placeGrown(x + dx, ly, z + dz, LEAVES);
        }
      }
    }
    noise('place', x, y, z);
  }
}

/** Put a block down the way growth does: no owner, no cost, but everybody sees it. */
function placeGrown(x: number, y: number, z: number, block: number): void {
  if (!setBlock(x, y, z, block)) return;
  record(x, y, z, block);
}

/** Anything whose time is up, if the spot is still empty. */
function stepRegrowth(now: number): void {
  for (const [index, entry] of regrowing) {
    if (now < entry.at) continue;
    regrowing.delete(index);
    const { x, y, z } = unpackIndex(index);
    // Somebody may have built here, or dug the ground out from under it. A berry bush
    // reappearing inside a wall would be worse than one that never came back.
    if (getBlock(x, y, z) !== AIR) continue;
    if (!blockDef(getBlock(x, y - 1, z)).solid) continue;
    if (!setBlock(x, y, z, entry.block)) continue;
    const i = idx(x, y, z);
    if (entry.block === pristineBlock(i)) edits.delete(i);
    else edits.set(i, entry.block);
    pending.push(i, entry.block);
    saveDirty = true;
  }
}

function wearTool(s: Session): void {
  const tool = itemDef(s.held)?.tool;
  if (!tool) return;
  const spent = (s.wear.get(s.held) ?? 0) + 1;
  if (spent < tool.uses) {
    s.wear.set(s.held, spent);
    return;
  }
  s.wear.delete(s.held);
  const broken = s.held;
  take(s, broken, 1);
  if (countOf(s.slots, broken) === 0) s.held = AIR;
  console.log(`[world] ${s.player.name} wore out a ${thingDef(broken).name}`);
}

function give(s: Session, b: number, n: number): void {
  giveInto(s.slots, b, n);
  sendInventory(s);
}

function take(s: Session, b: number, n: number): void {
  takeFrom(s.slots, b, n);
  sendInventory(s);
}

/**
 * The recipe book: make one, straight out of the pockets, without laying it out.
 *
 * The grid is the real thing and this is the shortcut beside it — the same choice
 * Minecraft made when it added a recipe book, and for the same reason: knowing the
 * pattern should be optional, and once you have made forty pickaxes, arranging the
 * forty-first is not the interesting part.
 */
function craft(s: Session, r: unknown): void {
  const i = int(r);
  if (i === null || i < 0 || i >= RECIPES.length) return;
  const recipe = RECIPES[i];
  if (!canCraft(asMap(s.slots), recipe)) return;
  // Smelting wants a furnace within reach. Checked here rather than trusted, like
  // everything else a client could simply assert.
  if (recipe.near !== undefined && !blockNear(s.player.x, s.player.y, s.player.z, recipe.near, NEAR_RADIUS)) return;
  for (const [id, n] of ingredientsOf(recipe)) takeFrom(s.slots, id, n);
  giveInto(s.slots, recipe.gives[0], recipe.gives[1]);
  sendInventory(s);
}

/**
 * A click in the inventory window. The server does all of it.
 *
 * Every rule about what a click means lives here rather than in the browser, because
 * a client that decided its own slot moves could put a diamond block in an empty slot
 * and keep the one it came from. What the client sends is which slot and which button.
 */
function slotClick(s: Session, rawSlot: unknown, right: boolean, shift: boolean): void {
  const slot = int(rawSlot);
  if (slot === null || slot < 0 || slot >= SLOT_COUNT) return;
  /*
   * Smelting cannot be laid out in the grid — there is no arrangement of iron ore and
   * coal that means "melt this" — so the output slot only ever offers the shaped and
   * shapeless recipes. The furnace check happens in the recipe book, above.
   */
  const changed = shift ? shiftClick(s.slots, slot) : click(s.slots, s.cursor, slot, right);
  if (slot >= GRID_START || slot === OUTPUT) refreshOutput(s.slots);
  if (changed) sendInventory(s);
}

/**
 * Eat something out of your own pocket.
 *
 * Refused when you are already full, so a berry is never wasted on a stomach that had
 * no room for it — which is the sort of small mercy that stops a survival game feeling
 * like it is out to get you.
 */
function eat(s: Session, raw: unknown): void {
  const thing = int(raw);
  if (thing === null || countOf(s.slots, thing) <= 0) return;
  const food = itemDef(thing)?.food;
  if (!food) return;
  if (!feed(s.player, food.fills, food.heals)) return;
  take(s, thing, 1);
}

function sendInventory(s: Session): void {
  refreshOutput(s.slots);
  const held = s.cursor[0];
  send(s.socket, { t: 'inv', d: packSlots(s.slots), cur: held ? [held.t, held.n] : [] });
}

// ---------------------------------------------------------------------------
// The world loop

let lastAt = performance.now();
const startedAt = Date.now();

setInterval(() => {
  const now = performance.now();
  // Real measured delta, clamped so a GC pause cannot teleport everybody.
  const dt = Math.min(0.25, Math.max(0, (now - lastAt) / 1000));
  lastAt = now;
  tick += 1;

  const live = [...sessions.values()];
  for (const s of live) {
    stepHealth(s.player, dt, (now - s.hurtAt) / 1000);
    // Gravity still applies to somebody who has gone quiet — they should land, not
    // hang in the air — but they do not keep walking. See `Session.heardAt`.
    const listening = now - s.heardAt < INPUT_TIMEOUT_MS;
    const inp = listening
      ? { fwd: s.fwd, strafe: s.strafe, jump: s.jump, sprint: s.sprint }
      : { fwd: 0, strafe: 0, jump: false, sprint: false };
    step(s.player, inp, dt);
    s.jump = false; // consumed — see `Session.jump`
    /*
     * What the landing cost, decided here and nowhere else.
     *
     * `step` ran on the client too and worked out the same distance — that part is
     * pure kinematics and both machines agree about it. Turning it into damage is
     * the server's alone, which is why the two are separate: the physics can be
     * shared without the health being predictable.
     */
    const damage = fallDamage(s.player);
    if (damage > 0) {
      s.hurtAt = now;
      if (hurt(s.player, damage)) died(s, 'came down too hard');
    }
    stepHunger(s.player, dt, s.working);
    s.working = false;
    if (s.player.hunger <= 0 && s.player.hp <= 0.5) {
      s.hurtAt = now;
      if (hurt(s.player, 999)) died(s, 'starved');
    }
    // Ten seconds down, then back at the start of the island, whole.
    if (s.player.respawn > 0 && s.player.respawn <= dt) revive(s.player, spawnPoint(Math.random()));
  }
  stepRegrowth(now);
  stepGrowth(now);

  /*
   * The creatures, after the people. They chase where players ARE this tick rather
   * than where they were last one, which is the difference between a zombie that
   * follows you and one that follows where you have just been.
   */
  const day = dayFraction();
  mobs.tick(dt, now, live.map((s) => s.player));

  // Serialise once, send to everyone. Every socket gets identical bytes.
  const players = live.map((s) => s.player);
  const frame = encode({ t: 'state', tick, day, players, mobs: mobs.snapshot() });
  const changes = pending.length > 0 ? encode({ t: 'edits', d: pending }) : null;
  pending = [];
  for (const s of live) {
    if (s.socket.readyState !== WebSocket.OPEN) continue;
    s.socket.send(frame);
    if (changes) s.socket.send(changes);
  }
}, TICK_MS);

/**
 * Where the sun is, 0..1 across a whole day.
 *
 * Driven by the wall clock rather than by the tick count, so a server that stalled
 * for a minute does not owe anybody a minute of daylight, and two servers restarted
 * at different times still agree on roughly what time it is. It starts a third of
 * the way through the morning, because arriving in the dark is a bad opening.
 */
function dayFraction(): number {
  // `WORLD_TIME=0.9` pins it, which is the only way to look at the stars without
  // waiting six minutes for them, and the only way to screenshot a sunset twice.
  if (FIXED_TIME !== null) return FIXED_TIME;
  return (((Date.now() - startedAt) / DAY_MS) + 0.28) % 1;
}

const FIXED_TIME = (() => {
  const n = Number.parseFloat(process.env.WORLD_TIME ?? '');
  return Number.isFinite(n) ? ((n % 1) + 1) % 1 : null;
})();

// ---------------------------------------------------------------------------
// The save file
//
// One flat array of [index, block, …] — the same shape that goes on the wire, for
// the same reason: it is three times smaller than the readable version and there
// are tens of thousands of them.

/**
 * What the save file is, and why it is not just a list of numbers.
 *
 * A world is stored as differences from the generated terrain: `[index, block, …]`.
 * Which means a saved world is only meaningful next to two other things — the block
 * ids it was written with, and the generator that made the terrain it is a difference
 * FROM. So both travel with it.
 *
 *  - `blocks` is the id→name table at the time of writing. On load the ids are
 *    remapped by NAME, so adding, removing or renumbering blocks in a later version
 *    migrates the world instead of turning everybody's house into a different house.
 *  - `gen` is the generator's version. Changing how terrain is made does not
 *    invalidate the edits — they are absolute positions — but it does mean they are
 *    now differences from a landscape that no longer exists, so it says so loudly.
 *
 * This is the whole point of the format: UPDATING THE GAME MUST NOT COST ANYBODY
 * THEIR WORLD. The protocol version can be bumped as often as it needs to be, every
 * connected client gets told to reload, and what everyone built is still there.
 */
const SAVE_FORMAT = 2;

interface SaveFile {
  save?: number;
  /** Pre-format-2 files carried the protocol version here instead. */
  v?: string;
  gen?: string;
  blocks?: Record<string, string>;
  d?: number[];
  players?: SavedPlayer[];
}

interface SavedPlayer {
  token: string;
  name: string;
  hue: number;
  hp: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Flat [block, count, …], remapped by name on the way in like the world is. */
  have: number[];
  seen: number;
}

function loadWorld(): void {
  let raw: string;
  try {
    raw = readFileSync(SAVE_PATH, 'utf8');
  } catch {
    console.log('[world] no save file — starting from the generated world');
    return;
  }

  /*
   * Keep the last few, before anything is allowed to touch the live one.
   *
   * A world is hours of somebody's evening and it lives in one file that a careless
   * command can remove — which is not a hypothetical: this exact file was deleted
   * once, by me, to get a clean slate for a test, and the only reason it came back
   * was an unrelated copy that happened to be lying around. Three rolling copies is
   * a few kilobytes and it is the difference between a mistake and a disaster.
   */
  for (let i = BACKUPS - 1; i > 0; i--) {
    try {
      renameSync(`${SAVE_PATH}.${i}`, `${SAVE_PATH}.${i + 1}`);
    } catch {
      /* that generation does not exist yet */
    }
  }
  try {
    writeFileSync(`${SAVE_PATH}.1`, raw);
  } catch (err) {
    console.warn(`[world] could not keep a backup: ${(err as Error).message}`);
  }
  let parsed: SaveFile;
  try {
    parsed = JSON.parse(raw) as SaveFile;
  } catch (err) {
    console.warn(`[world] the save file is not readable JSON, leaving it alone: ${(err as Error).message}`);
    return;
  }

  /*
   * Work out how to translate the ids in this file into the ids this build uses.
   *
   * Format 2 and up carry their own table and are remapped by name. Format 1 files
   * carried the protocol version and no table; ids have only ever been APPENDED, so
   * the identity mapping is correct for those and is what they get.
   */
  const remap = new Map<number, number>();
  let dropped = 0;
  if (parsed.blocks) {
    for (const [oldId, name] of Object.entries(parsed.blocks)) {
      const now = thingByName(name);
      if (now === null) {
        dropped += 1;
        continue;
      }
      remap.set(Number(oldId), now);
    }
  }
  const translate = (id: number): number | null => {
    if (!parsed.blocks) return id;
    const now = remap.get(id);
    return now === undefined ? null : now;
  };
  if (dropped > 0) {
    console.warn(`[world] ${dropped} kinds of block no longer exist; anything made of them becomes air`);
  }
  if (parsed.gen && parsed.gen !== GEN_VERSION) {
    console.warn(
      `[world] this world was built on terrain "${parsed.gen}" and this build makes "${GEN_VERSION}". ` +
        'What people changed is kept, but it now sits on a different landscape.',
    );
  }

  const d = parsed.d ?? [];
  let lost = 0;
  for (let i = 0; i + 1 < d.length; i += 2) {
    const b = translate(d[i + 1]);
    if (b === null) {
      lost += 1;
      setBlockRaw(d[i], AIR);
      edits.set(d[i], AIR);
      continue;
    }
    edits.set(d[i], b);
    setBlockRaw(d[i], b);
  }
  /*
   * One relight at the end rather than one per edit. Ten thousand incremental light
   * updates is about four orders of magnitude more work than lighting the whole
   * world once, and the whole world takes a fraction of a second.
   */
  if (d.length > 0) relightAll();

  for (const raw of parsed.players ?? []) {
    const token = sanitizeToken(raw.token);
    if (!token) continue;
    const have: number[] = [];
    for (let i = 0; i + 1 < (raw.have ?? []).length; i += 2) {
      const b = translate(raw.have[i]);
      if (b === null || b === AIR) continue;
      have.push(b, Math.max(0, Math.min(99999, Math.floor(raw.have[i + 1]))));
    }
    profiles.set(token, { ...raw, token, have });
  }

  const version = parsed.save ? `format ${parsed.save}` : `${parsed.v ?? 'format 1'}`;
  console.log(
    `[world] loaded ${edits.size} changed blocks and ${profiles.size} people from ${SAVE_PATH} (${version})` +
      (lost > 0 ? ` — ${lost} blocks were of a kind that no longer exists` : ''),
  );
}

/** Copy everybody who is currently here into their profile, ready to be written out. */
function snapshotProfiles(): void {
  for (const s of sessions.values()) remember(s);
  if (profiles.size <= MAX_PROFILES) return;
  // Oldest first, so the people who actually come back are the people who are kept.
  const order = [...profiles.entries()].sort((a, b) => a[1].seen - b[1].seen);
  for (let i = 0; i < order.length - MAX_PROFILES; i++) profiles.delete(order[i][0]);
}

function remember(s: Session): void {
  if (!s.token || !s.helloDone) return;
  profiles.set(s.token, {
    token: s.token,
    name: s.player.name,
    hue: s.player.hue,
    hp: s.player.hp,
    x: s.player.x,
    y: s.player.y,
    z: s.player.z,
    yaw: s.player.yaw,
    have: packSlots(s.slots),
    seen: Date.now(),
  });
  saveDirty = true;
}

/**
 * Put somebody back where they left off. Returns true if there was anything to put.
 *
 * The position is checked rather than trusted: somebody who logged out standing in a
 * doorway may find that the doorway has been filled in, and dropping them inside it
 * would be a worse welcome than the walk from spawn.
 */
function restore(s: Session): boolean {
  const saved = s.token ? profiles.get(s.token) : undefined;
  if (!saved) return false;
  s.player.hue = saved.hue;
  s.player.hp = Math.max(1, Math.min(MAX_HP, saved.hp || MAX_HP));
  /*
   * Older saves held a bag of [thing, count] pairs rather than slots. Both are flat
   * arrays of pairs, and the difference is only whether zeros are meaningful — so a
   * short one is poured in and a full-length one is read as slots.
   */
  s.slots = emptySlots();
  if (saved.have.length === SLOT_COUNT * 2) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const t = saved.have[i * 2];
      const n = saved.have[i * 2 + 1];
      if (t > 0 && n > 0 && i < GRID_START) s.slots[i] = { t, n };
    }
  } else {
    for (let i = 0; i + 1 < saved.have.length; i += 2) {
      if (saved.have[i + 1] > 0) giveInto(s.slots, saved.have[i], saved.have[i + 1]);
    }
  }
  if (Number.isFinite(saved.yaw)) s.player.yaw = saved.yaw;
  if (canStandAt(saved.x, saved.y, saved.z)) {
    s.player.x = saved.x;
    s.player.y = saved.y;
    s.player.z = saved.z;
    s.player.peakY = saved.y;
  } else {
    console.log(`[world] ${s.player.name} logged out somewhere that is now solid — back to the middle`);
  }
  return true;
}

function saveWorld(): void {
  snapshotProfiles();
  if (!saveDirty) return;
  saveDirty = false;
  const d: number[] = [];
  for (const [index, b] of edits) d.push(index, b);
  const body: SaveFile = {
    save: SAVE_FORMAT,
    gen: GEN_VERSION,
    blocks: thingNames(),
    d,
    players: [...profiles.values()],
  };
  const tmp = `${SAVE_PATH}.tmp`;
  try {
    // Write beside it and rename, so a process killed mid-write leaves the last
    // good save rather than half of a new one.
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, SAVE_PATH);
  } catch (err) {
    console.warn(`[world] could not save: ${(err as Error).message}`);
  }
}

const saver = setInterval(saveWorld, 20_000);
saver.unref?.();

// ---------------------------------------------------------------------------
// Static client (production only)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (decoded.includes('\0')) return sendText(res, 400, 'Bad request');

  const relative = normalize(decoded.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(CLIENT_DIR, relative);
  // Never escape the client directory, whatever the URL claims.
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  let info = await statOrNull(filePath);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await statOrNull(filePath);
  }
  if (!info && extname(filePath) === '') {
    filePath = join(CLIENT_DIR, 'index.html');
    info = await statOrNull(filePath);
  }
  if (!info) return sendText(res, 404, 'Not found');

  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ---------------------------------------------------------------------------

function send(socket: WebSocket, msg: ServerMsg): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
}

function clamp1(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(-1, n));
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A whole number, or null for anything a hostile client might have sent instead. */
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * A token is whatever the browser made up, as long as it is short and boring.
 *
 * It is never shown, never compared to anything but itself, and never used to build
 * a path or a query — so the only rules it needs are "is a string", "is not enormous"
 * and "contains nothing that could confuse a log file".
 */
function sanitizeToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned.length >= 8 ? cleaned : '';
}

function sanitizeName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    // Control characters, written as escapes: literal ones in the source make git
    // treat the whole file as binary and every diff of it useless.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return cleaned || `wanderer-${randomBytes(2).toString('hex')}`;
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function readPort(): number {
  const n = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8081;
}

function shutdown(): void {
  saveWorld();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

http.listen(PORT, '0.0.0.0', () => {
  console.log(`[world] listening on 0.0.0.0:${PORT} (protocol ${PROTOCOL_VERSION}, ${TICK_RATE} Hz)`);
  console.log(`[world] saving changed blocks to ${SAVE_PATH}`);
  if (PRODUCTION) console.log(`[world] serving client from ${CLIENT_DIR}`);
});
