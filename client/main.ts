/**
 * BLOONS WORLD — the client.
 *
 * The loop that ties input, the socket and the renderer together, and the one piece
 * of real netcode in the game:
 *
 *  - YOUR player is predicted locally. The server is authoritative, but waiting a
 *    round trip to start walking feels broken on any connection, so the same
 *    `step` the server runs is run here immediately and the server's answer is
 *    eased in rather than snapped to. You get instant response and still cannot
 *    walk anywhere the server disagrees with.
 *  - EVERYONE ELSE is interpolated between the last two snapshots, held
 *    INTERP_DELAY_MS in the past so there is always a pair to interpolate between.
 *    Drawing them at the newest position instead means stuttering on every late
 *    packet.
 *
 * It also owns which VIEW you are in. First person is a camera and a control
 * mapping and nothing more: `worldMove` folds "forward and to my right" back into
 * the same world-space vector the top-down view sends, so both views produce
 * identical traffic and the netcode above never learns there are two of them.
 */

import { INPUT_RATE, INTERP_DELAY_MS, MAX_HP, clampToWorld, step } from '../shared/world.js';
import type { Player } from '../shared/world.js';
import { EYE_H, yawOf } from './fp.js';
import type { Eye } from './fp.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Menu } from './menu.js';
import { Net } from './net.js';
import { Renderer } from './render.js';

const NAME_KEY = 'world.name';

const root = document.getElementById('app');
if (!root) throw new Error('world: missing #app');

const renderer = new Renderer();
root.appendChild(renderer.el);
const input = new Input(root);
const net = new Net(loadName());
const hud = new Hud(root);

/*
 * The name box.
 *
 * This used to be a `prompt()` at module top level, which was a black screen: the
 * dialog blocks before the canvas is even created, so if it was suppressed, hidden
 * behind the window or dismissed oddly, there was nothing on the page at all and no
 * clue why. Nothing should stand between opening the page and seeing the world.
 */
const nameBox = document.createElement('input');
nameBox.className = 'namebox';
nameBox.maxLength = 16;
nameBox.spellcheck = false;
nameBox.setAttribute('aria-label', 'your name');
nameBox.value = loadName();
root.appendChild(nameBox);

const commitName = () => {
  const clean = nameBox.value.trim().slice(0, 16);
  if (!clean) {
    nameBox.value = me.name;
    return;
  }
  nameBox.value = clean;
  me.name = clean;
  saveName(clean);
  net.rename(clean);
};
nameBox.addEventListener('change', commitName);
nameBox.addEventListener('blur', commitName);
nameBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameBox.blur();
});

/*
 * The title screen. It owns the socket's start: nothing is connected until
 * ENTER WORLD is pressed, so nobody stands at spawn while their player is still
 * reading the front of the game.
 */
const menu = new Menu(loadName());
root.appendChild(menu.el);
root.classList.add('title');
/** True once the first snapshot has landed and the title has been taken away. */
let entered = false;
// Keys and thumbstick are dead while the title is up: WASD typed at the name
// field must not also be walking somebody around behind it.
input.setEnabled(false);

/**
 * Leave the title. Deliberately called from the first snapshot rather than from
 * the button — the world is on screen the instant the title stops covering it,
 * instead of a grey field for however long the socket takes.
 */
function enterWorld(): void {
  if (entered) return;
  entered = true;
  menu.dismiss();
  root!.classList.remove('title');
  input.setEnabled(true);
}

menu.onEnter = (chosen) => {
  me.name = chosen;
  nameBox.value = chosen;
  saveName(chosen);
  // Before the socket exists this only updates the name `hello` will carry;
  // `Net.rename` drops the message while offline rather than queueing it.
  net.rename(chosen);
  net.connect();
};

net.onStatus = (s, detail) => {
  hud.setStatus(s, detail);
  menu.setStatus(s, detail);
};

/** Our predicted position. Reconciled toward the server every snapshot. */
const me: Player = {
  id: '',
  name: loadName(),
  x: 0,
  y: 0,
  dir: 'down',
  moving: false,
  z: 0,
  vz: 0,
  hue: 0,
  hp: MAX_HP,
};
let seeded = false;

let lastInputAt = 0;
let lastFrame = performance.now();
/**
 * How much of the server's disagreement to swallow per second.
 *
 * This used to be a flat 12% PER FRAME, which meant a 144 Hz screen reconciled two
 * and a half times faster than a 60 Hz one and a dropped frame reconciled less —
 * the correction speed was whatever the monitor happened to be. Exponential decay
 * over the real elapsed time gives every machine the same curve, which is one of
 * the two things that were actually making the walk shimmer.
 */
const CATCH_UP_RATE = 8;
/** A jump waiting for the next input frame, and one for the local prediction. */
let jumpPending = false;
let predictJump = false;
/**
 * Whether you are standing in the world or looking down at it.
 *
 * This is a CLIENT choice and nothing else knows about it. The controls are mapped
 * back into the same world-space vector before anything is sent, so the server, the
 * protocol and everybody else's screen cannot tell the two apart — which is what
 * keeps a second view from being a second game to keep in sync.
 */
let firstPerson = false;

/**
 * The clock the world is DRAWN at, which is not the clock it arrives on.
 *
 * Snapshots are stamped when they land, and when they land is exactly as jittery as
 * the network is: 40ms, then 65, then 45. Interpolating against those stamps hands
 * that jitter straight to everybody's legs. So this advances at real time — smooth
 * by construction — and is only pulled gently toward where the snapshots say it
 * should be. A late packet slows nobody down; it just spends a moment being wrong by
 * a few milliseconds, which is invisible, instead of being right in a way you can
 * see.
 */
let renderAt = 0;
/** How fast that pull is, and the gap at which it gives up and jumps. */
const CLOCK_PULL = 2.2;
const CLOCK_RESYNC_MS = 400;

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  input.update(dt);

  const target = (net.last?.at ?? now) - INTERP_DELAY_MS;
  if (renderAt === 0) renderAt = target;
  renderAt += dt * 1000;
  const drift = target - renderAt;
  // A backgrounded tab, a long stall, or a fresh connection: too far to walk back.
  if (Math.abs(drift) > CLOCK_RESYNC_MS) renderAt = target;
  else renderAt += drift * (1 - Math.exp(-CLOCK_PULL * dt));

  if (input.takeViewToggle()) {
    firstPerson = !firstPerson;
    // Arrive facing the way you were already facing. Being spun to face east on
    // the way in costs a second of "which way am I pointed" every single time.
    if (firstPerson) input.yaw = yawOf(me.dir);
    input.setFirstPerson(firstPerson);
    hud.setFirstPerson(firstPerson);
  }
  if (input.takeHelpToggle()) hud.toggleHelp();

  const v = firstPerson ? worldMove(input.moveLocal(), input.yaw) : input.vector();
  // Latched here rather than read inside the timed block below: a jump pressed
  // between two input frames would otherwise be thrown away.
  if (input.takeJump()) {
    jumpPending = true;
    predictJump = true;
  }

  // Post intent at a fixed rate rather than every frame — a 144 Hz screen does not
  // get to send seven times more input than a 20 Hz one.
  if (now - lastInputAt > 1000 / INPUT_RATE) {
    lastInputAt = now;
    net.sendInput(v.x, v.y, jumpPending);
    jumpPending = false;
  }

  const server = net.last?.players.find((p) => p.id === net.id);
  if (server && !seeded) {
    // First snapshot: take the server's spawn wholesale rather than easing to it.
    Object.assign(me, server);
    seeded = true;
    // There is now something to look at, so the title can go.
    enterWorld();
  }
  if (seeded) {
    /*
     * Predict the jump locally too, on the same frame the key went down. The server
     * gets the same press a moment later and lands on the same arc, because both
     * sides run `step`. Waiting for the server to start the hop is the difference
     * between a jump that feels connected to the key and one that does not.
     */
    step(me, v.x, v.y, dt, predictJump);
    predictJump = false;
    if (server) {
      /*
       * Reconcile softly. A hard snap every 50ms is visible as a stutter even when
       * the correction is a single pixel; bleeding off the error exponentially
       * closes a real disagreement in a few frames and hides a rounding one
       * entirely. See `CATCH_UP_RATE` for why it is per second and not per frame.
       */
      const ex = server.x - me.x;
      const ey = server.y - me.y;
      if (Math.hypot(ex, ey) > 24) {
        // Too far to be latency — we were wrong, or we drowned and were moved back
        // to the middle. Accept it.
        me.x = server.x;
        me.y = server.y;
      } else {
        const catchUp = 1 - Math.exp(-CATCH_UP_RATE * dt);
        me.x += ex * catchUp;
        me.y += ey * catchUp;
      }
      me.hue = server.hue;
      me.id = server.id;
      // Health is the server's alone; there is nothing to predict and nothing to
      // ease. It arrives already smooth, because it changes by fractions of a pip.
      me.hp = server.hp;
      /*
       * Height is taken from the server outright rather than eased.
       * A jump is short and its arc is the whole read — easing it produces a
       * visible double-bounce on landing, where the prediction has touched down and
       * the smoothed value is still coming home.
       */
      me.z = server.z;
      me.vz = server.vz;
    }
    const c = clampToWorld(me.x, me.y);
    me.x = c.x;
    me.y = c.y;
  }

  // Nothing to draw behind the title, and the title is opaque — so do not.
  if (!entered) return;
  renderer.draw(worldNow(), net.id, now / 1000, eyeNow(now / 1000));
  hud.setCount(net.last?.players.length ?? 0);
  hud.setHealth(me.hp);
}

/** The camera for the first-person view, or null to look down at the world. */
function eyeNow(time: number): Eye | null {
  if (!firstPerson || !seeded) return null;
  return {
    x: me.x,
    y: me.y,
    yaw: input.yaw,
    pitch: input.pitch,
    // A jump lifts the camera exactly as much as it lifts your sprite on everybody
    // else's screen, so the two views agree about how high two-thirds of a second
    // gets you.
    height: EYE_H + me.z + bob(time),
  };
}

/**
 * A little under a pixel of head movement per footfall.
 *
 * The ground is flat and quiet enough that walking across it can read as gliding.
 * 5 Hz is the rate the legs already swap at, so the bob lands on the steps rather
 * than beside them, and 0.8 world pixels is small enough to be felt rather than
 * watched. Nothing bobs in the air — you are not taking steps up there.
 */
function bob(time: number): number {
  if (!me.moving || me.z > 0.5) return 0;
  return Math.sin(time * Math.PI * 10) * 0.8;
}

/**
 * Turn "forward, and to my right" into "north-east", which is the only thing the
 * wire carries. Your right is a quarter turn clockwise on the map, because the
 * world's y axis points down the screen.
 */
function worldMove(m: { fwd: number; strafe: number }, yaw: number): { x: number; y: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: m.fwd * c - m.strafe * s, y: m.fwd * s + m.strafe * c };
}

/**
 * Everybody, positioned for this instant: remote players interpolated between the
 * last two snapshots, and you from local prediction.
 */
function worldNow(): Player[] {
  const last = net.last;
  if (!last) return seeded ? [me] : [];
  const prev = net.prev ?? last;
  const span = Math.max(1, last.at - prev.at);
  // Against the smoothed render clock, NOT against arrival times. See `renderAt`.
  const t = clamp01((renderAt - prev.at) / span);

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
    });
  }
  if (seeded) out.push(me);
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function loadName(): string {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) return stored;
  } catch {
    /* private mode */
  }
  // Nobody is ever asked for a name before they can see the world. You arrive as
  // somebody, and rename yourself in the corner if you care to.
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
requestAnimationFrame(loop);

// Handy from the console, and what the headless tests read.
(window as unknown as Record<string, unknown>).world = { net, me, input };
