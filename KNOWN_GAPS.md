# Known gaps

Honest and current. Anything unverified says so.

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

- **Bug class 5 (respawn).** Recovery does not trigger when the kart is placed
  30 m off the centreline. Under investigation — the likely cause is the wall
  resolver clamping the kart back inside the corridor before the off-track timer
  can accumulate, which would mean the timer never sees a Void surface.
- **Bug class 6 (AI off-road).** One AI kart stayed off the corridor for 1.43 s
  in an AI-only race, against a 1.0 s bar. Under investigation.

Both are real defects. Neither assertion has been relaxed.
