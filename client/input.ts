/**
 * BLOONS WORLD — input.
 *
 * Everything the player does, reduced to a handful of numbers the rest of the game
 * reads. Keyboard, mouse, thumbstick and touch buttons all write to the same state,
 * so nothing downstream ever learns which one you are holding and a phone and a
 * laptop are the same client.
 *
 * Two kinds of signal, and the difference matters:
 *
 *  - HELD things — walking, looking, sprinting, digging — are read every frame and
 *    are true for as long as the key is down.
 *  - TAPPED things — placing a block, changing slot, opening a panel — are latched on
 *    the key-down EDGE and cleared by whoever reads them. A tap that happened
 *    between two frames still counts, and leaning on a key does not fire it a
 *    hundred times.
 *
 * `yaw` and `pitch` live here rather than in the renderer because they are input, not
 * a picture: they are the running total of every mouse movement and every drag.
 */

/** Radians per pixel of mouse movement, and per pixel of thumb. */
const MOUSE_SENS = 0.0022;
const TOUCH_SENS = 0.0055;
/**
 * How close to straight up you may look.
 *
 * Not all the way: at exactly vertical the camera's right-hand vector is undefined
 * and the view matrix degenerates into noise. A thousandth of a radian short is
 * indistinguishable and always well defined.
 */
export const PITCH_LIMIT = Math.PI / 2 - 0.001;

/** Placing repeats while the button is held, at this many per second. */
const PLACE_REPEAT_MS = 190;

export class Input {
  yaw = 0;
  pitch = 0;

  /** True while the button that digs is down. */
  digging = false;
  /** Held, for walking and jumping. */
  jump = false;
  /** Shift, on a keyboard. See `sprint` for the other way. */
  private sprintKey = false;

  /**
   * Running.
   *
   * Shift on a keyboard, and on a tablet: PUSH THE STICK ALL THE WAY. There is no
   * shift key on glass and no room for another button under a thumb that is already
   * holding three, and "shove it harder to go faster" is a thing people try without
   * being told — which is worth more than any button would be.
   */
  get sprint(): boolean {
    return this.sprintKey || Math.hypot(this.stick.x, this.stick.y) > 0.92;
  }

  private keys = new Set<string>();
  private on = true;
  private root: HTMLElement;

  /** A jump that happened and ended between two sends. See the note up top. */
  private jumpTapped = false;
  /**
   * A trigger pull. The same button that digs, latched on the EDGE.
   *
   * Digging is a held thing and firing is not — a gun that went off sixty times a
   * second while the button was down would empty your pockets in a blink. Both come
   * off the same press and `main` uses whichever suits what is in your hand.
   */
  private fireQueued = false;
  private placeQueued = false;
  private placeHeld = false;
  private placeNextAt = 0;
  private pickQueued = false;
  private slotQueued: number | null = null;
  private slotDelta = 0;
  private invQueued = false;
  private helpQueued = false;

  /** Thumbstick, normalised to [-1, 1]. */
  private stick = { x: 0, y: 0 };
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private lookId = -1;
  /** Mouse look without pointer lock: only while a button is down. */
  private dragLook = false;

  readonly pad: HTMLElement;
  private nub: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;

    window.addEventListener('keydown', (e) => {
      if (!this.on || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || e.code === 'Space') {
        this.jump = true;
        this.jumpTapped = true;
        e.preventDefault(); // space scrolls the page otherwise
      }
      if (e.repeat) return;
      this.keys.add(k);
      if (k === 'shift') this.sprintKey = true;
      if (k >= '1' && k <= '9') this.slotQueued = Number(k) - 1;
      if (k === 'e') this.invQueued = true;
      if (k === '?' || k === '/') this.helpQueued = true;
      if (k.startsWith('arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === ' ' || e.code === 'Space') this.jump = false;
      if (k === 'shift') this.sprintKey = false;
    });
    /*
     * A window that loses focus with keys held would otherwise walk you into a wall
     * forever — and, worse, keep digging. Alt-tabbing out of a game must stop the
     * game doing things.
     */
    window.addEventListener('blur', () => this.release());

    // ---- mouse

    root.addEventListener('pointerdown', (e) => {
      if (!this.on || isChrome(e.target)) return;
      if (e.pointerType !== 'mouse') return this.touchDown(e);
      if (e.button === 0) {
        this.digging = true;
        this.fireQueued = true;
        // Held-drag look, for when pointer lock is refused or the player pressed
        // escape. An unlocked cursor that spins the camera whenever it crosses the
        // window is unusable, so it only turns while a button is down.
        if (document.pointerLockElement !== root) this.dragLook = true;
      } else if (e.button === 2) {
        this.placeQueued = true;
        this.placeHeld = true;
        this.placeNextAt = performance.now() + PLACE_REPEAT_MS * 2;
      } else if (e.button === 1) {
        this.pickQueued = true;
        e.preventDefault();
      }
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return this.touchUp(e);
      if (e.button === 0) {
        this.digging = false;
        this.dragLook = false;
      }
      if (e.button === 2) this.placeHeld = false;
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    // A button released outside the window never reaches the element.
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') up(e);
    });

    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return this.touchMove(e);
      if (!this.on) return;
      if (document.pointerLockElement !== root && !this.dragLook) return;
      this.look(e.movementX * MOUSE_SENS, -e.movementY * MOUSE_SENS);
    });

    root.addEventListener(
      'wheel',
      (e) => {
        if (!this.on) return;
        this.slotDelta += e.deltaY > 0 ? 1 : -1;
        e.preventDefault();
      },
      { passive: false },
    );

    /*
     * Pointer lock is the real first-person mouse, and a browser will only hand it
     * over from a genuine gesture — which is why it is asked for on a click and not
     * when the game starts.
     */
    root.addEventListener('click', () => {
      if (!this.on || document.pointerLockElement === root) return;
      try {
        const req = root.requestPointerLock() as unknown as Promise<void> | undefined;
        req?.catch?.(() => {
          /* refused — the held-drag path above still works */
        });
      } catch {
        /* not supported here */
      }
    });
    // Right-click places a block, so it must not also be the browser's menu — and on
    // a tablet the same event is the long-press callout, which would otherwise pop a
    // "copy / look up" bubble over the world every time somebody held DIG.
    root.addEventListener('contextmenu', (e) => {
      if (this.on) e.preventDefault();
    });
    /*
     * iOS decides on its own whether `user-scalable=no` applies, and since iOS 10 it
     * mostly decides not to. Killing the gesture events is the only thing that
     * actually stops a two-finger pinch from zooming the whole game, or a double-tap
     * on the DIG button from zooming into it.
     */
    for (const kind of ['gesturestart', 'gesturechange', 'gestureend']) {
      root.addEventListener(kind, (e) => e.preventDefault());
      document.addEventListener(kind, (e) => {
        if (this.on) e.preventDefault();
      });
    }

    // ---- touch
    //
    // The left half of the screen is a thumbstick that appears wherever you put your
    // thumb — there is no pad to find and no wrong place to press. The right half
    // looks around. Digging and building are buttons, because a tap that both aimed
    // and dug would do neither.

    this.pad = document.createElement('div');
    this.pad.className = 'stick hidden';
    const nub = document.createElement('div');
    nub.className = 'stick-nub';
    this.pad.appendChild(nub);
    root.appendChild(this.pad);
    this.nub = nub;

    this.button(root, 'jump-btn', 'JUMP', () => {
      this.jump = true;
      this.jumpTapped = true;
    }, () => {
      this.jump = false;
    });
    this.button(root, 'dig-btn', 'DIG', () => {
      this.digging = true;
      this.fireQueued = true;
    }, () => {
      this.digging = false;
    });
    this.button(root, 'place-btn', 'PUT', () => {
      this.placeQueued = true;
      this.placeHeld = true;
      this.placeNextAt = performance.now() + PLACE_REPEAT_MS * 2;
    }, () => {
      this.placeHeld = false;
    });
  }

  private button(
    root: HTMLElement,
    cls: string,
    label: string,
    down: () => void,
    up: () => void,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.on) down();
    });
    const end = (e: Event) => {
      e.stopPropagation();
      up();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('pointerleave', end);
    root.appendChild(b);
    return b;
  }

  private touchDown(e: PointerEvent): void {
    if (e.clientX > window.innerWidth / 2) {
      this.lookId = e.pointerId;
      return;
    }
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.pad.style.left = `${e.clientX}px`;
    this.pad.style.top = `${e.clientY}px`;
    this.pad.classList.remove('hidden');
    this.nub.style.transform = 'translate(-50%, -50%)';
  }

  private touchMove(e: PointerEvent): void {
    if (!this.on) return;
    if (e.pointerId === this.lookId) {
      this.look(e.movementX * TOUCH_SENS, -e.movementY * TOUCH_SENS);
      return;
    }
    if (e.pointerId !== this.stickId) return;
    const RADIUS = 46;
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(RADIUS, len);
    this.stick = { x: (dx / len) * (clamped / RADIUS), y: (dy / len) * (clamped / RADIUS) };
    this.nub.style.transform = `translate(calc(-50% + ${(dx / len) * clamped}px), calc(-50% + ${(dy / len) * clamped}px))`;
  }

  private touchUp(e: PointerEvent): void {
    if (e.pointerId === this.lookId) this.lookId = -1;
    if (e.pointerId !== this.stickId) return;
    this.stickId = -1;
    this.stick = { x: 0, y: 0 };
    this.pad.classList.add('hidden');
  }

  private look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    // Kept in a sane range so the number on the debug line does not wander off to
    // forty thousand after ten minutes of turning the same way.
    if (this.yaw > Math.PI * 4 || this.yaw < -Math.PI * 4) this.yaw %= Math.PI * 2;
    this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch + dPitch));
  }

  /** Where you want to go, relative to your face: forward, and to your right. */
  move(): { fwd: number; strafe: number } {
    let fwd = -this.stick.y;
    let strafe = this.stick.x;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) strafe -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) strafe += 1;
    return { fwd: clamp1(fwd), strafe: clamp1(strafe) };
  }

  /** True if a block should go down this frame, held-repeat included. */
  takePlace(): boolean {
    if (this.placeQueued) {
      this.placeQueued = false;
      this.placeNextAt = performance.now() + PLACE_REPEAT_MS * 2;
      return true;
    }
    if (!this.placeHeld) return false;
    const now = performance.now();
    if (now < this.placeNextAt) return false;
    this.placeNextAt = now + PLACE_REPEAT_MS;
    return true;
  }

  /** Jump for the wire: held, or tapped and released since the last send. */
  takeJump(): boolean {
    const want = this.jump || this.jumpTapped;
    this.jumpTapped = false;
    return want;
  }

  /** Read and clear a pending trigger pull. */
  takeFire(): boolean {
    const f = this.fireQueued;
    this.fireQueued = false;
    return f;
  }

  takePick(): boolean {
    const p = this.pickQueued;
    this.pickQueued = false;
    return p;
  }

  /** A hotbar slot chosen outright, or null. */
  takeSlot(): number | null {
    const s = this.slotQueued;
    this.slotQueued = null;
    return s;
  }

  /** How many notches the wheel has turned since last asked. */
  takeSlotDelta(): number {
    const d = this.slotDelta;
    this.slotDelta = 0;
    return d;
  }

  takeInventoryToggle(): boolean {
    const i = this.invQueued;
    this.invQueued = false;
    return i;
  }

  takeHelpToggle(): boolean {
    const h = this.helpQueued;
    this.helpQueued = false;
    return h;
  }

  get locked(): boolean {
    return document.pointerLockElement === this.root;
  }

  /**
   * Turn input on or off. Turning it off releases everything held, so a key that was
   * down when a panel opened is not still down when it closes.
   */
  setEnabled(on: boolean): void {
    this.on = on;
    if (!on) this.release();
  }

  private release(): void {
    this.keys.clear();
    this.jump = false;
    this.sprintKey = false;
    this.digging = false;
    this.dragLook = false;
    this.placeHeld = false;
    this.jumpTapped = false;
    this.fireQueued = false;
    this.stick = { x: 0, y: 0 };
    this.stickId = -1;
    this.lookId = -1;
    this.pad.classList.add('hidden');
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
  return isTyping(target) || (!!el && (el.tagName === 'BUTTON' || !!el.closest?.('.panel')));
}

function clamp1(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
