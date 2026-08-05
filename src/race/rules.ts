import { CONFIG } from '../core/config.ts';
import type { Controls, Phase, TrackSpec } from '../core/contracts.ts';
import { wrapLength } from '../core/mathx.ts';
import type { TrackSurface } from '../track/surface.ts';
import type { Kart } from '../vehicle/kart.ts';

/**
 * Race rules: checkpoints, laps, positions, the countdown, and results.
 *
 * ============ BUG CLASS 4: LAP COUNTING EXPLOITS ============
 * Reversing back and forth over the finish line must not count laps. The rule
 * here is that **every checkpoint must be taken in order**: a kart's
 * `nextCheckpoint` only advances when it is standing in exactly that sector, so
 * crossing the line backwards moves it into sector N-1 while it is waiting for
 * sector 1, and nothing happens. To score a lap you have to go all the way
 * round, which is the definition of a lap.
 *
 * Progress is `lap × lapLength + u`, which is monotonic across the start line
 * by construction — the two terms swap magnitudes exactly as u wraps — so
 * positions do not flicker as the field crosses the line.
 */

export interface KartRaceState {
  lap: number;
  nextCheckpoint: number;
  progress: number;
  position: number;
  finished: boolean;
  finishTime: number;
  /** Lap times in seconds, one per completed lap. */
  lapTimes: number[];
  lastLapStart: number;
  bestLap: number;
  /** True once the kart has crossed the line for the first time. */
  started: boolean;
}

export interface RaceResult {
  index: number;
  driverId: string;
  position: number;
  totalTime: number;
  bestLap: number;
  points: number;
}

export type RaceMode = 'grand-prix' | 'time-trial' | 'arena';

export class Race {
  readonly spec: TrackSpec;
  readonly surface: TrackSurface;
  readonly karts: Kart[];
  readonly states: KartRaceState[] = [];
  readonly mode: RaceMode;

  phase: Phase = 'countdown';
  /** Seconds. Negative during the countdown, so GO is exactly zero. */
  time: number;
  finishOrder: number[] = [];

  private readonly checkpointCount: number;
  private readonly sectorLength: number;
  readonly lapLength: number;
  readonly totalLaps: number;

  /** Set for one frame when a kart crosses the line, for the HUD and audio. */
  lapEvents: { index: number; lap: number; lapTime: number }[] = [];

  constructor(spec: TrackSpec, surface: TrackSurface, karts: Kart[], mode: RaceMode = 'grand-prix') {
    this.spec = spec;
    this.surface = surface;
    this.karts = karts;
    this.mode = mode;
    this.checkpointCount = Math.max(3, spec.checkpoints);
    this.lapLength = surface.length;
    this.sectorLength = this.lapLength / this.checkpointCount;
    this.totalLaps = mode === 'time-trial' ? Math.max(3, spec.laps) : spec.laps;
    this.time = -CONFIG.race.countdownSeconds;

    for (let i = 0; i < karts.length; i++) {
      this.states.push({
        lap: 0,
        nextCheckpoint: 0,
        progress: 0,
        position: i + 1,
        finished: false,
        finishTime: 0,
        lapTimes: [],
        lastLapStart: 0,
        bestLap: Infinity,
        started: false,
      });
    }
    this.layOutGrid();
  }

  /**
   * The starting grid: two columns behind the line, staggered, in reverse
   * position order. Placed through `surfaceAt` like everything else, so a grid
   * on a banked or climbing start straight sits on the road rather than in it.
   */
  layOutGrid(): void {
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.karts.length; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      // Behind the line, wrapping backwards around the lap.
      const u = wrapLength(
        this.lapLength - CONFIG.track.gridRowSpacing * (row + 1) - 4,
        this.lapLength,
      );
      const station = this.surface.stationAt(u);
      const lateral = col * CONFIG.track.gridLaneOffset;
      this.surface.pointAt(u, lateral, p);
      const heading = Math.atan2(station.tx, station.tz);
      this.karts[i]!.placeAt(p.x, p.y + 0.35, p.z, heading, 0);
      this.karts[i]!.hintU = u;
      const st = this.states[i]!;
      st.progress = u - this.lapLength; // negative before the line, so positions are right on lap 1
    }
    this.updatePositions();
  }

  /** Controls are gated during the countdown. Returns the controls the vehicle
   *  should actually receive. */
  gateControls(index: number, controls: Controls): Controls {
    if (this.phase === 'countdown') {
      // Throttle is *recorded* but not applied — that is what makes a perfect
      // start possible without letting the field creep.
      GATED.throttle = 0;
      GATED.brake = 0;
      GATED.steer = 0;
      GATED.drift = false;
      GATED.useItem = false;
      GATED.lookBack = controls.lookBack;
      return GATED;
    }
    if (this.states[index]!.finished) {
      // A finished kart drives itself to a stop rather than parking dead on the
      // racing line in front of everyone still racing.
      GATED.throttle = 0.25;
      GATED.brake = 0;
      GATED.steer = controls.steer;
      GATED.drift = false;
      GATED.useItem = false;
      GATED.lookBack = false;
      return GATED;
    }
    return controls;
  }

  /**
   * The perfect start: throttle applied inside a narrow window before GO earns
   * a boost. Applied too early and you get nothing — deliberately no penalty,
   * because a jump-start penalty on a touchscreen is a coin toss.
   */
  checkStartBoost(index: number, controls: Controls): void {
    if (this.phase !== 'countdown') return;
    const untilGo = -this.time;
    if (untilGo <= CONFIG.race.perfectStartWindow && controls.throttle > 0.6) {
      START_BOOST_ARMED[index] = true;
    } else if (untilGo > CONFIG.race.perfectStartWindow && controls.throttle > 0.6) {
      START_BOOST_ARMED[index] = false;
    }
  }

  step(dt: number): void {
    this.lapEvents.length = 0;
    const wasCountdown = this.phase === 'countdown';
    this.time += dt;

    if (wasCountdown && this.time >= 0) {
      this.phase = 'racing';
      for (let i = 0; i < this.karts.length; i++) {
        if (START_BOOST_ARMED[i]) {
          this.karts[i]!.grantBoost(CONFIG.race.perfectStartBoost, 5.0, 'start');
          START_BOOST_ARMED[i] = false;
        }
        this.states[i]!.lastLapStart = 0;
      }
    }

    if (this.phase !== 'racing') {
      this.updatePositions();
      return;
    }

    for (let i = 0; i < this.karts.length; i++) {
      this.updateKart(i, this.karts[i]!, this.states[i]!);
    }
    this.updatePositions();

    if (this.finishOrder.length >= this.karts.length) {
      this.phase = 'finished';
    }
  }

  private updateKart(index: number, kart: Kart, st: KartRaceState): void {
    if (st.finished) return;
    const u = kart.sample.u;
    const sector = Math.floor(u / this.sectorLength) % this.checkpointCount;

    // The whole anti-exploit rule, in one comparison: the sector must be
    // exactly the one being waited for. Anything else — including standing on
    // the line and rocking back and forth over it — advances nothing.
    if (sector === st.nextCheckpoint) {
      st.nextCheckpoint = (sector + 1) % this.checkpointCount;
      if (sector === 0) {
        if (st.started) {
          const lapTime = this.time - st.lastLapStart;
          st.lapTimes.push(lapTime);
          if (lapTime < st.bestLap) st.bestLap = lapTime;
          this.lapEvents.push({ index, lap: st.lap + 1, lapTime });
        }
        st.lastLapStart = this.time;
        st.lap++;
        st.started = true;

        if (st.lap > this.totalLaps) {
          st.finished = true;
          st.finishTime = this.time;
          this.finishOrder.push(index);
        }
      }
    }

    st.progress = st.lap * this.lapLength + u;
  }

  private updatePositions(): void {
    ORDER.length = 0;
    for (let i = 0; i < this.karts.length; i++) ORDER.push(i);
    ORDER.sort((a, b) => {
      const sa = this.states[a]!;
      const sb = this.states[b]!;
      // Finished karts rank by finish time, always ahead of anyone still out
      // there — otherwise the winner drops to last the moment they slow down.
      if (sa.finished && sb.finished) return sa.finishTime - sb.finishTime;
      if (sa.finished) return -1;
      if (sb.finished) return 1;
      return sb.progress - sa.progress;
    });
    for (let rank = 0; rank < ORDER.length; rank++) {
      this.states[ORDER[rank]!]!.position = rank + 1;
    }
  }

  /** Position of a kart, 1-based. */
  positionOf(index: number): number {
    return this.states[index]!.position;
  }

  results(): RaceResult[] {
    const out: RaceResult[] = [];
    for (let i = 0; i < this.karts.length; i++) {
      const st = this.states[i]!;
      out.push({
        index: i,
        driverId: this.karts[i]!.driver.id,
        position: st.position,
        totalTime: st.finished ? st.finishTime : 0,
        bestLap: Number.isFinite(st.bestLap) ? st.bestLap : 0,
        points: CONFIG.race.cupPoints[st.position - 1] ?? 0,
      });
    }
    out.sort((a, b) => a.position - b.position);
    return out;
  }

  /** Seconds until GO, or 0 once racing. */
  countdownRemaining(): number {
    return this.phase === 'countdown' ? Math.max(0, -this.time) : 0;
  }
}

/** Module-scope scratch: the gated control struct and the sort buffer. */
const GATED: Controls = {
  throttle: 0,
  brake: 0,
  steer: 0,
  drift: false,
  useItem: false,
  lookBack: false,
};
const ORDER: number[] = [];
const START_BOOST_ARMED: boolean[] = [];
