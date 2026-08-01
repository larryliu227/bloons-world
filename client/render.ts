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
 * Both are the same world at the same instant out of the same art. The camera rounds
 * to whole world pixels for the same reason the scale is an integer — a fractional
 * camera makes every straight edge shimmer as you walk.
 */

import { BODY_H, BODY_W, WORLD_PX_H, WORLD_PX_W } from '../shared/world.js';
import type { Player } from '../shared/world.js';
import { groundCanvas, paintPerson, walkFrame } from './art.js';
import { FirstPerson } from './fp.js';
import type { Eye, TagSpot } from './fp.js';

/** How many world pixels tall the viewport is. Everything scales off this. */
const VIEW_H = 176;

export class Renderer {
  /** Wrapper holding the canvas and the name-tag layer, so both share a transform. */
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private tagLayer: HTMLElement;
  private tags = new Map<string, HTMLElement>();
  private ctx: CanvasRenderingContext2D;
  /** Viewport size in WORLD pixels — the canvas backing store is exactly this. */
  private vw = 240;
  private vh = VIEW_H;
  private scale = 3;
  /** The ground, baked once and shared with the first-person view. */
  private ground: HTMLCanvasElement;
  /** Built the first time somebody actually looks through it. */
  private fp: FirstPerson | null = null;

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
    /*
     * Pick the biggest WHOLE-number scale that fits. A fractional scale is what
     * turns crisp pixel art into mush, so it is better to letterbox a few pixels
     * than to draw at 2.7x.
     */
    this.scale = Math.max(2, Math.floor(cssH / VIEW_H));
    this.vh = VIEW_H;
    this.vw = Math.ceil(cssW / this.scale);
    this.canvas.width = this.vw;
    this.canvas.height = this.vh;
    this.canvas.style.width = `${this.vw * this.scale}px`;
    this.canvas.style.height = `${this.vh * this.scale}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * One frame. Pass an `Eye` to stand in the world, or null to look down at it.
   *
   * Either way the labels are placed the same afterwards: the view says where each
   * name landed on the canvas and this puts a crisp div there.
   */
  draw(players: Player[], meId: string, time: number, eye: Eye | null): void {
    let spots: TagSpot[];
    if (eye) {
      if (!this.fp) this.fp = new FirstPerson();
      spots = this.fp.draw(this.ctx, this.vw, this.vh, eye, players, meId, time);
    } else {
      spots = this.drawFromAbove(players, meId, time);
    }
    this.placeTags(spots, players, meId);
  }

  /** The top-down view: ground blit, then everybody, back to front. */
  private drawFromAbove(players: Player[], meId: string, time: number): TagSpot[] {
    const me = players.find((p) => p.id === meId);
    const ctx = this.ctx;

    // Camera: centred on you, clamped to the world, rounded to whole pixels.
    const camX = Math.round(clamp((me?.x ?? WORLD_PX_W / 2) - this.vw / 2, 0, Math.max(0, WORLD_PX_W - this.vw)));
    const camY = Math.round(clamp((me?.y ?? WORLD_PX_H / 2) - this.vh / 2, 0, Math.max(0, WORLD_PX_H - this.vh)));

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, this.vw, this.vh);
    ctx.drawImage(this.ground, -camX, -camY);

    const spots: TagSpot[] = [];
    // Painter's algorithm: whoever is further down the screen is in front.
    for (const p of [...players].sort((a, b) => a.y - b.y)) {
      this.drawPerson(p, p.x - camX, p.y - camY, time, p.id === meId);
      // Follows the sprite up when they jump, so the tag stays over their head.
      spots.push({ id: p.id, x: p.x - camX, y: p.y - camY - BODY_H - p.z - 3 });
    }
    return spots;
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
      tag.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translateX(-50%)`;
      // Cheap cull: a label parked far off-screen still costs layout.
      tag.style.display = sx < -80 || sy < -40 || sx > this.vw * this.scale + 80 ? 'none' : '';
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
    if (x < -32 || y < -48 || x > this.vw + 32 || y > this.vh + 48) return;

    /*
     * The shadow stays on the ground and shrinks with height. It is the only cue
     * for how high somebody is — without it a jump is indistinguishable from
     * walking north, because both just move the sprite up the screen.
     */
    const lift = Math.min(1, p.z / 24);
    const shW = Math.max(3, Math.round((BODY_W - 2) * (1 - lift * 0.45)));
    ctx.fillStyle = `rgba(0,0,0,${0.28 - lift * 0.14})`;
    ctx.fillRect(x + 1 + Math.round((BODY_W - 2 - shW) / 2), groundY - 1, shW, 2);

    paintPerson(ctx, x, y, p.hue, p.dir, walkFrame(p, time));

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
