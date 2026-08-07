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
import { AIR, BLOCKS, RECIPES, blockDef, canCraft } from '../shared/blocks.js';
import {
  DAY_MS,
  EYE_H,
  REACH,
  TICK_MS,
  TICK_RATE,
  bodyOverlapsBlock,
  generate,
  getBlock,
  idx,
  pristineBlock,
  relightAll,
  setBlock,
  setBlockRaw,
  spawnPoint,
  step,
} from '../shared/world.js';
import type { Player } from '../shared/world.js';

const PORT = readPort();
const PRODUCTION = process.env.NODE_ENV === 'production';
const CLIENT_DIR = resolve(process.cwd(), 'dist');
const SAVE_PATH = resolve(process.cwd(), process.env.WORLD_SAVE ?? 'world-edits.json');
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
  /** What they are carrying: block id to count. */
  have: Map<number, number>;
  /** Rate limits. These ARE the anti-cheat for building. */
  digReadyAt: number;
  placeReadyAt: number;
}

const sessions = new Map<string, Session>();
let tick = 0;

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
let saveDirty = false;

// ---------------------------------------------------------------------------
// Boot

generate();
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
    have: new Map(),
    digReadyAt: 0,
    placeReadyAt: 0,
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
    s.helloDone = true;
    sessions.set(s.player.id, s);
    send(s.socket, { t: 'welcome', id: s.player.id, version: PROTOCOL_VERSION, edits: edits.size });
    syncWorld(s);
    sendInventory(s);
    console.log(`[world] ${s.player.name} arrived — ${sessions.size} here, ${edits.size} blocks changed`);
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
      s.heardAt = performance.now();
      // Latched. The tick clears it, so one press is one jump however many input
      // frames carry the flag.
      if (msg.jump === true) s.jump = true;
      return;

    case 'edit':
      applyEdit(s, msg.x, msg.y, msg.z, msg.b);
      return;

    case 'craft':
      craft(s, msg.r);
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

function applyEdit(s: Session, rx: unknown, ry: unknown, rz: unknown, rb: unknown): void {
  const x = int(rx);
  const y = int(ry);
  const z = int(rz);
  const b = int(rb);
  if (x === null || y === null || z === null || b === null) return;
  if (b < 0 || b >= BLOCKS.length) return;

  const p = s.player;
  // Reach, measured from the eye to the middle of the block, with a block of slack
  // for the fact that the position the server has is a moment behind the one the
  // client aimed from.
  const dist = Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + EYE_H), z + 0.5 - p.z);
  if (dist > REACH + 1.2) return correct(s, x, y, z);

  const now = performance.now();
  const existing = getBlock(x, y, z);

  if (b === AIR) {
    const def = blockDef(existing);
    if (existing === AIR || !Number.isFinite(def.hardness)) return correct(s, x, y, z);
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
    s.digReadyAt = now + def.hardness * 1000 * DIG_LENIENCE;
    if (def.drop !== AIR) give(s, def.drop, 1);
  } else {
    if (now < s.placeReadyAt) return correct(s, x, y, z);
    if (!blockDef(existing).replaceable) return correct(s, x, y, z);
    if ((s.have.get(b) ?? 0) <= 0) return correct(s, x, y, z);
    // Never build a block into somebody — including yourself, which is the common
    // case: aim at your own feet and the block would land where you are standing.
    for (const other of sessions.values()) {
      const o = other.player;
      if (bodyOverlapsBlock(o.x, o.y, o.z, x, y, z)) return correct(s, x, y, z);
    }
    if (!setBlock(x, y, z, b)) return correct(s, x, y, z);
    s.placeReadyAt = now + PLACE_COOLDOWN;
    take(s, b, 1);
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
function correct(s: Session, x: number, y: number, z: number): void {
  send(s.socket, { t: 'edits', d: [idx(x, y, z), getBlock(x, y, z)] });
}

function give(s: Session, b: number, n: number): void {
  s.have.set(b, (s.have.get(b) ?? 0) + n);
  sendInventory(s);
}

function take(s: Session, b: number, n: number): void {
  const left = (s.have.get(b) ?? 0) - n;
  if (left > 0) s.have.set(b, left);
  else s.have.delete(b);
  sendInventory(s);
}

function craft(s: Session, r: unknown): void {
  const i = int(r);
  if (i === null || i < 0 || i >= RECIPES.length) return;
  const recipe = RECIPES[i];
  if (!canCraft(s.have, recipe)) return;
  for (const [id, n] of recipe.needs) {
    const left = (s.have.get(id) ?? 0) - n;
    if (left > 0) s.have.set(id, left);
    else s.have.delete(id);
  }
  s.have.set(recipe.gives[0], (s.have.get(recipe.gives[0]) ?? 0) + recipe.gives[1]);
  sendInventory(s);
}

function sendInventory(s: Session): void {
  const d: number[] = [];
  for (const [b, n] of s.have) d.push(b, n);
  send(s.socket, { t: 'inv', d });
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
    // Gravity still applies to somebody who has gone quiet — they should land, not
    // hang in the air — but they do not keep walking. See `Session.heardAt`.
    const listening = now - s.heardAt < INPUT_TIMEOUT_MS;
    const inp = listening
      ? { fwd: s.fwd, strafe: s.strafe, jump: s.jump, sprint: s.sprint }
      : { fwd: 0, strafe: 0, jump: false, sprint: false };
    step(s.player, inp, dt);
    s.jump = false; // consumed — see `Session.jump`
  }

  // Serialise once, send to everyone. Every socket gets identical bytes.
  const players = live.map((s) => s.player);
  const frame = encode({ t: 'state', tick, day: dayFraction(), players });
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

function loadWorld(): void {
  let raw: string;
  try {
    raw = readFileSync(SAVE_PATH, 'utf8');
  } catch {
    console.log('[world] no save file — starting from the generated world');
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { v?: string; d?: number[] };
    if (parsed.v !== PROTOCOL_VERSION) {
      // A block id meant something else in an older protocol, so replaying those
      // numbers would put the wrong things in the right holes.
      console.warn(`[world] save is ${parsed.v}, we speak ${PROTOCOL_VERSION} — ignoring it`);
      return;
    }
    const d = parsed.d ?? [];
    for (let i = 0; i + 1 < d.length; i += 2) {
      edits.set(d[i], d[i + 1]);
      setBlockRaw(d[i], d[i + 1]);
    }
    /*
     * One relight at the end rather than one per edit. Ten thousand incremental
     * light updates is about four orders of magnitude more work than lighting the
     * whole world once, and the whole world takes a fraction of a second.
     */
    if (d.length > 0) relightAll();
    console.log(`[world] loaded ${edits.size} changed blocks from ${SAVE_PATH}`);
  } catch (err) {
    console.warn(`[world] could not read the save file: ${(err as Error).message}`);
  }
}

function saveWorld(): void {
  if (!saveDirty) return;
  saveDirty = false;
  const d: number[] = [];
  for (const [index, b] of edits) d.push(index, b);
  const tmp = `${SAVE_PATH}.tmp`;
  try {
    // Write beside it and rename, so a process killed mid-write leaves the last
    // good save rather than half of a new one.
    writeFileSync(tmp, JSON.stringify({ v: PROTOCOL_VERSION, d }));
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
