/**
 * BLOONS WORLD — the title screen.
 *
 * Two jobs: ask who you are, and be the one place a failed connection can be
 * reported without the world already being on screen behind it.
 *
 * It does NOT connect on load. The socket is opened when ENTER WORLD is pressed,
 * because connecting earlier would stand you at spawn — visible to everybody,
 * named, motionless — while you were still reading the title. A world full of
 * people who have not arrived yet is worse than a title screen that takes a
 * moment.
 *
 * The screen is dismissed by `main`, not by the button, and only once the first
 * snapshot has landed. Pressing ENTER WORLD and getting an empty grey field
 * while the socket is still opening reads as a broken game; waiting on the title
 * for another 200ms reads as loading.
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
  private waiting = false;

  constructor(name: string) {
    this.el = document.createElement('div');
    this.el.className = 'menu';

    const card = document.createElement('div');
    card.className = 'menu-card';

    card.appendChild(text('h1', 'brand', 'BLOONS WORLD'));
    card.appendChild(text('p', 'tagline', 'One world. Everybody is in it.'));

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

    const keys = document.createElement('div');
    keys.className = 'menu-keys';
    keys.appendChild(text('p', '', 'WASD or ARROWS to walk · SPACE to jump'));
    keys.appendChild(text('p', '', 'On a phone, press anywhere to steer'));
    card.appendChild(keys);

    this.el.appendChild(card);

    // Enter from the name field is the same as pressing the button — it is the
    // last thing you touch before you want to be in.
    this.nameBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.enter();
    });
  }

  /** The name as typed, or a fallback so nobody is ever forced to fill this in. */
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
   * A failure has to put the button back. Otherwise a dropped connection leaves
   * a dead ENTER WORLD and the only way on is a reload, which is exactly the
   * thing the retry loop is already doing invisibly.
   */
  setStatus(s: Status, detail: string): void {
    if (!this.waiting) return;
    this.note.textContent = detail;
    this.note.dataset.state = s;
    if (s === 'offline') {
      this.waiting = false;
      this.go.disabled = false;
    }
  }

  /** Take the title away. `main` calls this on the first snapshot, not the click. */
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
