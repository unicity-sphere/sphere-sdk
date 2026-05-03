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

  // ===========================================================================
  // Issue #167 — conservative-mode NFT cascade MUST NOT be silent
  // ===========================================================================
  //
  // Historic bug: the cascade walker silently dropped cascade-failed events
  // for outbox entries with `mode !== 'instant'`. For NFTs that meant a
  // sender who shipped a one-of-a-kind token in conservative mode and saw
  // it cascade had NO signal — the `cascaded: 0, nftNotified: 0` return
  // value was indistinguishable from "no outstanding shipments." This
  // regression-pins the new behaviour: emit the event with a discriminator
  // (`mode: 'conservative' | 'txf'`, `silent: true`) so the UI can render
  // an irrecoverable hard-error notification.

  it('issue #167: conservative-mode NFT cascade emits cascade-failed with silent:true discriminator', async () => {
    const NFT = 'nft-conservative';
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
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-conservative',
        tokenIds: [NFT],
        recipientTransportPubkey: 'alice',
        mode: 'conservative',
        // status is non-terminal — emission must not be filtered.
        status: 'delivered',
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

    // The cascade-failed event MUST fire, with the silent discriminator.
    expect(result.nftNotified).toBe(1);
    expect(result.silentNotified).toBe(1);

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);

    const data = cascadeEvents[0]!.data as {
      readonly outboxId: string;
      readonly tokenId: string;
      readonly mode?: string;
      readonly silent?: boolean;
      readonly recipientTransportPubkey: string;
    };
    expect(data.outboxId).toBe('ob-conservative');
    expect(data.tokenId).toBe(NFT);
    expect(data.mode).toBe('conservative');
    expect(data.silent).toBe(true);
    expect(data.recipientTransportPubkey).toBe('alice');
  });

  it('issue #167: txf-mode NFT cascade also emits silent discriminator', async () => {
    const NFT = 'nft-txf';
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
      makeOutboxEntry({
        id: 'ob-txf',
        tokenIds: [NFT],
        mode: 'txf',
        status: 'delivered',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'belief-divergence');

    expect(result.nftNotified).toBe(1);
    expect(result.silentNotified).toBe(1);

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);
    const data = cascadeEvents[0]!.data as {
      readonly mode?: string;
      readonly silent?: boolean;
    };
    expect(data.mode).toBe('txf');
    expect(data.silent).toBe(true);
  });

  it('issue #167: instant-mode NFT cascade carries mode:instant WITHOUT the silent flag', async () => {
    const NFT = 'nft-instant';
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
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-instant',
        tokenIds: [NFT],
        mode: 'instant',
        status: 'delivered-instant',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'oracle-rejected');

    expect(result.nftNotified).toBe(1);
    expect(result.silentNotified).toBe(0); // instant is NOT silent

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);
    const data = cascadeEvents[0]!.data as {
      readonly mode?: string;
      readonly silent?: boolean;
    };
    expect(data.mode).toBe('instant');
    // silent is OMITTED for instant mode (treated as false).
    expect(data.silent).toBeUndefined();
  });

  it('issue #167: mixed instant + conservative NFT outbox emits both, silentNotified counts only the silent ones', async () => {
    const NFT = 'nft-mixed';
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
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-i1',
        tokenIds: [NFT],
        mode: 'instant',
        status: 'delivered-instant',
      }),
      makeOutboxEntry({
        id: 'ob-c1',
        tokenIds: [NFT],
        mode: 'conservative',
        status: 'delivered',
      }),
      makeOutboxEntry({
        id: 'ob-c2',
        tokenIds: [NFT],
        mode: 'conservative',
        status: 'failed-transient',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'oracle-rejected');

    expect(result.nftNotified).toBe(3);
    expect(result.silentNotified).toBe(2);

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(3);

    const silents = cascadeEvents.filter((e) => {
      const d = e.data as { readonly silent?: boolean };
      return d.silent === true;
    });
    expect(silents).toHaveLength(2);
  });

  it('issue #167: finalized / expired entries are STILL filtered out regardless of mode', async () => {
    // The finalized / expired filter is the ONLY status-based filter
    // that survives — those entries are hard-terminal and the
    // recipient already has a clean proof or the entry is GC'd. The
    // mode filter (issue #167) is removed; the status filter stays.
    const NFT = 'nft-status-filter';
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
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-finalized',
        tokenIds: [NFT],
        mode: 'conservative',
        status: 'finalized',
      }),
      makeOutboxEntry({
        id: 'ob-expired',
        tokenIds: [NFT],
        mode: 'conservative',
        status: 'expired',
      }),
      makeOutboxEntry({
        id: 'ob-active',
        tokenIds: [NFT],
        mode: 'conservative',
        status: 'delivered',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'oracle-rejected');

    // Only the non-terminal active entry is notified.
    expect(result.nftNotified).toBe(1);
    expect(result.silentNotified).toBe(1);

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);
    expect(
      (cascadeEvents[0]!.data as { readonly outboxId: string }).outboxId,
    ).toBe('ob-active');
  });
});
