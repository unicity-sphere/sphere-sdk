// Shared tsup build configuration (sphere-sdk#548).
//
// Single source of truth for the per-entry tsup configs, consumed by BOTH
// `tsup.config.ts` (for `tsup --watch` dev use — parallel is fine locally) and
// `scripts/build.mjs` (the publish/CI build, which runs these SEQUENTIALLY).
//
// Why split this out: tsup runs an array of configs under `Promise.all`
// (parallel), and with this many `dts: true` entries the concurrent declaration
// passes intermittently drop an output (notably `dist/token-engine/index.d.ts`)
// ~50% of the time — there is no sequential option in tsup 8.x (egoist/tsup#577,
// #670, #1270; vercel/ai#10662). `scripts/build.mjs` imports these and builds
// them one at a time via the programmatic API, which removes the race while
// preserving every per-entry option here byte-for-byte. Plain ESM (no
// TypeScript) so Node can import it directly from the build script.

/** @type {import('tsup').Options[]} */
export const configs = [
  // Main entry - universal (works in browser with bundler, and Node.js)
  {
    entry: { 'index': 'index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'ws',
    ],
  },
  // Core only — for Node.js projects
  {
    entry: { 'core/index': 'core/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'ws',
    ],
  },
  // Token-engine (incl. the SpherePaymentData codec) — for server-side
  // consumers (wallet-api validation) that must not pull browser/Nostr
  {
    entry: { 'token-engine/index': 'token-engine/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'ws',
    ],
  },
  // payments-v2 vertical (docs/PAYMENTS-V2-DESIGN.md) — platform-neutral
  {
    entry: { 'modules/payments-v2/index': 'modules/payments-v2/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'ws',
    ],
  },
  // wallet-api-v2 session/client/ports (payments-v2 impl) — platform-neutral (fetch/WS injected)
  {
    entry: { 'impl/wallet-api-v2/index': 'impl/wallet-api-v2/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'ws',
    ],
  },
  // Browser implementation
  {
    entry: { 'impl/browser/index': 'impl/browser/index.ts' },
    format: ['esm', 'cjs'],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'browser',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
    ],
  },
  // Shared wallet-api providers (S4 composition presets) — platform-neutral,
  // consumed by the Sphere frontend; ships dts (unlike impl/browser, whose
  // missing types forced a consumer-side shim — sphere-sdk#511).
  {
    entry: { 'impl/shared/wallet-api/index': 'impl/shared/wallet-api/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'browser',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
    ],
  },
  // Node.js implementation
  {
    entry: { 'impl/nodejs/index': 'impl/nodejs/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      /^@unicitylabs\//,
      'ws',
    ],
  },
  // Sphere Connect — ESM: ./connect, ./connect/browser and ./connect/nodejs
  // built as ONE code-split graph (was: one `splitting: false` config per
  // entry, sphere-sdk#789).
  //
  // Why: with a bundle per entry, ./connect/browser inlined its own copy of
  // ConnectClient/ConnectError (and, through the '../../../connect' barrel,
  // dead ConnectHost leftovers), so a dApp importing both ./connect and
  // ./connect/browser got two ConnectError classes and `err instanceof
  // ConnectError` was false for autoConnect errors. With splitting, a module
  // reached from several entries is emitted ONCE in dist/connect/chunks/ and
  // every entry imports it; the public entry files keep their paths.
  //
  // The two `connect/internal/*` entries are NOT package exports. They exist
  // only to give the wallet host and the NFT wire codec a chunk of their own
  // (esbuild groups code by the set of entries that reach it), so
  // dist/connect/index.js is a pure re-export file. A dApp that imports
  // ConnectClient/ERROR_CODES from ./connect then uses nothing from the host
  // chunk, and because package.json "sideEffects" does not list the Connect
  // outputs, a bundler that honours "sideEffects" (esbuild, webpack) drops
  // that file whole. Rollup/Vite already removed the host statement by
  // statement.
  //
  // `platform: 'neutral'`: the graph uses no Node built-ins and touches no
  // browser globals at module scope, so one build serves both runtimes. `ws`
  // is reached only through a dynamic import inside WebSocketTransport and
  // stays external.
  //
  // NOTE: entry files must never import each other — only non-entry chunks.
  // An entry that imported dist/connect/index.js would let a consumer's
  // vi.mock('@unicitylabs/sphere-sdk/connect') leak into autoConnect.
  {
    entry: {
      'connect/index': 'connect/index.ts',
      'connect/internal/host': 'connect/host/index.ts',
      'connect/internal/nft-wire': 'connect/nft-wire.ts',
      'impl/browser/connect/index': 'impl/browser/connect/index.ts',
      'impl/nodejs/connect/index': 'impl/nodejs/connect/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    platform: 'neutral',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
      'ws',
    ],
    esbuildOptions(options) {
      // Shared chunks live under dist/connect/, not in the dist/ root.
      options.chunkNames = 'connect/chunks/[name]-[hash]';
    },
  },
  // Sphere Connect — CJS: deliberately still one unsplit bundle per entry,
  // byte-for-byte the 0.17.2 build shape (minus the dead host code the
  // transports' barrel import used to drag in).
  //
  // Why not split these too: tsup implements CJS splitting by running every
  // emitted chunk through sucrase, which renames ConnectClient/ConnectHost and
  // the WS transports to `_class` (`.name` is part of our public surface in
  // logs and error reporting), switches class fields to assignment semantics
  // and degrades the .cjs.map files. No consumer loads the .cjs Connect files,
  // so the duplicate-class fix is shipped for ESM only and CJS keeps today's
  // behaviour. If a CJS consumer ever needs one ConnectError across entries,
  // revisit with `keepNames` plus CJS class-identity tests.
  //
  // These three also emit the .d.cts declarations package.json points at.
  {
    entry: { 'connect/index': 'connect/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'neutral',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
    ],
  },
  {
    entry: { 'impl/browser/connect/index': 'impl/browser/connect/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'browser',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
    ],
  },
  {
    entry: { 'impl/nodejs/connect/index': 'impl/nodejs/connect/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
      'ws',
    ],
  },
];
