/**
 * BLOONS WORLD — the socket.
 *
 * Same-origin `/ws`: in production one node process serves the page and the socket,
 * and in development vite proxies `/ws` to it. The client is therefore never told
 * where the server is, which is the difference between "open the link" and "also edit
 * a config file".
 *
 * It owns one piece of real work beyond plumbing: the JOIN. The terrain is generated
 * locally from shared code, so joining is not a download of the world — it is a
 * download of everything anybody has done to the world, applied on top of a locally
 * generated copy. That arrives in batches, is applied without lighting, and is lit
 * once at the end. Doing it the other way round — relighting after each of ten
 * thousand edits — takes about four orders of magnitude longer, and looks from the
 * outside exactly like a hang.
 */

import { PROTOCOL_VERSION, decode, encode } from '../shared/protocol.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import type { Player } from '../shared/world.js';
import type { Mob } from '../shared/mobs.js';
import { getBlock, markAllDirty, relightAll, resetToPristine, setBlock, setBlockRaw, unpackIndex } from '../shared/world.js';

/** One snapshot, stamped on arrival so other players can be interpolated. */
export interface Frame {
  at: number;
  tick: number;
  day: number;
  players: Player[];
  mobs: Mob[];
}

export type Status = 'offline' | 'connecting' | 'loading' | 'online';

export class Net {
  id = '';
  status: Status = 'offline';
  /** The last two frames. Two is all interpolation needs. */
  prev: Frame | null = null;
  last: Frame | null = null;
  /** What you are carrying, as flat [block, count, …]. */
  inventory: number[] = [];

  onStatus: ((s: Status, detail: string) => void) | null = null;
  /** Fired once the world is caught up and it is safe to be in it. */
  onReady: (() => void) | null = null;
  /** Fired for every block anybody changes, so the client can spray particles. */
  onEdit: ((x: number, y: number, z: number, was: number, now: number) => void) | null = null;
  /** Fired when the server restates what is in your pockets. */
  onInventory: ((slots: number[], cursor: number[]) => void) | null = null;
  /** Fired for anything the server says made a noise somewhere. */
  onNoise: ((what: string, at: [number, number, number]) => void) | null = null;
  /** Fired when anybody shoots, so every screen draws the tracer. */
  onShot:
    | ((from: [number, number, number], to: [number, number, number], hit: boolean) => void)
    | null = null;
  /** 0..1 while the world is arriving. */
  onProgress: ((fraction: number) => void) | null = null;

  private ws: WebSocket | null = null;
  private retry = 0;
  private name: string;
  private token: string;
  private expectedEdits = 0;
  private receivedEdits = 0;
  private syncing = false;

  constructor(name: string, token: string) {
    this.name = name;
    this.token = token;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.set('connecting', 'finding the world…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.set('offline', 'could not connect');
      this.scheduleRetry();
      return;
    }
    this.ws = socket;

    socket.onopen = () =>
      socket.send(encode({ t: 'hello', name: this.name, version: PROTOCOL_VERSION, token: this.token }));
    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = decode<ServerMsg>(e.data);
      if (msg) this.receive(msg);
    };
    socket.onclose = (e) => {
      this.ws = null;
      // A version mismatch must not retry: the server told us to reload, and a
      // reconnect loop would just spam the same rejection.
      if (e.code === 1002) return this.set('offline', 'out of date — reload the page');
      this.set('offline', 'lost the world — retrying');
      this.scheduleRetry();
    };
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.id = msg.id;
        this.retry = 0;
        this.expectedEdits = msg.edits;
        this.receivedEdits = 0;
        this.syncing = true;
        /*
         * Start from the world as generated, every time.
         *
         * Without this, reconnecting to a server that has been RESTARTED — and so has
         * forgotten every edit — would leave the client holding the ghosts of the old
         * one: holes in the ground the server has filled in and has no idea about,
         * which you would fall into and it would keep pulling you out of.
         */
        resetToPristine();
        this.set('loading', msg.edits > 0 ? 'catching up on the world…' : 'shaping the world…');
        this.onProgress?.(msg.edits === 0 ? 1 : 0);
        return;
      }

      case 'edits': {
        const d = msg.d;
        if (msg.sync) {
          // During the join: raw, no lighting, no meshes. One relight at the end.
          for (let i = 0; i + 1 < d.length; i += 2) setBlockRaw(d[i], d[i + 1]);
          this.receivedEdits += d.length / 2;
          if (this.expectedEdits > 0) this.onProgress?.(this.receivedEdits / this.expectedEdits);
          return;
        }
        // Live: one at a time, with the light and the meshes kept honest.
        for (let i = 0; i + 1 < d.length; i += 2) {
          const { x, y, z } = unpackIndex(d[i]);
          const now = d[i + 1];
          // Read BEFORE the change, so the break spray is the colour of the block
          // that broke rather than of the air that replaced it.
          const was = getBlock(x, y, z);
          if (setBlock(x, y, z, now)) this.onEdit?.(x, y, z, was, now);
        }
        return;
      }

      case 'ready':
        this.syncing = false;
        relightAll();
        markAllDirty();
        this.set('online', 'connected');
        this.onReady?.();
        return;

      case 'state':
        // A snapshot arriving mid-join would put you in a world you have not finished
        // building. There are only a few of them and the next one is 50ms away.
        if (this.syncing) return;
        this.prev = this.last;
        this.last = { at: performance.now(), tick: msg.tick, day: msg.day, players: msg.players, mobs: msg.mobs ?? [] };
        return;

      case 'inv':
        this.inventory = msg.d;
        this.onInventory?.(msg.d, msg.cur ?? []);
        return;

      case 'shot':
        this.onShot?.([msg.x, msg.y, msg.z], [msg.hx, msg.hy, msg.hz], msg.hit);
        return;

      case 'noise':
        this.onNoise?.(msg.what, [msg.x, msg.y, msg.z]);
        return;

      case 'error':
        this.set('offline', msg.message);
        return;

      default:
        return;
    }
  }

  /** Post the current intent. Dropped rather than queued — a stale input is worse. */
  sendInput(
    fwd: number,
    strafe: number,
    yaw: number,
    pitch: number,
    jump: boolean,
    sprint: boolean,
    held: number,
  ): void {
    this.send({ t: 'input', f: fwd, s: strafe, yaw, pitch, jump, sprint, held });
  }

  /** Ask for a block to change. The server decides whether it does. */
  sendEdit(x: number, y: number, z: number, b: number, n: [number, number, number] = [0, 0, 0]): void {
    this.send({ t: 'edit', x, y, z, b, nx: n[0], ny: n[1], nz: n[2] });
  }

  sendCraft(recipe: number): void {
    this.send({ t: 'craft', r: recipe });
  }

  /** Eat what is in the selected slot. The server decides whether there was room. */
  sendEat(thing: number): void {
    this.send({ t: 'eat', b: thing });
  }

  /** Pull the trigger. All the client sends is where the barrel was pointing. */
  sendFire(yaw: number, pitch: number): void {
    this.send({ t: 'fire', yaw, pitch });
  }

  /** Swing at whatever is in front of you. */
  sendMelee(yaw: number, pitch: number): void {
    this.send({ t: 'melee', yaw, pitch });
  }

  /** A click in the inventory window. The server decides what it did. */
  sendSlotClick(slot: number, right: boolean, shift: boolean): void {
    this.send({ t: 'click', slot, right, shift });
  }

  /** The window closed: tip the grid and the cursor back into the pockets. */
  sendClosePack(): void {
    this.send({ t: 'closepack' });
  }

  rename(name: string): void {
    this.name = name;
    this.send({ t: 'rename', name });
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === 'online') this.ws.send(encode(msg));
  }

  private scheduleRetry(): void {
    const delay = Math.min(8000, 500 * 2 ** this.retry);
    this.retry += 1;
    window.setTimeout(() => this.connect(), delay);
  }

  private set(s: Status, detail: string): void {
    this.status = s;
    this.onStatus?.(s, detail);
  }
}
