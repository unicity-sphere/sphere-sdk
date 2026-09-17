import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Connect packaging guard (sphere-sdk#789).
 *
 * ./connect, ./connect/browser and ./connect/nodejs used to be three `splitting: false`
 * bundles. ./connect/browser then carried its own ConnectClient, so an autoConnect() error
 * was never `instanceof` the ConnectError exported by ./connect, and the transports' import
 * of the '../../../connect' barrel dragged dead ConnectHost code into the browser bundle.
 * These checks keep the build shape that fixes both.
 */

type TsupConfig = {
  entry: Record<string, string>;
  format: string[];
  dts?: boolean;
  splitting?: boolean;
};

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  main: string;
  module: string;
  sideEffects: string[];
  exports: Record<string, unknown>;
};

const CONNECT_EXPORTS = ['./connect', './connect/browser', './connect/nodejs'];

function targets(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node && typeof node === 'object') return Object.values(node).flatMap(targets);
  return [];
}

const jsTargets = (node: unknown) => targets(node).filter((t) => /\.c?js$/.test(t));
const connectTargets = CONNECT_EXPORTS.flatMap((key) => targets(pkg.exports[key]));

/** dist path (minus extension) of a Connect entry, e.g. 'impl/browser/connect/index'. */
const CONNECT_ENTRY_KEYS = [
  ...new Set(connectTargets.map((t) => t.replace(/^\.\/dist\//, '').replace(/\.(c?js|d\.c?ts)$/, ''))),
];

// The glob subset esbuild, webpack and Vite read alike: `**` crosses '/', `*` does not,
// and a pattern without '/' matches that file name in any directory.
function globToRegExp(glob: string): RegExp {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const rooted = glob.includes('/') ? glob.replace(/^\.\//, '') : `**/${glob}`;
  const body = rooted
    .split('**/')
    .map((seg) =>
      seg
        .split('**')
        .map((part) => part.split('*').map(escape).join('[^/]*'))
        .join('.*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

const hasSideEffects = (file: string) =>
  pkg.sideEffects.some((glob) => globToRegExp(glob).test(file.replace(/^\.\//, '')));

async function loadConfigs(): Promise<TsupConfig[]> {
  const { configs } = (await import(pathToFileURL(`${root}tsup.shared.js`).href)) as { configs: TsupConfig[] };
  return configs;
}

const ownersOf = (configs: TsupConfig[], format: string) =>
  configs.filter((cfg) => cfg.format.includes(format) && CONNECT_ENTRY_KEYS.some((key) => key in cfg.entry));

describe('Connect packaging', () => {
  it('transports import connect leaf modules, never the barrel that re-exports ConnectHost', () => {
    for (const dir of ['impl/browser/connect', 'impl/nodejs/connect']) {
      for (const file of readdirSync(`${root}${dir}`).filter((f) => f.endsWith('.ts'))) {
        const src = readFileSync(`${root}${dir}/${file}`, 'utf8');
        expect(src, `${dir}/${file}`).not.toMatch(/from '(\.\.\/)+connect'/);
      }
    }
  });

  it('builds every Connect ESM export in one code-split config, so ConnectClient and ConnectError exist once', async () => {
    const owners = ownersOf(await loadConfigs(), 'esm');

    expect(owners).toHaveLength(1);
    expect(owners[0].splitting).toBe(true);
    expect(Object.keys(owners[0].entry)).toEqual(expect.arrayContaining(CONNECT_ENTRY_KEYS));
    // Not package exports: they exist only to give the wallet host and the NFT wire
    // codec chunks of their own, so dist/connect/index.js is a pure re-export file.
    expect(Object.keys(owners[0].entry)).toEqual(
      expect.arrayContaining(['connect/internal/host', 'connect/internal/nft-wire']),
    );
  });

  it('keeps the Connect CJS output unsplit, one bundle per entry (no sucrase chunk pass)', async () => {
    const owners = ownersOf(await loadConfigs(), 'cjs');

    // tsup implements CJS splitting by rewriting every chunk with sucrase, which renames
    // exported classes to `_class` and changes class-field semantics. Deliberately not shipped.
    expect(owners.map((cfg) => Object.keys(cfg.entry)).flat().sort()).toEqual([...CONNECT_ENTRY_KEYS].sort());
    for (const cfg of owners) {
      expect(Object.keys(cfg.entry)).toHaveLength(1);
      expect(cfg.splitting ?? false).toBe(false);
      expect(cfg.format).toEqual(['cjs']);
      // These configs emit the .d.cts files package.json "require" conditions point at.
      expect(cfg.dts).toBe(true);
    }
  });

  it('emits every file the Connect exports name, at the path they name', async () => {
    const configs = await loadConfigs();
    // A moved .d.ts silently degrades consumers: under moduleResolution node it is TS2307,
    // and if only the declaration moves TypeScript binds the stale path to the sibling .js.
    const emitted = new Set(
      configs.flatMap((cfg) =>
        Object.keys(cfg.entry).flatMap((key) =>
          cfg.format.flatMap((fmt) => {
            const ext = fmt === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.js', dts: '.d.ts' };
            return [`./dist/${key}${ext.js}`, ...(cfg.dts ? [`./dist/${key}${ext.dts}`] : [])];
          }),
        ),
      ),
    );
    for (const target of connectTargets) expect(emitted, target).toContain(target);
  });

  it('sideEffects lists every non-Connect bundle and no Connect output', () => {
    for (const [key, node] of Object.entries(pkg.exports)) {
      for (const target of jsTargets(node)) {
        expect(hasSideEffects(target), `${key} -> ${target}`).toBe(!CONNECT_EXPORTS.includes(key));
      }
    }
    for (const file of [pkg.main, pkg.module]) {
      expect(hasSideEffects(file), file).toBe(true);
    }
    for (const file of ['dist/connect/chunks/chunk-ABCD1234.js', 'dist/connect/internal/host.js']) {
      expect(hasSideEffects(file), file).toBe(false);
    }
  });

  it('sideEffects keeps every TypeScript source file side-effectful, so the SDK build itself is unchanged', () => {
    // esbuild applies this field to the package's own sources while tsup bundles them; a
    // dist-only list let it drop re-exported token-engine modules from impl/wallet-api-v2.
    for (const file of ['index.ts', 'constants.ts', 'token-engine/sdk.ts', 'connect/host/ConnectHost.ts']) {
      expect(hasSideEffects(file), file).toBe(true);
    }
  });
});
