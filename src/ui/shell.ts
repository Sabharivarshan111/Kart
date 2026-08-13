import { CONFIG } from '../core/config.ts';
import type { CupSpec, DriverSpec, TrackSpec } from '../core/contracts.ts';
import { KART_COLOURS, UI } from '../core/palette.ts';
import { CUPS, cupById, cupTracks } from '../content/cups.ts';
import { ROSTER, driverById } from '../content/roster.ts';
import { TRACKS, trackById } from '../content/tracks/index.ts';
import type { Game } from '../game.ts';
import type { RaceMode } from '../race/rules.ts';
import { formatTime } from './hud.ts';
import { BUILD_TOOLS, LICENCES } from './licences.ts';
import {
  DIFFICULTY_CHOICES,
  GRID_CHOICES,
  RESOLUTION_CHOICES,
  TOUCH_SCALE_CHOICES,
  applyLiveSettings,
  clearCup,
  loadCup,
  loadSettings,
  saveCup,
  saveSettings,
  type CupSession,
  type Settings,
} from './settings.ts';

/**
 * The shell: title, mode select, cup select, character select, results, pause,
 * options and the open-source licences screen.
 *
 * ---------------------------------------------------------------------------
 * Three decisions worth stating before the code, because each one is load
 * bearing and none of them is obvious from reading a screen class.
 *
 * **1. The game is always constructed, the shell is always on top of it.**
 * `main.ts` builds the `Game` and installs `window.sparkdrift` exactly as it
 * did before this module existed; the shell is a DOM layer over a running
 * renderer. Nothing about the harness's boot order changed, which is why the
 * verification suite still reaches a race the same way it always did. Menus run
 * over a live attract race rather than a still image because the renderer is
 * already there and a static menu backdrop would be a second, worse copy of it.
 *
 * **2. Starting a race reloads the page.** ARCHITECTURE.md §3.2: selecting a
 * track stores the choice and reloads, because hot-swapping a theme means
 * rebuilding and disposing every material and one missed dispose is a leak that
 * only shows up after six races. So every "start" here ends in
 * `location.assign()`, and everything that must outlive that — options, cup
 * standings — is written down by `ui/settings.ts` first. Between-race state is
 * the *only* reason storage exists in this game.
 *
 * **3. Screens build on show and tear down on hide.** Every screen owns its
 * listeners through `Screen.on()`, which records the removal alongside the
 * addition. Going back destroys the screen and rebuilds the one beneath it from
 * its factory rather than un-hiding a retained instance, so there is no path
 * where a hidden screen is still listening to the window.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
//  Small DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

/** Palette hex number → CSS colour. Formatting only; every value passed in
 *  comes from `core/palette.ts`. */
function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

// ---------------------------------------------------------------------------
//  Keyboard navigation
// ---------------------------------------------------------------------------

/**
 * Two-dimensional keyboard navigation over rows of focusable elements.
 *
 * Rows rather than a flat list because half these screens are grids — the
 * character select is 8 tiles wide-by-two, the options screen is a stack of
 * segmented controls — and a flat next/previous list makes both of them a
 * finger-numbing sequence of presses. Left/right moves within a row, up/down
 * moves between rows keeping the column where it can.
 *
 * Disabled controls are never collected, so the split-screen row (which is
 * genuinely not implemented) cannot be focused and pressed.
 */
class NavGrid {
  private rows: HTMLElement[][] = [];
  private row = 0;
  private col = 0;

  addRow(items: HTMLElement[]): void {
    const usable = items.filter((i) => !(i as HTMLButtonElement).disabled);
    if (usable.length) this.rows.push(usable);
  }

  get isEmpty(): boolean {
    return this.rows.length === 0;
  }

  focusFirst(): void {
    this.row = 0;
    this.col = 0;
    this.rows[0]?.[0]?.focus();
  }

  /** Sync the cursor to whatever the pointer or Tab key focused, so the next
   *  arrow press continues from where the player actually is. */
  syncTo(target: EventTarget | null): void {
    for (let r = 0; r < this.rows.length; r++) {
      const c = this.rows[r]!.indexOf(target as HTMLElement);
      if (c >= 0) {
        this.row = r;
        this.col = c;
        return;
      }
    }
  }

  /** Returns true when the key was consumed. */
  handle(key: string): boolean {
    if (this.isEmpty) return false;
    const rowLen = () => this.rows[this.row]!.length;
    switch (key) {
      case 'ArrowRight':
      case 'KeyD':
        this.col = (this.col + 1) % rowLen();
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.col = (this.col - 1 + rowLen()) % rowLen();
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.row = (this.row + 1) % this.rows.length;
        this.col = Math.min(this.col, rowLen() - 1);
        break;
      case 'ArrowUp':
      case 'KeyW':
        this.row = (this.row - 1 + this.rows.length) % this.rows.length;
        this.col = Math.min(this.col, rowLen() - 1);
        break;
      default:
        return false;
    }
    this.rows[this.row]![this.col]!.focus();
    return true;
  }
}

// ---------------------------------------------------------------------------
//  Screen base
// ---------------------------------------------------------------------------

abstract class Screen {
  readonly root: HTMLDivElement;
  protected readonly nav = new NavGrid();
  private readonly teardown: (() => void)[] = [];

  constructor(
    protected readonly shell: Shell,
    name: string,
    veil: 'scrim' | 'solid',
  ) {
    this.root = el('div', 'sd-screen');
    this.root.dataset.screen = name;
    this.root.dataset.veil = veil;
  }

  /** Add a listener and record its removal in the same breath. Nothing in a
   *  screen may call `addEventListener` any other way — that is the whole
   *  mechanism that stops a torn-down screen from still being wired up. */
  protected on<T extends EventTarget, E extends Event>(
    target: T,
    type: string,
    handler: (ev: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, options);
    this.teardown.push(() => target.removeEventListener(type, h, options));
  }

  /** Called once the root is in the document, so anything that measures has
   *  something to measure. */
  mounted(): void {
    this.on<HTMLElement, KeyboardEvent>(this.root, 'keydown', (e) => this.onKey(e));
    this.on<HTMLElement, FocusEvent>(this.root, 'focusin', (e) => this.nav.syncTo(e.target));
    this.nav.focusFirst();
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.code === 'Escape' || e.code === 'Backspace') {
      // Stopped here so the game's own InputSource — which listens on window
      // and treats Escape as pause — never sees a key the menu just used.
      e.preventDefault();
      e.stopPropagation();
      this.shell.back();
      return;
    }
    if (this.nav.handle(e.code)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  destroy(): void {
    for (const t of this.teardown) t();
    this.teardown.length = 0;
    this.root.remove();
  }

  // -- shared furniture ------------------------------------------------------

  protected head(title: string, sub?: string): HTMLDivElement {
    const head = el('div', 'sd-head', this.root);
    el('h1', 'sd-h1', head, title);
    if (sub) el('p', 'sd-sub', head, sub);
    return head;
  }

  protected body(scroll = true): HTMLDivElement {
    const body = el('div', 'sd-body', this.root);
    if (scroll) body.dataset.scroll = '1';
    return body;
  }

  protected foot(): HTMLDivElement {
    return el('div', 'sd-foot', this.root);
  }

  protected button(parent: HTMLElement, label: string, onPress: () => void): HTMLButtonElement {
    const b = el('button', 'sd-btnx', parent, label);
    b.type = 'button';
    this.on<HTMLButtonElement, MouseEvent>(b, 'click', () => onPress());
    return b;
  }
}

// ---------------------------------------------------------------------------
//  Title
// ---------------------------------------------------------------------------

/**
 * The wordmark, drawn to a canvas at load.
 *
 * Zero external assets means no logo file and no downloaded typeface, so the
 * mark is *constructed*: the system's heavy sans, sheared for speed, given a
 * hard ink keyline and a two-band flat fill with a crisp step rather than a
 * gradient — the same banding rule the renderer's cel ramp follows, so the
 * title looks like it came from the same game as the frame behind it.
 *
 * The trace beneath it is an ECG that loses its nerve: three clinical beats,
 * then the fourth pulls into a drift arc and leaves. That is the whole premise
 * of the game — medical students who have blocked out a weekend — in one line,
 * and it is drawn from arithmetic, not from an image.
 */
function drawWordmark(canvas: HTMLCanvasElement, cssWidth: number, cssMaxHeight: number): void {
  // Width alone is the wrong constraint. A phone in landscape is 844x390: the
  // full-width mark would be 760x228, which is 58% of the height, and the three
  // buttons under it fall off the bottom of the screen — measured, before this
  // second clamp existed. Height gets a vote.
  const byWidth = Math.max(260, Math.min(cssWidth, 760));
  const w = Math.max(260, Math.min(byWidth, Math.round(cssMaxHeight / 0.3)));
  const h = Math.round(w * 0.30);
  const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const word = 'SPARKDRIFT';
  const font = (size: number) =>
    `900 ${size}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;

  // Fit the word to 92% of the width by measuring, not by guessing: the
  // available system face differs between platforms and a hard-coded size
  // either overflows or floats in the middle of the panel.
  ctx.font = font(100);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '4px';
  const measured = ctx.measureText(word).width || 1;
  const size = Math.min((w * 0.92 * 100) / measured, h * 0.62);
  ctx.font = font(size);

  const baseline = h * 0.66;
  const textW = ctx.measureText(word).width;
  const x = (w - textW) / 2;

  // Shear from the baseline, so the letters lean forward without the word
  // sliding off its own centre.
  ctx.save();
  ctx.transform(1, 0, -0.13, 1, baseline * 0.13, 0);

  // Two echo copies behind, trailing to the left. Speed lines that are the
  // word itself rather than decoration stuck next to it.
  for (let i = 2; i >= 1; i--) {
    ctx.globalAlpha = 0.1 * i;
    ctx.fillStyle = UI.accentAlt;
    ctx.fillText(word, x - i * size * 0.09, baseline);
  }
  ctx.globalAlpha = 1;

  // Ink keyline first and thick, then the fill over it: stroking after filling
  // eats half the letterform at this weight.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = UI.backdrop;
  ctx.lineWidth = Math.max(6, size * 0.14);
  ctx.strokeText(word, x, baseline);

  // The cel band: a hard step at 46% of the cap height, no interpolation, the
  // same rule as the renderer's nearest-filtered ramp.
  const capTop = baseline - size * 0.72;
  const band = ctx.createLinearGradient(0, capTop, 0, baseline);
  band.addColorStop(0, css(KART_COLOURS.amber!));
  band.addColorStop(0.46, css(KART_COLOURS.amber!));
  band.addColorStop(0.46, css(KART_COLOURS.ember!));
  band.addColorStop(1, css(KART_COLOURS.ember!));
  ctx.fillStyle = band;
  ctx.fillText(word, x, baseline);
  ctx.restore();

  // --- the ECG that becomes a drift ----------------------------------------
  const y = h * 0.88;
  const x0 = w * 0.06;
  const x1 = w * 0.94;
  const beat = (w * 0.58) / 3;
  ctx.strokeStyle = UI.accentAlt;
  ctx.lineWidth = Math.max(2, w * 0.005);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y);
  for (let i = 0; i < 3; i++) {
    const bx = x0 + i * beat;
    ctx.lineTo(bx + beat * 0.32, y);
    ctx.lineTo(bx + beat * 0.40, y - h * 0.05); // P
    ctx.lineTo(bx + beat * 0.46, y);
    ctx.lineTo(bx + beat * 0.52, y + h * 0.04); // Q
    ctx.lineTo(bx + beat * 0.58, y - h * 0.22); // R
    ctx.lineTo(bx + beat * 0.64, y + h * 0.08); // S
    ctx.lineTo(bx + beat * 0.72, y);
  }
  // The fourth beat never comes back down to the baseline: it sweeps out as a
  // drift arc off the right-hand side.
  const sx = x0 + 3 * beat;
  ctx.quadraticCurveTo(sx + (x1 - sx) * 0.45, y, x1, y - h * 0.26);
  ctx.stroke();

  // Three sparks off the arc, in the drift tiers' own escalation order.
  ctx.fillStyle = UI.accent;
  for (let i = 0; i < 3; i++) {
    const t = 0.72 + i * 0.09;
    const px = sx + (x1 - sx) * t;
    const py = y - h * 0.26 * t * t;
    ctx.beginPath();
    ctx.arc(px, py - h * 0.05 * i, Math.max(1.6, w * 0.0035), 0, Math.PI * 2);
    ctx.fill();
  }
}

class TitleScreen extends Screen {
  private readonly canvas: HTMLCanvasElement;

  constructor(shell: Shell) {
    super(shell, 'title', 'scrim');

    const mark = el('div', 'sd-title-mark', this.root);
    this.canvas = el('canvas', 'sd-wordmark', mark);
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Sparkdrift');
    el(
      'p',
      'sd-tagline',
      mark,
      'Eight medical students, one weekend off, and eight circuits across India.',
    );

    const body = this.body(false);
    const main = el('div', 'sd-title-actions', body);
    const start = this.button(main, 'START', () => this.shell.push(() => new ModeScreen(this.shell)));
    start.classList.add('is-primary');
    const opts = this.button(main, 'OPTIONS', () =>
      this.shell.push(() => new OptionsScreen(this.shell)),
    );
    const lic = this.button(main, 'OPEN SOURCE LICENCES', () =>
      this.shell.push(() => new LicencesScreen(this.shell)),
    );
    this.nav.addRow([start]);
    this.nav.addRow([opts]);
    this.nav.addRow([lic]);

    const foot = this.foot();
    el(
      'p',
      'sd-fine',
      foot,
      'Arrow keys or WASD to move, Enter to choose, Esc to go back. Everything is touchable.',
    );
    el(
      'p',
      'sd-fine',
      foot,
      'Sparkdrift 0.1.0 — MIT. Built with three.js (MIT); its notice is on the licences screen.',
    );
  }

  override mounted(): void {
    super.mounted();
    this.redraw();
    this.on<Window, UIEvent>(window, 'resize', () => this.redraw());
  }

  private redraw(): void {
    // A third of the screen for the mark, at most. The rest belongs to the
    // buttons, which are the point of the screen.
    drawWordmark(this.canvas, this.root.clientWidth - 40, this.root.clientHeight * 0.34);
  }
}

// ---------------------------------------------------------------------------
//  Mode select
// ---------------------------------------------------------------------------

class ModeScreen extends Screen {
  constructor(shell: Shell) {
    super(shell, 'modes', 'scrim');
    this.head('CHOOSE A MODE');
    const body = this.body();

    const gp = this.card(body, {
      title: 'GRAND PRIX',
      note: 'Four tracks in a fixed order. Points after every race, carried to the next.',
      onPress: () => this.shell.push(() => new CupScreen(this.shell, 'grand-prix')),
    });
    const tt = this.card(body, {
      title: 'TIME TRIAL',
      note: 'One track, three laps, no rivals and no items. Only the clock.',
      onPress: () => this.shell.push(() => new CupScreen(this.shell, 'time-trial')),
    });
    const ss = this.card(body, {
      title: 'SPLIT-SCREEN',
      note: 'Two players, one screen. Not in this build — nothing behind this button yet.',
      chip: 'NOT BUILT',
      disabled: true,
    });
    ss.classList.add('is-unbuilt');

    this.nav.addRow([gp]);
    this.nav.addRow([tt]);
    this.nav.addRow([ss]);

    const foot = this.foot();
    const back = this.button(foot, '‹ BACK', () => this.shell.back());
    this.nav.addRow([back]);
  }

  private card(
    parent: HTMLElement,
    o: { title: string; note: string; chip?: string; disabled?: boolean; onPress?: () => void },
  ): HTMLButtonElement {
    const b = el('button', 'sd-card', parent);
    b.type = 'button';
    const line = el('div', 'sd-card-line', b);
    el('span', 'sd-card-title', line, o.title);
    if (o.chip) el('span', 'sd-chip is-warn', line, o.chip);
    el('div', 'sd-card-note', b, o.note);
    if (o.disabled) {
      b.disabled = true;
    } else if (o.onPress) {
      this.on<HTMLButtonElement, MouseEvent>(b, 'click', () => o.onPress!());
    }
    return b;
  }
}

// ---------------------------------------------------------------------------
//  Cup / track select
// ---------------------------------------------------------------------------

class CupScreen extends Screen {
  constructor(shell: Shell, private readonly mode: RaceMode) {
    super(shell, mode === 'time-trial' ? 'tracks' : 'cups', 'scrim');
    this.head(
      mode === 'time-trial' ? 'CHOOSE A TRACK' : 'CHOOSE A CUP',
      mode === 'time-trial'
        ? 'Every track in the game, grouped by the cup it belongs to.'
        : 'Four tracks, raced in this order. The order is the design.',
    );

    const body = this.body();
    const grid = el('div', 'sd-cups', body);

    for (const cup of CUPS) {
      const panel = el('div', 'sd-cup', grid);
      const header = el('div', 'sd-cup-head', panel);
      el('div', 'sd-cup-name', header, cup.name.toUpperCase());
      el('div', 'sd-cup-blurb', header, cup.blurb);

      const tracks = cupTracks(cup);
      if (this.mode === 'grand-prix') {
        const list = el('ol', 'sd-tracklist', panel);
        for (const t of tracks) this.trackLine(list, t, false);
        const go = this.button(panel, `RACE THE ${cup.name.toUpperCase()}`, () =>
          this.shell.push(() => new CharacterScreen(this.shell, this.mode, tracks[0]!, cup)),
        );
        go.classList.add('is-primary');
        this.nav.addRow([go]);
      } else {
        const list = el('ol', 'sd-tracklist', panel);
        const row: HTMLElement[] = [];
        for (const t of tracks) {
          const b = this.trackLine(list, t, true);
          this.on<HTMLElement, MouseEvent>(b, 'click', () =>
            this.shell.push(() => new CharacterScreen(this.shell, this.mode, t, null)),
          );
          row.push(b);
        }
        for (const b of row) this.nav.addRow([b]);
      }
    }

    const foot = this.foot();
    const back = this.button(foot, '‹ BACK', () => this.shell.back());
    this.nav.addRow([back]);
  }

  /** One track: its name, and the single sentence the track was built around,
   *  straight off the `TrackSpec`. Written as a button in time trial and as a
   *  list item in a cup, because in a cup the running order is the choice. */
  private trackLine(list: HTMLElement, t: TrackSpec, selectable: boolean): HTMLElement {
    const li = el('li', 'sd-track', list);
    const node = selectable ? el('button', 'sd-track-btn', li) : el('div', 'sd-track-btn', li);
    if (selectable) (node as HTMLButtonElement).type = 'button';
    el('div', 'sd-track-name', node, t.name);
    el('div', 'sd-track-idea', node, t.idea);
    return node;
  }
}

// ---------------------------------------------------------------------------
//  Character select
// ---------------------------------------------------------------------------

const STAT_ROWS: { key: keyof DriverSpec & ('topSpeed' | 'acceleration' | 'handling' | 'weight'); label: string }[] = [
  { key: 'topSpeed', label: 'TOP SPEED' },
  { key: 'acceleration', label: 'ACCELERATION' },
  { key: 'handling', label: 'HANDLING' },
  { key: 'weight', label: 'WEIGHT' },
];

class CharacterScreen extends Screen {
  private selected: DriverSpec = ROSTER[0]!;
  private readonly detail: HTMLDivElement;
  private readonly tiles = new Map<string, HTMLButtonElement>();

  constructor(
    shell: Shell,
    private readonly mode: RaceMode,
    private readonly track: TrackSpec,
    private readonly cup: CupSpec | null,
  ) {
    super(shell, 'characters', 'scrim');
    this.head(
      'CHOOSE A DRIVER',
      cup ? `${cup.name} — race 1 of ${cup.trackIds.length}, ${track.name}` : `Time trial — ${track.name}`,
    );

    const body = this.body();
    const layout = el('div', 'sd-chars', body);

    const gridWrap = el('div', 'sd-char-grid', layout);
    const rowA: HTMLElement[] = [];
    const rowB: HTMLElement[] = [];
    ROSTER.forEach((d, i) => {
      const tile = el('button', 'sd-char', gridWrap);
      tile.type = 'button';
      tile.dataset.driver = d.id;
      const swatch = el('span', 'sd-char-swatch', tile);
      swatch.style.background = css(KART_COLOURS[d.colourKey] ?? KART_COLOURS.slate!);
      el('span', 'sd-char-name', tile, d.name);
      this.on<HTMLButtonElement, MouseEvent>(tile, 'click', () => this.select(d));
      this.on<HTMLButtonElement, FocusEvent>(tile, 'focus', () => this.select(d));
      this.tiles.set(d.id, tile);
      (i < 4 ? rowA : rowB).push(tile);
    });
    this.nav.addRow(rowA);
    this.nav.addRow(rowB);

    this.detail = el('div', 'sd-char-detail', layout);

    const foot = this.foot();
    const back = this.button(foot, '‹ BACK', () => this.shell.back());
    const go = this.button(foot, 'START RACE ▸', () => this.start());
    go.classList.add('is-primary');
    this.nav.addRow([back, go]);

    this.select(ROSTER[0]!);
  }

  private select(d: DriverSpec): void {
    this.selected = d;
    for (const [id, tile] of this.tiles) tile.setAttribute('aria-pressed', String(id === d.id));
    this.renderDetail();
  }

  /**
   * The stat panel.
   *
   * Bars, not adjectives: the four numbers are real multipliers in
   * `vehicle/kart.ts`, and no stat total is constant across the roster, so a
   * bar chart is an honest picture of the trade and a five-star rating is not.
   *
   * Weight gets a sentence of its own because it is the one trade nobody
   * guesses. It is a genuine mass multiplier — it decides who wins a
   * collision — so the panel says so and then says exactly who this driver
   * beats and loses to, counted from the roster rather than asserted.
   */
  private renderDetail(): void {
    const d = this.selected;
    this.detail.replaceChildren();

    const head = el('div', 'sd-detail-head', this.detail);
    const swatch = el('span', 'sd-char-swatch is-big', head);
    swatch.style.background = css(KART_COLOURS[d.colourKey] ?? KART_COLOURS.slate!);
    el('div', 'sd-detail-name', head, d.name);

    const bars = el('div', 'sd-bars', this.detail);
    for (const row of STAT_ROWS) {
      const value = d[row.key];
      const line = el('div', 'sd-bar-row', bars);
      el('span', 'sd-bar-label', line, row.label);
      const track = el('span', 'sd-bar-track', line);
      const fill = el('span', 'sd-bar-fill', track);
      fill.style.width = pct(value);
      if (row.key === 'weight') fill.classList.add('is-weight');
      el('span', 'sd-bar-value', line, pct(value));
    }

    const lighter = ROSTER.filter((o) => o.weight < d.weight).length;
    const heavier = ROSTER.filter((o) => o.weight > d.weight).length;
    const note = el('div', 'sd-weight-note', this.detail);
    el('div', 'sd-weight-title', note, 'WEIGHT DECIDES WHO WINS A COLLISION');
    el(
      'p',
      'sd-weight-body',
      note,
      `It is a real mass multiplier, not a label: the heavier kart shoves the lighter one off its line, ` +
        `and above a ${CONFIG.kart.collision.spinThreshold} m/s closing speed it spins them out. ` +
        `${d.name} out-muscles ${lighter} of the grid and gets shoved by ${heavier}.`,
    );
    el(
      'p',
      'sd-fine',
      note,
      `As a rival: skill ${d.ai.skill.toFixed(2)}, aggression ${d.ai.aggression.toFixed(2)}, ` +
        `${d.ai.sloppiness.toFixed(1)} mistakes/min at zero skill.`,
    );
  }

  private start(): void {
    this.shell.launch({
      track: this.track.id,
      mode: this.mode,
      driver: this.selected.id,
      cup: this.cup?.id ?? null,
      round: this.cup ? 1 : null,
    });
  }
}

// ---------------------------------------------------------------------------
//  Options
// ---------------------------------------------------------------------------

class OptionsScreen extends Screen {
  constructor(shell: Shell) {
    super(shell, 'options', 'solid');
    this.head(
      'OPTIONS',
      'Every setting says when it takes effect. LIVE changes the running game now; NEXT RACE cannot, and says so.',
    );
    const body = this.body();
    const s = shell.settings;

    this.choice(body, {
      label: 'REDUCE CAMERA MOTION',
      applies: 'live',
      note: `Scales camera roll, shake and the FOV kick to ${CONFIG.camera.reducedMotionScale}× of normal. Banked track plus rolling camera plus FOV punch is what makes people ill.`,
      options: [
        { label: 'OFF', value: false },
        { label: 'ON', value: true },
      ],
      get: () => s.reduceMotion,
      set: (v) => {
        s.reduceMotion = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'ADAPTIVE RESOLUTION',
      applies: 'live',
      note: `Lets the renderer drop resolution to hold the frame budget. The floor is ${CONFIG.quality.scaleFloor}× — never lower, because a half-resolution image on a high-density panel looks broken while doing exactly what it was told.`,
      options: [
        { label: 'OFF', value: false },
        { label: 'ON', value: true },
      ],
      get: () => s.adaptive,
      set: (v) => {
        s.adaptive = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'RESOLUTION SCALE',
      applies: 'live',
      note: 'The fixed scale used when adaptive is off. With adaptive on, this is ignored and the controller decides.',
      options: RESOLUTION_CHOICES.map((v) => ({ label: `${Math.round(v * 100)}%`, value: v })),
      get: () => s.resolutionScale,
      set: (v) => {
        s.resolutionScale = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'FPS COUNTER',
      applies: 'live',
      note: 'Frames per second measured on the real animation-frame clock, with the worst frame in the last second.',
      options: [
        { label: 'OFF', value: false },
        { label: 'ON', value: true },
      ],
      get: () => s.fpsCounter,
      set: (v) => {
        s.fpsCounter = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'TOUCH HANDEDNESS',
      applies: 'live',
      note: 'Which thumb steers. Moves the steering zone and the buttons to the other side together.',
      options: [
        { label: 'STEER LEFT', value: 'right' as const },
        { label: 'STEER RIGHT', value: 'left' as const },
      ],
      get: () => s.handedness,
      set: (v) => {
        s.handedness = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'TOUCH SIZE',
      applies: 'live',
      note: 'Scales every touch control. The smallest setting still leaves each target above the 48 px floor.',
      options: TOUCH_SCALE_CHOICES.map((v) => ({ label: `${Math.round(v * 100)}%`, value: v })),
      get: () => s.touchScale,
      set: (v) => {
        s.touchScale = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'RIVAL DIFFICULTY',
      applies: 'next-race',
      note: 'How close the AI drives to the ideal speed profile. Each rival is built with this at the start of a race, so changing it now does nothing to the race you are in.',
      options: [
        { label: 'RELAXED', value: DIFFICULTY_CHOICES[0] },
        { label: 'STANDARD', value: DIFFICULTY_CHOICES[1] },
        { label: 'RUTHLESS', value: DIFFICULTY_CHOICES[2] },
      ],
      get: () => s.difficulty,
      set: (v) => {
        s.difficulty = v;
        shell.commitSettings();
      },
    });

    this.choice(body, {
      label: 'KARTS ON THE GRID',
      applies: 'next-race',
      note: 'Including you. The grid is laid out when the race is built, so this takes effect the next time one is.',
      options: GRID_CHOICES.map((v) => ({ label: String(v), value: v })),
      get: () => s.gridSize,
      set: (v) => {
        s.gridSize = v;
        shell.commitSettings();
      },
    });

    const foot = this.foot();
    const back = this.button(foot, '‹ BACK', () => this.shell.back());
    const lic = this.button(foot, 'OPEN SOURCE LICENCES', () =>
      this.shell.push(() => new LicencesScreen(this.shell)),
    );
    this.nav.addRow([back, lic]);
  }

  private choice<T>(
    parent: HTMLElement,
    o: {
      label: string;
      applies: 'live' | 'next-race';
      note: string;
      options: { label: string; value: T }[];
      get: () => T;
      set: (v: T) => void;
    },
  ): void {
    const row = el('div', 'sd-opt', parent);
    const head = el('div', 'sd-opt-head', row);
    el('span', 'sd-opt-label', head, o.label);
    const chip = el('span', 'sd-chip', head, o.applies === 'live' ? 'LIVE' : 'APPLIES NEXT RACE');
    chip.classList.add(o.applies === 'live' ? 'is-live' : 'is-later');
    el('p', 'sd-opt-note', row, o.note);

    const seg = el('div', 'sd-seg', row);
    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const current = o.get();
      for (let i = 0; i < buttons.length; i++) {
        buttons[i]!.setAttribute('aria-pressed', String(o.options[i]!.value === current));
      }
    };
    for (const opt of o.options) {
      const b = el('button', 'sd-seg-btn', seg, opt.label);
      b.type = 'button';
      this.on<HTMLButtonElement, MouseEvent>(b, 'click', () => {
        o.set(opt.value);
        sync();
      });
      buttons.push(b);
    }
    sync();
    this.nav.addRow(buttons);
  }
}

// ---------------------------------------------------------------------------
//  Licences
// ---------------------------------------------------------------------------

class LicencesScreen extends Screen {
  constructor(shell: Shell) {
    super(shell, 'licences', 'solid');
    this.head(
      'OPEN SOURCE LICENCES',
      'Full texts, carried inside the game. The game plays from a file with no network, so a link would not be a notice.',
    );
    const body = this.body();

    for (const entry of LICENCES) {
      const block = el('section', 'sd-lic', body);
      const head = el('div', 'sd-lic-head', block);
      el('span', 'sd-lic-name', head, `${entry.name} ${entry.version}`);
      const chip = el('span', 'sd-chip', head, entry.spdx);
      chip.classList.add('is-live');
      if (entry.shipped) el('span', 'sd-chip is-later', head, 'IN THIS BUILD');
      el('p', 'sd-lic-role', block, entry.role);
      el('pre', 'sd-lic-text', block, entry.text);
    }

    const tools = el('section', 'sd-lic', body);
    el('div', 'sd-lic-name', tools, 'Build tools — not distributed');
    el(
      'p',
      'sd-lic-role',
      tools,
      'Used to compile the game. None of their code is present in the file you are running, so no notice is required for them; they are listed so the claim above is checkable.',
    );
    const list = el('ul', 'sd-lic-tools', tools);
    for (const t of BUILD_TOOLS) el('li', '', list, `${t.name} ${t.version} — ${t.spdx}`);

    const foot = this.foot();
    const back = this.button(foot, '‹ BACK', () => this.shell.back());
    this.nav.addRow([back]);
  }
}

// ---------------------------------------------------------------------------
//  Pause
// ---------------------------------------------------------------------------

class PauseScreen extends Screen {
  constructor(shell: Shell) {
    super(shell, 'pause', 'scrim');
    this.root.classList.add('is-centred');
    const panel = el('div', 'sd-pause-panel', this.root);
    el('h1', 'sd-h1', panel, 'PAUSED');
    el('p', 'sd-sub', panel, shell.raceTitle());

    const resume = this.button(panel, 'RESUME', () => this.shell.resume());
    resume.classList.add('is-primary');
    const restart = this.button(panel, 'RESTART RACE', () => this.shell.restartRace());
    const options = this.button(panel, 'OPTIONS', () =>
      this.shell.push(() => new OptionsScreen(this.shell)),
    );
    const quit = this.button(panel, 'QUIT TO TITLE', () => this.shell.quitToTitle());
    quit.classList.add('is-danger');

    this.nav.addRow([resume]);
    this.nav.addRow([restart]);
    this.nav.addRow([options]);
    this.nav.addRow([quit]);
  }
}

// ---------------------------------------------------------------------------
//  Results
// ---------------------------------------------------------------------------

class ResultsScreen extends Screen {
  constructor(shell: Shell, cup: CupSpec | null, round: number) {
    super(shell, 'results', 'solid');
    const game = shell.game;
    const results = game.race.results();
    const isCup = cup !== null && game.race.mode === 'grand-prix';
    const totals = isCup ? shell.recordCupPoints(cup!, round, results) : null;

    this.head(
      isCup ? `${cup!.name.toUpperCase()} — RACE ${round} OF ${cup!.trackIds.length}` : 'RESULTS',
      `${game.spec.name} — ${game.race.totalLaps} laps`,
    );

    const body = this.body();
    const columns = el('div', 'sd-results-cols', body);

    const table = el('div', 'sd-table', columns);
    const header = el('div', 'sd-tr is-header', table);
    el('span', 'sd-td is-pos', header, 'POS');
    el('span', 'sd-td is-name', header, 'DRIVER');
    el('span', 'sd-td is-num', header, 'TIME');
    el('span', 'sd-td is-num', header, 'BEST LAP');
    if (isCup) el('span', 'sd-td is-num', header, 'PTS');

    for (const r of results) {
      const kart = game.karts[r.index]!;
      const row = el('div', 'sd-tr', table);
      if (kart.isPlayer) row.classList.add('is-player');
      el('span', 'sd-td is-pos', row, String(r.position));
      const name = el('span', 'sd-td is-name', row);
      const swatch = el('span', 'sd-char-swatch is-dot', name);
      swatch.style.background = css(KART_COLOURS[kart.driver.colourKey] ?? KART_COLOURS.slate!);
      el('span', '', name, kart.driver.name);
      // A kart that never finished has a finish time of zero, which would print
      // as a suspiciously fast 0:00.000. It gets DNF, because that is what it is.
      el('span', 'sd-td is-num', row, r.totalTime > 0 ? formatTime(r.totalTime) : 'DNF');
      el('span', 'sd-td is-num', row, r.bestLap > 0 ? formatTime(r.bestLap) : '—');
      if (isCup) el('span', 'sd-td is-num is-points', row, `+${r.points}`);
    }

    if (isCup && totals) {
      const side = el('div', 'sd-standings', columns);
      el('div', 'sd-standings-head', side, `STANDINGS AFTER RACE ${round}`);
      const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      for (const [driverId, points] of ranked) {
        const row = el('div', 'sd-tr', side);
        let driverName = driverId;
        try {
          driverName = driverById(driverId).name;
        } catch {
          // A cup carried over from a build with a different roster: show the id
          // rather than throwing on a screen the player cannot leave.
        }
        if (driverId === game.playerKart.driver.id) row.classList.add('is-player');
        el('span', 'sd-td is-name', row, driverName);
        el('span', 'sd-td is-num is-points', row, String(points));
      }
      el(
        'p',
        'sd-fine',
        side,
        `Points per finishing position: ${CONFIG.race.cupPoints.join(' · ')}.`,
      );
    }

    const foot = this.foot();
    const buttons: HTMLElement[] = [];
    if (isCup && round < cup!.trackIds.length) {
      const next = this.button(foot, 'NEXT RACE ▸', () => {
        const tracks = cupTracks(cup!);
        this.shell.launch({
          track: tracks[round]!.id,
          mode: 'grand-prix',
          driver: game.playerKart.driver.id,
          cup: cup!.id,
          round: round + 1,
        });
      });
      next.classList.add('is-primary');
      buttons.push(next);
    } else if (isCup) {
      const champion = Object.entries(totals ?? {}).sort((a, b) => b[1] - a[1])[0];
      if (champion) {
        el(
          'p',
          'sd-champion',
          foot,
          `${safeName(champion[0])} takes the ${cup!.name} with ${champion[1]} points.`,
        );
      }
    }
    const retry = this.button(foot, 'RETRY THIS RACE', () => this.shell.restartRace());
    const quit = this.button(foot, 'QUIT TO TITLE', () => this.shell.quitToTitle());
    buttons.push(retry, quit);
    this.nav.addRow(buttons);
  }

  /** Results is the end of a race, not a screen you can back out of. */
  protected override onKey(e: KeyboardEvent): void {
    if (e.code === 'Escape' || e.code === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    super.onKey(e);
  }
}

function safeName(driverId: string): string {
  try {
    return driverById(driverId).name;
  } catch {
    return driverId;
  }
}

// ---------------------------------------------------------------------------
//  The shell
// ---------------------------------------------------------------------------

export interface ShellOptions {
  game: Game;
  /** The overlay element the HUD and touch controls already live in. */
  overlay: HTMLElement;
  params: URLSearchParams;
}

export class Shell {
  readonly root: HTMLDivElement;
  readonly game: Game;
  settings: Settings;

  private readonly params: URLSearchParams;
  private readonly stack: (() => Screen)[] = [];
  private current: Screen | null = null;
  private readonly fpsEl: HTMLDivElement;
  private rafHandle = 0;
  private lastFrameMs = 0;
  private frameAvg = 16.7;
  private frameWorst = 0;
  private frameWindowStart = 0;
  /** True when this page load is a race launched from the menus. */
  private readonly inRace: boolean;
  private resultsShown = false;
  private playerFinishedAt = 0;
  private readonly disposers: (() => void)[] = [];

  constructor(opts: ShellOptions) {
    this.game = opts.game;
    this.params = opts.params;
    this.settings = loadSettings();
    this.inRace = opts.params.get('race') === '1';

    this.root = el('div', 'sd-shell');
    opts.overlay.appendChild(this.root);
    this.fpsEl = el('div', 'sd-fps', this.root);
    this.fpsEl.style.display = 'none';
  }

  // -- lifecycle -------------------------------------------------------------

  start(): void {
    applyLiveSettings(this.game, this.settings);
    this.syncFpsVisibility();

    if (this.inRace) {
      // A race launched from the menus: the shell is only the pause menu and
      // the results screen. The HUD and the touch controls stay exactly as
      // `main.ts` left them.
      this.game.touch.onPause = () => this.togglePause();
      this.addWindowKey();
    } else {
      // Attract mode. The renderer is already running, so the menu backdrop is
      // a real race rather than a still image of one — and it costs nothing
      // that was not already being spent.
      this.game.setPlayerAi(true);
      this.game.setPhase('racing');
      this.game.setTouchEnabled(false);
      this.game.hud.root.style.display = 'none';
      this.game.touch.onPause = () => {};
      this.push(() => new TitleScreen(this));
    }

    const tick = (now: number) => {
      this.rafHandle = requestAnimationFrame(tick);
      this.onFrame(now);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.current?.destroy();
    this.current = null;
    this.stack.length = 0;
    this.root.remove();
  }

  private addWindowKey(): void {
    const onKey = (e: KeyboardEvent) => {
      // Only when no screen is open: an open screen owns Escape itself, and
      // handles it before the event ever reaches the window.
      if (this.current) return;
      if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault();
        this.openPause();
      }
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  // -- per-frame -------------------------------------------------------------

  private onFrame(now: number): void {
    if (this.settings.fpsCounter) this.updateFps(now);

    if (!this.inRace || this.resultsShown) return;

    const race = this.game.race;
    const playerState = race.states[this.game.playerKart.index]!;
    if (playerState.finished && this.playerFinishedAt === 0) this.playerFinishedAt = now;

    // Results when the field is in, or eight seconds after the player is in —
    // whichever comes first. Waiting on the last kart alone means one stuck AI
    // holds the player on a results screen that never arrives.
    const fieldIn = race.phase === 'finished';
    const playerWaitedLongEnough = this.playerFinishedAt > 0 && now - this.playerFinishedAt > 8000;
    if (fieldIn || playerWaitedLongEnough) {
      this.resultsShown = true;
      this.showResults();
    }
  }

  private updateFps(now: number): void {
    if (this.lastFrameMs > 0) {
      const dt = now - this.lastFrameMs;
      // Exponential average over roughly half a second, and a true worst frame
      // in a one-second window: an average alone hides exactly the hitches
      // anybody turns a frame counter on to find.
      this.frameAvg += (dt - this.frameAvg) * 0.08;
      this.frameWorst = Math.max(this.frameWorst, dt);
      if (now - this.frameWindowStart > 1000) {
        this.frameWindowStart = now;
        this.fpsEl.textContent =
          `${Math.round(1000 / Math.max(0.001, this.frameAvg))} fps · ` +
          `${this.frameAvg.toFixed(1)} ms · worst ${this.frameWorst.toFixed(1)} ms`;
        this.frameWorst = 0;
      }
    }
    this.lastFrameMs = now;
  }

  private syncFpsVisibility(): void {
    this.fpsEl.style.display = this.settings.fpsCounter ? '' : 'none';
    if (this.settings.fpsCounter && !this.fpsEl.textContent) this.fpsEl.textContent = 'measuring…';
  }

  // -- navigation ------------------------------------------------------------

  push(factory: () => Screen): void {
    this.current?.destroy();
    this.stack.push(factory);
    this.mount(factory());
  }

  /** Replace the whole stack, for the one-way transitions (results). */
  reset(factory: () => Screen): void {
    this.current?.destroy();
    this.stack.length = 0;
    this.stack.push(factory);
    this.mount(factory());
  }

  back(): void {
    if (this.stack.length <= 1) {
      // In a race, the bottom of the stack is the pause menu, and backing out
      // of it means carrying on.
      if (this.inRace) this.resume();
      return;
    }
    this.stack.pop();
    this.current?.destroy();
    this.mount(this.stack[this.stack.length - 1]!());
  }

  private mount(screen: Screen): void {
    this.current = screen;
    this.root.appendChild(screen.root);
    screen.mounted();
  }

  // -- pause -----------------------------------------------------------------

  togglePause(): void {
    if (this.current) this.resume();
    else this.openPause();
  }

  openPause(): void {
    if (!this.inRace || this.resultsShown) return;
    this.game.setPaused(true);
    this.reset(() => new PauseScreen(this));
  }

  resume(): void {
    this.current?.destroy();
    this.current = null;
    this.stack.length = 0;
    this.game.setPaused(false);
  }

  raceTitle(): string {
    const cup = this.currentCup();
    const round = this.currentRound();
    if (cup) return `${cup.name} — race ${round} of ${cup.trackIds.length}, ${this.game.spec.name}`;
    return `${this.game.spec.name} — ${this.game.race.mode === 'time-trial' ? 'time trial' : 'single race'}`;
  }

  // -- results ---------------------------------------------------------------

  private showResults(): void {
    this.game.setPaused(true);
    this.reset(() => new ResultsScreen(this, this.currentCup(), this.currentRound()));
  }

  private currentCup(): CupSpec | null {
    const id = this.params.get('cup');
    if (!id) return null;
    try {
      return cupById(id);
    } catch {
      return null;
    }
  }

  private currentRound(): number {
    const n = Number.parseInt(this.params.get('round') ?? '1', 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  /**
   * Add this race's points to the cup's running totals and return them.
   *
   * Guarded by the round number: a refresh on the results screen, or any other
   * path that builds this screen twice, must not award the same race twice.
   */
  recordCupPoints(
    cup: CupSpec,
    round: number,
    results: { driverId: string; points: number }[],
  ): Record<string, number> {
    let session: CupSession | null = loadCup();
    if (!session || session.cupId !== cup.id) {
      session = {
        cupId: cup.id,
        round,
        driverId: this.game.playerKart.driver.id,
        points: {},
        scored: [],
      };
    }
    if (!session.scored.includes(round)) {
      for (const r of results) {
        session.points[r.driverId] = (session.points[r.driverId] ?? 0) + r.points;
      }
      session.scored.push(round);
      session.round = round;
      saveCup(session);
    }
    return session.points;
  }

  // -- settings --------------------------------------------------------------

  /** Persist, then push the live half into the running game. The next-race
   *  half is deliberately not pushed anywhere — see `applyLiveSettings`. */
  commitSettings(): void {
    saveSettings(this.settings);
    applyLiveSettings(this.game, this.settings);
    this.syncFpsVisibility();
  }

  // -- transitions out -------------------------------------------------------

  /**
   * Start a race. Ends in a page load, on purpose (ARCHITECTURE.md §3.2).
   */
  launch(o: {
    track: string;
    mode: RaceMode;
    driver: string;
    cup: string | null;
    round: number | null;
  }): void {
    // Starting a cup from the top wipes any half-finished cup, or its standings
    // would be added to and the first race of the new cup would score nothing.
    if (o.cup && (o.round ?? 1) === 1) clearCup();

    const p = new URLSearchParams();
    p.set('race', '1');
    p.set('track', trackById(o.track).id);
    p.set('mode', o.mode);
    p.set('driver', driverById(o.driver).id);
    // A time trial is one kart against the clock; there are no rivals to size.
    p.set('karts', String(o.mode === 'time-trial' ? 1 : this.settings.gridSize));
    p.set('difficulty', String(this.settings.difficulty));
    const seed = this.params.get('seed');
    if (seed) p.set('seed', seed);
    if (o.cup) {
      p.set('cup', o.cup);
      p.set('round', String(o.round ?? 1));
    }
    location.assign(`?${p.toString()}`);
  }

  restartRace(): void {
    location.assign(`?${this.params.toString()}`);
  }

  quitToTitle(): void {
    const p = new URLSearchParams();
    const seed = this.params.get('seed');
    if (seed) p.set('seed', seed);
    const query = p.toString();
    location.assign(query ? `?${query}` : location.pathname);
  }

  /** Direct entry to a screen, for development and for the shot suite. Every
   *  destination is reached through the same `push` the buttons use — there is
   *  no second path into a screen that the player cannot take. */
  openNamedScreen(name: string): boolean {
    switch (name) {
      case 'title':
        this.reset(() => new TitleScreen(this));
        return true;
      case 'modes':
        this.reset(() => new TitleScreen(this));
        this.push(() => new ModeScreen(this));
        return true;
      case 'cups':
        this.reset(() => new TitleScreen(this));
        this.push(() => new ModeScreen(this));
        this.push(() => new CupScreen(this, 'grand-prix'));
        return true;
      case 'tracks':
        this.reset(() => new TitleScreen(this));
        this.push(() => new ModeScreen(this));
        this.push(() => new CupScreen(this, 'time-trial'));
        return true;
      case 'characters':
        this.reset(() => new TitleScreen(this));
        this.push(() => new ModeScreen(this));
        this.push(() => new CupScreen(this, 'grand-prix'));
        this.push(
          () => new CharacterScreen(this, 'grand-prix', cupTracks(CUPS[0]!)[0]!, CUPS[0]!),
        );
        return true;
      case 'options':
        this.reset(() => new TitleScreen(this));
        this.push(() => new OptionsScreen(this));
        return true;
      case 'licences':
        this.reset(() => new TitleScreen(this));
        this.push(() => new LicencesScreen(this));
        return true;
      case 'pause':
        this.openPause();
        return true;
      default:
        return false;
    }
  }

  /** Names of every track, for the type checker's benefit as much as anyone's:
   *  the shell never invents a track id, it only passes on one from content. */
  static get trackCount(): number {
    return TRACKS.length;
  }

  // -- style -----------------------------------------------------------------

  static css(): string {
    return `
.sd-shell {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  color: ${UI.ink};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.sd-shell > * { pointer-events: auto; }

.sd-screen {
  position: absolute; inset: 0; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 12px;
  padding:
    calc(env(safe-area-inset-top, 0px) + 20px)
    calc(env(safe-area-inset-right, 0px) + 22px)
    calc(env(safe-area-inset-bottom, 0px) + 18px)
    calc(env(safe-area-inset-left, 0px) + 22px);
}
/* Solid for the reading screens, a raking scrim for the ones that sit over a
   live race — dark where the text is, clear where the track is. */
.sd-screen[data-veil="solid"] { background: ${UI.backdrop}; }
.sd-screen[data-veil="scrim"] {
  background: linear-gradient(104deg, ${UI.backdrop} 0%, ${UI.backdrop} 34%, ${UI.shadow} 68%, transparent 100%);
}
.sd-screen.is-centred {
  align-items: center; justify-content: center;
  background: ${UI.shadow};
}

.sd-head { flex: 0 0 auto; }
/* min-height:0 is what makes the scroll region actually scroll instead of
   growing the flex column past the viewport. */
.sd-body { flex: 1 1 auto; min-height: 0; overflow-x: hidden; }
.sd-body[data-scroll] { overflow-y: auto; }
.sd-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }

.sd-h1 { margin: 0; font-size: 26px; letter-spacing: 0.16em; font-weight: 700; }
.sd-sub { margin: 6px 0 0; font-size: 13px; color: ${UI.inkDim}; max-width: 78ch; }
.sd-fine { margin: 6px 0 0; font-size: 11px; color: ${UI.inkDim}; max-width: 82ch; line-height: 1.5; }

/* 48px is the floor for every interactive target, everywhere in the shell. */
.sd-shell button {
  font: inherit; font-size: 13px; letter-spacing: 0.08em;
  min-height: 48px; min-width: 48px;
  padding: 10px 16px; border-radius: 12px;
  border: 2px solid ${UI.panelEdge}; background: ${UI.panel}; color: ${UI.ink};
  text-align: left; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.sd-shell button:hover { border-color: ${UI.inkDim}; }
.sd-shell button:focus { outline: none; border-color: ${UI.accent}; box-shadow: inset 0 0 0 2px ${UI.accent}; }
.sd-shell button.is-primary { border-color: ${UI.accent}; color: ${UI.accent}; }
.sd-shell button.is-danger:focus { border-color: ${UI.danger}; box-shadow: inset 0 0 0 2px ${UI.danger}; }
.sd-shell button[disabled] { cursor: not-allowed; color: ${UI.inkDim}; border-style: dashed; }
.sd-shell button[aria-pressed="true"] { border-color: ${UI.accent}; color: ${UI.accent}; }

.sd-chip {
  font-size: 10px; letter-spacing: 0.14em; padding: 3px 7px; border-radius: 999px;
  border: 1px solid ${UI.panelEdge}; color: ${UI.inkDim}; white-space: nowrap;
}
.sd-chip.is-live { color: ${UI.good}; border-color: ${UI.good}; }
.sd-chip.is-later { color: ${UI.accentAlt}; border-color: ${UI.accentAlt}; }
.sd-chip.is-warn { color: ${UI.danger}; border-color: ${UI.danger}; }

/* --- title --------------------------------------------------------------- */
.sd-title-mark { flex: 0 0 auto; }
.sd-wordmark { display: block; max-width: 100%; }
.sd-tagline {
  margin: 2px 0 0; font-size: 13px; color: ${UI.inkDim}; letter-spacing: 0.04em;
  max-width: 60ch;
}
.sd-title-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding-top: 14px; }
.sd-title-actions button { min-width: 260px; }

/* --- cards --------------------------------------------------------------- */
.sd-card { display: block; width: 100%; max-width: 720px; margin-bottom: 10px; }
.sd-card-line { display: flex; align-items: center; gap: 10px; }
.sd-card-title { font-size: 16px; letter-spacing: 0.14em; }
.sd-card-note { margin-top: 6px; font-size: 12px; color: ${UI.inkDim}; letter-spacing: 0; line-height: 1.5; }
.sd-card.is-unbuilt { opacity: 0.75; }

/* --- cups ---------------------------------------------------------------- */
.sd-cups { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.sd-cup {
  border: 2px solid ${UI.panelEdge}; border-radius: 14px; background: ${UI.panel};
  padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.sd-cup-name { font-size: 15px; letter-spacing: 0.14em; color: ${UI.accent}; }
.sd-cup-blurb { font-size: 12px; color: ${UI.inkDim}; margin-top: 4px; line-height: 1.4; }
.sd-tracklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sd-track { counter-increment: sd-track; }
.sd-track-btn { display: block; width: 100%; box-sizing: border-box; }
div.sd-track-btn { padding: 8px 10px; border-radius: 10px; border: 1px solid ${UI.panelEdge}; }
.sd-track-name { font-size: 13px; letter-spacing: 0.06em; }
.sd-track-idea { margin-top: 3px; font-size: 11px; color: ${UI.inkDim}; letter-spacing: 0; line-height: 1.45; }

/* --- characters ---------------------------------------------------------- */
.sd-chars { display: grid; grid-template-columns: minmax(280px, 1.1fr) minmax(280px, 1fr); gap: 14px; }
@media (max-width: 720px) { .sd-chars { grid-template-columns: 1fr; } }
.sd-char-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; align-content: start; }
.sd-char { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.sd-char-name { font-size: 12px; letter-spacing: 0.04em; }
.sd-char-swatch { width: 14px; height: 14px; border-radius: 4px; flex: 0 0 auto; border: 1px solid ${UI.panelEdge}; display: inline-block; }
.sd-char-swatch.is-big { width: 22px; height: 22px; border-radius: 6px; }
.sd-char-swatch.is-dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
.sd-char-detail {
  border: 2px solid ${UI.panelEdge}; border-radius: 14px; background: ${UI.panel}; padding: 14px;
  align-self: start;
}
.sd-detail-head { display: flex; align-items: center; gap: 10px; }
.sd-detail-name { font-size: 17px; letter-spacing: 0.1em; }
.sd-bars { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.sd-bar-row { display: grid; grid-template-columns: 118px 1fr 44px; align-items: center; gap: 8px; }
.sd-bar-label { font-size: 10px; letter-spacing: 0.12em; color: ${UI.inkDim}; }
.sd-bar-track { height: 12px; border-radius: 3px; background: ${UI.shadow}; border: 1px solid ${UI.panelEdge}; overflow: hidden; }
.sd-bar-fill { display: block; height: 100%; background: ${UI.accent}; }
.sd-bar-fill.is-weight { background: ${UI.accentAlt}; }
.sd-bar-value { font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; color: ${UI.inkDim}; }
.sd-weight-note { margin-top: 14px; border-top: 1px solid ${UI.panelEdge}; padding-top: 10px; }
.sd-weight-title { font-size: 11px; letter-spacing: 0.12em; color: ${UI.accentAlt}; }
.sd-weight-body { margin: 6px 0 0; font-size: 12px; color: ${UI.ink}; line-height: 1.5; }

/* --- options ------------------------------------------------------------- */
.sd-opt { border-bottom: 1px solid ${UI.panelEdge}; padding: 12px 0; max-width: 860px; }
.sd-opt-head { display: flex; align-items: center; gap: 10px; }
.sd-opt-label { font-size: 13px; letter-spacing: 0.12em; }
.sd-opt-note { margin: 6px 0 0; font-size: 11px; color: ${UI.inkDim}; line-height: 1.5; max-width: 76ch; }
.sd-seg { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.sd-seg-btn { text-align: center; }

/* --- licences ------------------------------------------------------------ */
.sd-lic { margin-bottom: 18px; max-width: 92ch; }
.sd-lic-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sd-lic-name { font-size: 14px; letter-spacing: 0.1em; color: ${UI.accent}; }
.sd-lic-role { margin: 6px 0 8px; font-size: 12px; color: ${UI.inkDim}; line-height: 1.5; }
.sd-lic-text {
  margin: 0; padding: 10px 12px; font-size: 11px; line-height: 1.55;
  border: 1px solid ${UI.panelEdge}; border-radius: 10px; background: ${UI.panel};
  white-space: pre-wrap; word-break: break-word; color: ${UI.ink};
}
.sd-lic-tools { margin: 6px 0 0; padding-left: 18px; font-size: 11px; color: ${UI.inkDim}; line-height: 1.7; }

/* --- pause --------------------------------------------------------------- */
.sd-pause-panel {
  border: 2px solid ${UI.panelEdge}; border-radius: 16px; background: ${UI.backdrop};
  padding: 18px; display: flex; flex-direction: column; gap: 10px;
  min-width: min(340px, 86vw); max-width: 92vw; box-sizing: border-box;
}
.sd-pause-panel button { text-align: center; }

/* --- results ------------------------------------------------------------- */
.sd-results-cols { display: grid; grid-template-columns: minmax(340px, 2fr) minmax(220px, 1fr); gap: 16px; }
@media (max-width: 860px) { .sd-results-cols { grid-template-columns: 1fr; } }
.sd-table, .sd-standings { display: flex; flex-direction: column; gap: 3px; }
.sd-standings {
  border: 2px solid ${UI.panelEdge}; border-radius: 14px; background: ${UI.panel};
  padding: 12px; align-self: start;
}
.sd-standings-head { font-size: 11px; letter-spacing: 0.14em; color: ${UI.inkDim}; margin-bottom: 6px; }
.sd-tr {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 8px; background: ${UI.panel};
  font-size: 13px;
}
.sd-tr.is-header { background: transparent; color: ${UI.inkDim}; font-size: 10px; letter-spacing: 0.14em; }
.sd-tr.is-player { border: 1px solid ${UI.accent}; color: ${UI.accent}; }
.sd-td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-td.is-pos { flex: 0 0 34px; font-variant-numeric: tabular-nums; }
.sd-td.is-name { flex: 1 1 auto; display: flex; align-items: center; min-width: 0; }
.sd-td.is-num { flex: 0 0 92px; text-align: right; font-variant-numeric: tabular-nums; }
.sd-td.is-points { color: ${UI.accent}; flex-basis: 56px; }
.sd-champion { margin: 0; font-size: 14px; color: ${UI.accent}; letter-spacing: 0.06em; flex-basis: 100%; }

/* --- short viewports ------------------------------------------------------
   A phone in landscape is the shape this game is played in, and it is short:
   844x390 for a mid-size handset, less once the browser chrome is counted.
   Every screen here was laid out as a tall column, which at 390 px of height
   put the START button 18 px below the fold — measured, on the title screen,
   with the game therefore unstartable.

   The rules below are about height, not width, because that is what actually
   runs out: type comes down, vertical padding comes in, the stacked button
   columns become rows, and — as a floor under all of it — the body scrolls, so
   that nothing can ever be unreachable even on a shape not anticipated here.
   Touch targets keep their 48 px minimum. That floor does not move. */
@media (max-height: 520px) {
  .sd-screen {
    gap: 8px;
    padding:
      calc(env(safe-area-inset-top, 0px) + 12px)
      calc(env(safe-area-inset-right, 0px) + 18px)
      calc(env(safe-area-inset-bottom, 0px) + 10px)
      calc(env(safe-area-inset-left, 0px) + 18px);
  }
  .sd-body { overflow-y: auto; }
  .sd-h1 { font-size: 19px; }
  .sd-sub { font-size: 12px; margin-top: 4px; }
  .sd-fine { font-size: 10px; line-height: 1.45; }
  .sd-tagline { font-size: 11px; }
  .sd-title-actions {
    flex-direction: row; flex-wrap: wrap; align-items: center; padding-top: 6px;
  }
  .sd-title-actions button { min-width: 0; flex: 1 1 200px; text-align: center; }
  .sd-card { margin-bottom: 8px; }
  .sd-cups { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
  .sd-opt { padding: 8px 0; }
  /* The prose is clamped, not deleted. A track's one-line idea is the reason
     to pick it; on a short screen it gets one line instead of two. */
  .sd-card-note, .sd-cup-blurb, .sd-track-idea, .sd-opt-note {
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1;
    line-clamp: 1; overflow: hidden;
  }
  .sd-weight-note { margin-top: 8px; }
  .sd-pause-panel { gap: 8px; }
}

/* --- fps ----------------------------------------------------------------- */
.sd-fps {
  /* Below the pause button, which owns the top-centre band on the touch
     layout. Two overlaid readouts in the same 48 px is how you get a frame
     counter nobody can read and a pause button nobody can press. */
  position: absolute; top: calc(env(safe-area-inset-top, 0px) + 64px); left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px; border-radius: 8px;
  background: ${UI.shadow}; color: ${UI.ink};
  font-size: 11px; font-variant-numeric: tabular-nums; pointer-events: none;
}
`;
  }
}
