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
  pebbles: 0,
  down: 0,
  swing: 0,
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

  /*
   * Flat on your back, nothing you press does anything — including here, not just on
   * the server. Predicting a walk the server is going to refuse means two seconds of
   * being dragged back to where you fell, which reads as a broken connection rather
   * than as being knocked down.
   */
  const flat = me.down > 0;
  const v = flat ? ZERO : firstPerson ? worldMove(input.moveLocal(), input.yaw) : input.vector();
  // Latched here rather than read inside the timed block below: a jump pressed
  // between two input frames would otherwise be thrown away.
  if (input.takeJump() && !flat) {
    jumpPending = true;
    predictJump = true;
  }

  /*
   * Attacks go out the INSTANT they are pressed rather than on the next input frame.
   * They are rare, they are edge-triggered, and up to 50ms of delay on a swing is
   * the difference between connecting and watching somebody walk out of range. The
   * server still decides everything about them; all this sends is the bearing.
   */
  if (input.takeHit() && !flat) net.attack('hit', aim());
  if (input.takeThrow() && !flat) net.attack('throw', aim());

  // Post intent at a fixed rate rather than every frame — a 144 Hz screen does not
  // get to send seven times more input than a 20 Hz one.
  if (now - lastInputAt > 1000 / INPUT_RATE) {
    lastInputAt = now;
    net.sendInput(v.x, v.y, jumpPending);
    jumpPending = false;
  }

  // Everybody but you, positioned for this instant. Wanted twice below: once as
  // bodies to bump into, and once to draw.
  const others = worldNow();
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
    // Predicted against everybody else's body too, so walking into somebody stops
    // you here and not a round trip later. The bodies are the interpolated ones,
    // a tenth of a second stale, which reconciliation is exactly what it is for.
    step(me, v.x, v.y, dt, predictJump, others);
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
        // Too far to be latency — we were simply wrong. Accept it.
        me.x = server.x;
        me.y = server.y;
      } else {
        const catchUp = 1 - Math.exp(-CATCH_UP_RATE * dt);
        me.x += ex * catchUp;
        me.y += ey * catchUp;
      }
      me.hue = server.hue;
      me.id = server.id;
      /*
       * Health, stones in hand, the swing and the knockdown are the server's alone.
       * None of it is predicted: being briefly wrong about a pixel is invisible,
       * being briefly wrong about whether a hit landed is not, and a bar that
       * flickered down and back on every mispredicted swing would be worse than one
       * that answers a round trip late.
       */
      me.hp = server.hp;
      me.pebbles = server.pebbles;
      me.down = server.down;
      me.swing = server.swing;
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
  const everyone = seeded ? [...others, me] : others;
  renderer.draw(everyone, net.id, now / 1000, eyeNow(now / 1000), stonesNow(now), net.last?.gone ?? EMPTY);
  hud.setCount(net.last?.players.length ?? 0);
  hud.setHealth(me.hp, me.down > 0);
  hud.setPebbles(me.pebbles);
  input.setPebbles(me.pebbles);
}

/** One empty set and one still vector, rather than a fresh one of each every frame. */
const EMPTY: ReadonlySet<number> = new Set();
const ZERO = { x: 0, y: 0 };

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
 * Everybody ELSE, positioned for this instant, interpolated between the last two
 * snapshots. You are not in here: you come from local prediction, and `me` is
 * appended at the point of drawing.
 */
function worldNow(): Player[] {
  const last = net.last;
  if (!last) return [];
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
  return out;
}

/**
 * Stones in the air, extrapolated forward from the newest snapshot.
 *
 * Not interpolated like people are: a stone crosses eleven pixels a tick, so drawing
 * one a tenth of a second in the past puts it two body-widths behind where it looks
 * like it should be. They fly in a straight line at a known speed, so running that
 * line forward from the last thing the server said is both smoother AND more honest
 * than lagging it — and if it turns out to have already hit somebody, it vanishes,
 * which is what a stone that hit somebody should do anyway.
 */
function stonesNow(now: number): { x: number; y: number }[] {
  const last = net.last;
  if (!last) return [];
  const ahead = Math.max(0, Math.min(0.25, (now - last.at) / 1000));
  return last.stones.map((s) => ({ x: s.x + s.vx * ahead, y: s.y + s.vy * ahead }));
}

/**
 * Which way an attack goes.
 *
 * Standing in the world it is wherever you are looking. From above it is the cursor
 * if there is one, because facing is four-way and a swing is a cone — and failing
 * that, whichever way the sprite is turned, which is all a thumb has to say with.
 */
function aim(): number {
  if (firstPerson) return input.yaw;
  const box = renderer.el.getBoundingClientRect();
  // You are always in the middle of your own screen, except against the world's edge
  // where the camera stops and you walk on across it — so ask the renderer.
  const at = renderer.screenOf(me.x, me.y);
  return input.aimFromCursor(box.left + at.x, box.top + at.y) ?? yawOf(me.dir);
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
