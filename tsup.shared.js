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
      /^@libp2p\//,
      /^@helia\//,
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
      'helia',
      'multiformats',
      'ws',
    ],
  },
  // Core only (no browser impl with helia) - for Node.js projects
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
  // consumers (wallet-api validation) that must not pull browser/IPFS/Nostr
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
  // Wallet-api client (sdk-changes S1) — platform-independent (fetch/WS injected)
  {
    entry: { 'wallet-api/index': 'wallet-api/index.ts' },
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
  // Browser implementation (without IPFS - no helia dependency)
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
  // Browser IPFS implementation (requires helia)
  // Separate entry point so users can opt-in to IPFS functionality
  {
    entry: { 'impl/browser/ipfs': 'impl/browser/ipfs.ts' },
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
      /^@libp2p\//,
      /^@helia\//,
      'helia',
      'multiformats',
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
      /^@libp2p\//,
      /^@helia\//,
      'helia',
      'multiformats',
      'ws',
    ],
  },
  // Sphere Connect - Core (transport-agnostic)
  {
    entry: { 'connect/index': 'connect/index.ts' },
    format: ['esm', 'cjs'],
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
  // Sphere Connect - Browser transport (PostMessage)
  {
    entry: { 'impl/browser/connect/index': 'impl/browser/connect/index.ts' },
    format: ['esm', 'cjs'],
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
  // Sphere Connect - Node.js transport (WebSocket)
  {
    entry: { 'impl/nodejs/connect/index': 'impl/nodejs/connect/index.ts' },
    format: ['esm', 'cjs'],
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
