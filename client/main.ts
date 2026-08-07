/**
 * BLOONS WORLD — the client.
 *
 * The loop that ties input, the socket and the renderer together, and the two pieces
 * of real netcode in the game.
 *
 * WALKING is predicted. The server is authoritative, but waiting a round trip to
 * start moving feels broken on any connection, so the same `step` the server runs is
 * run here immediately and the server's answer is eased in rather than snapped to.
 * You get instant response and still cannot walk anywhere the server disagrees with.
 * Everyone ELSE is interpolated between the last two snapshots, held a tenth of a
 * second in the past so there is always a pair to interpolate between.
 *
 * DIGGING is predicted too, and that is a different bet. A block that took a round
 * trip to break would make every swing feel like a request rather than an action, so
 * the block is removed the instant the timer finishes and the server is told after.
 * If it disagrees it sends back what is actually there and the block reappears. That
 * is a visible correction, and it is the right trade: the common case is right and
 * instant, and the rare case is right and late.
 *
 * The inventory is NOT predicted. Being briefly wrong about a pixel is invisible;
 * being briefly wrong about whether you have four planks or three is the sort of
 * thing people notice and remember.
 */

import { AIR, blockDef } from '../shared/blocks.js';
import {
  DAY_MS,
  EYE_H,
  INPUT_RATE,
  INTERP_DELAY_MS,
  PLAYER_H,
  REACH,
  clampToWorld,
  generate,
  getBlock,
  raycast,
  setBlock,
  spawnPoint,
  step,
} from '../shared/world.js';
import type { Hit, Player } from '../shared/world.js';
import * as worldModule from '../shared/world.js';
import * as blockModule from '../shared/blocks.js';
import { buildAtlas } from './atlas.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Menu } from './menu.js';
import { Net } from './net.js';
import { Renderer } from './render.js';

const NAME_KEY = 'world.name';

const root = document.getElementById('app');
if (!root) throw new Error('world: missing #app');

/*
 * The world is built BEFORE the renderer, because the renderer's constructor asks the
 * world for chunks to mesh. A third of a second of terrain generation happens here,
 * behind the title screen, once.
 */
generate();

const renderer = new Renderer();
root.appendChild(renderer.el);
const input = new Input(renderer.el);
const hud = new Hud(root, buildAtlas());
const net = new Net(loadName());

const menu = new Menu(loadName());
root.appendChild(menu.el);
root.classList.add('title');
/** True once the world is on screen and the title has gone. */
let entered = false;
input.setEnabled(false);

menu.onEnter = (chosen) => {
  me.name = chosen;
  saveName(chosen);
  net.rename(chosen);
  net.connect();
};

net.onStatus = (s, detail) => {
  hud.setStatus(s, detail);
  menu.setStatus(s, detail);
};
net.onProgress = (f) => menu.setProgress(f);
net.onInventory = (pairs) => hud.setInventory(pairs);
net.onEdit = (x, y, z, was, now) => {
  // Somebody else's dig, or the server confirming ours. Either way there is a block
  // less in the world and it should look like it went somewhere.
  if (was !== AIR && now === AIR) renderer.burst(x, y, z, was);
};
net.onReady = () => {
  // Drain the world's dirty list into the renderer FIRST: `relightAll` marks every
  // chunk, and a queue that still has them in it when the first frame lands would
  // rebuild the entire world a second time, immediately, for nothing.
  renderer.collectDirty();
  meshing = true;
};
hud.onCraft = (r) => net.sendCraft(r);

/** True while the whole world is being turned into triangles for the first time. */
let meshing = false;

/** Our predicted body. Reconciled toward the server every snapshot. */
const me: Player = {
  id: '',
  name: loadName(),
  ...spawnPoint(0.5),
  vy: 0,
  yaw: 0,
  pitch: 0,
  onGround: false,
  inWater: false,
  moving: false,
  sprinting: false,
  hue: 0,
};
let seeded = false;

let lastInputAt = 0;
let lastFrame = performance.now();
/**
 * How much of the server's disagreement to swallow per second.
 *
 * Exponential decay over the real elapsed time, rather than a flat percentage per
 * frame: a flat percentage means a 144 Hz screen reconciles two and a half times
 * faster than a 60 Hz one and a dropped frame reconciles less, so the correction
 * speed ends up being whatever the monitor happens to be.
 */
const CATCH_UP_RATE = 9;
/** Further than this and it was not latency — we were simply wrong. */
const CATCH_UP_LIMIT = 3.5;

/**
 * The clock the world is DRAWN at, which is not the clock it arrives on.
 *
 * Snapshots are stamped when they land, and when they land is exactly as jittery as
 * the network is: 40ms, then 65, then 45. Interpolating against those stamps hands
 * that jitter straight to everybody's legs. So this advances at real time — smooth by
 * construction — and is only pulled gently toward where the snapshots say it should
 * be. A late packet slows nobody down; it just spends a moment being wrong by a few
 * milliseconds, which is invisible, instead of being right in a way you can see.
 */
let renderAt = 0;
const CLOCK_PULL = 2.2;
const CLOCK_RESYNC_MS = 400;

/** How far through breaking the block under the crosshair, in seconds. */
let digProgress = 0;
/** Which block that is, so looking away starts again rather than carrying on. */
let digTarget = '';
/** Distance walked, for the hand bob. */
let walked = 0;
/** A local day clock, so the sky keeps moving between snapshots. */
let dayAt = 0.3;

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  /*
   * Turn the world into triangles before letting anybody into it.
   *
   * Twelve milliseconds a frame keeps the title screen's progress bar animating
   * while it happens, rather than locking the tab for two seconds and looking like
   * a crash.
   */
  if (meshing) {
    renderer.buildSome(12, me.x, me.y, me.z);
    menu.setProgress(1 - renderer.remaining / renderer.totalChunks, 'building the world…');
    if (renderer.remaining === 0) {
      meshing = false;
      enterWorld();
    }
    return;
  }
  if (!entered) return;
  advanceClock(now, dt);

  // Keep the meshes honest: anything anybody changed since the last frame.
  renderer.collectDirty();
  renderer.buildSome(6, me.x, me.y, me.z);

  const panel = hud.panelOpen;
  if (input.takeInventoryToggle()) {
    hud.toggleInventory();
    // A panel and a caught cursor cannot both be true — you need the pointer to click
    // a recipe, and you need it back in the middle when you close it.
    if (hud.panelOpen && document.pointerLockElement) document.exitPointerLock();
  }
  if (input.takeHelpToggle()) hud.toggleHelp();

  const slot = input.takeSlot();
  if (slot !== null) hud.selectSlot(slot);
  const wheel = input.takeSlotDelta();
  if (wheel !== 0) hud.selectSlot(hud.slot + wheel);

  const m = panel ? { fwd: 0, strafe: 0 } : input.move();
  me.yaw = input.yaw;
  me.pitch = input.pitch;
  const wantJump = !panel && input.jump;
  const wantSprint = !panel && input.sprint;

  if (seeded) {
    const before = { x: me.x, z: me.z };
    step(me, { fwd: m.fwd, strafe: m.strafe, jump: wantJump, sprint: wantSprint }, dt);
    walked += Math.hypot(me.x - before.x, me.z - before.z) * (me.sprinting ? 1.4 : 1) * 6;
    reconcile(dt);
    clampToWorld(me);
  }

  // Post intent at a fixed rate rather than every frame — a 144 Hz screen does not
  // get to send seven times more input than a 20 Hz one.
  if (now - lastInputAt > 1000 / INPUT_RATE) {
    lastInputAt = now;
    net.sendInput(m.fwd, m.strafe, input.yaw, input.pitch, input.takeJump() || wantJump, wantSprint);
  }

  const eyeY = me.y + EYE_H;
  const target = aimedBlock(eyeY);
  if (!panel) {
    dig(target, dt);
    if (input.takePlace()) place(target);
    if (input.takePick() && target) hud.pick(getBlock(target.x, target.y, target.z));
  } else {
    digProgress = 0;
  }

  // The sky runs on a local clock, nudged toward the server's. A snapshot every 50ms
  // is plenty to stay in step and far too coarse to drive a sunset from directly.
  const serverDay = net.last?.day;
  dayAt = (dayAt + dt / (DAY_MS / 1000)) % 1;
  if (serverDay !== undefined) {
    let drift = serverDay - dayAt;
    if (drift > 0.5) drift -= 1;
    if (drift < -0.5) drift += 1;
    dayAt = (dayAt + drift * Math.min(1, dt * 2) + 1) % 1;
  }

  const underwater = blockDef(getBlock(Math.floor(me.x), Math.floor(eyeY), Math.floor(me.z))).liquid;
  renderer.draw(
    {
      x: me.x,
      y: eyeY + bob(),
      z: me.z,
      yaw: input.yaw,
      pitch: input.pitch,
      day: dayAt,
      players: everyone(),
      meId: net.id,
      target,
      breaking: digTime(target) > 0 ? digProgress / digTime(target) : 0,
      held: hud.held(),
      time: now / 1000,
      walking: walked,
      underwater,
    },
    dt,
  );

  hud.tick();
  hud.setHeadcount(net.last?.players.length ?? 1);
  hud.setUnderwater(underwater);
  hud.setDebug(
    `${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(1)} · ${renderer.drawnChunks}/${renderer.totalChunks} chunks · ${clock(dayAt)}`,
  );
}

/**
 * Leave the title. Called once the world is both synced AND meshed, rather than on
 * the button, so the first thing you see is the world and not a grey field for
 * however long the socket and the mesher take.
 */
function enterWorld(): void {
  if (entered) return;
  entered = true;
  menu.dismiss();
  root!.classList.remove('title');
  input.setEnabled(true);
  renderer.resize();
}

// ---------------------------------------------------------------------------
// Walking

function reconcile(dt: number): void {
  const server = net.last?.players.find((p) => p.id === net.id);
  if (!server) return;
  if (!seeded) return;
  const ex = server.x - me.x;
  const ey = server.y - me.y;
  const ez = server.z - me.z;
  if (Math.hypot(ex, ey, ez) > CATCH_UP_LIMIT) {
    me.x = server.x;
    me.y = server.y;
    me.z = server.z;
    me.vy = server.vy;
    return;
  }
  /*
   * Bleed the error off exponentially rather than snapping. A hard correction every
   * 50ms is visible as a stutter even when the disagreement is a centimetre; this
   * closes a real one in a few frames and hides a rounding one entirely.
   *
   * Height is left alone unless it is badly wrong, because a jump is short and its
   * arc is the whole read: easing it produces a visible double-bounce on landing,
   * where the prediction has touched down and the smoothed value is still coming home.
   */
  const catchUp = 1 - Math.exp(-CATCH_UP_RATE * dt);
  me.x += ex * catchUp;
  me.z += ez * catchUp;
  if (Math.abs(ey) > 0.9) me.y += ey * catchUp;
  me.hue = server.hue;
  me.id = server.id;
}

/**
 * Everybody, positioned for this instant.
 *
 * The others are interpolated between the last two snapshots against a smoothed
 * clock. You are not: you come from local prediction, and are appended at the end.
 */
function everyone(): Player[] {
  const last = net.last;
  if (!last) return seeded ? [me] : [];
  const prev = net.prev ?? last;
  const span = Math.max(1, last.at - prev.at);
  const t = Math.min(1, Math.max(0, (renderAt - prev.at) / span));

  const out: Player[] = [];
  for (const p of last.players) {
    if (p.id === net.id) continue;
    const before = prev.players.find((q) => q.id === p.id);
    if (!before) {
      out.push(p); // just appeared — nothing to interpolate from
      continue;
    }
    out.push({
      ...p,
      x: before.x + (p.x - before.x) * t,
      y: before.y + (p.y - before.y) * t,
      z: before.z + (p.z - before.z) * t,
      yaw: before.yaw + shortestTurn(before.yaw, p.yaw) * t,
      pitch: before.pitch + (p.pitch - before.pitch) * t,
    });
  }
  if (seeded) out.push(me);
  return out;
}

/** The short way round, so somebody turning past west does not spin all the way back. */
function shortestTurn(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** A little head movement per footfall, so walking does not read as gliding. */
function bob(): number {
  if (!me.moving || !me.onGround) return 0;
  return Math.sin(walked) * 0.035;
}

// ---------------------------------------------------------------------------
// Digging and building

/** The block the crosshair is on. */
function aimedBlock(eyeY: number): Hit | null {
  const cp = Math.cos(input.pitch);
  return raycast(
    me.x,
    eyeY,
    me.z,
    Math.cos(input.yaw) * cp,
    Math.sin(input.pitch),
    Math.sin(input.yaw) * cp,
    REACH,
  );
}

/** How long this block takes to dig, or 0 if it cannot be dug at all. */
function digTime(target: Hit | null): number {
  if (!target) return 0;
  const def = blockDef(getBlock(target.x, target.y, target.z));
  return Number.isFinite(def.hardness) ? Math.max(0.05, def.hardness) : 0;
}

function dig(target: Hit | null, dt: number): void {
  if (!input.digging || !target) {
    digProgress = 0;
    digTarget = '';
    return;
  }
  const key = `${target.x},${target.y},${target.z}`;
  if (key !== digTarget) {
    // Looking at a different block starts again. Carrying progress across would let
    // you sweep the crosshair over a wall and have it fall apart behind you.
    digTarget = key;
    digProgress = 0;
  }
  const need = digTime(target);
  if (need === 0) return;
  digProgress += dt;
  if (digProgress < need) return;

  const was = getBlock(target.x, target.y, target.z);
  digProgress = 0;
  digTarget = '';
  // Predicted: gone now, told to the server after. See the note at the top of the file.
  setBlock(target.x, target.y, target.z, AIR);
  renderer.burst(target.x, target.y, target.z, was);
  net.sendEdit(target.x, target.y, target.z, AIR);
}

function place(target: Hit | null): void {
  const block = hud.held();
  if (!target || block === AIR) return;
  if (hud.countOf(block) <= 0) return;
  // No face means the ray started inside a block, which is no direction to build in.
  if (target.nx === 0 && target.ny === 0 && target.nz === 0) return;

  const x = target.x + target.nx;
  const y = target.y + target.ny;
  const z = target.z + target.nz;
  if (!blockDef(getBlock(x, y, z)).replaceable) return;
  /*
   * Never build into yourself. The server checks this too — it has to, since it is
   * the one that owns where everybody is — but checking here as well means aiming at
   * your own feet simply does nothing, instead of placing a block, having it come
   * back a moment later, and leaving you standing in a hole you did not dig.
   */
  if (overlapsMe(x, y, z)) return;
  setBlock(x, y, z, block);
  net.sendEdit(x, y, z, block);
}

function overlapsMe(bx: number, by: number, bz: number): boolean {
  const h = 0.32;
  return (
    me.x + h > bx && me.x - h < bx + 1 && me.y + PLAYER_H > by && me.y < by + 1 && me.z + h > bz && me.z - h < bz + 1
  );
}

/** The time of day, as a clock, because "0.63" means nothing to anybody. */
function clock(day: number): string {
  const minutes = Math.floor(day * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The render clock, advanced outside the main body so it is impossible to forget.

function advanceClock(now: number, dt: number): void {
  const target = (net.last?.at ?? now) - INTERP_DELAY_MS;
  if (renderAt === 0) renderAt = target;
  renderAt += dt * 1000;
  const drift = target - renderAt;
  // A backgrounded tab, a long stall, or a fresh connection: too far to walk back.
  if (Math.abs(drift) > CLOCK_RESYNC_MS) renderAt = target;
  else renderAt += drift * (1 - Math.exp(-CLOCK_PULL * dt));

  // The first snapshot with us in it: take the server's spawn wholesale rather than
  // easing to it from wherever the local guess put us.
  const server = net.last?.players.find((p) => p.id === net.id);
  if (server && !seeded) {
    Object.assign(me, server);
    input.yaw = server.yaw;
    seeded = true;
  }
}

// ---------------------------------------------------------------------------

function loadName(): string {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) return stored;
  } catch {
    /* private mode */
  }
  const fresh = `wanderer${Math.floor(Math.random() * 900 + 100)}`;
  saveName(fresh);
  return fresh;
}

function saveName(n: string): void {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode — the name just will not survive a reload */
  }
}

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
// Losing the cursor is how you leave the game for a moment; the panels should not
// stay open over a world you cannot steer.
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) return;
  hud.closePanels();
});

requestAnimationFrame(function first(now: number) {
  lastFrame = now;
  requestAnimationFrame(loop);
});

/*
 * Handy from the console, and what the headless tests read.
 *
 * `blocks` is the shared world module ITSELF rather than a copy of its functions, for
 * two reasons. A test that imports it separately gets a SECOND instance — one that
 * has never generated anything and quietly answers "air" to every question about a
 * world that is plainly on screen. And in a production build there is nothing to
 * import: it is all one bundle, and this is the only door into it. Handing out the
 * live modules is the only way to ask the running game what it actually thinks.
 */
(window as unknown as Record<string, unknown>).world = {
  net,
  me,
  input,
  hud,
  renderer,
  /** Terrain, light, physics: `world.blocks.getBlock(64, 33, 64)`. */
  blocks: worldModule,
  /** What each block id means: `world.kinds.BLOCKS[3].name`. */
  kinds: blockModule,
  /** What the crosshair is on, right now. */
  aim: () => aimedBlock(me.y + EYE_H),
};
