/**
 * BLOONS WORLD — the renderer.
 *
 * Owns the one canvas, the one set of name labels, and the scale everything is drawn
 * at. What it draws INTO that canvas is either of two views:
 *
 *  - from above, here — rectangles at 1x scaled up by a whole number with smoothing
 *    off, which is what actually makes something look like pixel art;
 *  - from eye level, in `fp.ts`, when `draw` is handed an `Eye`.
 *
 * Both are the same world at the same instant out of the same art.
 *
 * THE CAMERA IS THE JITTER. Walking is 78 pixels a second and a world pixel is four
 * or five screen pixels, so a camera rounded to whole world pixels shoves the entire
 * scene sideways five pixels at a time, about sixteen times a second. That is not a
 * frame-rate problem and no amount of interpolation fixes it. So the camera keeps
 * its fraction: the scene is drawn at the whole-pixel camera, and the canvas ELEMENT
 * is then slid by the leftover — rounded to whole DEVICE pixels, which keeps every
 * texel landing exactly on the screen grid while cutting the step by the pixel
 * ratio. Crisp, and smooth.
 */

import { BODY_H, BODY_W, MELEE_RANGE, SWING_MS, WORLD_PX_H, WORLD_PX_W, items, trees } from '../shared/world.js';
import type { Player, Tree } from '../shared/world.js';
import {
  TREE_H,
  TREE_W,
  groundCanvas,
  paintItem,
  paintPerson,
  paintStone,
  treeSprites,
  treeVariant,
  walkFrame,
} from './art.js';
import { FirstPerson } from './fp.js';
import type { Eye, TagSpot } from './fp.js';

/**
 * The most world the viewport will ever show, in world pixels.
 *
 * The scale is the smallest whole number that keeps the window inside this, which is
 * what "resolution" means here: a bigger bound means smaller, finer pixels and more
 * world on screen. There is no letterbox — both axes are derived from the window, so
 * a phone in portrait gets a portrait viewport instead of black bars.
 */
const MAX_VIEW_W = 460;
const MAX_VIEW_H = 300;

export class Renderer {
  /** Wrapper holding the canvas and the name-tag layer, so both share a transform. */
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private tagLayer: HTMLElement;
  private tags = new Map<string, HTMLElement>();
  private ctx: CanvasRenderingContext2D;
  /** The VISIBLE viewport in world pixels. The canvas is one pixel bigger — see below. */
  private viewW = 240;
  private viewH = 176;
  private scale = 4;
  /** CSS pixels per device pixel, which is the finest the camera slide can be. */
  private dpr = 1;
  /** The ground, baked once and shared with the first-person view. */
  private ground: HTMLCanvasElement;
  /** Built the first time somebody actually looks through it. */
  private fp: FirstPerson | null = null;
  private slid = '';
  /** The effective camera from the last top-down frame, for `screenOf`. */
  private camX = 0;
  private camY = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view';
    this.el.appendChild(this.canvas);
    /*
     * Names live in the DOM, not on the canvas.
     *
     * Canvas text has to be drawn at world resolution — about five pixels tall —
     * and then upscaled with smoothing off, which turns every letter to mush. A DOM
     * label sits over the same pixels at real CSS size and stays sharp at any zoom,
     * and it costs one div per player.
     */
    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'tags';
    this.el.appendChild(this.tagLayer);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.ground = groundCanvas();
    this.resize();
  }

  resize(): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    /*
     * The smallest WHOLE scale that keeps the view inside the bound above. A
     * fractional scale is what turns crisp pixel art into mush, so the choice is
     * between whole numbers and the bound decides which one.
     */
    this.scale = clamp(Math.ceil(Math.max(cssW / MAX_VIEW_W, cssH / MAX_VIEW_H)), 2, 8);
    this.viewW = Math.ceil(cssW / this.scale);
    this.viewH = Math.ceil(cssH / this.scale);

    // One world pixel of overdraw on the right and bottom, which is the room the
    // camera needs to slide into. Without it, sliding would expose an empty edge.
    this.canvas.width = this.viewW + 1;
    this.canvas.height = this.viewH + 1;
    this.canvas.style.width = `${(this.viewW + 1) * this.scale}px`;
    this.canvas.style.height = `${(this.viewH + 1) * this.scale}px`;
    this.el.style.width = `${this.viewW * this.scale}px`;
    this.el.style.height = `${this.viewH * this.scale}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.slide(0, 0);
  }

  /** How many world pixels are on screen. `main` wants this for the first-person eye. */
  get view(): { w: number; h: number } {
    return { w: this.viewW + 1, h: this.viewH + 1 };
  }

  /**
   * Where a world position lands on screen, in CSS pixels within the stage.
   *
   * `main` needs it to work out the angle from you to the mouse: you are usually in
   * the middle of your own screen, but not against the edge of the world, where the
   * camera stops and you keep walking across it.
   */
  screenOf(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.camX) * this.scale, y: (y - this.camY) * this.scale };
  }

  /**
   * One frame. Pass an `Eye` to stand in the world, or null to look down at it.
   *
   * Either way the labels are placed the same afterwards: the view says where each
   * name landed on the canvas and this puts a crisp div there.
   */
  draw(
    players: Player[],
    meId: string,
    time: number,
    eye: Eye | null,
    stones: readonly { x: number; y: number }[],
    gone: ReadonlySet<number>,
  ): void {
    let spots: TagSpot[];
    if (eye) {
      // Nothing to slide: the first-person camera is never quantised in the first
      // place, because floor casting works in floats all the way down.
      this.slide(0, 0);
      if (!this.fp) this.fp = new FirstPerson();
      spots = this.fp.draw(this.ctx, this.canvas.width, this.canvas.height, eye, players, meId, time, stones, gone);
    } else {
      spots = this.drawFromAbove(players, meId, time, stones, gone);
    }
    this.placeTags(spots, players, meId);
  }

  /** The top-down view: ground blit, then everything standing on it, back to front. */
  private drawFromAbove(
    players: Player[],
    meId: string,
    time: number,
    stones: readonly { x: number; y: number }[],
    gone: ReadonlySet<number>,
  ): TagSpot[] {
    const me = players.find((p) => p.id === meId);
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    // Camera: centred on you and clamped to the world, kept as a float.
    const camXf = clamp((me?.x ?? WORLD_PX_W / 2) - this.viewW / 2, 0, Math.max(0, WORLD_PX_W - this.viewW));
    const camYf = clamp((me?.y ?? WORLD_PX_H / 2) - this.viewH / 2, 0, Math.max(0, WORLD_PX_H - this.viewH));
    const camX = Math.floor(camXf);
    const camY = Math.floor(camYf);
    /*
     * The leftover, quantised to whole device pixels. Sliding the element by this
     * is what makes walking smooth; quantising it to the device grid is what keeps
     * every world pixel landing on an exact multiple of screen pixels rather than
     * being resampled across two of them.
     */
    const grid = this.scale * this.dpr;
    const fx = Math.round((camXf - camX) * grid) / grid;
    const fy = Math.round((camYf - camY) * grid) / grid;
    this.slide(-fx * this.scale, -fy * this.scale);

    this.camX = camX + fx;
    this.camY = camY + fy;

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(this.ground, -camX, -camY);

    /*
     * Berries and stones lie ON the ground rather than standing on it, so they go
     * down before the painter's list and never sort with it — nothing is ever behind
     * a berry.
     */
    const world = items();
    for (let i = 0; i < world.length; i++) {
      if (gone.has(i)) continue;
      const it = world[i];
      const sx = Math.round(it.x - camX);
      const sy = Math.round(it.y - camY);
      if (sx < -8 || sy < -8 || sx > cw + 8 || sy > ch + 8) continue;
      paintItem(ctx, sx, sy, it.kind);
    }

    /*
     * One painter's list for everything that stands up off the ground. Whoever is
     * further down the screen is in front — which is what puts you behind the tree
     * you are standing above and in front of the one you are standing below.
     */
    const sprites = treeSprites();
    const standing: { y: number; tree: Tree | null; player: Player | null }[] = [];
    for (const t of trees()) {
      if (t.x < camX - TREE_W || t.x > camX + cw + TREE_W) continue;
      if (t.y < camY - 4 || t.y > camY + ch + TREE_H) continue;
      standing.push({ y: t.y, tree: t, player: null });
    }
    for (const p of players) standing.push({ y: p.y, tree: null, player: p });
    standing.sort((a, b) => a.y - b.y);

    const spots: TagSpot[] = [];
    for (const item of standing) {
      if (item.tree) {
        const t = item.tree;
        const sx = Math.round(t.x - camX - TREE_W / 2);
        const sy = Math.round(t.y - camY - TREE_H);
        // A pool of shade under the trunk, so it is planted rather than floating.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(sx + 4, Math.round(t.y - camY) - 2, TREE_W - 8, 3);
        ctx.drawImage(sprites[treeVariant(t.vary)], sx, sy);
        continue;
      }
      const p = item.player!;
      this.drawPerson(p, p.x - camX, p.y - camY, time, p.id === meId);
      // Follows the sprite up when they jump, so the tag stays over their head.
      // Measured from the FLOAT camera, because a div can sit on any subpixel it
      // likes and a label that snaps while the world glides is worse than either.
      const lift = p.down > 0 ? 4 : BODY_H + p.z;
      spots.push({ id: p.id, x: p.x - camXf + fx, y: p.y - camYf + fy - lift - 3 });
    }

    // Stones last: they fly over everything, including whoever threw them.
    for (const s of stones) paintStone(ctx, s.x - camX, s.y - camY);
    return spots;
  }

  /** Slide the canvas under the stage's clip. See the file comment. */
  private slide(x: number, y: number): void {
    const t = x === 0 && y === 0 ? 'none' : `translate3d(${x}px, ${y}px, 0)`;
    if (t === this.slid) return;
    this.slid = t;
    this.canvas.style.transform = t;
  }

  /** Position one crisp label per spot, and retire the ones who left or dropped out. */
  private placeTags(spots: TagSpot[], players: Player[], meId: string): void {
    const alive = new Set<string>();
    for (const spot of spots) {
      const p = players.find((q) => q.id === spot.id);
      if (!p) continue;
      alive.add(p.id);
      let tag = this.tags.get(p.id);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'tag';
        this.tagLayer.appendChild(tag);
        this.tags.set(p.id, tag);
      }
      if (tag.textContent !== p.name) tag.textContent = p.name;
      tag.classList.toggle('me', p.id === meId);
      const sx = spot.x * this.scale;
      const sy = spot.y * this.scale;
      tag.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translateX(-50%)`;
      // Cheap cull: a label parked far off-screen still costs layout.
      tag.style.display = sx < -80 || sy < -40 || sx > this.viewW * this.scale + 80 ? 'none' : '';
    }
    for (const [id, el] of this.tags) {
      if (alive.has(id)) continue;
      el.remove();
      this.tags.delete(id);
    }
  }

  /**
   * One person from above: a 10x12 body with a two-frame walk, plus the two things
   * that only make sense looking down — the shadow they cast and the ring that says
   * which one is you.
   */
  private drawPerson(p: Player, sx: number, sy: number, time: number, isMe: boolean): void {
    const ctx = this.ctx;
    const x = Math.round(sx - BODY_W / 2);
    /*
     * The FEET stay where the simulation says. Only the drawing rises, so a jumping
     * player is still standing where their shadow is — which is what everyone reads
     * when judging who is next to what.
     */
    const groundY = Math.round(sy);
    const y = Math.round(sy - BODY_H - p.z);
    if (x < -32 || y < -48 || x > this.canvas.width + 32 || y > this.canvas.height + 48) return;

    /*
     * The shadow stays on the ground and shrinks with height. It is the only cue
     * for how high somebody is — without it a jump is indistinguishable from
     * walking north, because both just move the sprite up the screen.
     */
    const lift = Math.min(1, p.z / 24);
    const shW = Math.max(3, Math.round((BODY_W - 2) * (1 - lift * 0.45)));
    ctx.fillStyle = `rgba(0,0,0,${0.28 - lift * 0.14})`;
    ctx.fillRect(x + 1 + Math.round((BODY_W - 2 - shW) / 2), groundY - 1, shW, 2);

    /*
     * The swing, drawn as an arc of the ground it covers rather than as a weapon.
     * There is nothing in anybody's hand, so what has to read is REACH — the shape
     * on the floor is the honest picture of who was close enough, and it is the
     * same cone the server tested.
     */
    if (p.swing > 0) {
      const a = swingAim(p);
      const fade = Math.min(1, p.swing / (SWING_MS / 1000));
      ctx.strokeStyle = `rgba(255,232,176,${0.5 * fade})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(Math.round(sx), Math.round(sy) - 4, MELEE_RANGE, a - 0.9, a + 0.9);
      ctx.stroke();
    }

    paintPerson(ctx, x, p.down > 0 ? groundY - BODY_H : y, p.hue, p.dir, walkFrame(p, time), p.down > 0);

    if (isMe) {
      // A ring under your own feet — with everybody the same size and shape, this is
      // the only thing that answers "which one am I" in a crowd. It stays on the
      // GROUND, so it doubles as a jump indicator.
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1.5, groundY - 2.5, BODY_W + 2, 4);
    }

    // The name itself is a DOM label — see `placeTags`.
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Which way to draw somebody's swing.
 *
 * The bearing they actually aimed at is not on the wire — only the four-way facing
 * is — so the arc is drawn along that. It is a hair off what the server tested when
 * the swinger was pointing between two compass points with a mouse, and it is the
 * same trade as everything else about aim: a whole float per player per tick, twenty
 * times a second, to make a flourish a few degrees more accurate.
 */
function swingAim(p: Player): number {
  return p.dir === 'right' ? 0 : p.dir === 'down' ? Math.PI / 2 : p.dir === 'left' ? Math.PI : -Math.PI / 2;
}
