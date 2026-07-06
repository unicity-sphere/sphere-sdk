/**
 * UXF Transfer T.5.C — recipient cascade WITH forward.
 *
 * Two sub-cases when the recipient HAS forwarded the token before
 * its parent finalized:
 *
 *  1. **Coin with forward**: the recipient split the coin via
 *     `TokenSplitBuilder` and shipped the children to a downstream
 *     recipient. Cascade walker walks `splitParent` children
 *     (transitive) AND emits `transfer:cascade-failed` for outbox
 *     entries referencing the cascaded children.
 *
 *  2. **NFT with forward**: the recipient forwarded the SAME
 *     `tokenId` to a downstream recipient (whole-token state-
 *     transition). Cascade walker emits `transfer:cascade-failed`
 *     for each outbox entry that shipped this NFT — NO splitParent
 *     walk (NFTs are not splittable).
 *
 * In BOTH sub-cases, the recipient's own copy of the failing token
 * is moved to `_invalid` via the disposition writer.
 *
 * Spec refs: §6.1.1 (cascade rules — coin/NFT class-disjoint),
 * §5.5 step 7.
 */

import { describe, expect, it } from 'vitest';

import {
  CascadeWalker,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
} from '../../../../extensions/uxf/pipeline/cascade-walker';
import { ManifestCas } from '../../../../extensions/uxf/profile/manifest-cas';
import {
  ADDR,
  PREVIOUS_CID,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeEventRecorder,
  makeFakeManifestStorage,
  makeQueueEntry,
  seedQueue,
} from './finalization-worker-recipient-fixtures';
import type { TokenManifestEntry } from '../../../../extensions/uxf/profile/token-manifest';
import type { UxfTransferOutboxEntry } from '../../../../extensions/uxf/types/uxf-outbox';

const CHILD_A = 'child-token-A';
const CHILD_B = 'child-token-B';

describe('recipient cascade — coin with forward', () => {
  it('cascade walker walks splitParent children and emits transfer:cascade-failed', async () => {
    // Build a real CascadeWalker with manifest entries for the
    // failing parent + two children that have splitParent === parent.
    const manifestEntries = new Map<string, TokenManifestEntry>([
      [
        `${ADDR}:${TOKEN_ID}`,
        { rootHash: PREVIOUS_CID, status: 'invalid', invalidReason: 'belief-divergence' },
      ],
      [
        `${ADDR}:${CHILD_A}`,
        { rootHash: 'aa'.repeat(32), status: 'valid', splitParent: TOKEN_ID } as TokenManifestEntry,
      ],
      [
        `${ADDR}:${CHILD_B}`,
        { rootHash: 'bb'.repeat(32), status: 'valid', splitParent: TOKEN_ID } as TokenManifestEntry,
      ],
    ]);
    const manifestStorage = makeFakeManifestStorage();
    // Pre-populate the storage so the CAS update can read children.
    for (const [k, v] of manifestEntries) {
      manifestStorage.entries.set(k, v);
    }
    const manifestCas = new ManifestCas(manifestStorage);
    const cascadeEvents = makeEventRecorder();

    const manifestScanner: CascadeManifestScanner = {
      async readEntry(addr, tokenId) {
        return manifestStorage.entries.get(`${addr}:${tokenId}`);
      },
      async findChildren(_addr, parentTokenId) {
        if (parentTokenId === TOKEN_ID) return [CHILD_A, CHILD_B];
        return [];
      },
    };
    const outboxEntries: UxfTransferOutboxEntry[] = [
      {
        _schemaVersion: 'uxf-1',
        id: 'outbox-child-a',
        bundleCid: 'bafy-child-a',
        tokenIds: [CHILD_A],
        deliveryMethod: 'car-over-nostr',
        recipient: '@charlie',
        recipientTransportPubkey: 'charlie-pk',
        mode: 'instant',
        status: 'delivered-instant',
        outstandingRequestIds: ['req-x'],
        completedRequestIds: [],
        submitRetryCount: 0,
        proofErrorCount: 0,
        createdAt: 1,
        updatedAt: 1,
        lamport: 1,
      },
    ];
    const outboxScanner: CascadeOutboxScanner = {
      async findEntriesByTokenId(tokenId) {
        return outboxEntries.filter((e) => e.tokenIds.includes(tokenId));
      },
    };

    const realWalker = new CascadeWalker({
      manifestScanner,
      manifestCas,
      outboxScanner,
      classifyToken: async () => 'coin',
      emit: cascadeEvents.emit,
    });

    // Wrap to record cascade calls.
    const calls: Array<{ addr: string; tokenId: string; reason: string }> = [];
    const original = realWalker.cascade.bind(realWalker);
    realWalker.cascade = async (addr, tokenId, reason) => {
      calls.push({ addr, tokenId, reason });
      return original(addr, tokenId, reason);
    };
    (realWalker as unknown as { cascadeCalls: typeof calls }).cascadeCalls =
      calls;

    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const harness = buildWorker({
      aggregator,
      cascadeWalker: realWalker as unknown as ReturnType<
        typeof import('./finalization-worker-recipient-fixtures').makeFakeCascadeWalker
      >,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.cascadeInvoked).toBe(true);
    expect(calls.length).toBe(1);

    // Both children flipped to invalid via CAS.
    const childA = manifestStorage.entries.get(`${ADDR}:${CHILD_A}`);
    const childB = manifestStorage.entries.get(`${ADDR}:${CHILD_B}`);
    expect(childA?.status).toBe('invalid');
    expect(childA?.invalidReason).toBe('parent-rejected');
    expect(childB?.status).toBe('invalid');
    expect(childB?.invalidReason).toBe('parent-rejected');

    // transfer:cascade-failed emitted for outbox entry
    // referencing CHILD_A.
    const cascadeFailed = cascadeEvents.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeFailed.length).toBeGreaterThanOrEqual(1);
    const childACascade = cascadeFailed.find(
      (e) =>
        (e.data as { tokenId: string }).tokenId === CHILD_A,
    );
    expect(childACascade).toBeDefined();
  });
});

describe('recipient cascade — NFT with forward', () => {
  it('cascade walker emits transfer:cascade-failed for NFT outbox entries (no splitParent walk)', async () => {
    // NFT path: no splitParent children. The walker should ONLY
    // emit transfer:cascade-failed for outbox entries that shipped
    // this NFT.
    const manifestStorage = makeFakeManifestStorage();
    manifestStorage.entries.set(`${ADDR}:${TOKEN_ID}`, {
      rootHash: PREVIOUS_CID,
      status: 'invalid',
      invalidReason: 'belief-divergence',
    });
    const manifestCas = new ManifestCas(manifestStorage);
    const cascadeEvents = makeEventRecorder();

    const manifestScanner: CascadeManifestScanner = {
      async readEntry(addr, tokenId) {
        return manifestStorage.entries.get(`${addr}:${tokenId}`);
      },
      async findChildren() {
        return []; // NFTs have no splitParent children.
      },
    };
    const outboxEntries: UxfTransferOutboxEntry[] = [
      {
        _schemaVersion: 'uxf-1',
        id: 'outbox-forward',
        bundleCid: 'bafy-fwd',
        tokenIds: [TOKEN_ID],
        deliveryMethod: 'car-over-nostr',
        recipient: '@dora',
        recipientTransportPubkey: 'dora-pk',
        mode: 'instant',
        status: 'delivered-instant',
        outstandingRequestIds: ['req-fwd'],
        completedRequestIds: [],
        submitRetryCount: 0,
        proofErrorCount: 0,
        createdAt: 1,
        updatedAt: 1,
        lamport: 1,
      },
    ];
    const outboxScanner: CascadeOutboxScanner = {
      async findEntriesByTokenId(tokenId) {
        return outboxEntries.filter((e) => e.tokenIds.includes(tokenId));
      },
    };

    const realWalker = new CascadeWalker({
      manifestScanner,
      manifestCas,
      outboxScanner,
      classifyToken: async () => 'nft',
      emit: cascadeEvents.emit,
    });
    const calls: Array<{ addr: string; tokenId: string; reason: string }> = [];
    const original = realWalker.cascade.bind(realWalker);
    realWalker.cascade = async (addr, tokenId, reason) => {
      calls.push({ addr, tokenId, reason });
      return original(addr, tokenId, reason);
    };
    (realWalker as unknown as { cascadeCalls: typeof calls }).cascadeCalls =
      calls;

    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const harness = buildWorker({
      aggregator,
      cascadeWalker: realWalker as unknown as ReturnType<
        typeof import('./finalization-worker-recipient-fixtures').makeFakeCascadeWalker
      >,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.cascadeInvoked).toBe(true);

    // transfer:cascade-failed emitted for the NFT outbox entry.
    const cascadeFailed = cascadeEvents.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeFailed.length).toBe(1);
    const ev = cascadeFailed[0].data as {
      tokenId: string;
      recipientTransportPubkey: string;
    };
    expect(ev.tokenId).toBe(TOKEN_ID);
    expect(ev.recipientTransportPubkey).toBe('dora-pk');

    // Self-invalidation also written.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
  });
});
