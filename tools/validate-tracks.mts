/**
 * Offline track validator.
 *
 * Runs under plain Node with type stripping — no bundler, no browser — because
 * a geometry failure should be catchable in a second from a terminal rather
 * than after a build and a page load. This is why `contracts.ts` avoids TS
 * enums: they are not erasable syntax and Node cannot strip them.
 *
 *   node --experimental-strip-types tools/validate-tracks.mts
 *
 * Also prints the lap fraction of each authored vertex, which is what you need
 * in order to place stretches: authoring a jump against a guessed fraction is
 * how it ends up halfway round a corner.
 */
import { buildCentreline } from '../src/track/centreline.ts';
import { validateTrack, formatReport } from '../src/track/validator.ts';
import { TRACKS } from '../src/content/tracks/index.ts';
import { theme } from '../src/core/palette.ts';
import '../src/content/themes.ts';

let failures = 0;

for (const spec of TRACKS) {
  const report = validateTrack(spec, theme(spec.theme.name));
  console.log(formatReport(report));

  // Vertex → lap fraction, for authoring.
  const cl = buildCentreline(spec);
  const fractions = spec.vertices.map((v, i) => {
    let best = 0;
    let bestD = Infinity;
    for (const s of cl.stations) {
      const d = (s.x - v.x) ** 2 + (s.z - v.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s.u;
      }
    }
    return `v${i}=${(best / cl.length).toFixed(3)}`;
  });
  console.log(`  vertex lap fractions: ${fractions.join(' ')}`);
  console.log('');

  if (!report.ok) failures++;
}

if (failures) {
  console.error(`${failures} track(s) failed validation`);
  process.exit(1);
}
console.log('all tracks pass');
