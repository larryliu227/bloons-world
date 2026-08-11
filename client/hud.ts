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

import { blockDef } from '../shared/blocks.js';
import { RECIPES, ingredientsOf, isBlock, thingDef } from '../shared/items.js';
import { GRID_START, GRID_SIZE, HOTBAR, MAIN_SLOTS, MAIN_START, OUTPUT, SLOT_COUNT, unpackSlots } from '../shared/inventory.js';
import type { Slot } from '../shared/inventory.js';
import { MAX_HP, MAX_HUNGER, SAFE_FALL, SECTIONS, SECTION_SIZE } from '../shared/world.js';
import { TEX_SIZE } from './atlas.js';
import type { Status } from './net.js';

/** How many slots the hotbar has. Nine, and the keys 1 to 9 pick them. */
export const HOTBAR_SLOTS = HOTBAR;

/**
 * Ten hearts for twenty points, so half a heart is a unit.
 *
 * Not a bar that fills. At this size the last tenth of a continuous bar disappears
 * into rounding, and the question anybody asks of it is "how much have I got left",
 * which is a counting question. Halves matter because the smallest thing that can
 * hurt you costs one.
 */
const HEARTS = MAX_HP / 2;
/** Ten drumsticks for twenty points of hunger, read exactly like the hearts. */
const BITES = MAX_HUNGER / 2;
/** How many hearts one health section is worth, for the divider marks. */
const HEARTS_PER_SECTION = SECTION_SIZE / 2;

const TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;

export class Hud {
  /** Which hotbar slot is selected, 0..8. */
  slot = 0;
  /**
   * Every slot the server says you have. The hotbar is the first nine of these, which
   * is why picking a slot needs no bookkeeping at all — it IS the inventory.
   */
  slots: Slot[] = new Array(SLOT_COUNT).fill(null);
  /** What the mouse is carrying, or null. */
  cursor: Slot = null;
  /** Fired when a slot is clicked in the window. */
  onSlotClick: ((slot: number, right: boolean, shift: boolean) => void) | null = null;
  /** Fired when the window closes, so the server can tip the grid back. */
  onClosePack: (() => void) | null = null;
  /** Fired when the player asks to make something. */
  onCraft: ((recipe: number) => void) | null = null;
  /**
   * Whether a given block is standing near the player right now.
   *
   * Set by `main`, because the HUD does not know where anybody is and has no business
   * finding out. It is only ever asked about the furnace.
   */
  nearby: ((block: number) => boolean) | null = null;

  private atlas: Uint8Array;
  private cells: HTMLElement[] = [];
  private counts: HTMLElement[] = [];
  private label: HTMLElement;
  private status: HTMLElement;
  private headcount: HTMLElement;
  private debug: HTMLElement;
  private panel: HTMLElement;
  private packCells: HTMLElement[] = [];
  private cursorEl!: HTMLElement;
  private recipeList!: HTMLElement;
  private quickBtn!: HTMLButtonElement;
  /** True while taps should behave like shift-clicks. See the QUICK MOVE button. */
  private quickMove = false;
  private cursorX = 0;
  private cursorY = 0;
  private helpPanel: HTMLElement;
  private helpBtn: HTMLButtonElement;
  private wet: HTMLElement;
  private hearts: HTMLElement;
  private pips: HTMLElement[] = [];
  private hungerRow: HTMLElement;
  private bites: HTMLElement[] = [];
  private deathScreen: HTMLElement;
  private deathCount: HTMLElement;
  private hurtFlash: HTMLElement;
  private toast: HTMLElement;
  private toastAt = 0;

  private have = new Map<number, number>();
  private icons = new Map<number, string>();
  private shownLabel = '';
  private shownStatus = '';
  private shownCount = -1;
  private shownDebug = '';
  private shownBar = '';
  private shownWet = false;
  private shownHp = '';
  private shownHunger = -1;
  private shownDead = -1;

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

    // ---- health

    this.hearts = div('hearts', root);
    for (let i = 0; i < HEARTS; i++) {
      const pip = document.createElement('i');
      // A gap after every section, so where the ceilings are is visible at a glance
      // rather than being something you have to have read about.
      if (i > 0 && i % HEARTS_PER_SECTION === 0) pip.classList.add('divide');
      this.hearts.appendChild(pip);
      this.pips.push(pip);
    }
    this.hungerRow = div('hunger', root);
    for (let i = 0; i < BITES; i++) {
      const pip = document.createElement('i');
      this.hungerRow.appendChild(pip);
      this.bites.push(pip);
    }

    this.deathScreen = div('dead', root);
    this.deathScreen.hidden = true;
    this.deathScreen.appendChild(text('h2', '', 'YOU DIED'));
    this.deathScreen.appendChild(text('p', 'dead-lost', 'everything you were carrying is gone'));
    this.deathCount = text('p', 'dead-count', '');
    this.deathScreen.appendChild(this.deathCount);
    this.deathScreen.appendChild(text('p', 'dead-note', 'your health sections come back'));

    // One line at the bottom for the things the game has to tell you and cannot show
    // you: mostly "you need an axe for that".
    this.toast = div('toast', root);
    this.toast.hidden = true;
    // A wash rather than an animation on the hearts: what you want to know when
    // something hurts is that it happened, and you are usually not looking at the
    // corner of the screen when it does.
    this.hurtFlash = div('hurt-flash', root);

    // ---- the panel: what you have, and what it makes

    /*
     * The window: a crafting grid and its output on top, the pockets and the hotbar
     * below. Every one of them is the same kind of cell and every one of them sends
     * the same message — which slot, which button — so there is exactly one code path
     * for picking up, putting down, splitting, swapping and crafting.
     */
    this.panel = div('panel inventory', root);
    this.panel.hidden = true;
    const card = div('panel-card pack', this.panel);
    const head = div('panel-head', card);
    head.appendChild(text('h2', '', 'INVENTORY'));
    /*
     * The stand-in for shift-click, because there is no shift key on a tablet.
     *
     * A toggle rather than a gesture on purpose: a two-finger tap or a double-tap
     * would be invisible, and this is a thing you want to do to eight slots in a row.
     * Turn it on, tap four things, turn it off.
     */
    this.quickBtn = document.createElement('button');
    this.quickBtn.type = 'button';
    this.quickBtn.className = 'quick-btn';
    this.quickBtn.textContent = 'QUICK MOVE';
    this.quickBtn.title = 'tap a slot to send it to the other half (shift-click on a mouse)';
    this.quickBtn.addEventListener('click', () => {
      this.quickMove = !this.quickMove;
      this.quickBtn.classList.toggle('on', this.quickMove);
    });
    head.appendChild(this.quickBtn);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'close');
    close.addEventListener('click', () => this.toggleInventory());
    head.appendChild(close);

    /*
     * One slot, and the three gestures that have to work on a mouse AND on glass.
     *
     * A mouse has three buttons and two modifiers; a finger has none of that, so each
     * of the three actions needs a second way in:
     *
     *   take/put all    left click          a tap
     *   take half / put one   right click   a long press
     *   send it across  shift-click         the QUICK button, then a tap
     *
     * The long press is 350ms and is cancelled by any real movement, so dragging the
     * panel about never fires one by accident.
     */
    const makeCell = (index: number, cls: string, into: HTMLElement): HTMLElement => {
      const cell = document.createElement('div');
      cell.className = `pslot ${cls}`;
      cell.appendChild(document.createElement('i'));
      cell.appendChild(document.createElement('b'));

      let holdTimer = 0;
      let handled = false;
      let downAt: { x: number; y: number } | null = null;

      cell.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.moveCursorTo(e.clientX, e.clientY);
        if (e.pointerType === 'mouse') {
          this.onSlotClick?.(index, e.button === 2, e.shiftKey || this.quickMove);
          return;
        }
        handled = false;
        downAt = { x: e.clientX, y: e.clientY };
        holdTimer = window.setTimeout(() => {
          handled = true;
          // A long press is the right button. Half a stack, or one out of the cursor.
          this.onSlotClick?.(index, true, false);
        }, 350);
      });
      const finish = (e: PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        window.clearTimeout(holdTimer);
        if (handled || !downAt) return;
        if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 14) return;
        this.onSlotClick?.(index, false, this.quickMove);
      };
      cell.addEventListener('pointerup', finish);
      cell.addEventListener('pointercancel', () => window.clearTimeout(holdTimer));
      cell.addEventListener('pointermove', (e) => {
        if (!downAt) return;
        if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 14) window.clearTimeout(holdTimer);
      });
      cell.addEventListener('contextmenu', (e) => e.preventDefault());
      into.appendChild(cell);
      this.packCells[index] = cell;
      return cell;
    };

    const bench = div('bench', card);
    const grid = div('craft-grid', bench);
    for (let i = 0; i < GRID_SIZE; i++) makeCell(GRID_START + i, '', grid);
    bench.appendChild(text('div', 'craft-arrow', '→'));
    makeCell(OUTPUT, 'output', bench);

    card.appendChild(text('h3', '', 'POCKETS'));
    const main = div('slot-grid', card);
    for (let i = 0; i < MAIN_SLOTS; i++) makeCell(MAIN_START + i, '', main);
    // Its own heading, because at a glance it was reading as a fourth row of pockets
    // — and which nine slots are the ones in your hands is the single most important
    // fact in the window.
    card.appendChild(text('h3', 'belt-head', 'IN YOUR HANDS'));
    const belt = div('slot-grid belt', card);
    for (let i = 0; i < HOTBAR; i++) makeCell(i, '', belt);

    card.appendChild(text('h3', '', 'RECIPE BOOK'));
    this.recipeList = div('recipes', card);
    card.appendChild(
      text(
        'p',
        'panel-foot',
        TOUCH
          ? 'tap to take a stack · hold to take half · QUICK MOVE sends it across'
          : 'lay it out in the grid, or click a recipe to make one · E closes this',
      ),
    );
    this.panel.addEventListener('click', (e) => {
      if (e.target === this.panel) this.toggleInventory();
    });

    // The stack on the cursor. Outside the card so it can follow the mouse anywhere.
    this.cursorEl = div('cursor-stack', root);
    this.cursorEl.appendChild(document.createElement('i'));
    this.cursorEl.appendChild(document.createElement('b'));
    this.cursorEl.hidden = true;
    // `pointermove`, not `mousemove`: touch never fires the latter, so on a tablet
    // the stack you are carrying would sit frozen wherever the mouse last was, which
    // on a tablet is nowhere at all.
    root.addEventListener('pointermove', (e) => this.moveCursorTo(e.clientX, e.clientY));

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

    /*
     * Items and cross-shaped blocks are drawn flat. A flower is not a cube and neither
     * is an axe, and drawing either as one would be a lie about what you are holding.
     */
    if (!isBlock(block) || def.shape === 'cross') {
      ctx.drawImage(tile(thingDef(block).tex), 2, 2, S - 4, S - 4);
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

  /** What is in the selected hotbar slot, or 0. */
  held(): number {
    return this.slots[this.slot]?.t ?? 0;
  }

  /** How many of a thing the player has, anywhere in the window. */
  countOf(thing: number): number {
    let n = 0;
    for (let i = 0; i < OUTPUT; i++) if (this.slots[i]?.t === thing) n += this.slots[i]!.n;
    return n;
  }

  selectSlot(i: number): void {
    this.slot = ((i % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
  }

  /**
   * Middle-click: hold that kind, if you have any.
   *
   * Only ever SELECTS. The slots belong to the server now, so the client has nothing
   * to put anywhere — all it can do is look along the hotbar for what you already
   * have and point at it.
   */
  pick(thing: number): void {
    if (thing === 0) return;
    for (let i = 0; i < HOTBAR; i++) {
      if (this.slots[i]?.t === thing) {
        this.slot = i;
        return;
      }
    }
  }

  /**
   * Take the server's word for what is in your pockets.
   *
   * Anything newly picked up that is not on the bar goes into the first empty slot,
   * which is what makes the first ten minutes work without anybody opening a menu:
   * dig some dirt, and dirt is in your hand.
   */
  /** Take the server's word for every slot and for what the cursor is holding. */
  setInventory(flat: number[], cursor: number[]): void {
    this.slots = unpackSlots(flat);
    this.cursor = cursor.length >= 2 && cursor[0] > 0 ? { t: cursor[0], n: cursor[1] } : null;
    this.refreshBar();
    if (!this.panel.hidden) this.refreshPanel();
  }

  private refreshBar(): void {
    const key = `${this.slot}|${this.slots.slice(0, HOTBAR).map((s) => (s ? `${s.t}x${s.n}` : '-')).join(',')}`;
    if (key === this.shownBar) return;
    this.shownBar = key;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const stack = this.slots[i];
      const cell = this.cells[i];
      cell.classList.toggle('on', i === this.slot);
      cell.classList.toggle('empty', !stack);
      const img = cell.querySelector('i') as HTMLElement;
      img.style.backgroundImage = stack ? `url(${this.icon(stack.t)})` : 'none';
      const label = stack && stack.n > 1 ? String(stack.n) : '';
      if (this.counts[i].textContent !== label) this.counts[i].textContent = label;
    }
    const name = this.held() === 0 ? '' : thingDef(this.held()).name;
    if (name !== this.shownLabel) {
      this.shownLabel = name;
      this.label.textContent = name;
      this.label.classList.toggle('show', name !== '');
    }
  }

  /** Called every frame; only actually touches the DOM when something moved. */
  tick(): void {
    this.refreshBar();
    this.fadeToast();
  }

  // -------------------------------------------------------------------------
  // The panel

  toggleInventory(): void {
    this.panel.hidden = !this.panel.hidden;
    if (this.panel.hidden) {
      this.quickMove = false;
      this.quickBtn.classList.remove('on');
      this.onClosePack?.();
    } else {
      this.refreshPanel();
    }
  }

  get panelOpen(): boolean {
    return !this.panel.hidden || !this.helpPanel.hidden;
  }

  closePanels(): void {
    if (!this.panel.hidden) this.onClosePack?.();
    this.panel.hidden = true;
    this.helpPanel.hidden = true;
    this.helpBtn.classList.remove('open');
  }

  /** Keep the carried stack under the finger or the pointer, whichever is moving. */
  private moveCursorTo(x: number, y: number): void {
    this.cursorX = x;
    this.cursorY = y;
    if (this.cursorEl.hidden) return;
    this.cursorEl.style.transform = `translate(${x - 18}px, ${y - 18}px)`;
  }

  /**
   * Draw every slot in the window from the server's copy.
   *
   * Rebuilt wholesale rather than diffed. It is forty-six small elements and it only
   * happens when something actually changed, and the alternative — working out which
   * slots moved — is where every inventory bug in every game comes from.
   */
  private refreshPanel(): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const cell = this.packCells[i];
      if (!cell) continue;
      const stack = this.slots[i];
      const img = cell.querySelector('i') as HTMLElement;
      const num = cell.querySelector('b') as HTMLElement;
      img.style.backgroundImage = stack ? `url(${this.icon(stack.t)})` : 'none';
      const label = stack && stack.n > 1 ? String(stack.n) : '';
      if (num.textContent !== label) num.textContent = label;
      cell.title = stack ? thingDef(stack.t).name : '';
      cell.classList.toggle('filled', !!stack);
    }
    // The cursor is a slot that follows the mouse. Same markup, no parent.
    const held = this.cursor;
    this.cursorEl.hidden = !held;
    if (held) {
      // Put it wherever the last touch was, so it appears in the right place on a
      // tablet rather than at the origin until something moves.
      this.cursorEl.style.transform = `translate(${this.cursorX - 18}px, ${this.cursorY - 18}px)`;
      (this.cursorEl.querySelector('i') as HTMLElement).style.backgroundImage = `url(${this.icon(held.t)})`;
      (this.cursorEl.querySelector('b') as HTMLElement).textContent = held.n > 1 ? String(held.n) : '';
    }
    this.refreshRecipeState();
  }

  private buildRecipes(): void {
    RECIPES.forEach((r, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'recipe';
      /*
       * A little picture of the pattern, and it is not decoration.
       *
       * A pickaxe and an axe are BOTH three planks and two sticks — they differ only
       * by where those go in the grid — so without this the book has two rows that
       * read as exactly the same recipe making two different things, which looks like
       * a bug and is impossible to argue with.
       */
      if (r.shape) {
        const pat = document.createElement('span');
        pat.className = 'pattern';
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 3; x++) {
            const cell = document.createElement('i');
            const filled = (r.shape[y] ?? [])[x];
            if (filled) cell.className = 'on';
            pat.appendChild(cell);
          }
        }
        row.appendChild(pat);
      } else {
        row.appendChild(text('span', 'pattern loose', ''));
      }
      row.appendChild(text('span', 'verb', r.verb));
      row.appendChild(
        text('span', 'in', ingredientsOf(r).map(([b, n]) => `${n} ${thingDef(b).name}`).join(' + ')),
      );
      row.appendChild(text('span', 'arrow', '→'));
      row.appendChild(text('span', 'out', `${r.gives[1]} ${thingDef(r.gives[0]).name}`));
      if (r.near !== undefined) row.appendChild(text('span', 'near', `by a ${thingDef(r.near).name}`));
      row.addEventListener('click', () => this.onCraft?.(i));
      this.recipeList.appendChild(row);
    });
  }

  private refreshRecipeState(): void {
    const rows = [...this.recipeList.querySelectorAll('.recipe')] as HTMLButtonElement[];
    RECIPES.forEach((r, i) => {
      const hasStuff = ingredientsOf(r).every(([b, n]) => this.countOf(b) >= n);
      const inPlace = r.near === undefined || !!this.nearby?.(r.near);
      rows[i]?.classList.toggle('ready', hasStuff && inPlace);
      rows[i]?.classList.toggle('wrong-place', hasStuff && !inPlace);
      if (rows[i]) rows[i].disabled = !(hasStuff && inPlace);
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

  /**
   * Fill in hearts to match. Rounded UP to the nearest half, so a scratch shows as a
   * scratch rather than as nothing — the one place a player should be told the worse
   * of two roundings is their own health.
   */
  setHealth(hp: number, cap: number): void {
    const halves = Math.max(0, Math.min(MAX_HP, Math.ceil(hp * 2 - 0.001) / 2));
    const capHalves = Math.max(0, Math.min(MAX_HP, cap / 2));
    const key = `${halves}/${capHalves}`;
    if (key === this.shownHp) return;
    this.shownHp = key;
    for (let i = 0; i < HEARTS; i++) {
      const full = halves >= i + 1;
      const half = !full && halves > i;
      /*
       * Three states, not two. A heart above your section's ceiling is drawn as a
       * hollow outline rather than an empty slot, because it is a different fact: an
       * empty heart is one you will get back and a barred one is one you will not,
       * and a player who cannot tell those apart will sit still waiting for a heart
       * that is never coming.
       */
      const lost = i + 1 > capHalves;
      this.pips[i].className = `${full ? 'on' : half ? 'half' : ''}${lost ? ' lost' : ''}`.trim();
    }
    // Below a third the row starts breathing, so being nearly out is noticed by
    // somebody watching the ground rush up rather than by the corner of the screen.
    this.hearts.classList.toggle('low', halves > 0 && halves <= HEARTS / 3);
  }

  setHunger(hunger: number): void {
    const halves = Math.max(0, Math.min(MAX_HUNGER, Math.ceil(hunger * 2 - 0.001) / 2));
    if (halves === this.shownHunger) return;
    this.shownHunger = halves;
    for (let i = 0; i < BITES; i++) {
      const full = halves >= i + 1;
      this.bites[i].className = full ? 'on' : !full && halves > i ? 'half' : '';
    }
    this.hungerRow.classList.toggle('low', halves <= 2);
  }

  /** The death screen and its countdown. `respawn` is seconds left, 0 when alive. */
  setDead(respawn: number): void {
    const secs = respawn > 0 ? Math.ceil(respawn) : 0;
    if (secs === this.shownDead) return;
    this.shownDead = secs;
    this.deathScreen.hidden = secs === 0;
    if (secs > 0) this.deathCount.textContent = `back in ${secs}`;
  }

  /** Say something at the bottom of the screen for a moment. */
  say(message: string): void {
    if (this.toast.textContent !== message || performance.now() - this.toastAt > 900) {
      this.toast.textContent = message;
    }
    this.toast.hidden = false;
    this.toast.classList.add('go');
    this.toastAt = performance.now();
  }

  /** Called every frame: fades the message out once it has been up long enough. */
  private fadeToast(): void {
    if (this.toast.hidden) return;
    if (performance.now() - this.toastAt < 2200) return;
    this.toast.classList.remove('go');
    this.toast.hidden = true;
  }

  /** A red wash across the screen, restarted from the beginning on every hit. */
  flashDamage(): void {
    this.hurtFlash.classList.remove('go');
    // Reading `offsetWidth` is what makes the class removal take effect before the
    // class is added back; without it the browser collapses the two into no change
    // at all and a second hit in quick succession flashes nothing.
    void this.hurtFlash.offsetWidth;
    this.hurtFlash.classList.add('go');
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

const FIRST_FIVE: Row[] = [
  { keys: 'punch a tree', what: 'hold left click on a log. Your hands work on wood, soil and sand' },
  { keys: 'make planks', what: '1 log → 4 planks. Then 2 planks → 4 sticks' },
  { keys: 'make a pickaxe', what: '3 planks + 2 sticks. Now you can mine stone' },
  { keys: 'stone pickaxe', what: '3 cobble + 2 sticks. Now you can mine iron ore' },
  { keys: 'build a furnace', what: '8 cobble. Stand beside it and smelt the iron' },
  { keys: 'keep going down', what: 'iron reaches gold and diamond. Diamond reaches everything' },
];

const DIGGING: Row[] = [
  { keys: 'hold left', what: 'dig. Rock needs a pickaxe; everything else your hands can manage' },
  { keys: 'chop one log', what: 'and the whole tree comes down. A log wall you built stays up' },
  { keys: 'right click', what: 'put a block down — or eat, if you are holding food' },
  { keys: 'middle click', what: 'point at something to hold that kind' },
  { keys: '1 … 9  ·  wheel', what: 'choose a slot' },
  { keys: 'E', what: 'everything you are carrying, and everything it can be made into' },
  { keys: 'tools wear out', what: 'wood lasts 60 blocks, stone 132, iron 251, diamond 1562' },
];

const GETTING_ABOUT: Row[] = [
  { keys: 'W A S D', what: 'walk' },
  { keys: 'shift', what: 'run. It costs three times the food' },
  { keys: 'space', what: 'jump — a block and a quarter, so one step up and no more' },
  { keys: 'mouse', what: 'look. Click once and the cursor is caught; escape gives it back' },
  { keys: 'in water', what: 'hold space to swim up, let go to sink. It cannot hurt you' },
];

const THUMBS: Row[] = [
  { keys: 'left half', what: 'press anywhere and steer — that spot becomes the stick' },
  { keys: 'push it all the way', what: 'past the dashed ring, and you run' },
  { keys: 'right half', what: 'drag to look around' },
  { keys: 'DIG · PUT · JUMP', what: 'the round ones, bottom right. Hold DIG to keep digging or to fire' },
  { keys: 'the hotbar', what: 'tap a slot to select it' },
  { keys: 'in the inventory', what: 'tap to take or put a whole stack' },
  { keys: 'hold a slot', what: 'takes half, or puts down one. The right-click, without a right button' },
  { keys: 'QUICK MOVE', what: 'turn it on and a tap sends the stack to the other half' },
];

const GUNS: Row[] = [
  { keys: 'sulfur · saltpetre', what: 'deep, rare, and worth nothing until you have both' },
  { keys: 'gunpowder', what: '1 saltpetre + 1 sulfur + 1 coal → 3' },
  { keys: 'shot', what: '1 iron + 1 gunpowder → 8 lead balls · cartridges cost twice the powder' },
  { keys: 'musket · rifle', what: 'one shot at a time. The musket hits hardest, the rifle aims true' },
  { keys: 'revolver', what: 'fast, short-ranged, and cheap to feed' },
  { keys: 'auto rifle · machine gun', what: 'hold the trigger. They will empty your pockets faster than anything' },
  { keys: 'firing', what: 'left click, or the DIG button. It goes where the barrel pointed' },
];

const STAYING_UP: Row[] = [
  { keys: 'ten hearts', what: `in ${SECTIONS} sections of ${SECTION_SIZE / 2}. Look for the gaps between them` },
  { keys: 'a section lost', what: 'is lost until you die. You mend up to its ceiling and no further' },
  { keys: 'falling', what: `the first ${SAFE_FALL} blocks are free; every one after costs a tenth of a heart` },
  { keys: 'where you land', what: 'matters more than how far. Sand is a twelfth of stone, water is nothing' },
  { keys: 'hunger', what: 'the row under the hearts. Empty, you stop mending and then start starving' },
  { keys: 'eat', what: 'hold berries, a root or a mushroom and right-click' },
  { keys: 'dying', what: 'costs you EVERYTHING you were carrying, and gives every section back. 10 seconds' },
];

const THE_WORLD: Row[] = [
  { keys: 'the island', what: '128 blocks across and 64 deep. You can walk off the edge of it' },
  { keys: 'caves', what: 'mushrooms and loose stone, then coal, iron, sulfur, saltpetre, gold, diamond' },
  { keys: 'animals', what: 'pigs, cows and chickens wander about. They drop meat; cook it on a furnace' },
  { keys: 'lying about', what: 'pebbles, sticks and berries grow back after a few minutes' },
  { keys: 'the day', what: 'twelve minutes long, and the same time of day for everybody' },
  { keys: 'everyone else', what: 'is in this world, not a copy of it. What they dig, you see' },
  { keys: 'coming back', what: 'your pockets, your wounds and where you stood are all still here' },
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

  card.appendChild(section('YOUR FIRST FIVE MINUTES', FIRST_FIVE));
  const keyboard = [section('DIGGING AND BUILDING', DIGGING), section('GETTING ABOUT', GETTING_ABOUT)];
  const touch = [section('ON A TOUCH SCREEN', THUMBS)];
  // Whichever you are most likely to be holding goes first; both are always here,
  // because a laptop with a touchscreen is both and guessing wrong should cost a
  // scroll rather than the information.
  for (const s of TOUCH ? [...touch, ...keyboard] : [...keyboard, ...touch]) card.appendChild(s);
  card.appendChild(section('THE FAR END OF IT', GUNS));
  card.appendChild(section('STAYING ON YOUR FEET', STAYING_UP));
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
