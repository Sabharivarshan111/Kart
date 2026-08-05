/**
 * Generates the live progress page from docs/progress.json plus whatever
 * frames are currently in shots/.
 *
 * Run it after every wave:  node tools/progress.mjs
 *
 * The screenshots are inlined as data URIs rather than linked, for the same
 * reason the game itself is one file: the page has to work wherever it is
 * opened, with no server and no second request.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const data = JSON.parse(readFileSync(join(root, 'docs/progress.json'), 'utf8'));

/** What each named frame is evidence for. Keyed by filename stem. */
const FRAME_CLAIMS = {
  'grid': 'Eight karts on the grid, every one sitting on the road surface rather than in it.',
  'track-overview': 'The circuit closes, and its corners have measured radii rather than eyeballed ones.',
  'banking-and-kerbs': 'Banking and alternating kerbs on a corner the validator measured at 13°.',
  'cel-closeup': 'Flat cel bands with hard steps, an ink silhouette, and interior creases the hull cannot draw.',
  'drift': 'A committed drift charged to a tier, with tier-coloured sparks at the rear contact patches.',
  'jump': 'The kart leaves the ramp and its shadow separates — a 40 m flight at top speed.',
  'tunnel': 'The tunnel reads as enclosure without the interior collapsing to black.',
};

const shotsDir = join(root, 'shots');
const frames = existsSync(shotsDir)
  ? readdirSync(shotsDir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => ({
        name: f.replace(/\.png$/, ''),
        claim: FRAME_CLAIMS[f.replace(/\.png$/, '')] ?? 'Captured frame.',
        uri: `data:image/png;base64,${readFileSync(join(shotsDir, f)).toString('base64')}`,
      }))
  : [];

const stamp = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date());

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const STATUS = {
  done: { label: 'landed', tone: 'good' },
  running: { label: 'in build', tone: 'live' },
  queued: { label: 'queued', tone: 'idle' },
  blocked: { label: 'blocked', tone: 'warn' },
};

const pieceCards = data.pieces
  .map((p) => {
    const s = STATUS[p.status] ?? STATUS.queued;
    return `
      <article class="piece" data-tone="${s.tone}">
        <div class="piece-head">
          <span class="piece-id">${esc(p.id)}</span>
          <span class="chip chip-${s.tone}">${esc(s.label)}</span>
        </div>
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.note)}</p>
      </article>`;
  })
  .join('');

const foundationRows = data.foundation
  .map(
    (f) => `
      <div class="row">
        <div class="row-name">${esc(f.name)}</div>
        <div class="row-note">${esc(f.note)}</div>
      </div>`,
  )
  .join('');

const frameCards = frames
  .map(
    (f) => `
      <figure class="frame">
        <img src="${f.uri}" alt="${esc(f.claim)}" loading="lazy" />
        <figcaption><span class="frame-name">${esc(f.name)}</span>${esc(f.claim)}</figcaption>
      </figure>`,
  )
  .join('');

const fixedItems = data.fixed.map((f) => `<li>${esc(f)}</li>`).join('');
const caveatItems = data.caveats.map((c) => `<li>${esc(c)}</li>`).join('');

const bugPct = Math.round((data.build.bugClassPassing / data.build.bugClassTotal) * 100);

const html = `<style>
  /* Palette: a pit-wall timing board. Neutrals carry a blue bias toward the
     amber accent's complement, so the greys read as chosen rather than default. */
  :root {
    --ground: #0d1117;
    --surface: #151b25;
    --surface-2: #1b2331;
    --line: #26303f;
    --ink: #e9edf5;
    --dim: #8592a6;
    --accent: #ffb13d;
    --good: #43d98c;
    --live: #3da5ff;
    --warn: #ff6e5c;
    --idle: #5c6980;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --ground: #f2f4f7;
      --surface: #ffffff;
      --surface-2: #f7f9fb;
      --line: #dde3ec;
      --ink: #131922;
      --dim: #5d6a7d;
      --accent: #b06f00;
      --good: #1a8f56;
      --live: #1668bd;
      --warn: #b8341f;
      --idle: #8794a6;
    }
  }
  :root[data-theme="light"] {
    --ground: #f2f4f7; --surface: #ffffff; --surface-2: #f7f9fb; --line: #dde3ec;
    --ink: #131922; --dim: #5d6a7d; --accent: #b06f00; --good: #1a8f56;
    --live: #1668bd; --warn: #b8341f; --idle: #8794a6;
  }
  :root[data-theme="dark"] {
    --ground: #0d1117; --surface: #151b25; --surface-2: #1b2331; --line: #26303f;
    --ink: #e9edf5; --dim: #8592a6; --accent: #ffb13d; --good: #43d98c;
    --live: #3da5ff; --warn: #ff6e5c; --idle: #5c6980;
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 72px; }

  /* --- header ------------------------------------------------------------ */
  header { border-bottom: 2px solid var(--line); padding-bottom: 22px; margin-bottom: 34px; }
  .eyebrow {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--accent); margin: 0 0 10px;
  }
  h1 {
    font-size: clamp(30px, 5vw, 46px); line-height: 1.06; margin: 0 0 8px;
    letter-spacing: -0.025em; font-weight: 800; text-wrap: balance;
  }
  .sub { color: var(--dim); margin: 0 0 22px; font-size: 16px; max-width: 62ch; }

  .meters { display: flex; flex-wrap: wrap; gap: 10px; }
  .meter {
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px;
    padding: 9px 14px; min-width: 116px;
  }
  .meter-k {
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--dim); display: block; margin-bottom: 3px;
  }
  .meter-v {
    font-family: var(--mono); font-size: 19px; font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .meter-v.good { color: var(--good); }
  .meter-v.warn { color: var(--warn); }

  /* --- sections ---------------------------------------------------------- */
  section { margin-bottom: 42px; }
  h2 {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--dim); font-weight: 600;
    margin: 0 0 16px; padding-bottom: 9px; border-bottom: 1px solid var(--line);
  }

  /* --- pieces ------------------------------------------------------------ */
  .pieces { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 12px; }
  .piece {
    background: var(--surface); border: 1px solid var(--line);
    border-left: 3px solid var(--idle); border-radius: 3px; padding: 14px 16px;
  }
  .piece[data-tone="good"] { border-left-color: var(--good); }
  .piece[data-tone="live"] { border-left-color: var(--live); }
  .piece[data-tone="warn"] { border-left-color: var(--warn); }
  .piece-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
  .piece-id {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    color: var(--dim); font-weight: 600;
  }
  .piece h3 { font-size: 16px; margin: 0 0 5px; font-weight: 650; letter-spacing: -0.01em; }
  .piece p { margin: 0; font-size: 13.5px; color: var(--dim); line-height: 1.5; }
  .chip {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em;
    text-transform: uppercase; padding: 2px 7px; border-radius: 2px; font-weight: 600;
  }
  .chip-good { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
  .chip-live { background: color-mix(in srgb, var(--live) 18%, transparent); color: var(--live); }
  .chip-warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .chip-idle { background: color-mix(in srgb, var(--idle) 18%, transparent); color: var(--idle); }

  /* --- rows -------------------------------------------------------------- */
  .row { display: grid; grid-template-columns: 168px 1fr; gap: 18px; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row-name { font-family: var(--mono); font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
  .row-note { font-size: 14px; color: var(--dim); }
  @media (max-width: 620px) { .row { grid-template-columns: 1fr; gap: 4px; } }

  /* --- critic ------------------------------------------------------------ */
  .critic {
    background: var(--surface-2); border: 1px solid var(--line);
    border-left: 3px solid var(--accent); border-radius: 3px; padding: 18px 20px;
  }
  .critic p { margin: 0; font-size: 15px; }
  .critic .gap { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .gap-label {
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--accent); display: block; margin-bottom: 4px;
  }

  /* --- frames ------------------------------------------------------------ */
  .frames { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; }
  .frame { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .frame img { display: block; width: 100%; height: auto; border-bottom: 1px solid var(--line); }
  .frame figcaption { padding: 11px 14px; font-size: 12.5px; color: var(--dim); line-height: 1.5; }
  .frame-name {
    display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink); margin-bottom: 4px;
  }

  /* --- lists ------------------------------------------------------------- */
  ul.notes { margin: 0; padding-left: 20px; }
  ul.notes li { font-size: 14px; color: var(--dim); margin-bottom: 8px; line-height: 1.55; }
  ul.notes li::marker { color: var(--accent); }

  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line);
    font-family: var(--mono); font-size: 11px; color: var(--dim); letter-spacing: 0.04em;
  }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">${esc(data.waveLabel)} &nbsp;·&nbsp; ${esc(stamp)} IST</p>
    <h1>${esc(data.title)}</h1>
    <p class="sub">${esc(data.subtitle)}</p>
    <div class="meters">
      <div class="meter">
        <span class="meter-k">Typecheck</span>
        <span class="meter-v good">${esc(data.build.typecheck)}</span>
      </div>
      <div class="meter">
        <span class="meter-k">Bug classes</span>
        <span class="meter-v ${bugPct === 100 ? 'good' : 'warn'}">${data.build.bugClassPassing}/${data.build.bugClassTotal}</span>
      </div>
      <div class="meter">
        <span class="meter-k">Tracks valid</span>
        <span class="meter-v good">${data.build.tracksValidated}</span>
      </div>
      <div class="meter">
        <span class="meter-k">Single file</span>
        <span class="meter-v">${(data.build.singleFileBytes / 1024).toFixed(0)}<span style="font-size:12px;color:var(--dim)"> KB</span></span>
      </div>
      <div class="meter">
        <span class="meter-k">Frames captured</span>
        <span class="meter-v">${frames.length}</span>
      </div>
    </div>
  </header>

  <section>
    <h2>Pieces in flight</h2>
    <div class="pieces">${pieceCards}</div>
  </section>

  <section>
    <h2>Critic — round ${data.critic.round}</h2>
    <div class="critic">
      <p>${esc(data.critic.verdict)}</p>
      ${
        data.critic.biggestGap
          ? `<div class="gap"><span class="gap-label">Biggest gap</span>${esc(data.critic.biggestGap)}</div>`
          : ''
      }
    </div>
  </section>

  <section>
    <h2>Frames — evidence, not decoration</h2>
    <div class="frames">${frameCards}</div>
  </section>

  <section>
    <h2>Foundation already standing</h2>
    <div>${foundationRows}</div>
  </section>

  <section>
    <h2>Defects found by looking, not by reading</h2>
    <ul class="notes">${fixedItems}</ul>
  </section>

  <section>
    <h2>What this page is not claiming</h2>
    <ul class="notes">${caveatItems}</ul>
  </section>

  <footer>Regenerated by tools/progress.mjs · frames are real captures from the production build</footer>
</div>
`;

writeFileSync(join(root, 'docs/progress.html'), html);
console.log(
  `progress page written: ${frames.length} frames, ${(html.length / 1024 / 1024).toFixed(2)} MB`,
);
