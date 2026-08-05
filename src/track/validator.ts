import { CONFIG } from '../core/config.ts';
import { SurfaceKind } from '../core/contracts.ts';
import type { TrackSpec, SurfaceSample } from '../core/contracts.ts';
import { len2, segmentsIntersect } from '../core/mathx.ts';
import { MIN_SHADED_LUMINANCE, luminance, type Theme } from '../core/palette.ts';
import { buildCentreline, type BuildIssue } from './centreline.ts';
import { TrackSurface, blankSample } from './surface.ts';

/**
 * The track geometry validator (brief §3, bug class 11).
 *
 * It builds every track and fails on: overlapping fillets, a closure gap,
 * unintended self-intersection, a corner too tight for the kart to take at any
 * speed, and — the one that actually catches things — **a jump whose landing is
 * not reachable from its take-off at achievable speed**. That last one is
 * simulated ballistically against the real surface query, not eyeballed.
 *
 * It never silently repairs a track. A failing track is an authoring bug and
 * the message says which vertex.
 */

export interface ValidationIssue {
  severity: 'error' | 'warning';
  kind: string;
  message: string;
}

export interface ValidationReport {
  trackId: string;
  ok: boolean;
  issues: ValidationIssue[];
  measurements: {
    lapLength: number;
    stationCount: number;
    minRadius: number;
    minHalfWidth: number;
    maxBankDeg: number;
    climbRange: number;
    jumps: JumpMeasurement[];
    closureGap: number;
  };
}

export interface JumpMeasurement {
  /** Arc length of the take-off. */
  takeOffU: number;
  takeOffAngleDeg: number;
  /** Landing distance and surface for each probed speed. */
  probes: { speed: number; distance: number; surface: SurfaceKind; onRoad: boolean }[];
}

/** Lateral acceleration the kart can actually generate, m/s². This is what
 *  decides whether a corner is takeable at any speed at all. */
const MAX_LATERAL_ACCEL = CONFIG.kart.grip.lateralPeak * 9.81;

/** The tightest radius the steering geometry can produce at all, from the
 *  Ackermann relation R = wheelbase / tan(maxSteer). A corner tighter than this
 *  cannot be driven at *any* speed, which is a different failure from "tight". */
const GEOMETRIC_MIN_RADIUS = CONFIG.kart.wheelbase / Math.tan(CONFIG.kart.steer.maxAngleLow);

/** Below this the corner is takeable but only at a crawl, which on a racing
 *  circuit is an authoring mistake rather than a design choice. 7 m is a
 *  corner takeable at sqrt(15.2 × 7) ≈ 10.3 m/s. */
const PRACTICAL_MIN_RADIUS = 7.0;

export function validateTrack(spec: TrackSpec, theme?: Theme): ValidationReport {
  const issues: ValidationIssue[] = [];
  const buildIssues: BuildIssue[] = [];
  const cl = buildCentreline(spec, buildIssues);

  for (const b of buildIssues) {
    issues.push({ severity: 'error', kind: b.kind, message: b.message });
  }

  const measurements: ValidationReport['measurements'] = {
    lapLength: cl.length,
    stationCount: cl.stations.length,
    minRadius: cl.minRadius,
    minHalfWidth: Infinity,
    maxBankDeg: 0,
    climbRange: 0,
    jumps: [],
    closureGap: 0,
  };

  if (!cl.stations.length) {
    return { trackId: spec.id, ok: false, issues, measurements };
  }

  const surface = new TrackSurface(cl);

  // --- Closure -------------------------------------------------------------
  const first = cl.stations[0]!;
  const last = cl.stations[cl.stations.length - 1]!;
  const gap = Math.abs(len2(first.x - last.x, first.z - last.z) - cl.spacing);
  measurements.closureGap = gap;
  if (gap > cl.spacing * 0.25) {
    issues.push({
      severity: 'error',
      kind: 'closure-gap',
      message: `centreline does not close: last-to-first gap is ${gap.toFixed(3)} m off the ${cl.spacing} m station spacing`,
    });
  }
  const heightGap = Math.abs(first.y - last.y);
  if (heightGap > 0.25) {
    issues.push({
      severity: 'error',
      kind: 'closure-gap',
      message: `elevation does not close: ${heightGap.toFixed(2)} m step across the start line`,
    });
  }

  // --- Widths, banking, elevation -----------------------------------------
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of cl.stations) {
    measurements.minHalfWidth = Math.min(measurements.minHalfWidth, s.halfWidth);
    measurements.maxBankDeg = Math.max(measurements.maxBankDeg, Math.abs((s.bank * 180) / Math.PI));
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }
  measurements.climbRange = maxY - minY;

  // Two karts are 1.28 m wide each and need room to be side by side without
  // permanent contact, plus a racing line. Below 4 m half-width the track is a
  // corridor, not a circuit.
  if (measurements.minHalfWidth < CONFIG.kart.trackWidth * 1.6) {
    issues.push({
      severity: 'error',
      kind: 'too-narrow',
      message: `minimum half-width ${measurements.minHalfWidth.toFixed(2)} m is under ${(CONFIG.kart.trackWidth * 1.6).toFixed(2)} m — two karts cannot pass`,
    });
  }
  if (measurements.maxBankDeg > 45) {
    issues.push({
      severity: 'error',
      kind: 'bank-too-steep',
      message: `banking reaches ${measurements.maxBankDeg.toFixed(1)}° — past 45° the tan(bank) height relation runs away`,
    });
  }

  // --- Corner radius -------------------------------------------------------
  if (cl.minRadius < GEOMETRIC_MIN_RADIUS) {
    issues.push({
      severity: 'error',
      kind: 'corner-impossible',
      message:
        `tightest corner is ${cl.minRadius.toFixed(2)} m, below the kart's ` +
        `${GEOMETRIC_MIN_RADIUS.toFixed(2)} m minimum turning radius — not takeable at any speed`,
    });
  } else if (cl.minRadius < PRACTICAL_MIN_RADIUS) {
    issues.push({
      severity: 'warning',
      kind: 'corner-tight',
      message:
        `tightest corner is ${cl.minRadius.toFixed(2)} m, takeable only at ` +
        `${Math.sqrt(MAX_LATERAL_ACCEL * cl.minRadius).toFixed(1)} m/s`,
    });
  }

  // --- Self-intersection ---------------------------------------------------
  // The 2D surface query is only well-defined if the corridor never overlaps
  // itself (ARCHITECTURE.md §3.1 forbids crossings). Two tests: a strict
  // segment crossing of the centreline, and a proximity test on the full
  // corridor including verges, because a near miss returns the wrong station
  // just as badly as a real crossing does.
  const st = cl.stations;
  const n = st.length;
  let crossed = false;
  let tooClose = 0;
  let closestPair = { i: -1, j: -1, d: Infinity, need: 0 };
  for (let i = 0; i < n; i++) {
    const a = st[i]!;
    const b = st[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if ((j + 1) % n === i) continue;
      const c = st[j]!;
      const d = st[(j + 1) % n]!;
      if (!crossed && segmentsIntersect(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) {
        crossed = true;
        issues.push({
          severity: 'error',
          kind: 'self-intersection',
          message: `centreline crosses itself near u=${a.u.toFixed(0)} m and u=${c.u.toFixed(0)} m — crossings are forbidden (ARCHITECTURE.md §3.1)`,
        });
      }
      const need = a.halfWidth + c.halfWidth + CONFIG.track.vergeWidth * 2;
      // Two stations *on the same corner* are legitimately close in space —
      // the chord of an arc is always shorter than the arc. Comparing them
      // flags every corner on every track, so pairs nearer than 1.6 × the
      // required separation *along the track* are skipped. At that ratio the
      // chord of the tightest radius we allow still clears `need`, so a real
      // doubling-back is still caught.
      const along = Math.min(Math.abs(c.u - a.u), cl.length - Math.abs(c.u - a.u));
      if (along < need * 1.6) continue;
      const dist = len2(a.x - c.x, a.z - c.z);
      if (dist < need) {
        tooClose++;
        if (dist - need < closestPair.d - closestPair.need) {
          closestPair = { i, j, d: dist, need };
        }
      }
    }
  }
  if (tooClose > 0) {
    issues.push({
      severity: 'error',
      kind: 'corridor-overlap',
      message:
        `corridor overlaps itself at ${tooClose} station pairs; worst is ` +
        `u=${st[closestPair.i]!.u.toFixed(0)} m and u=${st[closestPair.j]!.u.toFixed(0)} m at ` +
        `${closestPair.d.toFixed(1)} m apart, needing ${closestPair.need.toFixed(1)} m`,
    });
  }

  // --- Jumps ---------------------------------------------------------------
  for (const jump of findJumps(cl.stations.map((s) => s.jump))) {
    measurements.jumps.push(
      simulateJump(surface, cl.stations[jump.start]!.u, cl.stations[jump.end]!.u, issues),
    );
  }

  // --- Item boxes ----------------------------------------------------------
  const sample = blankSample();
  for (const box of spec.itemBoxes) {
    const u = box.at * cl.length;
    for (const lane of box.lanes) {
      const p = { x: 0, y: 0, z: 0 };
      surface.pointAt(u, lane, p);
      surface.sample(p.x, p.z, sample);
      if (!sample.onRoad) {
        issues.push({
          severity: 'error',
          kind: 'item-box-off-road',
          message: `item box at lap fraction ${box.at}, lane ${lane} m is off the road`,
        });
      }
    }
  }

  // --- Palette under this track's own sun ----------------------------------
  if (theme) validateThemeUnderSun(theme, spec, issues);

  const ok = !issues.some((i) => i.severity === 'error');
  return { trackId: spec.id, ok, issues, measurements };
}

interface JumpRun {
  start: number;
  end: number;
}

function findJumps(flags: boolean[]): JumpRun[] {
  const runs: JumpRun[] = [];
  const n = flags.length;
  let i = 0;
  while (i < n) {
    if (!flags[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && flags[i]) i++;
    runs.push({ start, end: i - 1 });
  }
  return runs;
}

/**
 * Ballistic simulation of a take-off, against the real surface query.
 *
 * The brief says "simulate the jump" and means it: a jump that reads fine in
 * the elevation data can still fire the kart into a wall at boosted speed, or
 * land it in the void short of the far side. Both only show up if you actually
 * fly it.
 */
/**
 * Where the kart actually leaves the ground, at a given speed.
 *
 * Not "the last station flagged as a jump" — that is on the far side of the
 * crest and produces a nonsense downhill take-off angle. Separation happens at
 * the first point where following the road would need more downward
 * acceleration than gravity can supply: v²·κ > g, with κ the *vertical*
 * curvature d(sin θ)/du. This makes the take-off point speed-dependent, which
 * is correct — a faster kart leaves the ramp earlier and flies further for two
 * reasons, not one.
 */
function separationU(surface: TrackSurface, startU: number, endU: number, speed: number): number {
  const stepU = 0.5;
  let prev = surface.stationAt(startU).ty;
  for (let u = startU + stepU; u <= endU; u += stepU) {
    const ty = surface.stationAt(u).ty;
    const kappa = (prev - ty) / stepU; // +ve where the road curves over a crest
    if (speed * speed * kappa > 9.81) return u;
    prev = ty;
  }
  return endU;
}

function simulateJump(
  surface: TrackSurface,
  runStartU: number,
  runEndU: number,
  issues: ValidationIssue[],
): JumpMeasurement {
  const probes: JumpMeasurement['probes'] = [];

  // Achievable speed band: a kart that has just come off a slow corner, up to
  // one arriving on a tier-3 drift boost. Both ends have to land safely.
  const speeds = [12, 16, 20, CONFIG.kart.topSpeed, CONFIG.kart.boostTopSpeed];
  const sample: SurfaceSample = blankSample();
  let reportedU = runEndU;
  let reportedAngle = 0;

  for (const speed of speeds) {
    const takeOffU = separationU(surface, runStartU, runEndU, speed);
    const s = surface.stationAt(takeOffU);
    if (speed === CONFIG.kart.topSpeed) {
      reportedU = takeOffU;
      reportedAngle = (Math.asin(Math.max(-1, Math.min(1, s.ty))) * 180) / Math.PI;
    }
    let x = s.x;
    let y = s.y + 0.3; // wheel-centre height at take-off
    let z = s.z;
    let vx = s.tx * speed;
    let vy = s.ty * speed;
    let vz = s.tz * speed;
    const dt = 1 / 240;
    let t = 0;
    let travelled = 0;
    let landed = false;
    let landingSurface: SurfaceKind = SurfaceKind.Void;
    let landingOnRoad = false;

    // 8 s is far longer than any jump we would author; hitting the cap is
    // itself a failure and is reported as one below.
    while (t < 8) {
      vy -= 9.81 * dt;
      const nx2 = x + vx * dt;
      const ny2 = y + vy * dt;
      const nz2 = z + vz * dt;
      travelled += Math.hypot(nx2 - x, nz2 - z);
      x = nx2;
      y = ny2;
      z = nz2;
      t += dt;
      surface.sample(x, z, sample);
      if (vy < 0 && y <= sample.height + 0.3) {
        landed = true;
        landingSurface = sample.surface;
        landingOnRoad = sample.onRoad;
        break;
      }
    }

    probes.push({ speed, distance: travelled, surface: landingSurface, onRoad: landingOnRoad });

    if (!landed) {
      issues.push({
        severity: 'error',
        kind: 'jump-never-lands',
        message: `jump at u=${takeOffU.toFixed(0)} m never lands at ${speed} m/s within 8 s`,
      });
    } else if (landingSurface === SurfaceKind.Void) {
      issues.push({
        severity: 'error',
        kind: 'jump-lands-in-void',
        message:
          `jump at u=${takeOffU.toFixed(0)} m taken at ${speed} m/s lands off the corridor ` +
          `after ${travelled.toFixed(1)} m — the landing is not reachable at achievable speed`,
      });
    } else if (!landingOnRoad) {
      issues.push({
        severity: 'warning',
        kind: 'jump-lands-off-road',
        message:
          `jump at u=${takeOffU.toFixed(0)} m taken at ${speed} m/s lands on the verge ` +
          `after ${travelled.toFixed(1)} m`,
      });
    }
  }

  return { takeOffU: reportedU, takeOffAngleDeg: reportedAngle, probes };
}

/**
 * Bug class 8, done properly: not "is this colour dark" but "is this colour
 * dark *once the darkest cel band multiplies it*, under this track's own sun".
 * A low sun puts far more of the road into the bottom band, so a palette that
 * survives at noon can collapse at dusk.
 */
export function validateThemeUnderSun(
  theme: Theme,
  spec: TrackSpec,
  issues: ValidationIssue[],
): void {
  const sunEl = spec.theme.sunElevation;
  // Diffuse term on a flat road facing straight up.
  const ndotl = Math.max(0, Math.sin(sunEl));
  // The cel ramp's lowest band, as the shader computes it: ambient only.
  const bandStep = 1 / CONFIG.render.celBands;
  const band = Math.floor(ndotl / bandStep) / CONFIG.render.celBands;
  const lit = theme.ambientLevel + (1 - theme.ambientLevel) * band;

  const checks: [string, number][] = [
    ['road', theme.road],
    ['grass', theme.grass],
    ['sand', theme.sand],
    ['wall', theme.wall],
    ['scenery', theme.scenery],
  ];
  for (const [name, hex] of checks) {
    const shaded = luminance(hex) * lit;
    if (shaded < MIN_SHADED_LUMINANCE) {
      issues.push({
        severity: 'error',
        kind: 'palette-collapses',
        message:
          `theme "${theme.name}" ${name} renders at luminance ${shaded.toFixed(4)} under this ` +
          `track's sun elevation of ${((sunEl * 180) / Math.PI).toFixed(0)}° ` +
          `(floor ${MIN_SHADED_LUMINANCE}) — it will read as pure black`,
      });
    }
  }
}

export function formatReport(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.trackId}`);
  const m = r.measurements;
  lines.push(
    `  lap ${m.lapLength.toFixed(1)} m, ${m.stationCount} stations, ` +
      `min radius ${m.minRadius === Infinity ? 'inf' : m.minRadius.toFixed(1)} m, ` +
      `min half-width ${m.minHalfWidth.toFixed(1)} m, max bank ${m.maxBankDeg.toFixed(1)}°, ` +
      `climb range ${m.climbRange.toFixed(1)} m, closure gap ${m.closureGap.toFixed(3)} m`,
  );
  for (const j of m.jumps) {
    lines.push(
      `  jump @${j.takeOffU.toFixed(0)} m, ${j.takeOffAngleDeg.toFixed(1)}° — ` +
        j.probes.map((p) => `${p.speed}m/s→${p.distance.toFixed(1)}m${p.onRoad ? '' : '!'}`).join(', '),
    );
  }
  for (const i of r.issues) lines.push(`  [${i.severity}] ${i.kind}: ${i.message}`);
  return lines.join('\n');
}
