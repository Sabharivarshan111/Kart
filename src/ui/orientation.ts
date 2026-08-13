import { UI } from '../core/palette.ts';

/**
 * The landscape gate.
 *
 * This is a driving game with two thumbs on the bottom corners and a chase
 * camera that needs horizontal room to show the corner you are about to take.
 * In portrait there is nowhere to put the steering zone that is not either
 * under the kart or off the bottom of the screen, and the useful field of view
 * is roughly halved. Rather than lay the whole HUD out twice and ship a version
 * nobody should play, portrait shows this and pauses.
 *
 * `screen.orientation.lock('landscape')` is attempted on first touch in
 * `main.ts`, but it is refused on iOS entirely and in any browser that is not
 * fullscreen, so it can never be the only answer. This is the fallback that
 * always works.
 *
 * Detection is on `visualViewport`, not `screen.orientation`: a phone held
 * upright with the keyboard open, a foldable half-open, and a desktop window
 * dragged narrow are all cases where the reported orientation and the shape of
 * the space you actually have disagree. The shape is what matters.
 */

export interface OrientationGate {
  readonly root: HTMLDivElement;
  /** True while the gate is covering the screen. */
  readonly blocking: boolean;
  dispose(): void;
}

/** Below this the viewport is too short for the HUD's top band plus the
 *  steering zone plus a usable view between them. 380 CSS px measured against
 *  a 390×844 phone in landscape, which gives 390 of height. */
const MIN_LANDSCAPE_HEIGHT = 320;

export function createOrientationGate(
  parent: HTMLElement,
  onChange: (blocking: boolean) => void,
): OrientationGate {
  const root = document.createElement('div');
  root.className = 'sd-rotate';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-live', 'assertive');

  const inner = document.createElement('div');
  inner.className = 'sd-rotate-inner';
  root.appendChild(inner);

  // A phone drawn in CSS rather than an image or an emoji: the zero-asset rule
  // applies to the interstitial as much as to the track.
  const phone = document.createElement('div');
  phone.className = 'sd-rotate-phone';
  inner.appendChild(phone);

  const title = document.createElement('h2');
  title.className = 'sd-rotate-title';
  title.textContent = 'Turn your phone';
  inner.appendChild(title);

  const body = document.createElement('p');
  body.className = 'sd-rotate-body';
  body.textContent = 'Sparkdrift is played in landscape. Rotate to get racing.';
  inner.appendChild(body);

  parent.appendChild(root);

  const state = { blocking: false };

  const evaluate = () => {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    // Portrait, or a landscape window so short the controls would overlap the
    // instruments. Both are unplayable for the same reason.
    const blocking = h > w || h < MIN_LANDSCAPE_HEIGHT;
    if (blocking === state.blocking) return;
    state.blocking = blocking;
    root.classList.toggle('is-on', blocking);
    root.setAttribute('aria-hidden', blocking ? 'false' : 'true');
    onChange(blocking);
  };

  evaluate();

  const listeners: (() => void)[] = [];
  const on = (target: EventTarget | undefined | null, type: string) => {
    if (!target) return;
    target.addEventListener(type, evaluate);
    listeners.push(() => target.removeEventListener(type, evaluate));
  };
  on(window, 'resize');
  on(window, 'orientationchange');
  on(window.visualViewport, 'resize');

  return {
    root,
    get blocking() {
      return state.blocking;
    },
    dispose() {
      for (const off of listeners) off();
      root.remove();
    },
  };
}

export function orientationCss(): string {
  return `
.sd-rotate {
  position: fixed; inset: 0; z-index: 90;
  display: none; align-items: center; justify-content: center;
  background: ${UI.backdrop};
  color: ${UI.ink};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: center;
  padding: 24px;
  /* The gate is the only thing on screen, so it owns every gesture — without
     this a swipe over it still scrolls the page behind. */
  touch-action: none;
}
.sd-rotate.is-on { display: flex; }
.sd-rotate-inner { max-width: 30ch; }
.sd-rotate-phone {
  width: 54px; height: 92px; margin: 0 auto 26px;
  border: 3px solid ${UI.ink}; border-radius: 9px;
  position: relative;
  animation: sd-rotate-tip 2.4s ease-in-out infinite;
}
.sd-rotate-phone::after {
  /* The speaker slot, so the shape reads as a phone and not as a rectangle. */
  content: ''; position: absolute; top: 7px; left: 50%;
  transform: translateX(-50%);
  width: 18px; height: 3px; border-radius: 2px; background: ${UI.inkDim};
}
@keyframes sd-rotate-tip {
  0%, 30%   { transform: rotate(0deg); }
  55%, 100% { transform: rotate(-90deg); }
}
/* A device that reports a reduced-motion preference gets the shape without the
   tipping animation — the words carry the instruction on their own. */
@media (prefers-reduced-motion: reduce) {
  .sd-rotate-phone { animation: none; transform: rotate(-90deg); }
}
.sd-rotate-title {
  font-size: 22px; font-weight: 700; letter-spacing: 0.02em; margin: 0 0 10px;
}
.sd-rotate-body {
  font-size: 14px; line-height: 1.6; color: ${UI.inkDim}; margin: 0;
}
`;
}
