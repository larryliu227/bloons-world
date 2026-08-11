/**
 * BLOONS WORLD — the animals, and what they are doing.
 *
 * All of it is the server's. Animals never appear on the wire as anything but a
 * position and a state; nothing about what they intend leaves this file.
 *
 * There is no pathfinder and there does not need to be one. They amble in a direction
 * for a few seconds, they refuse to walk off anything that would hurt, and they back
 * away from whoever just hit them. That is enough to read as a living thing, and a
 * living thing is all they have to be — nothing here is hunting you.
 */

import { CHICKEN, COW, FLEE, IDLE, Mob, PIG, WALK, mobStats } from '../shared/mobs.js';
import { SEA_LEVEL, WORLD_X, WORLD_Y, WORLD_Z, getBlock, stepMob, surfaceY } from '../shared/world.js';
import type { Body, Player } from '../shared/world.js';
import { BLOCKS } from '../shared/blocks.js';

/** How many animals the island holds at once. */
const MAX_ANIMALS = 40;
/** Nothing appears nearer than this to anybody, or it pops into being in your face. */
const SPAWN_MIN_DIST = 20;
const SPAWN_MAX_DIST = 60;

export interface LiveMob extends Mob, Body {
  bw: number;
  bh: number;
  onGround: boolean;
  inWater: boolean;
  moving: boolean;
  sprinting: boolean;
  fell: number;
  peakY: number;
  vy: number;
  /** Where it is ambling to, and until when. */
  wanderYaw: number;
  wanderUntil: number;
  /** Running away until this moment, having just been hit. */
  fleeUntil: number;
}

export class Mobs {
  private list: LiveMob[] = [];
  private nextId = 1;
  private nextSpawnAt = 0;

  get all(): LiveMob[] {
    return this.list;
  }

  snapshot(): Mob[] {
    return this.list.map((m) => ({
      id: m.id,
      kind: m.kind,
      x: m.x,
      y: m.y,
      z: m.z,
      yaw: m.yaw,
      hp: m.hp,
      state: m.state,
    }));
  }

  tick(dt: number, now: number, players: Player[]): void {
    if (players.length > 0 && now > this.nextSpawnAt) {
      this.nextSpawnAt = now + 9_000;
      this.spawn(players);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.think(this.list[i], dt, now, players)) this.list.splice(i, 1);
    }
  }

  private think(m: LiveMob, dt: number, now: number, players: Player[]): boolean {
    const stats = mobStats(m.kind);
    const nearest = this.nearestPlayer(m, players);
    // Nobody within a hundred blocks: stop simulating it rather than running forty
    // animals in an empty corner of the island forever.
    if (!nearest) return this.list.length < 10;
    if (nearest.dist > 110) return true;

    let fwd = 0;
    if (now < m.fleeUntil) {
      // Away from whoever hit it, flat out.
      m.yaw = Math.atan2(m.z - nearest.p.z, m.x - nearest.p.x);
      fwd = 1;
      m.state = FLEE;
    } else {
      if (now > m.wanderUntil) {
        m.wanderUntil = now + 2000 + Math.random() * 4000;
        m.wanderYaw = Math.random() * Math.PI * 2;
        m.state = Math.random() < 0.4 ? IDLE : WALK;
      }
      if (m.state === WALK) {
        m.yaw = m.wanderYaw;
        fwd = 0.6;
      }
    }

    /*
     * Never walk off anything that would hurt. Checked BEFORE the step rather than
     * after, because a creature that works out it is falling has already fallen — and
     * a field of cows streaming off a cliff one at a time is funny exactly once.
     */
    if (fwd > 0 && this.dropAhead(m)) {
      fwd = 0;
      m.wanderUntil = 0;
    }

    stepMob(m, { fwd, strafe: 0, jump: false, sprint: false }, dt, stats.speed);
    // Falls hurt them exactly as much as they hurt you.
    if (m.fell > 5) {
      m.hp -= (m.fell - 5) * 0.4;
      if (m.hp <= 0) return false;
    }
    return true;
  }

  private nearestPlayer(m: LiveMob, players: Player[]): { p: Player; dist: number } | null {
    let best: Player | null = null;
    let bd = Infinity;
    for (const p of players) {
      if (p.respawn > 0) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { p: best, dist: bd } : null;
  }

  private dropAhead(m: LiveMob): boolean {
    if (!m.onGround) return false;
    const ax = m.x + Math.cos(m.yaw) * (m.bw / 2 + 0.4);
    const az = m.z + Math.sin(m.yaw) * (m.bw / 2 + 0.4);
    for (let d = 1; d <= 4; d++) {
      const b = getBlock(Math.floor(ax), Math.floor(m.y) - d, Math.floor(az));
      if (BLOCKS[b].solid || BLOCKS[b].liquid) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------

  /** A family group, somewhere out of sight. One cow alone on a hill looks like a bug. */
  private spawn(players: Player[]): void {
    if (this.list.length >= MAX_ANIMALS) return;
    const at = this.findSpot(players);
    if (!at) return;
    const kinds = [PIG, COW, COW, CHICKEN];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const want = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < want; i++) {
      const x = at.x + (Math.random() * 2 - 1) * 3;
      const z = at.z + (Math.random() * 2 - 1) * 3;
      const y = surfaceY(Math.floor(x), Math.floor(z));
      if (y <= SEA_LEVEL || y >= WORLD_Y - 2) continue;
      this.add(kind, x, y, z);
    }
  }

  private findSpot(players: Player[]): { x: number; z: number } | null {
    for (let tries = 0; tries < 50; tries++) {
      const anchor = players[Math.floor(Math.random() * players.length)];
      const a = Math.random() * Math.PI * 2;
      const r = SPAWN_MIN_DIST + Math.random() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
      const x = Math.floor(anchor.x + Math.cos(a) * r);
      const z = Math.floor(anchor.z + Math.sin(a) * r);
      if (x < 3 || z < 3 || x >= WORLD_X - 3 || z >= WORLD_Z - 3) continue;
      const y = surfaceY(x, z);
      if (y <= SEA_LEVEL + 1 || y >= WORLD_Y - 2) continue;
      if (players.some((p) => Math.hypot(p.x - x, p.z - z) < SPAWN_MIN_DIST)) continue;
      return { x: x + 0.5, z: z + 0.5 };
    }
    return null;
  }

  private add(kind: number, x: number, y: number, z: number): LiveMob {
    const stats = mobStats(kind);
    const m: LiveMob = {
      id: this.nextId++,
      kind,
      x,
      y,
      z,
      vy: 0,
      yaw: Math.random() * Math.PI * 2,
      hp: stats.hp,
      state: IDLE,
      bw: stats.width,
      bh: stats.height,
      onGround: false,
      inWater: false,
      moving: false,
      sprinting: false,
      fell: 0,
      peakY: y,
      wanderYaw: Math.random() * Math.PI * 2,
      wanderUntil: 0,
      fleeUntil: 0,
    };
    this.list.push(m);
    return m;
  }

  // -------------------------------------------------------------------------

  /**
   * The first animal a ray meets, for a swing or a shot.
   *
   * A slab test against the box, which is exact — as opposed to stepping along the ray
   * and asking "am I inside anything yet", which misses whenever the step is bigger
   * than the target and is how you get a gun that shoots through a chicken.
   */
  hitScan(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number,
  ): { mob: LiveMob; t: number } | null {
    let best: LiveMob | null = null;
    let bt = maxT;
    for (const m of this.list) {
      const h = m.bw / 2;
      const lo = [m.x - h, m.y, m.z - h];
      const hi = [m.x + h, m.y + m.bh, m.z + h];
      const o = [ox, oy, oz];
      const d = [dx, dy, dz];
      let near = 0;
      let far = bt;
      let miss = false;
      for (let a = 0; a < 3 && !miss; a++) {
        if (Math.abs(d[a]) < 1e-8) {
          if (o[a] < lo[a] || o[a] > hi[a]) miss = true;
          continue;
        }
        let t1 = (lo[a] - o[a]) / d[a];
        let t2 = (hi[a] - o[a]) / d[a];
        if (t1 > t2) [t1, t2] = [t2, t1];
        near = Math.max(near, t1);
        far = Math.min(far, t2);
        if (near > far) miss = true;
      }
      if (miss || near < 0 || near > bt) continue;
      bt = near;
      best = m;
    }
    return best ? { mob: best, t: bt } : null;
  }

  /** Damage one. It bolts if it survives. */
  hurt(m: LiveMob, amount: number): { died: boolean } {
    m.hp -= amount;
    if (m.hp <= 0) {
      this.list = this.list.filter((x) => x !== m);
      return { died: true };
    }
    m.fleeUntil = performance.now() + 4000;
    return { died: false };
  }

  clear(): void {
    this.list = [];
  }
}
