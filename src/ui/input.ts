import type { Controls } from '../core/contracts.ts';
import { neutralControls } from '../core/controls.ts';

/**
 * Keyboard and gamepad, producing the one control struct.
 *
 * Steering is ramped rather than binary: a keyboard gives you -1, 0 or +1, and
 * feeding that straight into a kart makes it twitch. The ramp is in *control*
 * space rather than in the vehicle, so a gamepad's analogue stick still gets
 * its full resolution and the AI is unaffected.
 */

/** Seconds for a key-held steer to reach full lock, and to return to centre.
 *  0.16 s measured against the steering response in `kart.ts`: any faster and
 *  keyboard input reintroduces the twitch the ramp exists to remove. */
const STEER_ATTACK = 0.16;
const STEER_RELEASE = 0.10;

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight', 'Space'],
  item: ['ControlLeft', 'KeyE', 'Enter'],
  lookBack: ['KeyQ'],
  pause: ['Escape', 'KeyP'],
} as const;

export class InputSource {
  readonly controls: Controls = neutralControls();
  private readonly down = new Set<string>();
  private steer = 0;
  private attached = false;
  /** Set for one poll when the pause key is pressed. */
  pausePressed = false;
  /** True while any keyboard or gamepad input is being given, so the game can
   *  hide the touch overlay on a device that has both. */
  active = false;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.down.add(e.code);
    this.active = true;
    if ((KEYS.pause as readonly string[]).includes(e.code)) this.pausePressed = true;
    // Space and the arrows scroll the page, which on a game canvas is never
    // what anyone wanted.
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private readonly onBlur = () => {
    // Without this, alt-tabbing mid-corner leaves the throttle held down and
    // the kart drives into a wall while the window is not even focused.
    this.down.clear();
    this.steer = 0;
  };

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private held(codes: readonly string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  poll(dt: number): Controls {
    const c = this.controls;
    c.throttle = this.held(KEYS.throttle) ? 1 : 0;
    c.brake = this.held(KEYS.brake) ? 1 : 0;
    c.drift = this.held(KEYS.drift);
    c.useItem = this.held(KEYS.item);
    c.lookBack = this.held(KEYS.lookBack);

    const left = this.held(KEYS.left);
    const right = this.held(KEYS.right);
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    if (target === 0) {
      const step = dt / STEER_RELEASE;
      this.steer = this.steer > 0 ? Math.max(0, this.steer - step) : Math.min(0, this.steer + step);
    } else {
      const step = dt / STEER_ATTACK;
      this.steer = Math.max(-1, Math.min(1, this.steer + Math.sign(target) * step));
    }
    c.steer = this.steer;

    this.pollGamepad(c);
    return c;
  }

  private pollGamepad(c: Controls): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      // Dead zone: sticks rest at small non-zero values and a kart that creeps
      // sideways on the grid is a bug report.
      const ax = pad.axes[0] ?? 0;
      const stick = Math.abs(ax) > 0.12 ? ax : 0;
      if (stick !== 0) {
        c.steer = Math.max(-1, Math.min(1, stick));
        this.active = true;
      }
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05) {
        c.throttle = rt;
        this.active = true;
      }
      if (lt > 0.05) c.brake = lt;
      if (pad.buttons[0]?.pressed) c.throttle = 1;
      if (pad.buttons[1]?.pressed) c.brake = 1;
      if (pad.buttons[5]?.pressed || pad.buttons[4]?.pressed) c.drift = true;
      if (pad.buttons[2]?.pressed) c.useItem = true;
      if (pad.buttons[3]?.pressed) c.lookBack = true;
      if (pad.buttons[9]?.pressed) this.pausePressed = true;
      break;
    }
  }

  consumePause(): boolean {
    const p = this.pausePressed;
    this.pausePressed = false;
    return p;
  }
}
