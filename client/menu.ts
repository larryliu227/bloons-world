/**
 * BLOONS WORLD — the title screen.
 *
 * Three jobs: ask who you are, be the one place a failed connection can be reported
 * without the world already being on screen behind it, and hold the loading bar.
 *
 * It does NOT connect on load. The socket is opened when ENTER WORLD is pressed,
 * because connecting earlier would stand you in the world — visible to everybody,
 * named, motionless — while you were still reading the title.
 *
 * And it is dismissed by `main`, not by the button, and only once the world has been
 * both caught up and turned into triangles. Pressing ENTER WORLD and getting a grey
 * field for two seconds reads as a broken game; waiting on the title with a bar that
 * is moving reads as loading, which is what it is.
 */

import type { Status } from './net.js';

const NAME_MAX = 16;

export class Menu {
  readonly el: HTMLElement;
  /** Fired with the chosen name when ENTER WORLD is pressed. */
  onEnter: ((name: string) => void) | null = null;

  private nameBox: HTMLInputElement;
  private go: HTMLButtonElement;
  private note: HTMLElement;
  private barWrap: HTMLElement;
  private bar: HTMLElement;
  private waiting = false;
  private shownNote = '';

  constructor(name: string) {
    this.el = document.createElement('div');
    this.el.className = 'menu';

    const card = document.createElement('div');
    card.className = 'menu-card';

    card.appendChild(text('h1', 'brand', 'BLOONS WORLD'));
    card.appendChild(text('p', 'tagline', 'One island, made of blocks. Everybody is in it.'));

    this.nameBox = document.createElement('input');
    this.nameBox.className = 'menu-name';
    this.nameBox.maxLength = NAME_MAX;
    this.nameBox.spellcheck = false;
    this.nameBox.autocapitalize = 'off';
    this.nameBox.setAttribute('aria-label', 'your name');
    this.nameBox.placeholder = 'YOUR NAME';
    this.nameBox.value = name;
    card.appendChild(this.nameBox);

    this.go = document.createElement('button');
    this.go.type = 'button';
    this.go.className = 'menu-go';
    this.go.textContent = 'ENTER WORLD';
    this.go.addEventListener('click', () => this.enter());
    card.appendChild(this.go);

    // Empty until there is something to say, so the layout does not jump when a
    // status finally appears.
    this.note = text('p', 'menu-note', '');
    card.appendChild(this.note);

    this.barWrap = document.createElement('div');
    this.barWrap.className = 'menu-bar';
    this.bar = document.createElement('i');
    this.barWrap.appendChild(this.bar);
    this.barWrap.hidden = true;
    card.appendChild(this.barWrap);

    const keys = document.createElement('div');
    keys.className = 'menu-keys';
    keys.appendChild(text('p', '', 'WASD to walk · SPACE to jump · SHIFT to run'));
    keys.appendChild(text('p', '', 'HOLD LEFT to dig · RIGHT CLICK to build'));
    keys.appendChild(text('p', '', '1–9 or the WHEEL to pick a block · E for everything you have'));
    keys.appendChild(text('p', '', 'On a phone, press the left half to steer'));
    keys.appendChild(text('p', '', '? for the rest of it, any time'));
    card.appendChild(keys);

    this.el.appendChild(card);

    // Enter from the name field is the same as pressing the button — it is the last
    // thing you touch before you want to be in.
    this.nameBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.enter();
    });
  }

  /** The name as typed, or nothing, so the button can refuse. */
  name(): string {
    return this.nameBox.value.trim().slice(0, NAME_MAX);
  }

  private enter(): void {
    if (this.waiting) return;
    const chosen = this.name();
    if (!chosen) {
      this.nameBox.focus();
      return;
    }
    this.waiting = true;
    this.go.disabled = true;
    this.note.textContent = 'finding the world…';
    this.note.dataset.state = 'connecting';
    this.onEnter?.(chosen);
  }

  /**
   * Reflect the socket while the title is still up.
   *
   * A failure has to put the button back. Otherwise a dropped connection leaves a
   * dead ENTER WORLD and the only way on is a reload, which is exactly the thing the
   * retry loop is already doing invisibly.
   */
  setStatus(s: Status, detail: string): void {
    if (!this.waiting) return;
    if (detail !== this.shownNote) {
      this.shownNote = detail;
      this.note.textContent = detail;
    }
    this.note.dataset.state = s;
    if (s === 'offline') {
      this.waiting = false;
      this.go.disabled = false;
      this.barWrap.hidden = true;
    }
  }

  /** How far through arriving, 0..1, with an optional replacement for the caption. */
  setProgress(fraction: number, label?: string): void {
    if (!this.waiting) return;
    this.barWrap.hidden = false;
    this.bar.style.width = `${Math.max(2, Math.min(100, fraction * 100))}%`;
    if (label && label !== this.shownNote) {
      this.shownNote = label;
      this.note.textContent = label;
    }
  }

  /** Take the title away. `main` calls this once the world is ready to stand in. */
  dismiss(): void {
    this.el.classList.add('gone');
    this.nameBox.blur();
  }
}

function text(tag: string, cls: string, body: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = body;
  return n;
}
