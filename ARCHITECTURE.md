# Sparkdrift — architecture contract

This document is **binding**. It is written before the game and changed only
deliberately, by editing this file first and the code second. Its purpose is to
stop the codebase from growing a second, slightly different implementation of
anything that matters.

Where a rule below says *single source of truth*, that means exactly one module
owns the data and every other module asks it. A convenient local copy is the
bug, not the shortcut.

---

## 1. Units and coordinate system

- **Y is up.** Right-handed, matching Three.js.
- **One world unit is one metre.** No exceptions, no "10 units per metre"
  anywhere, no per-module scale factors.
- Angles are **radians**. Time is **seconds**. Mass is **kilograms**.
- Forces are newtons, velocities m/s, accelerations m/s².

Reference vehicle, from which every other number is derived:

| Quantity | Value | Why this value |
|---|---|---|
| Kart length | 1.90 m | A real racing kart is 1.8–2.0 m; this sets track width, kerb size and camera distance. |
| Kart width (track) | 1.28 m | Wheel centres 1.28 m apart. Decides how much of a 9 m road two karts occupy side by side. |
| Wheelbase | 1.05 m | Front to rear axle. Drives the steering geometry and the pitch response under braking. |
| Mass | 165 kg | Kart plus driver. All forces are quoted against this; halve it and every tuned constant is wrong. |
| Top speed (base) | 24.5 m/s | ≈88 km/h. Sets the drag coefficient and, with the frame budget, the tunnelling margin. |
| Boosted top speed | 33.0 m/s | The ceiling the drift boost and item boost raise you to. |

At 24.5 m/s a kart covers **0.41 m per 60 Hz frame** and **0.20 m per 120 Hz
physics step**. Wall thickness and kerb height are chosen against those two
numbers, and so is the decision to sweep wall tests rather than point-test them.

---

## 2. Module ownership

Nothing outside a module reaches into its internals. Everything that crosses a
module boundary is a type declared in `src/core/contracts.ts`.

| Module | Owns | Must not |
|---|---|---|
| `core/config.ts` | Every tunable number in the game, in one frozen object. | Contain logic. |
| `core/palette.ts` | Every colour. | Be bypassed by a literal anywhere else. |
| `core/contracts.ts` | The types that cross module boundaries. | Import anything but types. |
| `core/controls.ts` | The one control struct and its neutral/clone helpers. | Know who produced it. |
| `core/loop.ts` | The fixed-step accumulator and the render interpolation alpha. | Touch game state. |
| `core/rng.ts` | Seeded deterministic RNG. | Use `Math.random`. |
| `track/centreline.ts` | Legs-and-fillets authoring → resampled stations. | Know about meshes. |
| `track/surface.ts` | **`surfaceAt()` — the one track surface.** | Be duplicated, ever. |
| `track/mesh.ts` | The swept render mesh, generated *from the same stations*. | Compute its own heights. |
| `track/validator.ts` | Geometry rules and their failure messages. | Silently repair a track. |
| `vehicle/kart.ts` | Vehicle state and its fixed-step integration. | Read input devices. |
| `vehicle/collision.ts` | Swept wall response, kart-to-kart, spin-out. | Own the surface query. |
| `render/*` | Materials, outlines, G-buffer, post, procedural meshes. | Affect the simulation. |
| `race/rules.ts` | Checkpoints, laps, positions, countdown, results. | Move a kart. |
| `race/ai.ts` | AI decisions, emitted **as a `Controls`**. | Write kart state directly. |
| `race/items.ts` | Item entities, distribution, effects. | Change AI speed for catch-up. |
| `ui/*` | DOM. | Own game state. |
| `audio/*` | Web Audio graph. | Block on the physics thread. |
| `content/*` | Track, roster and cup data. | Contain behaviour. |
| `harness/api.ts` | The `window.sparkdrift` verification API. | Exist in a shipped-only path that diverges from the game's own. |

---

## 3. Single sources of truth

### 3.1 One track surface

```ts
surfaceAt(x: number, z: number, hintU?: number): SurfaceSample
// → { height, normal, surface, onRoad, distanceToEdge, u, lateral }
```

- The **render mesh is generated from the same station array** the query reads.
  They cannot disagree, because there is only one set of numbers.
- Physics, AI, camera, respawn and item placement all call this. Nothing derives
  ground height any other way. Not by raycasting the mesh, not by a heightmap
  copy, not by "it's flat here so just use 0".

**Decision on self-crossing tracks (taken at M2, written down as the brief
demands):** *crossings are forbidden.* `surfaceAt` is a genuine 2D query and the
validator fails any track whose centreline corridor self-intersects. `hintU` is
a **performance** hint only — it narrows the station search from O(n) to O(1) —
and never changes the answer. If a future track needs a bridge, this decision
has to be reopened deliberately: the query would have to become authoritative on
`hintU`, and every caller audited for having one.

Tunnels are still available, because a tunnel is a wall/roof profile on a
non-crossing corridor, not an overlap.

### 3.2 One palette

`core/palette.ts` holds every colour as a named entry. Track themes select a
palette; materials read it **once at construction**. There is no live
re-theming: selecting a track stores the choice and reloads, because
hot-swapping means rebuilding and disposing every material and one missed
dispose is a leak that only shows up after six races.

### 3.3 One config

`core/config.ts` exports a single frozen object. Every tunable lives there with
a comment saying what it was measured against and what breaks if it moves.

### 3.4 One control struct

```ts
interface Controls {
  throttle: number;  // 0..1
  brake: number;     // 0..1
  steer: number;     // -1 left .. +1 right
  drift: boolean;
  useItem: boolean;
  lookBack: boolean;
}
```

The player's input and the AI's output are **the same shape**, and the vehicle
only ever moves through `applyControls`. This is what stops the AI from quietly
cheating, and it is what makes a race recordable and replayable.

---

## 4. The frame loop

- Physics runs at a **fixed 120 Hz** through an accumulator. Never variable.
- Rendering interpolates between the previous and current physics states with
  the leftover alpha.
- The accumulator is clamped to **8 steps (66 ms)** per frame. Past that the
  simulation deliberately runs slow rather than spiral: a kart that is handed a
  400 ms delta is through a wall, and a spiral makes the next frame worse.
- **No allocation in the frame loop.** Scratch vectors are preallocated at
  module scope. `new THREE.Vector3()` inside a per-frame function is a defect.

---

## 5. Determinism

- All gameplay randomness comes from `core/rng.ts`, seeded from the `seed` URL
  parameter (default `1`). `Math.random` is banned in `src/`.
- Given a seed and a control sequence, `simulate(seconds, dt)` produces the same
  state every run. The harness depends on this and so does the item balance
  table.

---

## 6. Verification

`harness/api.ts` exposes `window.sparkdrift` in every build, including
production — a harness that only exists in dev tests something other than what
ships. It provides `ready`, `simulate`, `setPhase`, `setControls`,
`setCameraPreset`, `stats`, `teleport`, `bounds`.

Rules, applied without exception:

1. **Never claim a visual result not seen in a captured frame.**
2. **Never claim a performance result not measured on the real rAF clock**, on
   the production build. The fixed-step harness never waits on vsync; its
   numbers say nothing about frame rate.
3. **Assert geometrically, not by eye.** Overlaps are rectangle intersections.
4. **Assert correctness, not presence.** A count assertion passes for a hundred
   objects in one invisible pile at the origin. Instanced sets are asserted
   *spread*; projectiles are asserted to have *moved* and *hit*.

---

## 7. Rendering pipeline order

1. Opaque cel pass (quantised nearest-filtered ramp; flat bands, hard steps).
2. Inverted-hull outlines, expanded along a smoothed normal by a **constant
   number of screen pixels**, so line weight does not change with distance.
3. G-buffer: view normal + linear depth + object id. **Outline hulls are
   excluded from it**, or every silhouette is drawn twice.
4. Sobel over the G-buffer combining depth (silhouette), normal (crease) and id
   (two objects meeting at the same depth and angle). Depth is compared
   **relatively** (Δd/d) or the foreground scribbles and the distance vanishes.
5. Composite, then speed FX (streaks, chromatic pinch), then HUD as DOM.

The G-buffer may render at half resolution. Its Sobel taps are then spaced in
**G-buffer texels**, not screen pixels — spacing them in screen pixels against a
half-res target samples one texel nine times and returns a gradient of exactly
zero, which is silently no lines at all.

---

## 8. Mobile

- Touch controls are **DOM elements, not canvas regions**, specifically for
  `setPointerCapture`: a captured pointer keeps firing at its element after the
  finger slides off it, which is what a drift button needs.
- **Quality tier is resolved once at load** and decides *structure*: mesh
  density, crowd counts, buffer sizes, frame budget. The **adaptive controller
  decides resolution continuously**. These are two different jobs and are not
  allowed to become one.
- The adaptive resolution **floor is 0.85×**, not 0.5×. A 0.5× floor on a device
  reporting DPR 2.6 renders a fifth of the panel's linear resolution and looks
  terrible while doing exactly what it was told.
- Viewport comes from `visualViewport`, never `innerHeight`.

---

## 9. Standing rules

- Comment **why**, not what. Every non-obvious constant states what it was
  measured against and what breaks if it moves.
- When a bug is fixed, the symptom goes in the comment.
- `KNOWN_GAPS.md` is honest and current. Unverified means it says unverified.
- Prefer deleting a feature to shipping one that half-works.
