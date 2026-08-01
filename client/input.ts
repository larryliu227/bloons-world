/**
 * BLOONS WORLD — input.
 *
 * Produces one thing: where you want to go. Keyboard, thumbstick, mouse and drag all
 * write to the same few numbers, so the rest of the game never learns which one you
 * are using and a phone and a laptop are the same client.
 *
 * There are two control schemes over the same state, because there are two views:
 *
 *  - From above, `vector()` is a direction in the WORLD. Pushing left walks west.
 *  - From eye level, `moveLocal()` is a direction relative to your FACE, and `yaw`
 *    is where that face is pointed. `main` rotates one into the other, so what
 *    reaches the wire is the same world-space intent either way — the server never
 *    learns which view you are using, and it does not have to.
 *
 * `yaw` and `pitch` live here rather than in the renderer because they are input, not
 * a picture: they are the accumulated total of every mouse movement and every drag.
 */

import { PITCH_LIMIT } from './fp.js';

/** Radians per second when turning with keys, and per pixel with a mouse or thumb. */
const TURN_SPEED = 2.4;
const MOUSE_YAW = 0.003;
const TOUCH_YAW = 0.006;
/**
 * Pitch is in world pixels of horizon shift, and the canvas is scaled by an integer
 * this class deliberately does not know about — plumbing the scale through for a
 * look-sensitivity constant would be a lot of wire for a number that has to be
 * chosen by feel anyway.
 */
const MOUSE_PITCH = 0.3;
const TOUCH_PITCH = 0.5;

export class Input {
  private keys = new Set<string>();
  /**
   * A jump waiting to be sent. Set on the KEYDOWN edge and cleared once read, so
   * one press is one jump no matter how long you lean on the key.
   */
  private jumpQueued = false;
  /** Same edge trick for the view switch — holding V must not strobe the camera. */
  private viewQueued = false;
  private helpQueued = false;
  /**
   * A swing and a throw waiting to be sent, on the same edge trick.
   *
   * Leaning on the button must not queue up a hundred attacks for the moment the
   * cooldown lifts — the server enforces the rate anyway, but sending it a hundred
   * messages to reject is a hundred messages.
   */
  private hitQueued = false;
  private throwQueued = false;
  /**
   * Where the mouse is, in CSS pixels, or null if this machine has not seen one.
   *
   * Only used to aim from above, where facing is four-way and pointing at what you
   * mean is the difference between a fight and a coin toss. Null on a phone, where
   * facing is all there is.
   */
  private cursor: { x: number; y: number } | null = null;
  /** Thumbstick offset, already normalised to [-1, 1]. */
  private stick = { x: 0, y: 0 };
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  /** The look pointer: a thumb on the right of the screen, or a held mouse. */
  private lookId = -1;
  private mouseLook = false;
  /**
   * Whether input is being read at all. False while the title screen is up: the
   * page is one full-screen element over the canvas, so without this a press on
   * the name field also plants a thumbstick, and WASD typed into it walks a
   * player around behind the menu.
   */
  private on = true;
  /** Which control scheme is live. Set by `main` when the view changes. */
  private fp = false;

  /** Where you are looking. Radians east-from-+x, and a horizon shift in pixels. */
  yaw = 0;
  pitch = 0;

  readonly pad: HTMLElement;
  private root: HTMLElement;
  private jumpBtn!: HTMLButtonElement;
  private viewBtn!: HTMLButtonElement;
  private throwBtn!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('keydown', (e) => {
      if (!this.on) return;
      // Never steal keys from the name box.
      if (isTyping(e.target)) return;
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === ' ' || e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault(); // space scrolls the page otherwise
      }
      const k = e.key.toLowerCase();
      if (k === 'v') this.viewQueued = true;
      if (k === 'f') this.hitQueued = true;
      if (k === 'r') this.throwQueued = true;
      // Both, because `?` needs a shift on most layouts and none on some.
      if (e.key === '?' || e.key === '/') this.helpQueued = true;
      // Arrows scroll the page otherwise, which drags the whole world sideways.
      if (e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    // A held key with the window unfocused would walk you into a wall forever.
    window.addEventListener('blur', () => this.keys.clear());

    /*
     * The thumbstick is the whole touch story: press anywhere on the left of the
     * screen and that point becomes the centre, so there is no fixed pad to find
     * with your thumb and no wrong place to put it.
     */
    this.pad = document.createElement('div');
    this.pad.className = 'stick hidden';
    const nub = document.createElement('div');
    nub.className = 'stick-nub';
    this.pad.appendChild(nub);
    root.appendChild(this.pad);

    /*
     * A jump button for thumbs, on the right where the stick is not. Kept out of the
     * stick's pointer handling entirely — sharing one pointer between "steer" and
     * "jump" means every jump twitches your direction.
     */
    this.jumpBtn = document.createElement('button');
    this.jumpBtn.className = 'jump';
    this.jumpBtn.textContent = 'JUMP';
    this.jumpBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.on) return;
      this.jumpQueued = true;
    });
    root.appendChild(this.jumpBtn);

    /*
     * The view switch lives up in the corner with the help button rather than down
     * by JUMP: swapping camera is a thing you do between doing things, and the
     * bottom right is now three buttons of fighting that a thumb has to hit without
     * looking.
     */
    this.viewBtn = document.createElement('button');
    this.viewBtn.className = 'view-btn';
    this.viewBtn.textContent = '1ST';
    this.viewBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.on) return;
      this.viewQueued = true;
    });
    root.appendChild(this.viewBtn);

    const attackBtn = (cls: string, label: string, set: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (!this.on) return;
        set();
      });
      root.appendChild(b);
      return b;
    };
    attackBtn('hit-btn', 'HIT', () => {
      this.hitQueued = true;
    });
    this.throwBtn = attackBtn('throw-btn', 'THROW', () => {
      this.throwQueued = true;
    });

    const RADIUS = 46;
    root.addEventListener('pointerdown', (e) => {
      if (!this.on || isChrome(e.target)) return;
      if (e.pointerType === 'mouse') {
        // Left swings, right throws — the same two everywhere, and the reason the
        // context menu is suppressed below.
        if (e.button === 0) this.hitQueued = true;
        else if (e.button === 2) this.throwQueued = true;
        /*
         * Mouse look without pointer lock, for when the browser refuses it or the
         * player pressed Escape. Held-drag rather than free move: an unlocked
         * cursor that spins the camera whenever it crosses the window is unusable.
         */
        if (this.fp && e.button === 0) this.mouseLook = true;
        return;
      }
      // Looking around and walking are the two halves of the screen. Above, there
      // is nothing to look around at, so the stick keeps the whole of it.
      if (this.fp && e.clientX > window.innerWidth / 2) {
        this.lookId = e.pointerId;
        return;
      }
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.pad.style.left = `${e.clientX}px`;
      this.pad.style.top = `${e.clientY}px`;
      this.pad.classList.remove('hidden');
      nub.style.transform = 'translate(-50%, -50%)';
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.lookId) {
        this.look(e.movementX * TOUCH_YAW, -e.movementY * TOUCH_PITCH);
        return;
      }
      if (e.pointerId !== this.stickId) return;
      const dx = e.clientX - this.stickOrigin.x;
      const dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(RADIUS, len);
      this.stick = { x: (dx / len) * (clamped / RADIUS), y: (dy / len) * (clamped / RADIUS) };
      nub.style.transform = `translate(calc(-50% + ${(dx / len) * clamped}px), calc(-50% + ${(dy / len) * clamped}px))`;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.mouseLook = false;
      if (e.pointerId === this.lookId) this.lookId = -1;
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.stick = { x: 0, y: 0 };
      this.pad.classList.add('hidden');
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);

    /*
     * Pointer lock is the real first-person mouse. It is requested on a click rather
     * than on entering the view because a browser will only grant it from a gesture,
     * and a mode switch by keypress is not one it accepts.
     */
    root.addEventListener('click', (e) => {
      if (!this.on || !this.fp || isChrome(e.target)) return;
      if (document.pointerLockElement === root) return;
      try {
        const req = root.requestPointerLock() as unknown as Promise<void> | undefined;
        req?.catch?.(() => {
          /* refused — the held-drag path above still works */
        });
      } catch {
        /* not supported here */
      }
    });
    window.addEventListener('mousemove', (e) => {
      this.cursor = { x: e.clientX, y: e.clientY };
      if (!this.on || !this.fp) return;
      if (document.pointerLockElement !== root && !this.mouseLook) return;
      this.look(e.movementX * MOUSE_YAW, -e.movementY * MOUSE_PITCH);
    });
    // Right-click is the throw, so it must not also be the browser's menu.
    root.addEventListener('contextmenu', (e) => {
      if (this.on) e.preventDefault();
    });
  }

  /**
   * Turn input on or off. Turning it off clears everything held, so a key that
   * was down when the world went away is not still down when it comes back.
   */
  setEnabled(on: boolean): void {
    this.on = on;
    if (on) return;
    this.keys.clear();
    this.jumpQueued = false;
    this.viewQueued = false;
    this.helpQueued = false;
    this.hitQueued = false;
    this.throwQueued = false;
    this.stick = { x: 0, y: 0 };
    this.stickId = -1;
    this.lookId = -1;
    this.mouseLook = false;
    this.pad.classList.add('hidden');
  }

  /** Switch control schemes. Leaving first person gives the cursor back. */
  setFirstPerson(on: boolean): void {
    this.fp = on;
    this.viewBtn.textContent = on ? 'TOP' : '1ST';
    this.lookId = -1;
    this.mouseLook = false;
    if (!on && document.pointerLockElement === this.root) document.exitPointerLock();
  }

  /** Advance anything that moves at a rate rather than by an event. */
  update(dt: number): void {
    if (!this.fp) return;
    const turn = this.turnAxis();
    if (turn !== 0) this.yaw += turn * TURN_SPEED * dt;
  }

  /** Read and clear the pending jump. Edge-triggered — see `jumpQueued`. */
  takeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  /** Read and clear a pending view switch. */
  takeViewToggle(): boolean {
    const v = this.viewQueued;
    this.viewQueued = false;
    return v;
  }

  /** Read and clear a pending request for the controls list. */
  takeHelpToggle(): boolean {
    const h = this.helpQueued;
    this.helpQueued = false;
    return h;
  }

  /** Read and clear a pending swing. */
  takeHit(): boolean {
    const h = this.hitQueued;
    this.hitQueued = false;
    return h;
  }

  /** Read and clear a pending throw. */
  takeThrow(): boolean {
    const t = this.throwQueued;
    this.throwQueued = false;
    return t;
  }

  /** Grey the THROW button out when there is nothing in hand to throw. */
  setPebbles(n: number): void {
    this.throwBtn.classList.toggle('empty', n <= 0);
  }

  /**
   * Where to aim, in radians, from above.
   *
   * The cursor if there is one, because facing is four-way and a swing is a cone —
   * pointing at what you mean is the difference between a fight and a coin toss.
   * `null` on a machine that has never seen a mouse, and the caller falls back to
   * whichever way the sprite is looking.
   */
  aimFromCursor(originX: number, originY: number): number | null {
    if (!this.cursor) return null;
    const dx = this.cursor.x - originX;
    const dy = this.cursor.y - originY;
    if (Math.hypot(dx, dy) < 6) return null; // on top of yourself: no direction in it
    return Math.atan2(dy, dx);
  }

  /** The current direction in WORLD space, keyboard and stick combined. */
  vector(): { x: number; y: number } {
    let x = this.stick.x;
    let y = this.stick.y;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y += 1;
    return { x: clamp1(x), y: clamp1(y) };
  }

  /**
   * The current direction relative to your FACE: forward is +1, and strafe is +1 to
   * your right. Left and right ARROWS are missing on purpose — from eye level those
   * turn you, and a key that both turns and strafes does neither well.
   */
  moveLocal(): { fwd: number; strafe: number } {
    let fwd = -this.stick.y;
    let strafe = this.stick.x;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('a')) strafe -= 1;
    if (this.keys.has('d')) strafe += 1;
    return { fwd: clamp1(fwd), strafe: clamp1(strafe) };
  }

  private turnAxis(): number {
    let t = 0;
    if (this.keys.has('arrowleft') || this.keys.has('q')) t -= 1;
    if (this.keys.has('arrowright') || this.keys.has('e')) t += 1;
    return t;
  }

  private look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch + dPitch));
  }
}

/** True when the event came from a text field, so gameplay keys stay out of it. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/** True for the chrome floating over the world — the name box and the buttons. */
function isChrome(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return isTyping(target) || (!!el && el.tagName === 'BUTTON');
}

function clamp1(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
