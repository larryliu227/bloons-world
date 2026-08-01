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
  HEAL_DELAY_MS,
  MAX_HP,
  TICK_MS,
  TICK_RATE,
  WATER,
  spawnPoint,
  step,
  stepHealth,
  terrainAt,
} from '../shared/world.js';
import type { Player } from '../shared/world.js';

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
  /**
   * When they were last standing in water. Healing waits on this rather than on a
   * flag, so wading in and straight back out does not top you up for free.
   */
  wetAt: number;
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
  // never in a lake, which would be a drowning you did not walk into.
  const at = spawnPoint(Math.random());
  const session: Session = {
    socket,
    inx: 0,
    iny: 0,
    jump: false,
    helloDone: false,
    wetAt: 0,
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
// The world loop

let lastAt = performance.now();

setInterval(() => {
  const now = performance.now();
  // Real measured delta, clamped so a GC pause cannot teleport everybody.
  const dt = Math.min(0.25, Math.max(0, (now - lastAt) / 1000));
  lastAt = now;
  tick += 1;

  for (const s of sessions.values()) {
    step(s.player, s.inx, s.iny, dt, s.jump);
    s.jump = false; // consumed — see `Session.jump`

    /*
     * Health is decided HERE and nowhere else. The client predicts its position
     * because being briefly wrong about a pixel is invisible; it does not predict
     * this, because being briefly wrong about whether somebody drowned is not.
     */
    if (s.player.z <= 0 && terrainAt(s.player.x, s.player.y) === WATER) s.wetAt = now;
    if (stepHealth(s.player, dt, now - s.wetAt)) {
      const back = spawnPoint(Math.random());
      s.player.x = back.x;
      s.player.y = back.y;
      s.player.z = 0;
      s.player.vz = 0;
      s.player.hp = MAX_HP;
      // Dry, or the next tick drowns them again where they stand.
      s.wetAt = now - HEAL_DELAY_MS;
      console.log(`[world] ${s.player.name} washed up back at the middle`);
    }
  }

  // Serialise once, send to everyone. Every socket gets identical bytes.
  const players = [...sessions.values()].map((s) => s.player);
  const frame = encode({ t: 'state', tick, players });
  for (const s of sessions.values()) {
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
