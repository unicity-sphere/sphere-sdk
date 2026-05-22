/**
 * Issue #223 — provider-factory contract for `cidFetchGateways`.
 *
 * Pins the wiring shape so a future refactor of `createNodeProviders`
 * cannot silently drop the recipient-side gateway list. Without it, the
 * auto-installed {@link IngestWorkerPool} would receive `cidOptions =
 * undefined` and every `kind: 'uxf-cid'` event would fall through
 * `acquireBundle`'s `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED` reject
 * branch — silently dropping the transfer (the production-visible
 * symptom of #223 root cause #1).
 *
 * Mirrors `providers-publish-to-ipfs.test.ts` (Issue #200) by intent: the
 * publisher and the fetcher MUST be driven by the SAME gateway list —
 * otherwise the sender pins to one IPFS network while the receiver looks
 * for blocks on another.
 */

import { describe, it, expect } from 'vitest';
import { createNodeProviders } from '../../../../impl/nodejs';
import { DEFAULT_IPFS_GATEWAYS } from '../../../../constants';

const TOKENS_DIR = './test-data/issue-223-cid-gateways-tokens';
const DATA_DIR = './test-data/issue-223-cid-gateways-data';

describe('createNodeProviders — cidFetchGateways wiring (Issue #223)', () => {
  it('returns undefined cidFetchGateways when tokenSync.ipfs is not configured', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
    });

    expect(providers.cidFetchGateways).toBeUndefined();
    expect(providers.publishToIpfs).toBeUndefined();
  });

  it('returns undefined cidFetchGateways when tokenSync.ipfs.enabled is false', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: { enabled: false },
      },
    });

    expect(providers.cidFetchGateways).toBeUndefined();
    expect(providers.publishToIpfs).toBeUndefined();
  });

  it('returns the explicit gateway list when tokenSync.ipfs.enabled is true with custom gateways', () => {
    const explicitGateways = [
      'https://ipfs.example.test',
      'https://backup.example.test',
    ];
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: {
          enabled: true,
          config: {
            gateways: explicitGateways,
          },
        },
      },
    });

    expect(providers.cidFetchGateways).toEqual(explicitGateways);
    // Same list as the publisher consumes — invariant the producer
    // and consumer MUST share so they target the same network.
    expect(providers.publishToIpfs).toBeDefined();
  });

  it('falls back to DEFAULT_IPFS_GATEWAYS when ipfs.enabled but no gateways are passed', () => {
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: DATA_DIR,
      tokensDir: TOKENS_DIR,
      tokenSync: {
        ipfs: { enabled: true },
      },
    });

    expect(providers.cidFetchGateways).toEqual([...DEFAULT_IPFS_GATEWAYS]);
  });
});
