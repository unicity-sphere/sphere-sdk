/* global console */
/**
 * Mirror every generated `.d.ts` to a `.d.cts` sibling.
 *
 * The package is dual ESM/CJS; the `require` (CJS) export conditions point at
 * `*.d.cts`. tsc emits only `*.d.ts`, so we copy the whole declaration tree to
 * `*.d.cts`. Extension-less relative imports inside a `.d.cts` resolve to sibling
 * `.d.cts` under node16/nodenext, so a plain copy of the full tree is sufficient.
 */
import { readdirSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let count = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.d.ts')) {
      copyFileSync(p, `${p.slice(0, -'.d.ts'.length)}.d.cts`);
      count++;
    }
  }
}
walk('dist');
// eslint-disable-next-line no-console
console.log(`copy-dcts: wrote ${count} .d.cts files`);
