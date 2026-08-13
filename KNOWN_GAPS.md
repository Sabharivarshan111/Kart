# Known gaps

Honest and current. Anything unverified says so.

## Broken, and the tests now say so

- **The AI still cannot complete a lap, but it is no longer stuck.** Three real
  defects were found and fixed; a fourth remains.

  Fixed:
  1. **The steering controller.** `angleError × 2.2` saturated at any error past
     26°. From the grid, with a 6 m look-ahead and the kart two metres off the
     line, the first frame already demanded full lock — it oscillated, ran wide,
     and held `steer` at exactly −1.00 for the rest of the race. Replaced with
     pure pursuit, which is self-limiting by construction.
  2. **The off-road branch held 70% throttle and set brake to zero.** On grass,
     at 58% of the road's grip, on the outside of a corner, that keeps the tyres
     saturated longitudinally with nothing left in the grip circle to turn with.
     It now scrubs to a recoverable speed and then powers back on.
  3. **No reverse.** A kart wedged nose-first into a barrier cannot drive out
     forwards at any throttle. It now detects being under walking pace for over
     a second and backs off, steering away from the wall.

  Measured effect, solo AI over 90 s on Kayal Causeway: progress went from
  ~810 m (i.e. barely off the grid) to ~1450 m, top speed seen rose from 4 m/s
  to 15.9 m/s, and it does now get back onto the road unaided.

  **Still wrong:** it oscillates in one narrow section near u≈670–740 and
  crosses the line in neither case. Bug class 6 improved from "91% of the race
  off the road" to **57%** on the latest run, and is still failing. The bar is
  25%.

  **The item balance table cannot be gathered until this is finished**, and no
  claim that the AI works should be made until it is.

- **Bug class 6 was passing while this was true**, which is worse than the bug.
  It sampled `offTrackTimer`, which only counts time on **Void** — fully
  outside the corridor. A kart pinned to the barrier on the verge is
  `onRoad === false` continuously and never accrues a single tick. Its other
  assertion, "progress > 200 m in 90 s", is 2.2 m/s and passes comfortably for
  a kart grinding along a wall.

  The test now samples `onRoad` directly and requires 1000 m of progress. It
  **fails**, correctly, and is left failing rather than relaxed.

## Not built yet

- **Online multiplayer.** Not started and not planned for this build. It needs
  an authoritative server, client prediction, lag compensation, matchmaking and
  a hosting bill that scales with players; none of that exists here. Local
  split-screen is the multiplayer that ships.
- **Records and ghosts.** No `localStorage` persistence, no time-trial ghost.
- **Customization.** Drivers have stats and colours; there is no picker, no
  paint, no wheels, no racing number.
- **Arena mode.** Not started. The rules module has a mode enum that accepts it
  and nothing behind it.
- **Music.** Sound effects are synthesised and self-tested; there is no
  sequenced theme yet.

## Built but weak

- **Shadows.** A flat translucent disc under each kart, scaled by height. It
  reads as a contact hint, not as a shadow. Nothing else in the world casts one.
- **Scenery.** One generic instanced post per track, recoloured by theme. It
  gives parallax and nothing else.
- **Driver figures.** A seated block figure with two-segment arms. No animation
  at all — the driver does not steer, lean, or react.
- **Item visuals.** Boxes, projectiles, traps and shields are tinted primitives.
  They are distinguishable but not designed.
- **Audio mix.** Every cue produces measured signal in the offline self-test.
  That proves nothing is silently disconnected. **It does not prove it sounds
  good**, and nothing automated will.

## Measured, with caveats

- **Frame timings** come from a headless Chromium with no GPU, running a
  software rasteriser. They bound CPU cost and say nothing about frame rate on
  real hardware. No measurement on a physical Android device has been taken —
  every mobile claim in this repo is from emulated profiles only.
- **Track validation** covers closure, achieved corner radius, corridor
  self-overlap, width, banking, item box placement, palette-under-sun, and a
  ballistic jump probe at five speeds. It does **not** check that a track is
  fun.

## Architectural limits, accepted deliberately

- **No self-crossing tracks.** `surfaceAt` is a genuine 2D query and the
  validator fails any corridor that overlaps itself, so there are no bridges and
  no true split paths. Recorded in ARCHITECTURE.md §3.1. Reopening it means
  making the query authoritative on `hintU` and auditing every caller for having
  one. Tunnels are still available, because a tunnel is a roof profile on a
  non-crossing corridor.
- **Shortcuts are therefore surface-based**, not geometric: a wide section where
  cutting across grass costs about as much as it saves unless you arrive
  boosting. That is a real trade, but it is not a second route.
- **Wheel casts are vertical**, not along the kart's own up vector. On a 17°
  bank that is roughly a 4% error in suspension compression, absorbed by the
  spring. Casting along the true up costs a division per wheel per step and
  changes nothing visible.

## Currently failing

- **Bug class 6 (AI off-road).** The one remaining failure, described in full at
  the top of this file. The assertion has not been relaxed.
- **The item balance table** (`tests/balance.spec.ts`) fails for the same
  reason: it needs a hundred races the AI cannot finish.

Bug class 5 (respawn) was listed here and now passes; the entry was stale.

## Orientation, and what it costs

- **Portrait is not a supported layout.** The game shows a rotate prompt and
  pauses behind it. This is a deliberate choice, not a missing feature: at
  390 px of width there is nowhere to put the steering zone that is not either
  under the kart or off the bottom of the screen, and the chase camera loses the
  horizontal room it needs to show the corner ahead. Laying the whole HUD out a
  second time to ship a version nobody should play is worse than saying no.
- **The gate is on viewport shape, not `screen.orientation`.** A phone with the
  keyboard open, a half-open foldable and a desktop window dragged flat all
  disagree with the reported orientation, and the shape is what actually
  matters. A landscape window under 320 px tall is gated for the same reason.
- **`screen.orientation.lock('landscape')` is attempted and mostly refused** —
  iOS does not implement it at all, and no browser honours it outside
  fullscreen. It can never be the only answer, so the gate is the real one.
- **Short viewports clamp prose to one line.** Below 520 px of height the mode
  descriptions, cup blurbs, track ideas and option notes are clamped with an
  ellipsis. The writing still ships and the screens still scroll; it is not all
  on screen at once. Touch targets keep their 48 px floor — that does not move.
- **Every mobile measurement in this repo is from an emulated viewport.**
  Nothing has run on a physical handset, so nothing here is evidence about how
  the gate behaves against real browser chrome, a real notch, or a real rotation
  animation.
