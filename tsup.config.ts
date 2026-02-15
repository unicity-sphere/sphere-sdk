import { defineConfig } from 'tsup';

export default defineConfig([
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
  // L1 module (for direct crypto operations)
  {
    entry: { 'l1/index': 'l1/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    target: 'es2022',
    noExternal: [/^@noble\//],
    external: [
      'bip39',
      'buffer',
      'crypto-js',
      'elliptic',
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
]);
