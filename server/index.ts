/**
 * BLOONS WORLD — server.
 *
 * One HTTP server, one WebSocket riding its upgrade, one 20 Hz loop that walks
 * everybody and ships the result. In production the same port serves the built
 * client, so deploying is `npm run build && npm start` and nothing else.
 *
 * There are no rooms. There is one world and everybody is in it.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { PROTOCOL_VERSION, decode, encode } from '../shared/protocol.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import {
  BERRY,
  MAX_CARRY,
  MAX_HP,
  MELEE_COOLDOWN,
  MELEE_DAMAGE,
  PEBBLE_DAMAGE,
  PEBBLE_RANGE,
  PEBBLE_SPEED,
  PEBBLE_HIT_R,
  PICKUP_R,
  REGROW_MS,
  SWING_MS,
  THROW_COOLDOWN,
  TICK_MS,
  TICK_RATE,
  eat,
  hurt,
  inSwing,
  items,
  spawnPoint,
  step,
  stepStone,
  stepTimers,
} from '../shared/world.js';
import type { Player, Stone } from '../shared/world.js';

const PORT = readPort();
const PRODUCTION = process.env.NODE_ENV === 'production';
const CLIENT_DIR = resolve(process.cwd(), 'dist');
const MAX_SOCKETS = 256;
const MAX_MSG_BYTES = 2048;
/** A socket that never says `hello` is dropped rather than held open forever. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const NAME_MAX = 16;

interface Session {
  socket: WebSocket;
  player: Player;
  /** Latest input vector from this client. Applied every tick until it changes. */
  inx: number;
  iny: number;
  /**
   * A jump waiting to be spent on the next tick.
   *
   * Edge-triggered, not level-triggered: the client sets it once per press and the
   * tick consumes it. Holding the key would otherwise re-fire every tick, and while
   * `step` refuses to launch you off the ground twice, the flag would still be true
   * the instant you landed — so you would bunny-hop forever by leaning on space.
   */
  jump: boolean;
  helloDone: boolean;
  /** When they may swing and throw again. Rate limiting IS the anti-cheat here. */
  swingAt: number;
  throwAt: number;
}

const sessions = new Map<string, Session>();
let tick = 0;

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
  // Somewhere dry and clear near the middle, rather than all on one pixel — and
  // never in a lake, which would be a first ten seconds spent wading out of one.
  const at = spawnPoint(Math.random());
  const session: Session = {
    socket,
    inx: 0,
    iny: 0,
    jump: false,
    helloDone: false,
    swingAt: 0,
    throwAt: 0,
    player: {
      id,
      name: 'wanderer',
      x: at.x,
      y: at.y,
      dir: 'down',
      moving: false,
      z: 0,
      vz: 0,
      hue: Math.floor(Math.random() * 360),
      hp: MAX_HP,
      pebbles: 0,
      down: 0,
      swing: 0,
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
    send(s.socket, { t: 'welcome', id: s.player.id, version: PROTOCOL_VERSION });
    console.log(`[world] ${s.player.name} arrived — ${sessions.size} here`);
    return;
  }

  switch (msg.t) {
    case 'input':
      /*
       * Clamped, because this is the one number a client controls and the whole
       * anti-cheat surface of a walking game: unclamped, `{x: 50}` is a speed hack.
       */
      s.inx = clamp1(msg.x);
      s.iny = clamp1(msg.y);
      // Latch it. The tick clears it, so one press is one jump however many input
      // frames carry the flag.
      if (msg.jump === true) s.jump = true;
      return;

    case 'hit':
      swing(s, msg.a);
      return;

    case 'throw':
      lob(s, msg.a);
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
// Fighting
//
// Every one of these decisions is the server's. The client says which way it is
// pointing and nothing else — not whether it may attack, not who was in range, not
// what it cost them. A client that could report its own hits could report all of
// them.

/** Stones in the air, and the counter that names them. */
const stones: Stone[] = [];
let stoneId = 0;

/**
 * Which item indices are picked, and when each grows back.
 *
 * Keyed by index into the shared `items()` list, which both sides generate
 * identically — so what goes on the wire is a handful of numbers rather than three
 * hundred positions twenty times a second.
 */
const takenUntil = new Map<number, number>();

function swing(s: Session, aim: number): void {
  const now = performance.now();
  if (s.player.down > 0 || now < s.swingAt) return;
  s.swingAt = now + MELEE_COOLDOWN * 1000;
  s.player.swing = SWING_MS / 1000;
  const a = safeAngle(aim);
  for (const other of sessions.values()) {
    if (other === s || !other.helloDone) continue;
    if (!inSwing(s.player, a, other.player)) continue;
    if (hurt(other.player, MELEE_DAMAGE)) knockedDown(s.player, other.player);
  }
}

function lob(s: Session, aim: number): void {
  const now = performance.now();
  if (s.player.down > 0 || now < s.throwAt || s.player.pebbles <= 0) return;
  s.throwAt = now + THROW_COOLDOWN * 1000;
  s.player.pebbles -= 1;
  const a = safeAngle(aim);
  stones.push({
    id: ++stoneId,
    by: s.player.id,
    // Leaves the hand, not the feet — otherwise the first thing every stone hits is
    // the ground the thrower is standing on.
    x: s.player.x + Math.cos(a) * 6,
    y: s.player.y + Math.sin(a) * 6,
    vx: Math.cos(a) * PEBBLE_SPEED,
    vy: Math.sin(a) * PEBBLE_SPEED,
    left: PEBBLE_RANGE,
  });
}

function knockedDown(by: Player, who: Player): void {
  console.log(`[world] ${by.name} put ${who.name} on the ground`);
}

/** A finite angle, or straight ahead. `NaN` here would put a stone nowhere at all. */
function safeAngle(a: number): number {
  return Number.isFinite(a) ? a : 0;
}

// ---------------------------------------------------------------------------
// The world loop

let lastAt = performance.now();

setInterval(() => {
  const now = performance.now();
  // Real measured delta, clamped so a GC pause cannot teleport everybody.
  const dt = Math.min(0.25, Math.max(0, (now - lastAt) / 1000));
  lastAt = now;
  tick += 1;

  const live = [...sessions.values()];
  const world = items();

  for (const s of live) {
    stepTimers(s.player, dt);
    if (s.player.down > 0) {
      // Flat on your back: no walking, and the jump you were holding is forgotten.
      s.jump = false;
      continue;
    }
    // Everybody else's body, so people stop at each other instead of overlapping.
    const others = live.filter((o) => o !== s).map((o) => o.player);
    step(s.player, s.inx, s.iny, dt, s.jump, others);
    s.jump = false; // consumed — see `Session.jump`

    // Anything lying where they are walking. Berries are only taken if they would
    // mend something, so a full player walks over them and leaves them for whoever
    // needs one.
    for (let i = 0; i < world.length; i++) {
      if (takenUntil.has(i)) continue;
      const it = world[i];
      if (Math.hypot(it.x - s.player.x, it.y - s.player.y) > PICKUP_R) continue;
      if (it.kind === BERRY) {
        if (eat(s.player)) takenUntil.set(i, now + REGROW_MS);
      } else if (s.player.pebbles < MAX_CARRY) {
        s.player.pebbles += 1;
        takenUntil.set(i, now + REGROW_MS);
      }
    }
  }

  for (const [i, at] of takenUntil) if (now >= at) takenUntil.delete(i);

  // Stones, last, so they meet everybody where this tick left them.
  for (let i = stones.length - 1; i >= 0; i--) {
    const stone = stones[i];
    let spent = !stepStone(stone, dt);
    if (!spent) {
      for (const s of live) {
        if (s.player.id === stone.by || s.player.down > 0) continue;
        if (Math.hypot(s.player.x - stone.x, s.player.y - stone.y) > PEBBLE_HIT_R) continue;
        // A stone passes under somebody at the top of a jump.
        if (s.player.z > 14) continue;
        if (hurt(s.player, PEBBLE_DAMAGE)) {
          const thrower = sessions.get(stone.by);
          if (thrower) knockedDown(thrower.player, s.player);
        }
        spent = true;
        break;
      }
    }
    if (spent) stones.splice(i, 1);
  }

  // Serialise once, send to everyone. Every socket gets identical bytes.
  const players = live.map((s) => s.player);
  const frame = encode({ t: 'state', tick, players, stones, gone: [...takenUntil.keys()] });
  for (const s of live) {
    if (s.socket.readyState === WebSocket.OPEN) s.socket.send(frame);
  }
}, TICK_MS);

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
  createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------------------

function send(socket: WebSocket, msg: ServerMsg): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
}

function clamp1(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(-1, n));
}

function sanitizeName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    // Control characters, written as escapes: literal ones in the source make
    // git treat the whole file as binary and every diff of it useless.
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

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

http.listen(PORT, '0.0.0.0', () => {
  console.log(`[world] listening on 0.0.0.0:${PORT} (protocol ${PROTOCOL_VERSION}, ${TICK_RATE} Hz)`);
  if (PRODUCTION) console.log(`[world] serving client from ${CLIENT_DIR}`);
});
