# Brief for every agent working on this repo

Read this **and** `ARCHITECTURE.md` before touching anything. `ARCHITECTURE.md`
is binding; this file is how to work.

## What the game is

A cel-shaded arcade kart racer **set across India**, with a playful
medical-student cast, built to a Nintendo first-party quality bar. Browser,
Three.js, no game engine.

## Non-negotiable rules

1. **Zero external assets.** Every mesh, texture and sound is generated in code
   at runtime. No .glb, .png, .mp3, no fetched fonts, no CDN. Geometry from
   `BufferGeometry`, textures from canvas 2D or shaders, audio from Web Audio
   oscillators and generated noise buffers. This is what lets the whole game
   build to one HTML file.

2. **Clean room.** Do not consult, reference or reproduce any other
   implementation of this genre. Techniques are free — raycast-per-wheel
   physics, grip circles, drift-charged boosts, cel ramps, inverted hulls,
   Sobel over a G-buffer, position-weighted items are all standard published
   game development. **Identity is not free.** Invent our own characters, names,
   logos, item designs, track layouts and UI copy. Never name, imitate or
   allude to another franchise's cast, items or courses. "Match the quality
   bar" never means "copy the thing".

3. **Respect the single sources of truth.** One track surface (`surfaceAt`),
   one palette, one config, one control struct. No colour literal outside
   `core/palette.ts` and the theme files. No second way to get ground height.
   Adding a convenient parallel implementation is the bug, not the shortcut.

4. **Fixed-step physics at 120 Hz, no allocation in the frame loop.**

5. **Never claim a visual result you have not seen in a captured frame, or a
   performance result you have not measured on the real rAF clock.** If
   something is unverified, say so in your report. An honest "I did not check
   this" is worth more than a confident guess.

6. **Comment why, not what.** Every non-obvious constant states what it was
   measured against and what breaks if it moves. When you fix a bug, record the
   symptom in the comment.

## Cultural representation

The setting is India, and the cast are medical students. Both are to be
handled with warmth and specificity, not caricature:

- Draw on real regional geography, architecture, colour and climate. A Kerala
  backwater and a Himalayan pass should be unmistakable from a single frame.
- Character names should be plausible and varied across regions and
  communities. Avoid stereotype shorthand of any kind.
- The medical-student angle is **playful**, not clinical: a stethoscope on a
  wing mirror, a coffee-fuelled all-nighter driver stat, ward-round humour in
  the UI copy. It is never gore, never a real patient, never a real
  institution's name or logo.
- Do not use real people, real hospitals, real brands or real deities as
  characters, items or track dressing.

## Commands

```bash
npx tsc --noEmit                                   # typecheck; must be clean
node --experimental-strip-types tools/validate-tracks.mts   # track geometry
npm run build                                      # production single file
npx playwright test --project=desktop              # shots + bug classes
npx playwright test --project=desktop tests/shots.spec.ts   # just the frames
```

Screenshots land in `shots/`. The verification harness is `window.sparkdrift`
in every build (see `src/harness/api.ts`) — `simulate`, `setControls`,
`teleport`, `stats`, `setCameraPreset`, `analyseEdges`, `validateAllTracks`.

## How work is judged

A separate critic agent looks at the **actual rendered frames** — never your
summary — against a first-party quality rubric, and names the single biggest
remaining gap. Expect to be sent back. Write your report so the next round can
start from it: what you changed, what you measured, what you did **not** get to,
and what you think the weakest part still is.

## Definition of done for a piece

- `npx tsc --noEmit` clean.
- The track validator passes if you touched track data.
- The bug-class suite still passes if you touched physics, collision or rules.
- New behaviour has a captured frame or a measured number behind it.
- `KNOWN_GAPS.md` updated honestly with anything you left broken or unverified.
