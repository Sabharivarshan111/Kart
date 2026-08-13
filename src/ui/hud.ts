import { CONFIG } from '../core/config.ts';
import { DRIFT_TIER_COLOURS, UI } from '../core/palette.ts';
import { ITEM_NAMES, type ItemKind } from '../race/items.ts';
import type { Race } from '../race/rules.ts';
import type { TrackSurface } from '../track/surface.ts';
import type { Kart } from '../vehicle/kart.ts';

/**
 * The HUD, as DOM over the canvas.
 *
 * **Laid out for thumbs when touch is active.** The bottom corners belong to
 * thumbs and the bottom centre is where the chase camera puts the player's own
 * kart, so on touch every instrument moves to the top band. The mobile test
 * asserts geometrically that no control overlaps an instrument.
 *
 * ============ BUG CLASS 9: TEXT OVERFLOWING ITS FIELD ============
 * A leaderboard row whose driver also carries a badge — the item they are
 * holding, or a lap-record marker — has less room for the name than the rows
 * without one. Sizing the name field as though every row were the widest case
 * wastes half the panel; sizing it as though none had a badge overflows. The
 * name element is therefore measured against its *own* remaining width and
 * clipped with an ellipsis, and `rects()` exposes both so a test can assert the
 * text box never exceeds the row.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly positionEl: HTMLDivElement;
  private readonly positionNumber: Text;
  private readonly positionOrdinal: HTMLSpanElement;
  private readonly lapEl: HTMLDivElement;
  private readonly timeEl: HTMLDivElement;
  private readonly speedEl: HTMLDivElement;
  private readonly itemEl: HTMLDivElement;
  private readonly itemLabel: HTMLDivElement;
  private readonly driftMeter: HTMLDivElement;
  private readonly driftFill: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly warningEl: HTMLDivElement;
  private readonly boardEl: HTMLDivElement;
  private readonly boardRows: {
    row: HTMLDivElement;
    pos: HTMLSpanElement;
    name: HTMLSpanElement;
    badge: HTMLSpanElement;
  }[] = [];
  private readonly minimap: HTMLCanvasElement;
  private readonly minimapCtx: CanvasRenderingContext2D | null;

  private touchLayout = false;
  private trackPath: { x: number; z: number }[] = [];
  private trackBounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };

  constructor(kartCount: number) {
    this.root = el('div', 'sd-hud');

    const topLeft = el('div', 'sd-hud-topleft', this.root);
    this.positionEl = el('div', 'sd-position', topLeft);
    // A dedicated text node for the number, so the ordinal suffix can be a
    // separate span at its own size without either overwriting the other.
    this.positionNumber = document.createTextNode('1');
    this.positionEl.appendChild(this.positionNumber);
    this.positionOrdinal = el('span', 'sd-position-ordinal', this.positionEl);
    this.lapEl = el('div', 'sd-lap', topLeft);

    const topRight = el('div', 'sd-hud-topright', this.root);
    this.timeEl = el('div', 'sd-time', topRight);
    this.minimap = el('canvas', 'sd-minimap', topRight);
    this.minimap.width = 168;
    this.minimap.height = 168;
    this.minimapCtx = this.minimap.getContext('2d');

    const bottomRight = el('div', 'sd-hud-bottomright', this.root);
    this.speedEl = el('div', 'sd-speed', bottomRight);

    const itemWrap = el('div', 'sd-hud-item', this.root);
    this.itemEl = el('div', 'sd-item', itemWrap);
    this.itemLabel = el('div', 'sd-item-label', itemWrap);

    this.driftMeter = el('div', 'sd-drift', this.root);
    this.driftFill = el('div', 'sd-drift-fill', this.driftMeter);

    this.countdownEl = el('div', 'sd-countdown', this.root);
    this.warningEl = el('div', 'sd-warning', this.root);
    this.warningEl.textContent = 'INCOMING';

    this.boardEl = el('div', 'sd-board', this.root);
    for (let i = 0; i < kartCount; i++) {
      const row = el('div', 'sd-board-row', this.boardEl);
      const pos = el('span', 'sd-board-pos', row);
      const name = el('span', 'sd-board-name', row);
      const badge = el('span', 'sd-board-badge', row);
      this.boardRows.push({ row, pos, name, badge });
    }
  }

  /** Precompute the minimap path once per track. */
  setTrack(surface: TrackSurface): void {
    this.trackPath = [];
    const stations = surface.cl.stations;
    const step = Math.max(1, Math.floor(stations.length / 160));
    for (let i = 0; i < stations.length; i += step) {
      const s = stations[i]!;
      this.trackPath.push({ x: s.x, z: s.z });
    }
    this.trackBounds = { ...surface.cl.bounds };
  }

  setTouchLayout(on: boolean): void {
    if (this.touchLayout === on) return;
    this.touchLayout = on;
    this.root.dataset.layout = on ? 'touch' : 'desktop';
  }

  update(race: Race, player: Kart, karts: Kart[], heldItem: ItemKind | null, warning: boolean): void {
    const st = race.states[player.index]!;

    const pos = st.position;
    this.positionNumber.textContent = String(pos);
    this.positionOrdinal.textContent = ordinal(pos);
    this.lapEl.textContent = `LAP ${Math.min(Math.max(1, st.lap), race.totalLaps)}/${race.totalLaps}`;
    this.timeEl.textContent = formatTime(Math.max(0, race.time));
    this.speedEl.textContent = `${Math.round(player.speed * 3.6)}`;

    if (heldItem) {
      this.itemEl.dataset.kind = heldItem;
      this.itemEl.textContent = heldItem.charAt(0).toUpperCase();
      this.itemLabel.textContent = ITEM_NAMES[heldItem];
      this.itemEl.classList.add('has-item');
    } else {
      this.itemEl.textContent = '';
      this.itemLabel.textContent = '';
      this.itemEl.classList.remove('has-item');
    }

    // Drift meter: shows charge as a fraction of the *next* tier, and the fill
    // colour is the tier colour, so the escalation is legible without reading.
    if (player.drifting) {
      this.driftMeter.style.opacity = '1';
      const tier = player.driftTier;
      const times = CONFIG.kart.drift.tierTimes;
      const prev = tier > 0 ? times[tier - 1]! : 0;
      const next = tier < times.length ? times[tier]! : times[times.length - 1]!;
      const frac = tier >= times.length ? 1 : (player.driftCharge - prev) / Math.max(0.001, next - prev);
      this.driftFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      const colour = DRIFT_TIER_COLOURS[Math.min(tier, DRIFT_TIER_COLOURS.length - 1)]!;
      this.driftFill.style.background = tier === 0 ? UI.inkDim : `#${colour.toString(16).padStart(6, '0')}`;
    } else {
      this.driftMeter.style.opacity = '0';
    }

    const remaining = race.countdownRemaining();
    if (race.phase === 'countdown') {
      const n = Math.ceil(remaining);
      this.countdownEl.textContent = n > 0 ? String(n) : 'GO';
      this.countdownEl.style.opacity = '1';
    } else if (race.time < 0.9 && race.phase === 'racing') {
      this.countdownEl.textContent = 'GO';
      this.countdownEl.style.opacity = String(Math.max(0, 1 - race.time / 0.9));
    } else {
      this.countdownEl.style.opacity = '0';
    }

    this.warningEl.style.opacity = warning ? '1' : '0';

    // The full running order is for the moments when the player can read it:
    // the grid, and the flag. **During the race it goes away.** Eight rows of
    // names in the corner of a phone held in landscape is a third of the useful
    // screen spent on information the big position number top-left already
    // gives, and it sat there for the whole race.
    //
    // On the grid it is worth the space on a desktop window. On a phone held in
    // landscape it is **not**: at 390 CSS px of height the board's own box lands
    // squarely on the countdown numeral, and hiding "3 — 2 — 1 — GO" behind a
    // list of names the player has not raced yet is the wrong trade. There, the
    // board waits for the flag.
    const atFlag = race.phase === 'finished';
    const onGrid = race.phase === 'countdown' || (race.phase === 'racing' && race.time < 1.5);
    const showBoard = atFlag || (onGrid && !this.touchLayout);
    this.root.dataset.board = showBoard ? 'full' : 'hidden';

    this.updateBoard(race, karts);
    this.drawMinimap(race, karts, player);
  }

  private updateBoard(race: Race, karts: Kart[]): void {
    const order = karts
      .map((k, i) => ({ i, pos: race.states[i]!.position, kart: k }))
      .sort((a, b) => a.pos - b.pos);

    for (let r = 0; r < this.boardRows.length; r++) {
      const row = this.boardRows[r];
      const entry = order[r];
      if (!row) continue;
      if (!entry) {
        row.row.style.display = 'none';
        continue;
      }
      row.row.style.display = '';
      row.pos.textContent = String(entry.pos);
      row.name.textContent = entry.kart.driver.name;
      row.row.classList.toggle('is-player', entry.kart.isPlayer);

      // Bug class 9: the badge is what eats the name's width. Set it first,
      // then give the name whatever is genuinely left, measured — not assumed.
      const st = race.states[entry.i]!;
      let badge = '';
      if (st.finished) badge = 'FIN';
      else if (entry.kart.spinOutTimer > 0) badge = 'HIT';
      else if (entry.kart.boostTime > 0) badge = 'BST';
      row.badge.textContent = badge;
      row.badge.style.display = badge ? '' : 'none';

      const rowWidth = row.row.clientWidth;
      if (rowWidth > 0) {
        const posWidth = row.pos.offsetWidth;
        const badgeWidth = badge ? row.badge.offsetWidth : 0;
        // 14 px of gaps and padding, measured from the stylesheet below.
        const available = Math.max(24, rowWidth - posWidth - badgeWidth - 14);
        row.name.style.maxWidth = `${available}px`;
      }
    }
  }

  private drawMinimap(race: Race, karts: Kart[], player: Kart): void {
    const ctx = this.minimapCtx;
    if (!ctx || this.trackPath.length < 2) return;
    const w = this.minimap.width;
    const h = this.minimap.height;
    ctx.clearRect(0, 0, w, h);

    const b = this.trackBounds;
    const pad = 12;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
    const ox = (w - spanX * scale) / 2 - b.minX * scale;
    const oz = (h - spanZ * scale) / 2 - b.minZ * scale;
    const px = (x: number) => x * scale + ox;
    const pz = (z: number) => z * scale + oz;

    ctx.lineWidth = 5;
    ctx.strokeStyle = UI.panelEdge;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(px(this.trackPath[0]!.x), pz(this.trackPath[0]!.z));
    for (const p of this.trackPath) ctx.lineTo(px(p.x), pz(p.z));
    ctx.closePath();
    ctx.stroke();

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i]!;
      const isPlayer = k.isPlayer;
      ctx.fillStyle = isPlayer ? UI.accent : UI.inkDim;
      ctx.beginPath();
      ctx.arc(px(k.x), pz(k.z), isPlayer ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    void race;
    void player;
  }

  /** Rectangles of every HUD element, in CSS pixels, for the overlap test. */
  rects(): Record<string, { x: number; y: number; w: number; h: number }> {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const add = (name: string, node: Element | null) => {
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        out[name] = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    };
    add('hud.position', this.positionEl);
    add('hud.lap', this.lapEl);
    add('hud.time', this.timeEl);
    add('hud.speed', this.speedEl);
    add('hud.item', this.itemEl);
    add('hud.minimap', this.minimap);
    // Only when it is actually on screen; see the board visibility note above.
    // `visibility: hidden` still reports a box, so the rows have to be gated on
    // the same flag or a hidden board would keep failing the overlap test for
    // space it is not using.
    if (this.root.dataset.board !== 'hidden') {
      add('hud.board', this.boardEl);
      const first = this.boardRows[0];
      if (first && first.row.style.display !== 'none') {
        add('hud.board.row0', first.row);
        add('hud.board.row0.name', first.name);
        add('hud.board.row0.badge', first.badge);
      }
    }
    return out;
  }

  static css(): string {
    return `
.sd-hud {
  position: fixed; inset: 0; pointer-events: none; z-index: 30;
  color: ${UI.ink};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* A hard ink contour, not a soft drop shadow.
     Symptom this fixes: over the salt flat's near-white sky and ground, "LAP
     1/3" in the dim ink colour with a soft shadow behind it was effectively
     invisible — the HUD has to be legible over the brightest AND the darkest
     part of every track, and a blur only helps against one of them. Four
     offsets plus a blur gives a contour that survives both. */
  text-shadow:
    -1px 0 0 ${UI.contour}, 1px 0 0 ${UI.contour},
    0 -1px 0 ${UI.contour}, 0 1px 0 ${UI.contour},
    0 2px 7px ${UI.shadow};
}
.sd-hud-topleft {
  position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: calc(env(safe-area-inset-left, 0px) + 14px);
}
.sd-hud-topright {
  position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px);
  right: calc(env(safe-area-inset-right, 0px) + 14px);
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
}
.sd-position { font-size: 56px; font-weight: 700; line-height: 1; }
.sd-position-ordinal { font-size: 20px; margin-left: 2px; }
/* Full ink, not the dim tone: this is the one instrument the player checks
   without taking their eyes off the corner. */
.sd-lap { font-size: 16px; letter-spacing: 0.1em; color: ${UI.ink}; margin-top: 4px; }
.sd-time { font-size: 22px; font-variant-numeric: tabular-nums; }
.sd-minimap { width: 132px; height: 132px; opacity: 0.92; }
.sd-hud-bottomright {
  position: absolute; bottom: calc(env(safe-area-inset-bottom, 0px) + 14px);
  right: calc(env(safe-area-inset-right, 0px) + 16px);
}
.sd-speed { font-size: 44px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sd-speed::after { content: ' km/h'; font-size: 13px; color: ${UI.inkDim}; font-weight: 400; }
.sd-hud-item {
  position: absolute; top: calc(env(safe-area-inset-top, 0px) + 96px);
  left: calc(env(safe-area-inset-left, 0px) + 14px);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.sd-item {
  width: 62px; height: 62px; border-radius: 14px;
  border: 3px solid ${UI.panelEdge}; background: ${UI.shadow};
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; font-weight: 700;
}
.sd-item.has-item { border-color: ${UI.accent}; color: ${UI.accent}; }
.sd-item-label { font-size: 11px; letter-spacing: 0.08em; color: ${UI.inkDim}; }
.sd-drift {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
  width: 180px; height: 8px; border-radius: 4px;
  background: ${UI.shadow}; overflow: hidden;
  opacity: 0; transition: opacity 120ms linear;
}
.sd-drift-fill { height: 100%; width: 0%; background: ${UI.inkDim}; transition: width 60ms linear; }
.sd-countdown {
  position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%);
  font-size: 96px; font-weight: 700; opacity: 0;
  transition: opacity 150ms linear;
}
.sd-warning {
  position: absolute; left: 50%; top: 22%; transform: translateX(-50%);
  font-size: 20px; letter-spacing: 0.22em; color: ${UI.danger};
  opacity: 0; transition: opacity 90ms linear;
}
.sd-board {
  position: absolute; left: calc(env(safe-area-inset-left, 0px) + 14px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 14px);
  width: 210px; display: flex; flex-direction: column; gap: 2px;
  font-size: 12px;
  transition: opacity 220ms ease, transform 220ms ease;
}
/* Hidden while racing. visibility as well as opacity, so it stops taking
   pointer events, stops being announced to a screen reader, and reports no
   rectangle — a test asserting that no control overlaps an instrument must not
   trip over an instrument that is not on screen. */
.sd-hud[data-board="hidden"] .sd-board {
  opacity: 0; visibility: hidden; transform: translateY(6px);
}
.sd-hud[data-layout="touch"][data-board="hidden"] .sd-board {
  transform: translateX(-50%) translateY(6px);
}
.sd-board-row {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 6px; border-radius: 5px;
  background: ${UI.shadow}; color: ${UI.inkDim};
  overflow: hidden;
}
.sd-board-row.is-player { color: ${UI.ink}; background: ${UI.panel}; }
.sd-board-pos { min-width: 14px; text-align: right; font-variant-numeric: tabular-nums; }
.sd-board-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-board-badge {
  margin-left: auto; font-size: 10px; letter-spacing: 0.08em;
  color: ${UI.accentAlt}; flex: 0 0 auto;
}

/* Touch layout: the bottom corners belong to thumbs and the bottom centre is
   where the chase camera puts the player's own kart, so everything moves up. */
.sd-hud[data-layout="touch"] .sd-hud-bottomright {
  bottom: auto; top: calc(env(safe-area-inset-top, 0px) + 12px);
  right: calc(env(safe-area-inset-right, 0px) + 168px);
}
.sd-hud[data-layout="touch"] .sd-speed { font-size: 30px; }
.sd-hud[data-layout="touch"] .sd-position { font-size: 40px; }
.sd-hud[data-layout="touch"] .sd-board {
  bottom: auto; top: calc(env(safe-area-inset-top, 0px) + 112px);
  left: 50%; transform: translateX(-50%);
  width: 190px;
}
.sd-hud[data-layout="touch"] .sd-hud-item {
  top: calc(env(safe-area-inset-top, 0px) + 78px);
}
.sd-hud[data-layout="touch"] .sd-minimap { width: 104px; height: 104px; }
.sd-hud[data-layout="touch"] .sd-drift {
  bottom: auto; top: calc(env(safe-area-inset-top, 0px) + 62px);
}
`;
  }
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
