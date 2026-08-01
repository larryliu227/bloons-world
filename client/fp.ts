/**
 * BLOONS WORLD — the first-person view.
 *
 * The same world from eye level. There is no second simulation and no second
 * protocol: this is a camera, and `main` maps the controls into the same world-space
 * intent vector the top-down view sends. A player in first person and a player
 * looking down at the map are the same client to the server and to each other.
 *
 * How the picture is made, cheapest thing first:
 *
 *  - The FLOOR is cast, not projected. Every screen row below the horizon is a fixed
 *    distance away, so one divide gives that distance and then the world position
 *    steps linearly across the row — the whole ground is a texture read per pixel
 *    with no geometry at all. It samples `groundPixels()`, so the grass, the sand
 *    and the water underfoot are literally what the top-down view blits.
 *  - The WALL around the world is four line segments and the camera is always inside
 *    them, so a column's wall distance is one slab test — no DDA, no grid march.
 *  - TREES AND PEOPLE are billboards. Nothing can hide behind the wall (everything
 *    is inside it, always), so drawing them far-to-near is the entire depth test.
 *    No z-buffer.
 *
 * Sky and fog are the same colour on purpose. The ground fades into exactly what is
 * above the horizon, so the far edge of the world dissolves instead of ending.
 */

import { BODY_H, BODY_W, WORLD_PX_H, WORLD_PX_W, trees } from '../shared/world.js';
import type { Dir, Player, Tree } from '../shared/world.js';
import {
  EDGE_RGB,
  TREE_H,
  TREE_W,
  groundPixels,
  pack,
  paintPerson,
  treeSprites,
  treeVariant,
  walkFrame,
} from './art.js';

/** Horizontal field of view. Wide enough not to feel like a periscope. */
const FOV = (74 * Math.PI) / 180;
const PLANE = Math.tan(FOV / 2);

/** Eye height above your own feet, in world pixels. A person is 12 tall. */
export const EYE_H = 10;

/**
 * How far the horizon may be shoved from centre, in world pixels.
 *
 * Pitch here is a shear, not a rotation: moving the horizon is an off-axis
 * projection, which stays exact for a floor plane and costs nothing. Past a point it
 * starts to read as a fisheye, and you can also lose the ground entirely — hence a
 * clamp rather than a free axis.
 */
export const PITCH_LIMIT = 110;

/**
 * The wall around the world, in world pixels.
 *
 * Taller than an eye, so it closes the horizon rather than being a kerb — but not so
 * tall that a jump cannot see over it, because finding out there is nothing out
 * there is worth the one line that allows it.
 */
const WALL_H = 26;

/** Where the haze starts and where it is total. */
const FOG_NEAR = 96;
const FOG_FAR = 640;

/**
 * Daylight. The sky is deep overhead and pale at the horizon, and the pale end is
 * also the fog, so distance washes things OUT rather than dimming them — which is
 * what haze actually does, and the only version of it that agrees with there being
 * a sun up there.
 */
const SKY_TOP = { r: 34, g: 62, b: 112 };
/** Also the fog colour — see the file comment. */
const HAZE = { r: 146, g: 172, b: 196 };
const HAZE_PACKED = pack(HAZE.r, HAZE.g, HAZE.b);

/** Where the sun sits, as a compass bearing, and how far above the horizon. */
const SUN_YAW = -1.15;
const SUN_UP = 56;
const SUN_R = 9;
const SUN_GLOW = 46;
const SUN_RGB = { r: 255, g: 232, b: 176 };

/** The sprite is one pixel taller than the body: the forward leg hangs below. */
const SPRITE_H = BODY_H + 1;

/** How many pre-tinted copies of each tree to keep. See `fadedTree`. */
const FOG_STEPS = 8;

/** Where you are and where you are looking. Built by `main` every frame. */
export interface Eye {
  /** World position of your feet — the simulation's, not the camera's. */
  x: number;
  y: number;
  /** Radians. 0 faces +x (east); +y is south, because the screen's y points down. */
  yaw: number;
  /** Horizon shift in world pixels. Positive looks up. See `PITCH_LIMIT`. */
  pitch: number;
  /** Eye height above the ground, including the jump and the walk bob. */
  height: number;
}

/** Where one name label belongs, in canvas pixels. The renderer places the DOM. */
export interface TagSpot {
  id: string;
  x: number;
  y: number;
}

/** One thing standing in the world, already transformed into camera space. */
interface Billboard {
  depth: number;
  screenX: number;
  player: Player | null;
  tree: Tree | null;
}

export class FirstPerson {
  private img: ImageData | null = null;
  private buf = new Uint32Array(0);
  private w = 0;
  private h = 0;
  /** One person is painted here at 1x, then blitted scaled. */
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  /** Reused every frame so a forest is not two hundred fresh objects a frame. */
  private seen: Billboard[] = [];

  constructor() {
    this.scratch = document.createElement('canvas');
    this.scratch.width = BODY_W;
    this.scratch.height = SPRITE_H;
    const ctx = this.scratch.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.sctx = ctx;
  }

  /**
   * Draw the world from `eye`, and return where every visible name belongs.
   *
   * `players` includes you; you are the camera, so you are not drawn.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    eye: Eye,
    players: Player[],
    meId: string,
    time: number,
  ): TagSpot[] {
    if (this.w !== vw || this.h !== vh || !this.img) {
      this.w = vw;
      this.h = vh;
      this.img = new ImageData(vw, vh);
      this.buf = new Uint32Array(this.img.data.buffer);
    }

    /*
     * The camera basis. `dir` is unit and `plane` is perpendicular to it and as long
     * as tan(fov/2), which is what makes every distance below a PERPENDICULAR one:
     * moving t along `dir + plane * camX` always advances exactly t along `dir`. That
     * is also what keeps the walls flat instead of bowing toward the edges.
     */
    const dirX = Math.cos(eye.yaw);
    const dirY = Math.sin(eye.yaw);
    const rightX = -Math.sin(eye.yaw);
    const rightY = Math.cos(eye.yaw);
    const planeX = rightX * PLANE;
    const planeY = rightY * PLANE;
    /** Distance from the eye to the screen, in pixels. */
    const focal = vw / (2 * PLANE);
    const horizon = vh / 2 + eye.pitch;

    this.paintSky(vw, vh, horizon, focal, eye.yaw);
    this.paintFloor(vw, vh, horizon, focal, eye, dirX, dirY, planeX, planeY);
    this.paintWalls(vw, vh, horizon, focal, eye, dirX, dirY, planeX, planeY);
    ctx.putImageData(this.img, 0, 0);

    return this.paintStanding(
      ctx, vw, vh, horizon, focal, eye, players, meId, time, dirX, dirY, planeX, planeY, rightX, rightY,
    );
  }

  /** A gradient, darkest overhead, with the sun wherever you are not looking. */
  private paintSky(vw: number, vh: number, horizon: number, focal: number, yaw: number): void {
    const end = Math.min(vh, Math.max(0, Math.ceil(horizon)));
    for (let y = 0; y < end; y++) {
      // Squared, so the haze hugs the horizon instead of washing out the whole sky.
      const t = clamp01(y / horizon) ** 2;
      const c = pack(
        (SKY_TOP.r + (HAZE.r - SKY_TOP.r) * t) | 0,
        (SKY_TOP.g + (HAZE.g - SKY_TOP.g) * t) | 0,
        (SKY_TOP.b + (HAZE.b - SKY_TOP.b) * t) | 0,
      );
      this.buf.fill(c, y * vw, y * vw + vw);
    }

    /*
     * The sun. It is the one fixed thing in a world with no landmarks — a field of
     * grass looks the same in all four directions, and without something in the sky
     * to steer by, turning around in first person loses you completely.
     *
     * Painted into the sky buffer rather than over the finished frame, so the wall
     * covers it when it has set behind one.
     */
    const delta = wrapAngle(SUN_YAW - yaw);
    if (Math.abs(delta) > 1.3) return;
    const cx = vw / 2 + Math.tan(delta) * focal;
    const cy = horizon - SUN_UP;
    const x0 = Math.max(0, Math.floor(cx - SUN_GLOW));
    const x1 = Math.min(vw, Math.ceil(cx + SUN_GLOW));
    const y0 = Math.max(0, Math.floor(cy - SUN_GLOW));
    const y1 = Math.min(Math.min(vh, end), Math.ceil(cy + SUN_GLOW));
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const d = Math.hypot(dx, dy);
        if (d > SUN_GLOW) continue;
        // Solid in the middle, and a glow that falls off fast enough to stay a sun
        // rather than a smear across a quarter of the sky.
        const a = d <= SUN_R ? 1 : (1 - (d - SUN_R) / (SUN_GLOW - SUN_R)) ** 3 * 0.55;
        const i = y * vw + x;
        const c = this.buf[i];
        this.buf[i] =
          ((255 << 24) |
            ((((c >>> 16) & 255) * (1 - a) + SUN_RGB.b * a) << 16) |
            ((((c >>> 8) & 255) * (1 - a) + SUN_RGB.g * a) << 8) |
            ((c & 255) * (1 - a) + SUN_RGB.r * a)) >>>
          0;
      }
    }
  }

  /**
   * The ground, one texture read per pixel.
   *
   * Every pixel in a screen row is the same distance away, so the divide happens
   * once per row and the world position then walks across the row by a constant
   * step. Fog is a per-row constant for the same reason.
   */
  private paintFloor(
    vw: number,
    vh: number,
    horizon: number,
    focal: number,
    eye: Eye,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
  ): void {
    const gp = groundPixels();
    const buf = this.buf;
    const start = Math.max(0, Math.ceil(horizon));

    for (let y = start; y < vh; y++) {
      const p = y + 0.5 - horizon;
      if (p <= 0.0001) continue;
      const dist = (focal * eye.height) / p;
      const row = y * vw;
      const fog = fogAt(dist);
      if (fog >= 0.996) {
        buf.fill(HAZE_PACKED, row, row + vw);
        continue;
      }

      // The world point under the leftmost ray, and the step to the next column.
      let wx = eye.x + (dirX - planeX) * dist;
      let wy = eye.y + (dirY - planeY) * dist;
      const stepX = (2 * planeX * dist) / vw;
      const stepY = (2 * planeY * dist) / vw;

      if (fog <= 0.004) {
        for (let x = 0; x < vw; x++, wx += stepX, wy += stepY) {
          buf[row + x] =
            wx < 0 || wy < 0 || wx >= WORLD_PX_W || wy >= WORLD_PX_H
              ? HAZE_PACKED
              : gp[(wy | 0) * WORLD_PX_W + (wx | 0)];
        }
        continue;
      }

      const keep = 1 - fog;
      const fr = HAZE.r * fog;
      const fg = HAZE.g * fog;
      const fb = HAZE.b * fog;
      for (let x = 0; x < vw; x++, wx += stepX, wy += stepY) {
        if (wx < 0 || wy < 0 || wx >= WORLD_PX_W || wy >= WORLD_PX_H) {
          buf[row + x] = HAZE_PACKED;
          continue;
        }
        const c = gp[(wy | 0) * WORLD_PX_W + (wx | 0)];
        buf[row + x] =
          ((255 << 24) |
            ((((c >>> 16) & 255) * keep + fb) << 16) |
            ((((c >>> 8) & 255) * keep + fg) << 8) |
            ((c & 255) * keep + fr)) >>>
          0;
      }
    }
  }

  /**
   * The wall around the world.
   *
   * The camera is always inside the rectangle — `clampToWorld` guarantees it — so a
   * ray leaves through exactly one of the four sides and finding which is a slab
   * test. Drawn after the floor, which is what hides the ground beyond the edge,
   * except from someone at the top of a jump who has earned the look.
   */
  private paintWalls(
    vw: number,
    vh: number,
    horizon: number,
    focal: number,
    eye: Eye,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
  ): void {
    const buf = this.buf;
    for (let x = 0; x < vw; x++) {
      const camX = (2 * (x + 0.5)) / vw - 1;
      const rx = dirX + planeX * camX;
      const ry = dirY + planeY * camX;

      let dist = Infinity;
      let flat = false; // true when we hit a north/south wall, which is shaded darker
      if (rx > 1e-9) dist = (WORLD_PX_W - eye.x) / rx;
      else if (rx < -1e-9) dist = -eye.x / rx;
      if (ry > 1e-9) {
        const d = (WORLD_PX_H - eye.y) / ry;
        if (d < dist) {
          dist = d;
          flat = true;
        }
      } else if (ry < -1e-9) {
        const d = -eye.y / ry;
        if (d < dist) {
          dist = d;
          flat = true;
        }
      }
      if (!Number.isFinite(dist) || dist <= 0) continue;

      // Where the wall really is, and the part of it that is on screen. Both are
      // needed: the bands below are measured from the true edges, so that walking
      // into a wall does not paint its top lip across the top of the screen.
      const base = Math.round(horizon + (focal * eye.height) / dist);
      const top = Math.round(horizon + (focal * (eye.height - WALL_H)) / dist);
      const y0 = Math.max(0, top);
      const y1 = Math.min(vh, base);
      if (y1 <= y0) continue;

      /*
       * Three bands, not one flat colour. A single slab of the edge colour is the
       * darkest thing on screen and reads as a hole in the world rather than a
       * thing standing in it; a lip along the top and a shadow where it meets the
       * grass give it a near edge and a footing, which is all a wall needs.
       *
       * Brighter than the stripe baked into the ground, too — the same paint
       * catches more light standing up than it does lying down.
       */
      const shade = (flat ? 0.82 : 1) * 1.2;
      const fog = fogAt(dist);
      const r = EDGE_RGB.r * shade;
      const g = EDGE_RGB.g * shade;
      const b = EDGE_RGB.b * shade;
      const face = fogged(r, g, b, fog);
      const lip = fogged(r + 34, g + 38, b + 44, fog);
      const foot = fogged(r * 0.6, g * 0.6, b * 0.6, fog);
      const lipEnd = Math.min(y1, Math.max(y0, top + (dist < 240 ? 2 : 1)));
      const footStart = Math.max(lipEnd, Math.min(y1, base - Math.max(1, Math.round((base - top) * 0.16))));

      for (let y = y0; y < lipEnd; y++) buf[y * vw + x] = lip;
      for (let y = lipEnd; y < footStart; y++) buf[y * vw + x] = face;
      for (let y = footStart; y < y1; y++) buf[y * vw + x] = foot;
    }
  }

  /**
   * Everything standing on the ground — trees and people — as billboards.
   *
   * Each is blitted from a sprite that was rasterised once at 1x, so a tree twenty
   * tiles away is the same tree as one in your face, just fewer pixels of it, which
   * is the whole pixel-art look kept. They go in one list and sort together, because
   * a person behind a tree has to be behind that tree.
   */
  private paintStanding(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    horizon: number,
    focal: number,
    eye: Eye,
    players: Player[],
    meId: string,
    time: number,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
    rightX: number,
    rightY: number,
  ): TagSpot[] {
    const tags: TagSpot[] = [];
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const seen = this.seen;
    seen.length = 0;

    const place = (wx: number, wy: number, player: Player | null, tree: Tree | null): void => {
      const rx = wx - eye.x;
      const ry = wy - eye.y;
      // Cheap square reject before the transform — most of a forest is behind you.
      if (rx * rx + ry * ry > FOG_FAR * FOG_FAR) return;
      const depth = invDet * (-planeY * rx + planeX * ry);
      if (depth <= 1) return; // behind you, or close enough to be inside your head
      if (fogAt(depth) >= 0.985) return; // swallowed by the haze
      const across = invDet * (dirY * rx - dirX * ry);
      const screenX = (vw / 2) * (1 + across / depth);
      // Generous margin: a near tree is wide, and clipping it by its centre pops it.
      if (screenX < -vw || screenX > vw * 2) return;
      seen.push({ depth, screenX, player, tree });
    };

    for (const p of players) {
      if (p.id === meId) continue; // you are the camera
      place(p.x, p.y, p, null);
    }
    for (const t of trees()) place(t.x, t.y, null, t);

    // Far to near. Nothing can be behind the wall, so this is the entire depth test.
    seen.sort((a, b) => b.depth - a.depth);

    ctx.imageSmoothingEnabled = false;
    const sprites = treeSprites();
    for (const item of seen) {
      const { depth, screenX } = item;
      const scale = focal / depth;
      const fog = fogAt(depth);
      /** Screen row of the ground it is standing on — where the shadow goes. */
      const groundY = horizon + eye.height * scale;

      if (item.tree) {
        const w = Math.max(1, Math.round(TREE_W * scale));
        const h = Math.max(1, Math.round(TREE_H * scale));
        const left = Math.round(screenX - w / 2);
        const topY = Math.round(groundY - h);
        if (left > vw || left + w < 0 || topY > vh) continue;
        const shW = Math.max(1, Math.round(w * 0.5));
        ctx.fillStyle = `rgba(0,0,0,${0.24 * (1 - fog)})`;
        ctx.fillRect(Math.round(screenX - shW / 2), Math.round(groundY - Math.max(1, w * 0.09)), shW, Math.max(1, Math.round(w * 0.16)));
        ctx.drawImage(fadedTree(sprites, treeVariant(item.tree.vary), fog), left, topY, w, h);
        continue;
      }

      const p = item.player!;
      const w = Math.max(1, Math.round(BODY_W * scale));
      const h = Math.max(1, Math.round(SPRITE_H * scale));
      /** Their feet, which a jump lifts off the ground. */
      const feetY = groundY - p.z * scale;
      const topY = Math.round(feetY - BODY_H * scale);
      const left = Math.round(screenX - w / 2);
      if (left > vw || left + w < 0 || topY > vh || topY + h < 0) continue;

      // The shadow stays on the ground and shrinks with height — the only cue for
      // how high somebody is, exactly as from above.
      const lift = Math.min(1, p.z / 24);
      const shW = Math.max(1, Math.round(w * 0.8 * (1 - lift * 0.45)));
      const shH = Math.max(1, Math.round(w * 0.22));
      ctx.fillStyle = `rgba(0,0,0,${(0.3 - lift * 0.15) * (1 - fog)})`;
      ctx.fillRect(Math.round(screenX - shW / 2), Math.round(groundY - shH / 2), shW, shH);

      this.sctx.clearRect(0, 0, BODY_W, SPRITE_H);
      paintPerson(this.sctx, 0, 0, p.hue, faceToward(p, eye, rightX, rightY), walkFrame(p, time));
      if (fog > 0.02) {
        // `source-atop` tints the person and not the empty pixels around them, which
        // a rectangle of haze over the billboard would happily also do.
        this.sctx.globalCompositeOperation = 'source-atop';
        this.sctx.fillStyle = `rgba(${HAZE.r},${HAZE.g},${HAZE.b},${fog})`;
        this.sctx.fillRect(0, 0, BODY_W, SPRITE_H);
        this.sctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(this.scratch, left, topY, w, h);

      tags.push({ id: p.id, x: screenX, y: topY - 3 });
    }
    return tags;
  }
}

/**
 * A tree at one of eight fog strengths, rasterised once and kept.
 *
 * A forest is a couple of hundred billboards in a frame. Tinting each one through a
 * scratch canvas the way a person is tinted would be a couple of hundred clears,
 * draws and composites; eight steps is close enough that nobody can see the banding
 * against a haze that is itself a smooth gradient, and it turns all of that into a
 * lookup and a blit.
 */
let faded: HTMLCanvasElement[][] | null = null;
function fadedTree(sprites: HTMLCanvasElement[], variant: number, fog: number): HTMLCanvasElement {
  if (!faded) {
    faded = sprites.map((base) =>
      Array.from({ length: FOG_STEPS }, (_unused, step) => {
        const c = document.createElement('canvas');
        c.width = base.width;
        c.height = base.height;
        const g = c.getContext('2d')!;
        g.drawImage(base, 0, 0);
        const a = step / (FOG_STEPS - 1);
        if (a > 0) {
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = `rgba(${HAZE.r},${HAZE.g},${HAZE.b},${a})`;
          g.fillRect(0, 0, c.width, c.height);
        }
        return c;
      }),
    );
  }
  return faded[variant][Math.min(FOG_STEPS - 1, Math.max(0, Math.round(fog * (FOG_STEPS - 1))))];
}

/**
 * Which way a person is turned, as seen from here.
 *
 * Their `dir` is in world space and comes off the wire; what a billboard needs is
 * which face is pointed at the camera. Dotting their facing against the line to the
 * eye answers front-or-back, and dotting it against the camera's own right vector
 * answers which way their nose points across your screen.
 *
 * Nobody's look direction is on the wire — only the four-way facing the simulation
 * already sets from movement — so someone standing still and turning on the spot in
 * first person looks the same to you as one standing still. Adding a yaw to the
 * protocol would fix that and buy a versioned wire format and a desync surface for
 * a detail on a 10-pixel sprite.
 */
function faceToward(p: Player, eye: Eye, rightX: number, rightY: number): Dir {
  const f = FACING[p.dir];
  const dx = eye.x - p.x;
  const dy = eye.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const toward = (f.x * dx + f.y * dy) / len;
  if (toward > 0.45) return 'down'; // looking at us
  if (toward < -0.45) return 'up'; // looking away
  return f.x * rightX + f.y * rightY > 0 ? 'right' : 'left';
}

const FACING: Record<Dir, { x: number; y: number }> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
};

/**
 * The yaw that looks the way a four-way `dir` points, so dropping into first person
 * faces you where you already were rather than spinning you to face east.
 */
export function yawOf(dir: Dir): number {
  return Math.atan2(FACING[dir].y, FACING[dir].x);
}

/** Fold an angle into [-PI, PI], so "how far apart" is never the long way round. */
function wrapAngle(a: number): number {
  const t = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return t - Math.PI;
}

/** 0 close enough to see plainly, 1 lost in the haze. */
function fogAt(dist: number): number {
  if (dist <= FOG_NEAR) return 0;
  if (dist >= FOG_FAR) return 1;
  return (dist - FOG_NEAR) / (FOG_FAR - FOG_NEAR);
}

/** Blend a colour toward the haze and pack it. */
function fogged(r: number, g: number, b: number, fog: number): number {
  const keep = 1 - fog;
  return pack(
    Math.min(255, r * keep + HAZE.r * fog) | 0,
    Math.min(255, g * keep + HAZE.g * fog) | 0,
    Math.min(255, b * keep + HAZE.b * fog) | 0,
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
