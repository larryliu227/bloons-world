/**
 * BLOONS WORLD — the things floating over the world.
 *
 * The health bar, the head count, the connection state, and the list of what you
 * can actually do. All DOM rather than canvas, for the same reason the name tags
 * are: text drawn at world resolution and upscaled with smoothing off is mush, and
 * this is the part of the screen that has to be readable.
 *
 * Everything here is written to only when it CHANGES. It is called from inside the
 * frame loop, and setting `textContent` sixty times a second on a string that is the
 * same string sixty times a second is layout work in exchange for nothing.
 */

import { MAX_CARRY, MAX_HP, MELEE_DAMAGE, PEBBLE_DAMAGE } from '../shared/world.js';
import type { Status } from './net.js';

/**
 * Whether this is a machine with a pointer or a machine with thumbs.
 *
 * Only used to decide which half of the controls list to put FIRST — both halves are
 * always there. A laptop with a touchscreen is both, and guessing wrong should cost
 * a scroll rather than the information.
 */
const TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;

export class Hud {
  private bar: HTMLElement;
  private pips: HTMLElement[] = [];
  private ammo: HTMLElement;
  private stones: HTMLElement[] = [];
  private downNote: HTMLElement;
  private count: HTMLElement;
  private status: HTMLElement;
  private helpBtn: HTMLButtonElement;
  private help: HTMLElement;
  private shownPips = -1;
  private shownPebbles = -1;
  private shownDown = false;
  private shownCount = -1;
  private shownStatus = '';

  constructor(root: HTMLElement) {
    this.count = div('hud', root);
    this.status = div('status', root);

    /*
     * Ten pips, because the number is ten. Not a bar that fills — at this size a
     * continuous bar loses its last tenth to rounding, and "how many hits do I have
     * left" is a counting question rather than a proportion one. Which is also why
     * the stones below are counted the same way: three pips is one swing.
     */
    this.bar = div('health', root);
    for (let i = 0; i < MAX_HP; i++) {
      const pip = document.createElement('i');
      this.bar.appendChild(pip);
      this.pips.push(pip);
    }

    this.ammo = div('ammo', root);
    for (let i = 0; i < MAX_CARRY; i++) {
      const stone = document.createElement('i');
      this.ammo.appendChild(stone);
      this.stones.push(stone);
    }

    this.downNote = div('down-note', root);
    this.downNote.textContent = 'KNOCKED DOWN — GETTING UP';
    this.downNote.hidden = true;

    this.helpBtn = document.createElement('button');
    this.helpBtn.type = 'button';
    this.helpBtn.className = 'help-btn';
    this.helpBtn.textContent = '?';
    this.helpBtn.setAttribute('aria-label', 'controls');
    this.helpBtn.addEventListener('click', () => this.toggleHelp());
    root.appendChild(this.helpBtn);

    this.help = div('help', root);
    this.help.hidden = true;
    this.help.appendChild(buildHelp());
    // Anywhere outside the card closes it. A panel you have to hunt for the close
    // button on is a panel that ends up staying open over the game.
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.toggleHelp();
    });
    this.help.querySelector('.help-close')?.addEventListener('click', () => this.toggleHelp());
  }

  /** Fill in pips to match `hp`, rounding up so a scratch is not a whole pip. */
  setHealth(hp: number, down: boolean): void {
    const lit = Math.max(0, Math.min(MAX_HP, Math.ceil(hp - 0.001)));
    if (lit !== this.shownPips) {
      this.shownPips = lit;
      for (let i = 0; i < this.pips.length; i++) this.pips[i].classList.toggle('on', i < lit);
      // Below a third the bar starts breathing, so being nearly out is noticed by
      // somebody watching the fight rather than the corner of the screen.
      this.bar.classList.toggle('low', lit > 0 && lit <= 3);
    }
    if (down !== this.shownDown) {
      this.shownDown = down;
      // There is no death screen, because there is no death. A word and a bar that
      // has gone out is the whole of it, and it is over in two seconds.
      this.downNote.hidden = !down;
    }
  }

  /** How many stones are in hand, as a row of them. */
  setPebbles(n: number): void {
    const have = Math.max(0, Math.min(MAX_CARRY, Math.round(n)));
    if (have === this.shownPebbles) return;
    this.shownPebbles = have;
    for (let i = 0; i < this.stones.length; i++) this.stones[i].classList.toggle('on', i < have);
    // Nothing to throw is worth saying quietly rather than not at all.
    this.ammo.classList.toggle('empty', have === 0);
  }

  setCount(n: number): void {
    if (n === this.shownCount) return;
    this.shownCount = n;
    this.count.textContent = `${n} here`;
  }

  setStatus(s: Status, detail: string): void {
    if (detail === this.shownStatus) return;
    this.shownStatus = detail;
    this.status.textContent = detail;
    this.status.dataset.state = s;
  }

  /** The controls list names both views, so it says which one you are in. */
  setFirstPerson(on: boolean): void {
    this.help.classList.toggle('in-world', on);
  }

  toggleHelp(): void {
    this.help.hidden = !this.help.hidden;
    this.helpBtn.classList.toggle('open', !this.help.hidden);
  }
}

function div(cls: string, parent: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

interface Row {
  keys: string;
  what: string;
}

const FIGHTING: Row[] = [
  { keys: 'F  ·  left click', what: `swing — ${MELEE_DAMAGE} pips, but you have to be right there` },
  { keys: 'R  ·  right click', what: `throw a stone — ${PEBBLE_DAMAGE} pip, from across a clearing` },
  { keys: 'aiming', what: 'where you look, or where the mouse is when looking down' },
];

const LOOKING_DOWN: Row[] = [
  { keys: 'W A S D  ·  arrows', what: 'walk' },
  { keys: 'space', what: 'jump' },
  { keys: 'V', what: 'stand in the world' },
];

const IN_WORLD: Row[] = [
  { keys: 'W  ·  S', what: 'forward, back' },
  { keys: 'A  ·  D', what: 'step sideways' },
  { keys: 'mouse', what: 'look — click once to catch the cursor' },
  { keys: '←  →  ·  Q  E', what: 'turn on the spot' },
  { keys: 'space', what: 'jump — high enough to see over the edge' },
  { keys: 'V  ·  esc', what: 'back to looking down, let the cursor go' },
];

const THUMBS: Row[] = [
  { keys: 'left half', what: 'press anywhere and steer — that spot is the stick' },
  { keys: 'right half', what: 'drag to look, once you are in the world' },
  { keys: 'JUMP  ·  HIT  ·  THROW', what: 'the round ones, bottom right' },
  { keys: '1ST · TOP', what: 'swap views — up in the corner, out of the way' },
];

const RULES: Row[] = [
  { keys: 'berries', what: `grow in the shade of trees. Walk over one and you eat it, +3 pips` },
  { keys: 'stones', what: `lie on the sand. Walk over one to pick it up, ${MAX_CARRY} at most` },
  { keys: 'water', what: 'harmless, and desperately slow. It will not hurt you, just keep you' },
  { keys: 'trees', what: 'solid, and they stop thrown stones. A wood is cover' },
  { keys: 'no dying', what: 'run out and you are flat for two seconds, then up again, full' },
  { keys: 'the edge', what: 'a wall. Jump at it and you can just see over' },
];

function buildHelp(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'help-card';

  const head = document.createElement('div');
  head.className = 'help-head';
  head.appendChild(text('h2', '', 'WHAT YOU CAN DO'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'help-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'close');
  head.appendChild(close);
  card.appendChild(head);

  // Fighting first: it is the thing you can do that is least guessable from the
  // screen, and the only one where not knowing costs you something.
  card.appendChild(section('FIGHTING', FIGHTING, ''));
  const keyboard = [
    section('LOOKING DOWN AT IT', LOOKING_DOWN, 'top'),
    section('STANDING IN IT', IN_WORLD, 'fp'),
  ];
  const touch = [section('ON A TOUCH SCREEN', THUMBS, '')];
  // Whichever you are most likely to be holding goes first; both are always here.
  for (const s of TOUCH ? [...touch, ...keyboard] : [...keyboard, ...touch]) card.appendChild(s);
  card.appendChild(section('AND THE WORLD ITSELF', RULES, ''));

  card.appendChild(text('p', 'help-foot', '? or the corner button opens this again'));
  return card;
}

function section(title: string, rows: Row[], mark: string): HTMLElement {
  const s = document.createElement('section');
  if (mark) s.dataset.view = mark;
  s.appendChild(text('h3', '', title));
  const dl = document.createElement('dl');
  for (const r of rows) {
    dl.appendChild(text('dt', '', r.keys));
    dl.appendChild(text('dd', '', r.what));
  }
  s.appendChild(dl);
  return s;
}

function text(tag: string, cls: string, body: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = body;
  return n;
}
