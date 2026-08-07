/**
 * BLOONS WORLD — everything floating over the world.
 *
 * The crosshair, the hotbar, what you are carrying, what you can make out of it, and
 * the list of what the buttons do. All DOM rather than drawn into the canvas, for one
 * reason: text. Canvas text at this scale is either blurry or enormous, and the
 * hotbar is the part of the screen you actually read.
 *
 * Everything here is written to only when it CHANGES. It is called from inside the
 * frame loop, and setting `textContent` sixty times a second on a string that is the
 * same string sixty times a second is layout work in exchange for nothing.
 */

import { PLACEABLE, RECIPES, blockDef } from '../shared/blocks.js';
import { TEX_SIZE } from './atlas.js';
import type { Status } from './net.js';

/** How many slots the hotbar has. Nine, and the keys 1 to 9 pick them. */
export const HOTBAR_SLOTS = 9;

const TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;

export class Hud {
  /** Which slot is selected, 0..8. */
  slot = 0;
  /** What is in each slot: a block id, or 0 for empty. */
  bar: number[] = new Array(HOTBAR_SLOTS).fill(0);
  /** Fired when the player asks to make something. */
  onCraft: ((recipe: number) => void) | null = null;

  private atlas: Uint8Array;
  private cells: HTMLElement[] = [];
  private counts: HTMLElement[] = [];
  private label: HTMLElement;
  private status: HTMLElement;
  private headcount: HTMLElement;
  private debug: HTMLElement;
  private panel: HTMLElement;
  private carrying: HTMLElement;
  private recipeList: HTMLElement;
  private helpPanel: HTMLElement;
  private helpBtn: HTMLButtonElement;
  private wet: HTMLElement;

  private have = new Map<number, number>();
  private icons = new Map<number, string>();
  private shownLabel = '';
  private shownStatus = '';
  private shownCount = -1;
  private shownDebug = '';
  private shownBar = '';
  private shownWet = false;

  constructor(root: HTMLElement, atlas: Uint8Array) {
    this.atlas = atlas;

    // The crosshair. `mix-blend-mode: difference` in the stylesheet is what makes it
    // visible against both a sunlit field and the inside of a cave without ever
    // needing to know which one you are looking at.
    div('crosshair', root);

    this.headcount = div('headcount', root);
    this.status = div('status', root);
    this.debug = div('debug', root);
    this.wet = div('wet', root);
    this.wet.hidden = true;

    const bar = div('hotbar', root);
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const cell = document.createElement('div');
      cell.className = 'slot';
      const icon = document.createElement('i');
      cell.appendChild(icon);
      const count = document.createElement('b');
      cell.appendChild(count);
      const key = document.createElement('u');
      key.textContent = String(i + 1);
      cell.appendChild(key);
      cell.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.slot = i;
      });
      bar.appendChild(cell);
      this.cells.push(cell);
      this.counts.push(count);
    }
    this.label = div('held-name', root);

    // ---- the panel: what you have, and what it makes

    this.panel = div('panel inventory', root);
    this.panel.hidden = true;
    const card = div('panel-card', this.panel);
    const head = div('panel-head', card);
    head.appendChild(text('h2', '', 'WHAT YOU ARE CARRYING'));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'close');
    close.addEventListener('click', () => this.toggleInventory());
    head.appendChild(close);

    this.carrying = div('carry-grid', card);
    card.appendChild(text('h3', '', 'MAKING'));
    this.recipeList = div('recipes', card);
    card.appendChild(
      text('p', 'panel-foot', 'click a block to put it in the selected slot · E closes this'),
    );
    this.panel.addEventListener('click', (e) => {
      if (e.target === this.panel) this.toggleInventory();
    });

    // ---- help

    this.helpBtn = document.createElement('button');
    this.helpBtn.type = 'button';
    this.helpBtn.className = 'help-btn';
    this.helpBtn.textContent = '?';
    this.helpBtn.setAttribute('aria-label', 'controls');
    this.helpBtn.addEventListener('click', () => this.toggleHelp());
    root.appendChild(this.helpBtn);

    this.helpPanel = div('panel help', root);
    this.helpPanel.hidden = true;
    this.helpPanel.appendChild(buildHelp());
    this.helpPanel.addEventListener('click', (e) => {
      if (e.target === this.helpPanel) this.toggleHelp();
    });
    this.helpPanel.querySelector('.panel-close')?.addEventListener('click', () => this.toggleHelp());

    this.buildRecipes();
    this.refreshBar();
  }

  // -------------------------------------------------------------------------
  // Icons
  //
  // Each block is drawn once, as a little cube seen from the corner, and cached as a
  // data URL. Three faces of the real texture skewed into three parallelograms — the
  // same picture the game would give you if you stood in front of one, which is the
  // point: the thing in the hotbar has to be recognisably the thing in the ground.

  private icon(block: number): string {
    const cached = this.icons.get(block);
    if (cached) return cached;
    const def = blockDef(block);
    const S = 64;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;

    const tile = (layer: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = TEX_SIZE;
      c.height = TEX_SIZE;
      const cx = c.getContext('2d');
      if (!cx) return c;
      const stride = TEX_SIZE * TEX_SIZE * 4;
      const px = new Uint8ClampedArray(stride);
      px.set(this.atlas.subarray(layer * stride, layer * stride + stride));
      cx.putImageData(new ImageData(px, TEX_SIZE, TEX_SIZE), 0, 0);
      return c;
    };

    if (def.shape === 'cross') {
      // A flower is not a cube and drawing it as one would be a lie about what you
      // are about to put down.
      ctx.drawImage(tile(def.tex[0]), 4, 4, S - 8, S - 8);
      const url = canvas.toDataURL();
      this.icons.set(block, url);
      return url;
    }

    const top = tile(def.tex[0]);
    const side = tile(def.tex[2]);
    const k = S / TEX_SIZE;
    // Top face: the unit square sheared into a rhombus.
    ctx.setTransform(k / 2, k / 4, -k / 2, k / 4, S / 2, 0);
    ctx.drawImage(top, 0, 0);
    // Left face, then right, each a rectangle pushed down at one end.
    ctx.setTransform(k / 2, k / 4, 0, k / 2, 0, S / 4);
    ctx.drawImage(side, 0, 0);
    ctx.setTransform(k / 2, -k / 4, 0, k / 2, S / 2, S / 2);
    ctx.drawImage(side, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // The same directional shading the world uses, so the icon and the block agree
    // about which way the light comes from.
    shadePoly(ctx, [[0, S / 4], [S / 2, S / 2], [S / 2, S], [0, (S * 3) / 4]], 0.28);
    shadePoly(ctx, [[S, S / 4], [S / 2, S / 2], [S / 2, S], [S, (S * 3) / 4]], 0.12);

    const url = canvas.toDataURL();
    this.icons.set(block, url);
    return url;
  }

  // -------------------------------------------------------------------------
  // The hotbar

  /** What is in the selected slot, or 0. */
  held(): number {
    return this.bar[this.slot] ?? 0;
  }

  /** How many of a block the player has. */
  countOf(block: number): number {
    return this.have.get(block) ?? 0;
  }

  selectSlot(i: number): void {
    this.slot = ((i % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  }

  /** Put a block in the selected slot, or jump to it if it is already on the bar. */
  pick(block: number): void {
    if (block === 0) return;
    const at = this.bar.indexOf(block);
    if (at >= 0) {
      this.slot = at;
      return;
    }
    this.bar[this.slot] = block;
  }

  /**
   * Take the server's word for what is in your pockets.
   *
   * Anything newly picked up that is not on the bar goes into the first empty slot,
   * which is what makes the first ten minutes work without anybody opening a menu:
   * dig some dirt, and dirt is in your hand.
   */
  setInventory(pairs: number[]): void {
    const next = new Map<number, number>();
    for (let i = 0; i + 1 < pairs.length; i += 2) next.set(pairs[i], pairs[i + 1]);
    for (const [block] of next) {
      if (this.have.has(block) || this.bar.includes(block)) continue;
      const empty = this.bar.indexOf(0);
      if (empty >= 0) this.bar[empty] = block;
    }
    this.have = next;
    // A slot whose block ran out stays put rather than clearing: you are about to dig
    // another one, and a hotbar that rearranged itself every time you ran out would
    // be a hotbar you could never learn.
    this.refreshBar();
    if (!this.panel.hidden) this.refreshPanel();
  }

  private refreshBar(): void {
    const key = `${this.slot}|${this.bar.join(',')}|${this.bar.map((b) => this.countOf(b)).join(',')}`;
    if (key === this.shownBar) return;
    this.shownBar = key;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const block = this.bar[i];
      const cell = this.cells[i];
      cell.classList.toggle('on', i === this.slot);
      cell.classList.toggle('empty', block === 0);
      const img = cell.querySelector('i') as HTMLElement;
      img.style.backgroundImage = block === 0 ? 'none' : `url(${this.icon(block)})`;
      const n = this.countOf(block);
      const label = block === 0 || n === 0 ? '' : String(n);
      if (this.counts[i].textContent !== label) this.counts[i].textContent = label;
      cell.classList.toggle('none-left', block !== 0 && n === 0);
    }
    const name = this.bar[this.slot] === 0 ? '' : blockDef(this.bar[this.slot]).name;
    if (name !== this.shownLabel) {
      this.shownLabel = name;
      this.label.textContent = name;
      this.label.classList.toggle('show', name !== '');
    }
  }

  /** Called every frame; only actually touches the DOM when something moved. */
  tick(): void {
    this.refreshBar();
  }

  // -------------------------------------------------------------------------
  // The panel

  toggleInventory(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.refreshPanel();
  }

  get panelOpen(): boolean {
    return !this.panel.hidden || !this.helpPanel.hidden;
  }

  closePanels(): void {
    this.panel.hidden = true;
    this.helpPanel.hidden = true;
    this.helpBtn.classList.remove('open');
  }

  private refreshPanel(): void {
    this.carrying.replaceChildren();
    const holding = PLACEABLE.filter((b) => this.countOf(b) > 0);
    if (holding.length === 0) {
      this.carrying.appendChild(text('p', 'nothing', 'nothing yet — go and dig something'));
    }
    for (const block of holding) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'carry';
      const img = document.createElement('i');
      img.style.backgroundImage = `url(${this.icon(block)})`;
      cell.appendChild(img);
      cell.appendChild(text('b', '', String(this.countOf(block))));
      cell.appendChild(text('span', '', blockDef(block).name));
      cell.addEventListener('click', () => {
        this.bar[this.slot] = block;
        this.refreshBar();
      });
      this.carrying.appendChild(cell);
    }
    this.refreshRecipeState();
  }

  private buildRecipes(): void {
    RECIPES.forEach((r, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'recipe';
      row.appendChild(text('span', 'in', r.needs.map(([b, n]) => `${n} ${blockDef(b).name}`).join(' + ')));
      row.appendChild(text('span', 'arrow', '→'));
      row.appendChild(text('span', 'out', `${r.gives[1]} ${blockDef(r.gives[0]).name}`));
      row.addEventListener('click', () => this.onCraft?.(i));
      this.recipeList.appendChild(row);
    });
  }

  private refreshRecipeState(): void {
    const rows = [...this.recipeList.children] as HTMLElement[];
    RECIPES.forEach((r, i) => {
      const ok = r.needs.every(([b, n]) => this.countOf(b) >= n);
      rows[i]?.classList.toggle('ready', ok);
      (rows[i] as HTMLButtonElement).disabled = !ok;
    });
  }

  toggleHelp(): void {
    this.helpPanel.hidden = !this.helpPanel.hidden;
    this.helpBtn.classList.toggle('open', !this.helpPanel.hidden);
  }

  // -------------------------------------------------------------------------
  // Corners

  setHeadcount(n: number): void {
    if (n === this.shownCount) return;
    this.shownCount = n;
    this.headcount.textContent = n === 1 ? 'alone here' : `${n} here`;
  }

  setStatus(s: Status, detail: string): void {
    if (detail === this.shownStatus) return;
    this.shownStatus = detail;
    this.status.textContent = detail;
    this.status.dataset.state = s;
  }

  setDebug(line: string): void {
    if (line === this.shownDebug) return;
    this.shownDebug = line;
    this.debug.textContent = line;
  }

  setUnderwater(on: boolean): void {
    if (on === this.shownWet) return;
    this.shownWet = on;
    this.wet.hidden = !on;
  }
}

// ---------------------------------------------------------------------------

function shadePoly(ctx: CanvasRenderingContext2D, points: [number, number][], alpha: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fill();
  ctx.restore();
}

function div(cls: string, parent: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function text(tag: string, cls: string, body: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = body;
  return n;
}

interface Row {
  keys: string;
  what: string;
}

const GETTING_ABOUT: Row[] = [
  { keys: 'W A S D', what: 'walk' },
  { keys: 'shift', what: 'run' },
  { keys: 'space', what: 'jump — a block and a quarter, so one step up and no more' },
  { keys: 'mouse', what: 'look. Click once and the cursor is caught; escape gives it back' },
  { keys: 'in water', what: 'hold space to swim up, let go to sink. It cannot hurt you' },
];

const DIGGING: Row[] = [
  { keys: 'hold left', what: 'dig. Hard things take longer — watch the cracks' },
  { keys: 'right click', what: 'put down whatever is in the selected slot' },
  { keys: 'middle click', what: 'point at something to hold that kind' },
  { keys: '1 … 9  ·  wheel', what: 'choose a slot' },
  { keys: 'E', what: 'everything you are carrying, and what it can be made into' },
];

const THUMBS: Row[] = [
  { keys: 'left half', what: 'press anywhere and steer — that spot becomes the stick' },
  { keys: 'right half', what: 'drag to look around' },
  { keys: 'DIG · PUT · JUMP', what: 'the round ones, bottom right' },
  { keys: 'the hotbar', what: 'tap a slot to select it' },
];

const THE_WORLD: Row[] = [
  { keys: 'the island', what: '128 blocks across and 64 deep. You can walk off the edge of it' },
  { keys: 'caves', what: 'go down. There is coal near the surface and diamond near the bottom' },
  { keys: 'lamps', what: 'made from glass and coal, and the only light you can carry' },
  { keys: 'the day', what: 'twelve minutes long, and the same time of day for everybody' },
  { keys: 'everyone else', what: 'is in this world, not a copy of it. What they dig, you see' },
  { keys: 'nothing kills you', what: 'no falling damage, no drowning, no monsters. Only building' },
];

function buildHelp(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'panel-card';

  const head = document.createElement('div');
  head.className = 'panel-head';
  head.appendChild(text('h2', '', 'WHAT YOU CAN DO'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'close');
  head.appendChild(close);
  card.appendChild(head);

  const keyboard = [section('DIGGING AND BUILDING', DIGGING), section('GETTING ABOUT', GETTING_ABOUT)];
  const touch = [section('ON A TOUCH SCREEN', THUMBS)];
  // Whichever you are most likely to be holding goes first; both are always here,
  // because a laptop with a touchscreen is both and guessing wrong should cost a
  // scroll rather than the information.
  for (const s of TOUCH ? [...touch, ...keyboard] : [...keyboard, ...touch]) card.appendChild(s);
  card.appendChild(section('AND THE WORLD ITSELF', THE_WORLD));
  card.appendChild(text('p', 'panel-foot', '? or the corner button opens this again'));
  return card;
}

function section(title: string, rows: Row[]): HTMLElement {
  const s = document.createElement('section');
  s.appendChild(text('h3', '', title));
  const dl = document.createElement('dl');
  for (const r of rows) {
    dl.appendChild(text('dt', '', r.keys));
    dl.appendChild(text('dd', '', r.what));
  }
  s.appendChild(dl);
  return s;
}
