import { CONFIG } from '../core/config.ts';
import type { ItemBoxSpec, TrackSpec } from '../core/contracts.ts';
import { loopDelta } from '../core/mathx.ts';
import type { Rng } from '../core/rng.ts';
import { blankSample, type TrackSurface } from '../track/surface.ts';
import type { Kart } from '../vehicle/kart.ts';
import type { Race } from './rules.ts';

/**
 * ================= ITEMS ARE THE DIFFICULTY SYSTEM =================
 *
 * The single most important design decision in this genre:
 *
 *   **Do not rubber-band the AI's speed. Rubber-band the item distribution.**
 *
 * Every kart drives at an honest pace (`race/ai.ts` has no idea where the
 * player is). What changes with race position is *what comes out of a pickup*:
 * the leader draws defensive and minor items, the back of the field draws the
 * big equalisers. Catch-up becomes something the player earns and uses, and
 * being overtaken becomes a story rather than an insult.
 *
 * The names and designs here are invented for this game.
 */

export type ItemKind =
  | 'dart'      // straight projectile, spins out on contact
  | 'hound'     // homing, locks the kart directly ahead
  | 'burr'      // dropped trap, sits on the road
  | 'grease'    // spreading patch that steals grip rather than stopping you
  | 'husk'      // orbiting shield, absorbs one hit, throwable
  | 'surge'     // instant boost, stacks with drift boost
  | 'undertow'  // briefly slows everyone ahead of you
  | 'phase';    // short invulnerability and a speed bump — last place only

export const ITEM_NAMES: Record<ItemKind, string> = {
  dart: 'Dart',
  hound: 'Hound',
  burr: 'Burr',
  grease: 'Grease',
  husk: 'Husk',
  surge: 'Surge',
  undertow: 'Undertow',
  phase: 'Phase',
};

const KINDS: ItemKind[] = ['dart', 'hound', 'burr', 'grease', 'husk', 'surge', 'undertow', 'phase'];

/**
 * Draw weights by race position, as a fraction of the field (0 = leader,
 * 1 = last). Each row is a position band; the columns follow KINDS.
 *
 * Read down the `hound`, `undertow` and `phase` columns: they are zero at the
 * front and only appear behind. Read the `husk` and `burr` columns: defensive
 * items, weighted to the leader. That shape *is* the difficulty curve.
 */
const WEIGHT_BANDS: { upTo: number; weights: Record<ItemKind, number> }[] = [
  // Leader: defence and small gains only. Never a hound — there is nothing
  // ahead to lock, and handing the leader an equaliser makes a lead
  // self-reinforcing.
  { upTo: 0.15, weights: { dart: 18, hound: 0, burr: 30, grease: 24, husk: 26, surge: 6, undertow: 0, phase: 0 } },
  { upTo: 0.35, weights: { dart: 24, hound: 6, burr: 22, grease: 20, husk: 20, surge: 12, undertow: 2, phase: 0 } },
  { upTo: 0.6,  weights: { dart: 22, hound: 16, burr: 12, grease: 12, husk: 12, surge: 22, undertow: 8, phase: 0 } },
  { upTo: 0.85, weights: { dart: 14, hound: 24, burr: 6,  grease: 6,  husk: 8,  surge: 26, undertow: 18, phase: 2 } },
  // Last place: the big equalisers. `phase` exists only here.
  { upTo: 1.01, weights: { dart: 8,  hound: 26, burr: 3,  grease: 4,  husk: 5,  surge: 24, undertow: 22, phase: 14 } },
];

export interface ItemEntity {
  alive: boolean;
  kind: ItemKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  life: number;
  ownerIndex: number;
  /** For a hound: the kart it locked. -1 for everything else. */
  targetIndex: number;
  /** Distance travelled, so a test can assert a projectile actually *moved*
   *  rather than merely existing (brief §3). */
  travelled: number;
  /** Set when it hits something, so a test can assert it *hit*. */
  hits: number;
  hintU: number;
}

export interface TelemetryRow {
  time: number;
  event: 'pickup' | 'use' | 'hit' | 'block';
  kind: ItemKind;
  /** Position of the actor at the moment of the event. */
  actorPosition: number;
  actorIndex: number;
  /** Position of the victim, for hits. */
  victimPosition: number;
  victimIndex: number;
}

interface BoxState {
  u: number;
  lane: number;
  x: number;
  y: number;
  z: number;
  cooldown: number;
}

const MAX_ENTITIES = 64;

export class ItemSystem {
  readonly boxes: BoxState[] = [];
  readonly entities: ItemEntity[] = [];
  /** One slot only, so holding a shield is a real trade. */
  readonly held: (ItemKind | null)[] = [];
  readonly roulette: number[] = [];
  /** Orbiting shields per kart. */
  readonly shields: number[] = [];
  readonly phaseTimer: number[] = [];
  /** Set while a homing item is closing, so the HUD can warn in time for it to
   *  be dodged or blocked. */
  readonly homingWarning: number[] = [];

  telemetry: TelemetryRow[] = [];
  telemetryEnabled = false;

  private shieldAngle = 0;

  constructor(
    spec: TrackSpec,
    private readonly surface: TrackSurface,
    private readonly kartCount: number,
    private readonly rng: Rng,
  ) {
    for (let i = 0; i < kartCount; i++) {
      this.held.push(null);
      this.roulette.push(0);
      this.shields.push(0);
      this.phaseTimer.push(0);
      this.homingWarning.push(0);
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      this.entities.push({
        alive: false,
        kind: 'dart',
        x: 0, y: 0, z: 0, vx: 0, vz: 0,
        age: 0, life: 0,
        ownerIndex: -1, targetIndex: -1,
        travelled: 0, hits: 0, hintU: 0,
      });
    }
    for (const box of spec.itemBoxes) this.placeBoxes(box);
  }

  private placeBoxes(spec: ItemBoxSpec): void {
    const u = spec.at * this.surface.length;
    const p = { x: 0, y: 0, z: 0 };
    for (const lane of spec.lanes) {
      this.surface.pointAt(u, lane, p);
      this.boxes.push({ u, lane, x: p.x, y: p.y + 0.75, z: p.z, cooldown: 0 });
    }
  }

  get boxesAvailable(): number {
    let n = 0;
    for (const b of this.boxes) if (b.cooldown <= 0) n++;
    return n;
  }

  /** Draw an item for a kart at a given race position. */
  draw(position: number): ItemKind {
    const fraction = this.kartCount <= 1 ? 0 : (position - 1) / (this.kartCount - 1);
    const band = WEIGHT_BANDS.find((b) => fraction <= b.upTo) ?? WEIGHT_BANDS[WEIGHT_BANDS.length - 1]!;
    const weights = KINDS.map((k) => band.weights[k]);
    const idx = this.rng.weighted(weights);
    // A zero total would mean a misauthored band; falling back to the mildest
    // item is better than throwing mid-race, and the tests catch the table.
    return idx < 0 ? 'surge' : KINDS[idx]!;
  }

  step(dt: number, karts: Kart[], race: Race): void {
    this.shieldAngle = (this.shieldAngle + CONFIG.items.shieldOrbitRate * dt) % (Math.PI * 2);

    for (let i = 0; i < this.kartCount; i++) {
      if (this.roulette[i]! > 0) {
        this.roulette[i] = Math.max(0, this.roulette[i]! - dt);
        if (this.roulette[i]! === 0 && this.held[i] === null) {
          const kind = this.draw(race.positionOf(i));
          this.held[i] = kind;
          this.log(race, 'pickup', kind, i, -1);
        }
      }
      if (this.phaseTimer[i]! > 0) {
        this.phaseTimer[i] = Math.max(0, this.phaseTimer[i]! - dt);
        const kart = karts[i]!;
        kart.invulnerable = Math.max(kart.invulnerable, 0.05);
        kart.grantBoost(0.1, CONFIG.items.ghostSpeedBonus, 'item');
      }
      this.homingWarning[i] = Math.max(0, this.homingWarning[i]! - dt);
    }

    this.stepBoxes(dt, karts, race);
    this.stepEntities(dt, karts, race);
  }

  private stepBoxes(dt: number, karts: Kart[], race: Race): void {
    for (const box of this.boxes) {
      if (box.cooldown > 0) {
        box.cooldown -= dt;
        continue;
      }
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i]!;
        if (this.held[i] !== null || this.roulette[i]! > 0) continue;
        const dx = k.x - box.x;
        const dz = k.z - box.z;
        if (dx * dx + dz * dz < 1.6 * 1.6) {
          box.cooldown = CONFIG.items.boxRespawn;
          this.roulette[i] = CONFIG.items.rouletteSeconds;
          void race;
          break;
        }
      }
    }
  }

  /** Fire or drop whatever the kart is holding. */
  use(index: number, karts: Kart[], race: Race): boolean {
    const kind = this.held[index];
    if (kind === null) return false;
    const kart = karts[index]!;

    switch (kind) {
      case 'surge':
        kart.grantBoost(CONFIG.kart.boost.itemBoostTime, CONFIG.kart.boost.itemBoostSpeed, 'item');
        break;
      case 'phase':
        this.phaseTimer[index] = CONFIG.items.ghostDuration;
        break;
      case 'husk':
        // First use starts it orbiting; a second use throws it. That is the
        // trade the single slot creates — holding the shield costs you the
        // slot for as long as you want the protection.
        this.shields[index] = 1;
        break;
      case 'undertow':
        this.applyUndertow(index, karts, race);
        break;
      case 'dart':
        this.spawnProjectile(kind, kart, index, -1);
        break;
      case 'hound': {
        const target = this.kartAhead(index, karts, race);
        this.spawnProjectile(kind, kart, index, target);
        break;
      }
      case 'burr':
      case 'grease':
        this.spawnTrap(kind, kart, index);
        break;
    }

    this.held[index] = null;
    this.log(race, 'use', kind, index, -1);
    return true;
  }

  /** Throw an already-orbiting shield forward. */
  throwShield(index: number, karts: Kart[], race: Race): boolean {
    if (this.shields[index]! <= 0) return false;
    this.shields[index] = 0;
    this.spawnProjectile('husk', karts[index]!, index, -1);
    this.log(race, 'use', 'husk', index, -1);
    return true;
  }

  private applyUndertow(index: number, karts: Kart[], race: Race): void {
    const mine = race.positionOf(index);
    for (let i = 0; i < karts.length; i++) {
      if (i === index) continue;
      if (race.positionOf(i) >= mine) continue;
      if (karts[i]!.invulnerable > 0) {
        this.log(race, 'block', 'undertow', index, i);
        continue;
      }
      UNDERTOW_TIMERS[i] = CONFIG.items.fieldDuration;
      this.log(race, 'hit', 'undertow', index, i);
    }
  }

  /** The kart directly ahead on the road, which is what a hound locks. */
  private kartAhead(index: number, karts: Kart[], race: Race): number {
    const mine = race.positionOf(index);
    let best = -1;
    let bestPos = -1;
    for (let i = 0; i < karts.length; i++) {
      const p = race.positionOf(i);
      if (p < mine && p > bestPos) {
        bestPos = p;
        best = i;
      }
    }
    return best;
  }

  private spawn(): ItemEntity | null {
    for (const e of this.entities) {
      if (!e.alive) return e;
    }
    // Pool exhausted. Dropping the newest is better than growing the pool
    // mid-frame; 64 in flight has never been approached in a full field.
    return null;
  }

  private spawnProjectile(kind: ItemKind, kart: Kart, owner: number, target: number): void {
    const e = this.spawn();
    if (!e) return;
    const fx = Math.sin(kart.heading);
    const fz = Math.cos(kart.heading);
    const speed = kind === 'hound' ? CONFIG.items.homingSpeed : CONFIG.items.projectileSpeed;
    e.alive = true;
    e.kind = kind;
    e.x = kart.x + fx * 1.6;
    e.y = kart.y + 0.4;
    e.z = kart.z + fz * 1.6;
    // Launched at the kart's own speed plus the item's, or a projectile fired
    // at 33 m/s from a kart doing 33 m/s never leaves.
    e.vx = fx * speed + kart.vx * 0.35;
    e.vz = fz * speed + kart.vz * 0.35;
    e.age = 0;
    e.life = CONFIG.items.projectileLife;
    e.ownerIndex = owner;
    e.targetIndex = target;
    e.travelled = 0;
    e.hits = 0;
    e.hintU = kart.hintU;
  }

  private spawnTrap(kind: ItemKind, kart: Kart, owner: number): void {
    const e = this.spawn();
    if (!e) return;
    const fx = Math.sin(kart.heading);
    const fz = Math.cos(kart.heading);
    e.alive = true;
    e.kind = kind;
    // Dropped behind, not in front — a trap you drive into yourself is a bug
    // from the player's side of the screen.
    e.x = kart.x - fx * 2.4;
    e.y = kart.y + 0.15;
    e.z = kart.z - fz * 2.4;
    e.vx = 0;
    e.vz = 0;
    e.age = 0;
    e.life = kind === 'grease' ? CONFIG.items.slickLife : CONFIG.items.trapLife;
    e.ownerIndex = owner;
    e.targetIndex = -1;
    e.travelled = 0;
    e.hits = 0;
    e.hintU = kart.hintU;
  }

  private stepEntities(dt: number, karts: Kart[], race: Race): void {
    for (let i = 0; i < this.kartCount; i++) {
      if (UNDERTOW_TIMERS[i]! > 0) {
        UNDERTOW_TIMERS[i] = Math.max(0, UNDERTOW_TIMERS[i]! - dt);
        karts[i]!.externalSpeedScale = Math.min(
          karts[i]!.externalSpeedScale,
          CONFIG.items.fieldSlowFactor,
        );
      }
    }

    for (const e of this.entities) {
      if (!e.alive) continue;
      e.age += dt;
      if (e.age >= e.life) {
        e.alive = false;
        continue;
      }

      if (e.kind === 'hound' && e.targetIndex >= 0) {
        const t = karts[e.targetIndex];
        if (t) {
          // Steer toward the target rather than snapping onto it, so it can be
          // dodged. A homing item that cannot miss is a tax, not a threat.
          const dx = t.x - e.x;
          const dz = t.z - e.z;
          const d = Math.hypot(dx, dz) || 1;
          const speed = Math.hypot(e.vx, e.vz) || CONFIG.items.homingSpeed;
          const turn = CONFIG.items.homingTurnRate * dt;
          e.vx += (dx / d) * speed * turn;
          e.vz += (dz / d) * speed * turn;
          const s = Math.hypot(e.vx, e.vz) || 1;
          e.vx = (e.vx / s) * speed;
          e.vz = (e.vz / s) * speed;

          // Warn the target while there is still time to act.
          if (d / speed <= CONFIG.items.homingWarning) {
            this.homingWarning[e.targetIndex] = CONFIG.items.homingWarning;
          }
        }
      }

      if (e.vx !== 0 || e.vz !== 0) {
        const nx = e.x + e.vx * dt;
        const nz = e.z + e.vz * dt;
        e.travelled += Math.hypot(nx - e.x, nz - e.z);
        e.x = nx;
        e.z = nz;
        this.surface.sample(e.x, e.z, PROJ_SAMPLE, e.hintU);
        e.hintU = PROJ_SAMPLE.u;
        e.y = PROJ_SAMPLE.height + 0.4;
        // A projectile that leaves the corridor is gone. Without this they
        // sail off across the scenery and keep hunting.
        if (PROJ_SAMPLE.distanceToEdge < -(CONFIG.track.vergeWidth + 1)) {
          e.alive = false;
          continue;
        }
      }

      this.checkEntityHits(e, karts, race);
    }
  }

  private checkEntityHits(e: ItemEntity, karts: Kart[], race: Race): void {
    const isTrap = e.kind === 'burr' || e.kind === 'grease';
    const radius = e.kind === 'grease' ? CONFIG.items.slickRadius : 1.25;

    for (let i = 0; i < karts.length; i++) {
      if (!e.alive) return;
      const k = karts[i]!;
      // Your own trap cannot catch you for the first second, which is how long
      // it takes to drive clear of where you dropped it.
      if (i === e.ownerIndex && (isTrap ? e.age < 1.0 : e.age < 0.35)) continue;

      const dx = k.x - e.x;
      const dz = k.z - e.z;
      if (dx * dx + dz * dz > radius * radius) continue;

      if (e.kind === 'grease') {
        // Steals grip rather than stopping you — a slick you can drive through
        // badly is more interesting than one that ends your race.
        k.externalGripScale = Math.min(k.externalGripScale, CONFIG.items.slickGrip);
        e.hits++;
        continue;
      }

      // Counterplay: a shield eats the hit instead of the kart.
      if (this.shields[i]! > 0) {
        this.shields[i] = 0;
        e.alive = false;
        e.hits++;
        this.log(race, 'block', e.kind, e.ownerIndex, i);
        return;
      }
      if (k.invulnerable > 0 || this.phaseTimer[i]! > 0) continue;

      if (k.spinOut()) {
        e.hits++;
        this.log(race, 'hit', e.kind, e.ownerIndex, i);
      }
      e.alive = false;
      return;
    }
  }

  /** Shield world position, for the renderer. */
  shieldPosition(index: number, kart: Kart, out: { x: number; y: number; z: number }): void {
    const a = this.shieldAngle + (index * Math.PI) / 4;
    out.x = kart.x + Math.cos(a) * CONFIG.items.shieldOrbitRadius;
    out.y = kart.y + 0.45;
    out.z = kart.z + Math.sin(a) * CONFIG.items.shieldOrbitRadius;
  }

  /** Whether an AI holding this item should use it now. Asked by the AI rather
   *  than decided by it, because the answer depends on the item. */
  aiShouldUse(index: number, karts: Kart[], race: Race): boolean {
    const kind = this.held[index];
    if (kind === null) return false;
    const kart = karts[index]!;
    switch (kind) {
      case 'surge':
        // On a straight, not into a corner — a boost into a hairpin is a boost
        // into a barrier.
        return Math.abs(kart.sample.lateral) < 4 && kart.speed > CONFIG.kart.topSpeed * 0.7;
      case 'husk':
        return true; // always worth orbiting
      case 'phase':
        return true;
      case 'burr':
      case 'grease':
        // Drop when someone is close behind.
        for (let i = 0; i < karts.length; i++) {
          if (i === index) continue;
          const gap = loopDelta(karts[i]!.sample.u, kart.sample.u, this.surface.length);
          if (gap > 0 && gap < 22) return true;
        }
        return false;
      case 'dart': {
        // Only when something is actually in front and roughly in line.
        for (let i = 0; i < karts.length; i++) {
          if (i === index) continue;
          const gap = loopDelta(kart.sample.u, karts[i]!.sample.u, this.surface.length);
          if (gap > 2 && gap < 30 && Math.abs(karts[i]!.sample.lateral - kart.sample.lateral) < 3.5) {
            return true;
          }
        }
        return false;
      }
      case 'hound':
        return this.kartAhead(index, karts, race) >= 0;
      case 'undertow':
        return race.positionOf(index) > 1;
    }
  }

  private log(race: Race, event: TelemetryRow['event'], kind: ItemKind, actor: number, victim: number): void {
    if (!this.telemetryEnabled) return;
    this.telemetry.push({
      time: race.time,
      event,
      kind,
      actorIndex: actor,
      actorPosition: actor >= 0 ? race.positionOf(actor) : 0,
      victimIndex: victim,
      victimPosition: victim >= 0 ? race.positionOf(victim) : 0,
    });
  }

  /** Distribution check used by the balance test: draw n items at a position
   *  and report the counts. Deterministic given the seed. */
  sampleDistribution(position: number, n: number): Record<ItemKind, number> {
    const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ItemKind, number>;
    for (let i = 0; i < n; i++) counts[this.draw(position)]++;
    return counts;
  }
}

/** Module-scope scratch, per ARCHITECTURE.md §4. */
const UNDERTOW_TIMERS: number[] = new Array(16).fill(0);
const PROJ_SAMPLE = blankSample();
