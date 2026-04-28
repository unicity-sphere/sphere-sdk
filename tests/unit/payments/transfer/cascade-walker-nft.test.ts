/**
 * UXF Transfer T.5.B.5 — NFT-class cascade (§6.1.1).
 *
 * NFTs are NEVER split (TokenSplitBuilder rejects empty-coinData inputs)
 * — there are no `splitParent` children to walk. The walker examines
 * outbox entries that shipped this NFT in instant mode and emits
 * `transfer:cascade-failed` per (recipient-pubkey, tokenId).
 *
 * Acceptance:
 *  - NFT parent → no `splitParent` walk; outbox-driven notification only.
 *  - Outbox entries with this NFT in instant mode → cascade-failed event.
 *  - No manifest writes are performed against children (there are none).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeFakeOutboxScanner,
  makeManifestEntry,
  makeOutboxEntry,
} from './cascade-walker-fixtures';

describe('§6.1.1 cascade — NFT-class outbox-driven notification', () => {
  it('NFT parent triggers outbox notification with NO splitParent walk', async () => {
    const NFT = 'nft-token-1';

    // Storage contains the NFT itself (already invalid) AND a coin
    // child whose splitParent points at the NFT — this child WOULD be
    // walked if the NFT path mistakenly used the coin walker. The NFT
    // path MUST ignore splitParent entirely.
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: NFT,
        entry: makeManifestEntry({
          rootHashHex: 'aa'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: 'leaked-child',
        entry: makeManifestEntry({
          rootHashHex: 'bb'.repeat(32),
          status: 'valid',
          splitParent: NFT, // SHOULD NOT be cascaded by NFT path.
        }),
      },
    ]);

    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-1',
        tokenIds: [NFT],
        recipientTransportPubkey: 'alice',
        bundleCid: 'cid-1',
      }),
      makeOutboxEntry({
        id: 'ob-2',
        tokenIds: [NFT],
        recipientTransportPubkey: 'bob',
        bundleCid: 'cid-2',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      NFT,
      'oracle-rejected',
    );

    expect(result.cascaded).toBe(0); // NFT path doesn't cascade-write children
    expect(result.nftNotified).toBe(2);
    expect(result.outboxNotified).toBe(0); // coin-path counter

    // Critical: the leaked-child's status must NOT have been changed.
    const leakedEntry = await storage.readEntry(ADDR, 'leaked-child');
    expect(leakedEntry?.status).toBe('valid');
    expect(leakedEntry?.invalidReason).toBeUndefined();

    // Both outbox entries get cascade-failed events.
    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(2);
    const recipients = cascadeEvents
      .map(
        (e) =>
          (e.data as { recipientTransportPubkey: string })
            .recipientTransportPubkey,
      )
      .sort();
    expect(recipients).toEqual(['alice', 'bob']);
  });

  it('NFT cascade with no outbox entries → no events emitted', async () => {
    const NFT = 'nft-orphan';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: NFT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      NFT,
      'oracle-rejected',
    );

    expect(result.nftNotified).toBe(0);
    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(0);
  });

  it('NFT cascade carries the failing reason on the emitted event', async () => {
    const NFT = 'nft-1';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: NFT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'belief-divergence',
        }),
      },
    ]);
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({ id: 'ob', tokenIds: [NFT] }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    await harness.walker.cascade(ADDR, NFT, 'belief-divergence');

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);
    const data = cascadeEvents[0]!.data as {
      readonly tokenId: string;
      readonly reason: string;
    };
    expect(data.tokenId).toBe(NFT);
    expect(data.reason).toBe('belief-divergence');
  });
});
