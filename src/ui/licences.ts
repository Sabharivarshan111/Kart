/**
 * Open-source notices, as data.
 *
 * **This file is a legal obligation, not decoration.** Three.js is MIT, and the
 * MIT licence requires that its copyright notice and permission notice ship
 * "in all copies or substantial portions of the Software". Sparkdrift builds to
 * a single self-contained HTML file with three.js compiled into it, so the only
 * place that notice can live is inside the game itself.
 *
 * Two consequences, both deliberate:
 *
 *  - **The full text is here, verbatim, not a link.** The game is designed to
 *    play from `file://` with no network at all. A link is not a notice if it
 *    cannot be opened.
 *  - **The text is copied character-for-character** from each package's own
 *    LICENSE file at the version we build against, checked at the version in
 *    `package.json`. Paraphrasing a licence is not shipping it.
 *
 * When a dependency is added, removed or upgraded, this file is part of the
 * change. `shipped: true` means the code is inside the bundle a player runs;
 * anything false is a build-time tool whose code is not distributed.
 */

export interface LicenceEntry {
  /** Package or project name as it appears in `package.json`. */
  name: string;
  /** Version we build against. */
  version: string;
  /** SPDX identifier. */
  spdx: string;
  /** One line saying what it does here. */
  role: string;
  /** True when this package's code is compiled into the shipped bundle. */
  shipped: boolean;
  /** The licence text, verbatim. Empty only for entries that are not shipped
   *  and are listed for transparency. */
  text: string;
}

/** three.js r185 — node_modules/three/LICENSE, copied verbatim. */
const THREE_MIT = `The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

/** This repository's own LICENCE file, copied verbatim. */
const SPARKDRIFT_MIT = `MIT License

Copyright (c) 2026 Sparkdrift contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * Everything whose code is compiled into the shipped bundle, first, followed by
 * the build-time tools listed for transparency.
 *
 * three.js declares no runtime dependencies of its own (verified against
 * `node_modules/three/package.json`), so this list is complete rather than the
 * top of a tree.
 */
export const LICENCES: LicenceEntry[] = [
  {
    name: 'Sparkdrift',
    version: '0.1.0',
    spdx: 'MIT',
    role: 'This game. Every mesh, texture and sound in it is generated in code.',
    shipped: true,
    text: SPARKDRIFT_MIT,
  },
  {
    name: 'three.js',
    version: '0.185.1',
    spdx: 'MIT',
    role: 'WebGL2 renderer, scene graph and maths. The only third-party code in the bundle.',
    shipped: true,
    text: THREE_MIT,
  },
];

/**
 * Tools used to build the game whose code is **not** in the bundle. Listed
 * because saying so is more honest than a list that silently omits them, and
 * because the claim "three.js is the only third-party code that ships" needs
 * the counterpart list to be checkable.
 */
export const BUILD_TOOLS: { name: string; version: string; spdx: string }[] = [
  { name: 'vite', version: '8.2.x', spdx: 'MIT' },
  { name: 'vite-plugin-singlefile', version: '2.3.x', spdx: 'MIT' },
  { name: 'typescript', version: '5.9.x', spdx: 'Apache-2.0' },
  { name: '@playwright/test', version: '1.62.x', spdx: 'Apache-2.0' },
  { name: '@types/three', version: '0.185.x', spdx: 'MIT' },
  { name: '@types/node', version: '26.1.x', spdx: 'MIT' },
];
