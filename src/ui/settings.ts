import type { Game } from '../game.ts';

/**
 * Player options and cup standings — the two pieces of state the shell owns.
 *
 * Both live here rather than in `Game` because ARCHITECTURE.md §2 gives `ui/*`
 * the DOM and forbids it owning game state; the reverse also holds, and a menu
 * preference is not game state. `Game` is constructed fresh for every race and
 * knows nothing about the menu that launched it.
 *
 * **Why storage at all:** selecting a track reloads the page
 * (ARCHITECTURE.md §3.2 — there is no live re-theming, because hot-swapping
 * means disposing every material and one missed dispose is a leak that only
 * shows up after six races). A reload wipes memory, so anything that has to
 * survive between two races of a cup has to be written down. Options go to
 * `localStorage` (they outlive the session); cup standings go to
 * `sessionStorage` (a cup is one sitting, and a stale cup resuming days later
 * would be worse than losing it).
 *
 * Every read is defensive: `localStorage` throws outright in some privacy
 * modes and under `file://` on some browsers, and the game must still boot.
 */

const OPTIONS_KEY = 'sparkdrift.options.v1';
const CUP_KEY = 'sparkdrift.cup.v1';

/**
 * Whether a setting takes effect immediately or only when the next race is
 * built. This is a field on the setting rather than a comment because the
 * options screen prints it: a settings panel that silently does nothing until
 * some unstated later moment is the single most common lie in a game menu.
 */
export type Applies = 'live' | 'next-race';

export interface Settings {
  /** Scales camera roll, shake and FOV kick to 0.15× (bug class 12). Live. */
  reduceMotion: boolean;
  /** Adaptive resolution controller on/off. Live. */
  adaptive: boolean;
  /** Forced render scale when `adaptive` is off. Live. */
  resolutionScale: number;
  /** Frame-rate readout, measured on the real rAF clock. Live. */
  fpsCounter: boolean;
  /** Which side the steering zone sits on. Live. */
  handedness: 'right' | 'left';
  /** Touch control size multiplier. Live. */
  touchScale: number;
  /** AI difficulty. Constructor argument for every AI driver — next race. */
  difficulty: number;
  /** Karts on the grid, player included. Constructor argument — next race. */
  gridSize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  reduceMotion: false,
  adaptive: true,
  // 1.0 is also the adaptive ceiling, so turning adaptive off without touching
  // anything else changes nothing — which is what "off" should mean.
  resolutionScale: 1,
  fpsCounter: false,
  handedness: 'right',
  touchScale: 1,
  difficulty: 0.6,
  gridSize: 8,
};

export function loadSettings(): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OPTIONS_KEY);
  } catch {
    return out;
  }
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Field by field, with the stored value only accepted when it is the right
    // shape. A hand-edited or half-migrated blob must not be able to boot the
    // game into a state no menu can express.
    if (typeof parsed.reduceMotion === 'boolean') out.reduceMotion = parsed.reduceMotion;
    if (typeof parsed.adaptive === 'boolean') out.adaptive = parsed.adaptive;
    if (typeof parsed.fpsCounter === 'boolean') out.fpsCounter = parsed.fpsCounter;
    if (parsed.handedness === 'left' || parsed.handedness === 'right') {
      out.handedness = parsed.handedness;
    }
    if (typeof parsed.resolutionScale === 'number' && Number.isFinite(parsed.resolutionScale)) {
      out.resolutionScale = clampTo(RESOLUTION_CHOICES, parsed.resolutionScale);
    }
    if (typeof parsed.touchScale === 'number' && Number.isFinite(parsed.touchScale)) {
      out.touchScale = clampTo(TOUCH_SCALE_CHOICES, parsed.touchScale);
    }
    if (typeof parsed.difficulty === 'number' && Number.isFinite(parsed.difficulty)) {
      out.difficulty = clampTo(DIFFICULTY_CHOICES, parsed.difficulty);
    }
    if (typeof parsed.gridSize === 'number' && Number.isFinite(parsed.gridSize)) {
      out.gridSize = clampTo(GRID_CHOICES, parsed.gridSize);
    }
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  return out;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    // Storage refused. The setting still applies for this session; losing it
    // on reload is a far better outcome than a boot failure.
  }
}

export const RESOLUTION_CHOICES = [0.85, 0.9, 1] as const;
export const TOUCH_SCALE_CHOICES = [0.85, 1, 1.25] as const;
export const DIFFICULTY_CHOICES = [0.35, 0.6, 0.85] as const;
export const GRID_CHOICES = [4, 6, 8] as const;

/** Snap a stored number to the nearest offered choice, so a value from an older
 *  build can never leave a segmented control with nothing selected. */
function clampTo(choices: readonly number[], value: number): number {
  let best = choices[0]!;
  let bestGap = Math.abs(value - best);
  for (const c of choices) {
    const gap = Math.abs(value - c);
    if (gap < bestGap) {
      best = c;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Push every **live** setting into the running game.
 *
 * The next-race settings (`difficulty`, `gridSize`) are deliberately absent:
 * they are constructor arguments, and pretending to apply them here would be
 * the lie the honest labels exist to prevent. They are passed as URL parameters
 * when the shell launches the next race.
 */
export function applyLiveSettings(game: Game, s: Settings): void {
  game.setReducedMotion(s.reduceMotion);
  game.setResolutionScale(s.adaptive ? null : s.resolutionScale);
  game.touch.setOptions({ handedness: s.handedness, scale: s.touchScale });
}

// ---------------------------------------------------------------------------
//  Cup standings
// ---------------------------------------------------------------------------

/**
 * A cup in progress. Written by the results screen, read by the next race's
 * results screen after the reload.
 */
export interface CupSession {
  cupId: string;
  /** 1-based round about to be raced or just raced. */
  round: number;
  /** The driver the player chose at the start of the cup. */
  driverId: string;
  /** driverId → running points total. */
  points: Record<string, number>;
  /** Rounds already scored, so re-entering the results screen (or a page
   *  refresh on it) cannot award the same race's points twice. */
  scored: number[];
}

export function loadCup(): CupSession | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(CUP_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CupSession>;
    if (typeof parsed.cupId !== 'string' || typeof parsed.round !== 'number') return null;
    return {
      cupId: parsed.cupId,
      round: parsed.round,
      driverId: typeof parsed.driverId === 'string' ? parsed.driverId : '',
      points: isPointsMap(parsed.points) ? parsed.points : {},
      scored: Array.isArray(parsed.scored) ? parsed.scored.filter((n) => typeof n === 'number') : [],
    };
  } catch {
    return null;
  }
}

function isPointsMap(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== 'object') return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}

export function saveCup(session: CupSession): void {
  try {
    sessionStorage.setItem(CUP_KEY, JSON.stringify(session));
  } catch {
    // Same reasoning as the options: a cup that forgets its standings is worse
    // than nothing, but not as bad as a game that will not start.
  }
}

export function clearCup(): void {
  try {
    sessionStorage.removeItem(CUP_KEY);
  } catch {
    /* nothing to clear if storage is refusing us */
  }
}
