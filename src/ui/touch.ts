import type { Controls } from '../core/contracts.ts';
import { neutralControls } from '../core/controls.ts';
import { clamp } from '../core/mathx.ts';
import { UI } from '../core/palette.ts';

/**
 * Touch controls.
 *
 * Built as **DOM elements, not canvas regions**, specifically for
 * `setPointerCapture`: a captured pointer keeps firing at its element after the
 * finger slides off it, which is exactly what a drift button needs, because
 * your thumb *will* slide off it mid-corner. A canvas hit-test cannot do this —
 * the moment the finger leaves the region the button releases, and the drift
 * you were charging is gone.
 *
 * ============ BUG CLASS 10: INPUT GATES THAT MEASURE FRAME LATENCY ============
 * The steering zone has to tell a tap (use item) from a drag (steer). The
 * obvious test — "was pointerup within 200 ms of pointerdown" — measures the
 * gap between two *handler invocations*, which includes a whole render frame
 * and a compositor hop, and on a loaded phone it routinely reads 250 ms for a
 * genuine tap. So the gate here is **distance travelled**, which is a property
 * of the gesture rather than of the frame rate.
 */

/** A pointer that never travels further than this is a tap, however long it
 *  took. 14 CSS px is a little over a thumb's natural wobble. */
const TAP_DISTANCE_PX = 14;

/** Full lock at this many CSS pixels of travel from the touch-down point.
 *  Relative rather than absolute, so the steering zone has no "centre" the
 *  thumb has to find. */
const STEER_TRAVEL_PX = 84;

export type SteeringStyle = 'zone' | 'stick';
export type Handedness = 'right' | 'left';

export interface TouchOptions {
  steeringStyle: SteeringStyle;
  handedness: Handedness;
  /** 0.75 .. 1.5 */
  scale: number;
  autoThrottle: boolean;
}

export const DEFAULT_TOUCH_OPTIONS: TouchOptions = {
  // Auto-throttle plus a steering zone beats a virtual stick for most players,
  // because there is no reason not to be at full throttle most of the time.
  // Both are offered; this is the default, not the only option.
  steeringStyle: 'zone',
  handedness: 'right',
  scale: 1,
  autoThrottle: true,
};

interface Button {
  el: HTMLButtonElement;
  pressed: boolean;
  pointerId: number;
}

export class TouchControls {
  readonly root: HTMLDivElement;
  readonly controls: Controls = neutralControls();
  private options: TouchOptions;

  private steerZone!: HTMLDivElement;
  private steerKnob!: HTMLDivElement;
  private buttons: Record<string, Button> = {};

  private steerPointer = -1;
  private steerOriginX = 0;
  private steerOriginY = 0;
  private steerTravel = 0;
  private steerValue = 0;
  /** Set for one poll when a tap in the steering zone is recognised. */
  private tapPending = false;

  visible = false;
  onPause: () => void = () => {};

  constructor(options: TouchOptions = DEFAULT_TOUCH_OPTIONS) {
    this.options = { ...options };
    this.root = document.createElement('div');
    this.root.className = 'sd-touch';
    this.root.setAttribute('aria-hidden', 'false');
    this.build();
    this.applyOptions();
  }

  private build(): void {
    this.steerZone = document.createElement('div');
    this.steerZone.className = 'sd-steer';
    this.steerZone.setAttribute('role', 'slider');
    this.steerZone.setAttribute('aria-label', 'Steering');
    this.steerKnob = document.createElement('div');
    this.steerKnob.className = 'sd-steer-knob';
    this.steerZone.appendChild(this.steerKnob);
    this.root.appendChild(this.steerZone);

    this.steerZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.steerPointer !== -1) return;
      this.steerPointer = e.pointerId;
      // The capture is the whole reason these are DOM elements.
      this.steerZone.setPointerCapture(e.pointerId);
      this.steerOriginX = e.clientX;
      this.steerOriginY = e.clientY;
      this.steerTravel = 0;
    });
    this.steerZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return;
      e.preventDefault();
      const dx = e.clientX - this.steerOriginX;
      const dy = e.clientY - this.steerOriginY;
      this.steerTravel = Math.max(this.steerTravel, Math.hypot(dx, dy));
      if (this.options.steeringStyle === 'zone') {
        this.steerValue = clamp(dx / (STEER_TRAVEL_PX * this.options.scale), -1, 1);
      } else {
        this.steerValue = clamp(dx / (STEER_TRAVEL_PX * 0.8 * this.options.scale), -1, 1);
      }
      this.steerKnob.style.transform = `translateX(${this.steerValue * 34}px)`;
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      // Distance, not duration. See the bug class note at the top.
      if (this.steerTravel < TAP_DISTANCE_PX * this.options.scale) {
        this.tapPending = true;
      }
      this.steerPointer = -1;
      this.steerValue = 0;
      this.steerKnob.style.transform = 'translateX(0px)';
      if (this.steerZone.hasPointerCapture(e.pointerId)) {
        this.steerZone.releasePointerCapture(e.pointerId);
      }
    };
    this.steerZone.addEventListener('pointerup', endSteer);
    this.steerZone.addEventListener('pointercancel', endSteer);

    this.makeButton('drift', 'DRIFT');
    this.makeButton('item', 'ITEM');
    this.makeButton('brake', 'BRAKE');
    this.makeButton('throttle', 'GO');

    const pause = document.createElement('button');
    pause.className = 'sd-pause';
    pause.type = 'button';
    pause.textContent = '❙❙';
    pause.setAttribute('aria-label', 'Pause');
    // Without a pause button every option screen is unreachable on the
    // platform the game is actually for.
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onPause();
    });
    this.root.appendChild(pause);
  }

  private makeButton(name: string, label: string): void {
    const el = document.createElement('button');
    el.className = `sd-btn sd-btn-${name}`;
    el.type = 'button';
    el.textContent = label;
    el.setAttribute('aria-label', label);
    const state: Button = { el, pressed: false, pointerId: -1 };
    this.buttons[name] = state;

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      state.pressed = true;
      state.pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-down');
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== state.pointerId) return;
      state.pressed = false;
      state.pointerId = -1;
      el.classList.remove('is-down');
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    this.root.appendChild(el);
  }

  setOptions(options: Partial<TouchOptions>): void {
    this.options = { ...this.options, ...options };
    this.applyOptions();
  }

  getOptions(): TouchOptions {
    return { ...this.options };
  }

  private applyOptions(): void {
    this.root.dataset.hand = this.options.handedness;
    this.root.dataset.style = this.options.steeringStyle;
    this.root.style.setProperty('--sd-touch-scale', String(this.options.scale));
    const throttle = this.buttons.throttle;
    if (throttle) throttle.el.style.display = this.options.autoThrottle ? 'none' : '';
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
    this.root.setAttribute('aria-hidden', v ? 'false' : 'true');
  }

  poll(racing: boolean): Controls {
    const c = this.controls;
    c.steer = this.steerValue;
    c.drift = this.buttons.drift?.pressed ?? false;
    c.brake = this.buttons.brake?.pressed ? 1 : 0;
    // Auto-throttle only while actually racing — holding the field at full
    // throttle through the countdown would make the perfect start automatic.
    if (this.options.autoThrottle) {
      c.throttle = racing && !c.brake ? 1 : 0;
    } else {
      c.throttle = this.buttons.throttle?.pressed ? 1 : 0;
    }
    c.useItem = (this.buttons.item?.pressed ?? false) || this.tapPending;
    this.tapPending = false;
    c.lookBack = false;
    return c;
  }

  /**
   * Screen rectangles of every control, in CSS pixels. The mobile test asserts
   * geometrically that none of these overlaps a HUD instrument — comparing
   * screenshots by eye misses a two-pixel overlap, a rectangle intersection
   * does not.
   */
  rects(): Record<string, { x: number; y: number; w: number; h: number }> {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const add = (name: string, el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        out[name] = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    };
    add('touch.steer', this.steerZone);
    for (const [name, b] of Object.entries(this.buttons)) {
      if (b.el.style.display !== 'none') add(`touch.${name}`, b.el);
    }
    const pause = this.root.querySelector('.sd-pause');
    if (pause) add('touch.pause', pause);
    return out;
  }

  static css(): string {
    // 48 px is the floor for every interactive target, before the size slider
    // scales them up.
    return `
.sd-touch {
  position: fixed; inset: 0; pointer-events: none; z-index: 40;
  --sd-touch-scale: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.sd-touch > * { pointer-events: auto; }
.sd-steer {
  position: absolute; bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  width: calc(190px * var(--sd-touch-scale));
  height: calc(96px * var(--sd-touch-scale));
  border-radius: 18px;
  background: ${UI.shadow};
  border: 2px solid ${UI.panelEdge};
  display: flex; align-items: center; justify-content: center;
  touch-action: none; user-select: none;
}
.sd-touch[data-hand="right"] .sd-steer { left: calc(env(safe-area-inset-left, 0px) + 12px); }
.sd-touch[data-hand="left"]  .sd-steer { right: calc(env(safe-area-inset-right, 0px) + 12px); }
.sd-steer-knob {
  width: calc(56px * var(--sd-touch-scale)); height: calc(56px * var(--sd-touch-scale));
  border-radius: 50%; background: ${UI.panelEdge}; border: 2px solid ${UI.inkDim};
  transition: transform 60ms linear;
}
.sd-btn {
  position: absolute;
  min-width: calc(48px * var(--sd-touch-scale));
  min-height: calc(48px * var(--sd-touch-scale));
  width: calc(84px * var(--sd-touch-scale)); height: calc(84px * var(--sd-touch-scale));
  border-radius: 50%; border: 2px solid ${UI.panelEdge};
  background: ${UI.shadow}; color: ${UI.ink};
  font: 600 13px/1 ui-monospace, monospace; letter-spacing: 0.06em;
  touch-action: none; user-select: none; -webkit-tap-highlight-color: transparent;
}
.sd-btn.is-down { background: ${UI.accent}; color: #10131c; }
.sd-touch[data-hand="right"] .sd-btn-drift { right: calc(env(safe-area-inset-right, 0px) + 16px); bottom: calc(env(safe-area-inset-bottom, 0px) + 108px); }
.sd-touch[data-hand="right"] .sd-btn-item  { right: calc(env(safe-area-inset-right, 0px) + 112px); bottom: calc(env(safe-area-inset-bottom, 0px) + 76px); }
.sd-touch[data-hand="right"] .sd-btn-brake { right: calc(env(safe-area-inset-right, 0px) + 16px); bottom: calc(env(safe-area-inset-bottom, 0px) + 14px); }
.sd-touch[data-hand="right"] .sd-btn-throttle { right: calc(env(safe-area-inset-right, 0px) + 112px); bottom: calc(env(safe-area-inset-bottom, 0px) + 172px); }
.sd-touch[data-hand="left"] .sd-btn-drift { left: calc(env(safe-area-inset-left, 0px) + 16px); bottom: calc(env(safe-area-inset-bottom, 0px) + 108px); }
.sd-touch[data-hand="left"] .sd-btn-item  { left: calc(env(safe-area-inset-left, 0px) + 112px); bottom: calc(env(safe-area-inset-bottom, 0px) + 76px); }
.sd-touch[data-hand="left"] .sd-btn-brake { left: calc(env(safe-area-inset-left, 0px) + 16px); bottom: calc(env(safe-area-inset-bottom, 0px) + 14px); }
.sd-touch[data-hand="left"] .sd-btn-throttle { left: calc(env(safe-area-inset-left, 0px) + 112px); bottom: calc(env(safe-area-inset-bottom, 0px) + 172px); }
.sd-pause {
  position: absolute; top: calc(env(safe-area-inset-top, 0px) + 8px);
  right: calc(env(safe-area-inset-right, 0px) + 8px);
  width: 48px; height: 48px; border-radius: 12px;
  border: 2px solid ${UI.panelEdge}; background: ${UI.shadow}; color: ${UI.ink};
  font-size: 14px; touch-action: none;
}
`;
  }
}
