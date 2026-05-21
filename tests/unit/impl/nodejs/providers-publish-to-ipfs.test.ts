/**
 * Issue #200 Phase 1 wiring — provider-factory contract for the
 * canonical `publishToIpfs` callback.
 *
 * Pins the wiring shape so a future refactor of `createNodeProviders`
 * cannot silently drop the publisher field (which would leave production
 * `uxf-cid` delivery dormant).
 */

import { describe, it, expect } from 'vitest';
import { createNodeProviders } from '../../../../impl/nodejs';

const TOKENS_DIR = './test-data/issue-200-publish-tokens';
const DATA_DIR = './test-data/issue-200-publish-data';

describe('createNodeProviders — publishToIpfs wiring (Issue #200 Phase 1)', () => {
  it('returns undefined publishToIpfs when tokenSync.ipfs is not configured', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
    });

    expect(providers.publishToIpfs).toBeUndefined();
  });

  it('returns undefined publishToIpfs when tokenSync.ipfs.enabled is false', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: { enabled: false },
      },
    });

    expect(providers.publishToIpfs).toBeUndefined();
  });

  it('returns a publishToIpfs callback when tokenSync.ipfs.enabled is true', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: {
          enabled: true,
          config: {
            gateways: ['https://ipfs.example.test'],
          },
        },
      },
    });

    expect(providers.publishToIpfs).toBeDefined();
    expect(typeof providers.publishToIpfs).toBe('function');
  });

  it('falls back to DEFAULT_IPFS_GATEWAYS when ipfs.enabled but no gateways are passed', () => {
    // Just asserts the factory does not throw and produces a callable.
    // (The default gateway list is environment-dependent — exact URLs
    // are validated in constants.ts tests.)
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: { enabled: true },
      },
    });

    expect(providers.publishToIpfs).toBeDefined();
    expect(typeof providers.publishToIpfs).toBe('function');
  });
});
