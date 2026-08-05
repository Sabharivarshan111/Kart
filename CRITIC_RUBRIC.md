# The critic's rubric

The critic agent looks at **captured frames from the running game** and at
**measured numbers** — never at a builder's summary of its own work. Its job is
to be harsh, specific and useful: find the single biggest gap, name it, and send
the builder back.

## An honest note about the comparison

The brief asks for a blind side-by-side against a specific commercial kart
racer. **That is not possible here** — the game is not available in this
environment, there is no footage to compare against, and an agent claiming to
have done it would be inventing the result. Saying so is more useful than a
fabricated verdict.

What replaces it: the rubric below is a written description of what the
first-party bar actually consists of, drawn from what is publicly and widely
documented about the genre's best work. The critic applies it to our own frames.
Where a criterion cannot be judged from a still, it says so rather than guessing.

**The critic never scores something it did not look at.** "I did not check this"
is an acceptable line in its report. A confident guess is not.

## What "first-party" actually means, criterion by criterion

### 1. Frame discipline
- Locked to the display's refresh, with no visible hitching under load.
- No frame-rate-dependent behaviour anywhere in the simulation.
- **Measured**, on the real rAF clock, on the production build: p50, p95, worst,
  and the count of frames over budget. A fixed-step harness never waits on
  vsync; its numbers say nothing about frame rate.
- Note that the headless runner has no GPU, so its figures bound CPU cost only.

### 2. Silhouette readability
- Every kart is identifiable by shape alone at race distance, not only by
  colour. Squint at the frame: if two karts become the same blob, they fail.
- The player's own kart is distinguishable from the field instantly.
- Outline weight is consistent and does not swallow small or distant objects.

### 3. Colour and light
- Flat cel bands with hard steps. Any soft gradient where a band boundary
  should be is a defect.
- No surface collapses to black in the darkest band, at that scene's own sun
  angle.
- The palette reads as a place — a specific region, hour and weather — not as a
  set of hues.
- Karts separate from the road by value, not only by hue, so the frame survives
  being viewed in greyscale.

### 4. Readability of state
- Drift tier is legible at a glance from the sparks alone, with the eyes on the
  corner exit rather than on a meter.
- Boost, damage, invulnerability and item-held all read without reading text.
- The HUD is legible over the brightest and the darkest part of every track.

### 5. Camera
- Never clips through geometry, never shows the underside of the world.
- Roll is a fraction of the track's, damped; FOV widens with speed and punches
  on boost without inducing sickness.
- On a jump, the horizon stays trustworthy.
- Reduce-motion genuinely reduces roll, shake and FOV kick.

### 6. Feel (judged from simulated runs and telemetry, not stills)
- Steering tightens with speed; the kart is controllable at top speed.
- The grip circle is doing real work: braking mid-corner loses grip.
- Drift costs speed but pays it back — around a fifth through the corner.
- Landing flat is rewarded, landing sideways is punished, and both are legible.
- Surfaces are felt within half a second of touching them.

### 7. Worldbuilding
- A single frame identifies the region without a caption.
- Scenery has depth: foreground dressing, mid-ground structure, a horizon that
  belongs to the place.
- The track's one idea is visible from the track itself, not only in a data file.

### 8. Craft details that separate first-party from competent
- Nothing pops in or out of existence in view.
- No z-fighting anywhere, at any camera preset.
- No object intersects another where it should rest on it.
- Instanced sets are genuinely spread, not piled at the origin — a count
  assertion passes for a hundred objects in one invisible heap.
- Text never overflows its field, in any state, including the widest one.

## How the critic reports

1. **Verdict**: does this read as first-party? Yes or no. No hedging.
2. **The single biggest gap**: one thing, named precisely, with the frame or
   number that shows it.
3. **Evidence**: which frames it opened, what it saw in each.
4. **Not assessed**: everything it could not judge from what it had.

If the answer is no, the builder goes back in on the named gap. There is no
fixed number of rounds.
