/**
 * THE config (ARCHITECTURE.md §3.3). Every tunable in the game lives here.
 *
 * Every non-obvious constant carries a sentence saying what it was measured
 * against and what breaks if it moves. Numbers without that sentence are
 * either trivially geometric or a defect waiting to happen.
 */

export const CONFIG = {
  /** Physics runs at a fixed rate through an accumulator; rendering
   *  interpolates. 120 Hz because at 24.5 m/s a step is 0.20 m — half a kerb
   *  width — so a swept wall test has something to work with. At 60 Hz the
   *  step is 0.41 m and karts clip corners of walls on impact frames. */
  fixedHz: 120,
  /** Max physics steps per rendered frame. Past this the sim deliberately runs
   *  slow instead of spiralling: a kart handed a 400 ms catch-up is through a
   *  wall, and a spiral makes the next frame worse. 8 steps = 66 ms. */
  maxStepsPerFrame: 8,

  kart: {
    length: 1.9,
    /** Distance between left and right wheel centres. */
    trackWidth: 1.28,
    wheelbase: 1.05,
    /** Kart + driver. Every force below is quoted against this mass; halve it
     *  and all of them are wrong. */
    mass: 165,
    /** Yaw inertia. Measured by tuning until a 90° corner entry at 18 m/s
     *  settles in ~0.35 s without oscillating. Lower and the kart snaps;
     *  higher and it understeers into everything. */
    yawInertia: 92,
    wheelRadius: 0.28,

    /** Suspension. Chosen so static compression is ~40% of travel, which is
     *  what makes the visible nose-dive under braking read as weight transfer
     *  rather than as a glitch. */
    suspension: {
      restLength: 0.34,
      travel: 0.22,
      /** N/m per wheel. 4 wheels × 28000 × 0.058 m ≈ 165 kg · g at rest. */
      stiffness: 28000,
      /** Critical-ish. Under ~1800 the kart pogos on kerbs; over ~3600 it
       *  transmits every kerb into the camera and reads as harsh. */
      damping: 2600,
    },

    /** Engine. Force is a curve falling to zero at top speed so drag does not
     *  have to do all the limiting — that keeps acceleration honest at the top
     *  end instead of asymptotic. */
    driveForce: 5200,
    /** m/s. ≈88 km/h. Raise it and every corner radius in content/ is wrong. */
    topSpeed: 24.5,
    /** The ceiling boosts raise you to. */
    boostTopSpeed: 33.0,
    brakeForce: 7400,
    /** Reverse is deliberately feeble: it exists to unstick you, not to race. */
    reverseForce: 2100,
    reverseTopSpeed: 6.0,
    /** N per (m/s)². At top speed drag ≈ 0.7 × 24.5² ≈ 420 N, about 8% of
     *  drive force, so the falling drive curve does the rest. */
    dragCoefficient: 0.7,
    /** Rolling resistance, N per m/s. */
    rollingResistance: 12,

    /** Steering tightens with speed. A kart that turns as hard at 24 m/s as at
     *  5 m/s is uncontrollable — this is not a nicety. */
    steer: {
      maxAngleLow: 0.62,
      maxAngleHigh: 0.20,
      /** Speed at which the high-speed limit is fully in effect. */
      fullEffectSpeed: 22,
      /** Rate the steering angle approaches its target, 1/s. */
      responsiveness: 9.0,
      /** Extra angle available while drifting, so the slide can be modulated. */
      driftBonus: 0.30,
    },

    /** The grip circle. This single clamp is what makes braking mid-corner lose
     *  grip, and it is the whole difference between a car and a brick on rails.
     *  Values are the peak force per wheel as a multiple of that wheel's load. */
    grip: {
      lateralPeak: 1.55,
      longitudinalPeak: 1.35,
      /** Grip retained once past the peak (a sliding tyre). 0.62 measured by
       *  requiring a fully committed drift to lose ~20% of corner speed. */
      slidingFraction: 0.62,
      /** Lateral slip (m/s) at which the tyre is fully saturated. */
      slipSaturation: 3.6,
    },

    /** Drift. Section 4 of the brief: this is the game. */
    drift: {
      /** Below this you cannot initiate. Stops grid-line charging together with
       *  the slip gate below (bug class 3). */
      minSpeed: 8.0,
      /** Minimum |steer| to enter. */
      minSteer: 0.28,
      /** The hop. Not decoration — it is the tell that the state changed. */
      hopImpulse: 2.35,
      hopDuration: 0.22,
      /** Lateral slip (m/s) that must actually be happening for charge to
       *  accrue. Gating on the button instead of on real sliding is bug
       *  class 3, and players will charge on the grid. */
      chargeSlipThreshold: 1.6,
      /** Seconds of genuine sliding for each tier. */
      tierTimes: [0.55, 1.25, 2.10],
      /** Boost seconds granted per tier. */
      tierBoost: [0.55, 0.95, 1.45],
      /** Extra top speed (m/s) per tier while the boost runs. */
      tierSpeed: [4.5, 6.8, 8.5],
      /** Grip multiplier while drifting. 0.80 costs ~a fifth of corner speed,
       *  which is the point: a free drift button makes holding it the optimal
       *  line forever. */
      gripMultiplier: 0.80,
      /** Yaw the slide adds, rad/s at full commitment. */
      yawAssist: 1.5,
      /** Below this speed the drift auto-cancels. */
      cancelSpeed: 5.5,
    },

    /** Airtime. */
    air: {
      /** Rotation authority in the air, rad/s². */
      pitchControl: 2.6,
      rollControl: 3.2,
      yawControl: 1.9,
      /** Grace after leaving the ground during which drift can still start. */
      coyoteTime: 0.12,
      /** Landing flatter than this (dot of kart-up and surface normal) gets the
       *  bonus; below cosSideways it is punished. */
      cosFlat: 0.985,
      cosSideways: 0.86,
      landingBonusBoost: 0.35,
      /** Fraction of speed kept on a bad landing. */
      landingBadSpeedKeep: 0.72,
      /** A flick while airborne earns this. Minimum airtime stops it being
       *  spammable off kerbs. */
      trickMinAirtime: 0.45,
      trickBoost: 0.45,
      trickInputWindow: 0.35,
    },

    /** Boost. */
    boost: {
      /** Extra drive force while boosting. */
      force: 4200,
      /** Boost strip re-trigger interval so a long strip keeps topping up. */
      stripBoostTime: 0.85,
      stripSpeed: 6.0,
      itemBoostTime: 1.35,
      itemBoostSpeed: 8.5,
    },

    /** Spin-out from an item or a heavy hit. Never longer than 1.5 s: past that
     *  the player has stopped playing and started watching (brief §5). */
    spinOut: {
      duration: 1.35,
      /** Fraction of speed kept. */
      speedKeep: 0.28,
      spinRate: 11.0,
      /** Invulnerability after recovering, so you are not chain-hit. */
      invulnerability: 1.2,
    },

    /** Collision. */
    collision: {
      /** Collision radius. Slightly under half the kart length so two karts can
       *  sit side by side on a 9 m road without permanent contact. */
      radius: 0.82,
      /** Restitution against walls. Low: a bouncy wall throws you across the
       *  road and feels arbitrary. */
      wallRestitution: 0.18,
      /** Fraction of tangential speed kept when grazing a wall. High, because
       *  naive response cancels velocity into the wall and glues the kart to it
       *  (bug class 2). */
      wallTangentKeep: 0.94,
      /** Metres of separation pushed out per step when overlapping. Without
       *  this a kart resting on a wall re-collides every step and sticks. */
      separation: 0.02,
      /** Kart-to-kart bump impulse, N·s at equal mass. */
      kartImpulse: 900,
      /** Speed difference (m/s) above which a hit spins the lighter kart. */
      spinThreshold: 7.5,
    },

    /** Off-track recovery. */
    respawn: {
      /** Seconds fully off the corridor before recovery triggers. Long enough
       *  that a wide kerb-hopping line is never punished. */
      graceSeconds: 1.6,
      /** Fraction of speed restored, and never above this. */
      speedKeep: 0.45,
      maxSpeed: 12.0,
      /** Metres above the surface to place the kart. */
      lift: 0.5,
      invulnerability: 1.5,
    },
  },

  /** Per-surface handling. The speed difference has to be felt inside half a
   *  second or players never learn where the track's edges are (brief §4). */
  surfaces: {
    road: { gripScale: 1.0, dragScale: 1.0, rollScale: 1.0, rumble: 0.02 },
    /** Fast but unsettles the suspension — that is the trade. */
    kerb: { gripScale: 0.94, dragScale: 1.0, rollScale: 1.3, rumble: 0.55 },
    grass: { gripScale: 0.58, dragScale: 1.0, rollScale: 7.5, rumble: 0.30 },
    sand: { gripScale: 0.44, dragScale: 1.0, rollScale: 15.0, rumble: 0.42 },
    boost: { gripScale: 1.0, dragScale: 1.0, rollScale: 1.0, rumble: 0.05 },
    void: { gripScale: 0.5, dragScale: 1.0, rollScale: 9.0, rumble: 0.4 },
  },

  track: {
    /** Station spacing along the centreline. 1.0 m gives a corner of radius
     *  20 m about 31 stations, enough that the swept mesh has no visible
     *  faceting at kart height. Halving it doubles vertex count for no visible
     *  gain at this camera distance. */
    stationSpacing: 1.0,
    /** Fillet entry/exit curvature ramp, metres. Curvature is blended in with a
     *  raised cosine over this distance so the AI never meets a step change in
     *  steering demand (brief §1). */
    curvatureRamp: 6.0,
    /** Verge width outside the road before the wall. */
    vergeWidth: 3.2,
    wallHeight: 1.15,
    wallThickness: 0.45,
    kerbWidth: 0.85,
    kerbHeight: 0.075,
    tunnelHeight: 5.0,
    /** Grid spacing behind the start line. */
    gridRowSpacing: 3.4,
    gridLaneOffset: 2.1,
  },

  camera: {
    /** Chase camera. Distance and height measured against a 1.9 m kart so the
     *  kart occupies ~18% of frame height, which leaves the corner visible. */
    distance: 6.2,
    height: 2.65,
    lookAhead: 7.0,
    /** Position smoothing, 1/s. */
    followRate: 7.5,
    lookRate: 11.0,
    fovBase: 62,
    /** FOV added at top speed and again on boost. Selling speed, brief §4. */
    fovSpeedGain: 9,
    fovBoostKick: 7,
    fovRate: 4.0,
    /** Fraction of the track's bank the camera rolls. Banked track + rolling
     *  camera + FOV kick is how you make people ill (bug class 12), so the
     *  camera takes a third of the roll and the option below zeroes it. */
    rollFraction: 0.34,
    rollRate: 4.5,
    shakeDecay: 5.5,
    /** Multiplier applied to roll, shake and FOV kick when the player turns on
     *  "reduce camera motion". */
    reducedMotionScale: 0.15,
  },

  race: {
    countdownSeconds: 3.2,
    /** Perfect-start window before GO, in seconds, and what it grants. */
    perfectStartWindow: 0.18,
    perfectStartBoost: 0.9,
    /** Points for finishing positions, index 0 = 1st. */
    cupPoints: [15, 12, 10, 8, 6, 4, 2, 1],
    kartCount: 8,
  },

  items: {
    /** One slot only, so holding a shield is a real trade (brief §5). */
    slots: 1,
    /** Seconds a box takes to come back after being taken. */
    boxRespawn: 4.0,
    /** How long the roulette spins before settling. */
    rouletteSeconds: 0.9,
    /** Seconds of warning before a homing item lands, so it can be dodged or
     *  blocked. Without this the item is a tax rather than a threat. */
    homingWarning: 1.1,
    projectileSpeed: 34.0,
    homingSpeed: 30.0,
    homingTurnRate: 2.6,
    projectileLife: 6.0,
    trapLife: 45.0,
    slickLife: 12.0,
    slickRadius: 2.6,
    slickGrip: 0.42,
    shieldOrbitRadius: 1.5,
    shieldOrbitRate: 3.0,
    fieldSlowFactor: 0.72,
    fieldDuration: 2.4,
    ghostDuration: 4.5,
    ghostSpeedBonus: 3.5,
  },

  ai: {
    /** Look-ahead distance is speed-scaled: at 20 m/s the AI aims ~24 m ahead.
     *  Too short and it saws at the wheel; too long and it cuts corners. */
    lookAheadBase: 6.0,
    lookAheadPerSpeed: 0.9,
    /** Lateral metres the AI is allowed to deviate from the racing line to
     *  overtake or avoid. */
    lineDeviation: 2.8,
    /** Longitudinal deceleration used to back-propagate the speed profile. */
    brakingDecel: 11.0,
    /** Fraction of the ideal profile a skill-1.0 driver attempts. Below 1 so
     *  the best AI is still beatable by a clean human lap. */
    skillSpeedCeiling: 0.985,
    skillSpeedFloor: 0.86,
    /** Seconds a deliberate mistake lasts. */
    mistakeDuration: 1.1,
    /** How far ahead the AI looks for a kart to avoid. */
    avoidLookAhead: 12.0,
  },

  render: {
    /** Cel ramp resolution for the *standard* ramp. 4 bands: any more and it
     *  reads as a gradient, which defeats the point. NearestFilter, or the ramp
     *  interpolates and you get soft edges back. The soft ramp (terrain) runs
     *  one band under this and the crisp ramp (karts, items) one over — see
     *  `celmaterial.ts`, `RAMP_ROWS`. */
    celBands: 4,
    /** Outline thickness in *screen pixels*, held constant with distance by
     *  scaling the hull expansion by view depth (brief §M3). */
    outlinePixels: 2.4,
    /** Sobel edge strengths for the three G-buffer channels. Depth is the
     *  silhouette channel and carries full weight; normal and id are *interior*
     *  lines and are deliberately lighter, because a cel drawing that inks a
     *  crease as hard as an outline reads as a wireframe. */
    edgeDepthStrength: 1.0,
    edgeNormalStrength: 0.62,
    edgeIdStrength: 0.88,
    /** Relative depth threshold (Δd/d). Absolute depth comparison scribbles in
     *  the foreground and vanishes in the distance — this is bug class from
     *  M3 and the reason the comparison is relative. */
    edgeDepthThreshold: 0.028,
    edgeNormalThreshold: 0.42,
    /** Metres over which interior lines (crease + id) fade out. Silhouettes
     *  keep their weight until the far fade at 90–180 m. Measured against the
     *  Copper Flats back straight: past ~55 m a kerb's own creases were still
     *  being inked and the middle distance turned into a mat of hatching. */
    edgeInteriorNear: 20,
    edgeInteriorFar: 58,
    /** Metres over which the ink colour drifts from the theme's ink toward a
     *  darkened fog tint. Without it the distant tree line renders as a row of
     *  black cut-outs pasted on the sky. */
    edgeInkFadeNear: 34,
    edgeInkFadeFar: 150,
    /** Screen-space AO over the G-buffer. Radius in metres; 0.9 m is about a
     *  wheel diameter, which is the contact scale we want darkened. Strength
     *  above ~0.5 turns every kerb into a black gutter. */
    aoRadius: 0.9,
    aoStrength: 0.38,
    /** AO is quantised to this many levels so contact darkening still reads as
     *  drawn shading rather than as a soft render artefact. */
    aoLevels: 3,
    /** Speed at which screen streaks reach full opacity. */
    streakFullSpeed: 26,
    shadowMapSize: 1024,

    /** Tone map and grade, applied once at the end of the composite, before the
     *  single linear→sRGB conversion. Values measured against the Copper Flats
     *  grid shot: at exposure 1.0 with no shoulder the whole frame sat in the
     *  middle third of the range and read as washed-out. */
    exposure: 1.16,
    /** Reinhard white point. Chosen over an ACES fit because ACES crushes the
     *  darkest cel band down into the ink colour, and the bands are the look. */
    whitePoint: 2.6,
    saturation: 1.14,
    /** Split tone: shadows cooled, highlights warmed, both gently. Anything
     *  stronger and the ink stops matching the theme's ink colour, which is
     *  what `analyseEdges()` keys off. */
    shadowTint: [0.95, 0.98, 1.08] as [number, number, number],
    highlightTint: [1.05, 1.005, 0.95] as [number, number, number],

    /** Contact shadow blob under each kart. Multiplied into the beauty buffer,
     *  not drawn as a grey disc: a grey disc over a dark road reads as a stain
     *  that is *lighter* than the surface it is supposed to be darkening. */
    shadowDarkness: 0.46,
    /** How far the blob is allowed to stretch along the sun's ground direction.
     *  A low sun makes a long shadow; capped because a 6 m smear from a 15°
     *  sun stops reading as belonging to the kart. */
    shadowMaxStretch: 2.1,

    /** Particle pool sizes are per *tier* (structure, resolved once at load —
     *  ARCHITECTURE.md §8); these are the per-effect rates. */
    particleGravity: -9.0,
    /** Sparks per second per sliding rear wheel at drift tier 3. */
    sparkRate: 90,
    /** Dust puffs per second per wheel on a loose surface at full slip. */
    dustRate: 34,
    /** Boost flame puffs per second while a boost is running. */
    boostRate: 70,
  },

  quality: {
    /** Adaptive resolution floor. NOT 0.5: on a DPR 2.6 panel that renders a
     *  fifth of the linear resolution and looks terrible while doing exactly
     *  what it was told (brief §7). Cost comes down to meet the floor instead. */
    scaleFloor: 0.85,
    scaleCeiling: 1.0,
    /** Adaptive controller step and how long it waits before reacting. */
    scaleStep: 0.05,
    adaptWindowSeconds: 1.0,
    /** Device pixel ratio is clamped: past 2 the gain is invisible and the
     *  fill cost is quadratic. */
    maxDevicePixelRatio: 2.0,
  },

  audio: {
    masterGain: 0.55,
    engineMinHz: 58,
    engineMaxHz: 232,
    /** Engine harmonic mix — a single oscillator sounds like a hum, not a kart. */
    engineHarmonics: [1, 2, 3, 4.5],
    engineHarmonicGains: [1.0, 0.55, 0.3, 0.14],
  },
} as const;

export type Config = typeof CONFIG;
