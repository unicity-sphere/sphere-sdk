// Deterministic library build (sphere-sdk#548).
//
// tsup runs an array of configs under `Promise.all` (parallel) and offers no
// sequential mode (egoist/tsup#577). With this many `dts: true` entries the
// concurrent declaration passes intermittently fail to flush an output — most
// often `dist/token-engine/index.d.ts` — about half the time (egoist/tsup#670,
// #1270; vercel/ai#10662). That broke ~50% of publish dispatches at the
// packaging gate and cost a manual re-dispatch every release.
//
// Fix: build each entry one at a time via tsup's programmatic API. Serial
// execution removes the race entirely while preserving every per-entry option
// in tsup.shared.js byte-for-byte (same outputs, just ordered). A single
// up-front clean replaces the per-config `clean` flag so cleaning can never
// race a sibling's writes. A final assertion fails the build loudly if any
// declared artifact is still missing — defense in depth ahead of the publish
// gate, never a silent broken tarball.
//
// IMPORTANT: each build() passes `config: false`. tsup's programmatic build()
// otherwise loads tsup.config.ts from cwd and merges it UNDER the override —
// which, since that config is the 12-entry array, would re-run all 12 entries
// (concurrently) on every call and reintroduce the very race we remove. With
// `config: false` tsup uses only the options passed here: exactly one entry.

import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'tsup';

import { configs } from '../tsup.shared.js';

// Anchor every relative path (dist cleanup, entry resolution, the assertion) to
// the package root, so the build is correct regardless of the invoking cwd.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// tsup output extensions for this "type": "module" package: esm -> .js/.d.ts,
// cjs -> .cjs/.d.cts.
const FORMAT_EXT = {
  esm: { js: '.js', dts: '.d.ts' },
  cjs: { js: '.cjs', dts: '.d.cts' },
};

/** Files each config is expected to emit, derived from `cfg.format` and `cfg.dts`
 *  (not hard-coded) so the assertion stays in lockstep with the shared config:
 *  every entry key, each declared format's JS output, plus declarations for
 *  `dts: true` entries. An unmapped format fails loudly rather than silently
 *  skipping its artifacts. */
function expectedArtifacts(cfg) {
  const formats = Array.isArray(cfg.format) ? cfg.format : [cfg.format];
  return Object.keys(cfg.entry).flatMap((entryKey) => {
    const base = `dist/${entryKey}`;
    return formats.flatMap((fmt) => {
      const ext = FORMAT_EXT[fmt];
      if (!ext) throw new Error(`[build] expectedArtifacts: unmapped tsup format '${fmt}' for '${entryKey}'`);
      const files = [`${base}${ext.js}`];
      if (cfg.dts) files.push(`${base}${ext.dts}`);
      return files;
    });
  });
}

console.log(`[build] cleaning dist/ and building ${configs.length} entries sequentially`);
rmSync('dist', { recursive: true, force: true });

for (const [i, cfg] of configs.entries()) {
  const entryKeys = Object.keys(cfg.entry).join(', ');
  console.log(`[build] (${i + 1}/${configs.length}) ${entryKeys}`);
  // clean:false — cleaning is done once, above (a per-config clean under tsup's
  // parallel model can wipe a sibling's output, sphere-sdk#548).
  // config:false — do not load tsup.config.ts; build ONLY this entry (see note).
  await build({ ...cfg, clean: false, config: false });
}

const missing = configs.flatMap(expectedArtifacts).filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(
    `[build] FAILED — ${missing.length} expected artifact(s) missing after build:\n` +
      missing.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

console.log('[build] all entries built; declared artifacts present');
