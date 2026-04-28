/**
 * Tests for `modules/payments/transfer/bundle-acquirer.ts` (T.3.A).
 *
 * Spec references:
 *  - §5.1   Bundle acquisition (CAR / CID branch + replay LRU).
 *  - §5.2   Bundle verification (delegated to bundle-verifier).
 *  - §5.6   Idempotency (replay LRU short-circuit is a no-op).
 *
 * Coverage:
 *  - Happy path: kind='uxf-car' with consistent bundleCid → VerifiedBundle
 *  - kind='uxf-cid' rejection (T.4.B deferred)
 *  - root-CID mismatch rejection
 *  - replay short-circuit (idempotent re-arrival)
 *  - LRU is marked only AFTER successful verification
 *  - malformed envelope (legacy / unknown kind routed in)
 *  - invalid CAR base64
 */

import { describe, expect, it } from 'vitest';

import { isSphereError } from '../../../../core/errors';
import {
  acquireBundle,
  isReplayOutcome,
} from '../../../../modules/payments/transfer/bundle-acquirer';
import { ReplayLRU } from '../../../../modules/payments/transfer/replay-lru';
import type {
  UxfTransferPayload,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../../types/uxf-transfer';
import { UxfPackage } from '../../../../uxf/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../../uxf/transfer-payload';

import { TOKEN_A, TOKEN_B } from '../../../fixtures/uxf-mock-tokens';

const TOKEN_A_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';

const SENDER = 'a'.repeat(64); // 64-hex transport pubkey

/**
 * Build a real `uxf-car` payload from the supplied token fixtures. The
 * `bundleCid` is computed from the actual CAR root.
 */
async function buildCarPayload(opts: {
  tokens: ReadonlyArray<Record<string, unknown>>;
  claimedTokenIds: readonly string[];
  bundleCidOverride?: string;
}): Promise<UxfTransferPayloadCar> {
  const pkg = UxfPackage.create();
  pkg.ingestAll([...opts.tokens]);
  const carBytes = await pkg.toCar();
  const realBundleCid = await extractCarRootCid(carBytes);
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'instant',
    bundleCid: opts.bundleCidOverride ?? realBundleCid,
    tokenIds: opts.claimedTokenIds,
    carBase64: carBytesToBase64(carBytes),
  };
}

// =============================================================================
// 1. Happy path
// =============================================================================

describe('acquireBundle — happy path', () => {
  it('returns VerifiedBundle for a clean uxf-car payload', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
    });
    const lru = new ReplayLRU();
    const result = await acquireBundle(payload, SENDER, lru);
    expect(isReplayOutcome(result)).toBe(false);
    if (isReplayOutcome(result)) throw new Error('unreachable');
    expect(result.verified).toBe(true);
    expect(result.claimedTokens).toHaveLength(1);
    expect(result.claimedTokens[0].tokenId).toBe(TOKEN_A_ID);
    expect(result.bundleCid).toBe(payload.bundleCid);
  });

  it('marks the LRU after successful verification', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
    });
    const lru = new ReplayLRU();
    expect(lru.has(SENDER, payload.bundleCid)).toBe(false);
    await acquireBundle(payload, SENDER, lru);
    expect(lru.has(SENDER, payload.bundleCid)).toBe(true);
  });

  it('multi-token bundle: claimed + advisory split correctly', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A, TOKEN_B],
      claimedTokenIds: [TOKEN_A_ID], // only TOKEN_A claimed
    });
    const lru = new ReplayLRU();
    const result = await acquireBundle(payload, SENDER, lru);
    if (isReplayOutcome(result)) throw new Error('unreachable');
    expect(result.claimedTokens.map((r) => r.tokenId)).toEqual([TOKEN_A_ID]);
    expect(result.advisoryUnclaimedRoots.map((r) => r.tokenId)).toEqual([TOKEN_B_ID]);
  });
});

// =============================================================================
// 2. CID-mode gate (T.4.B deferred)
// =============================================================================

describe('acquireBundle — uxf-cid is not yet supported', () => {
  it('rejects kind=uxf-cid with BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED', async () => {
    const payload: UxfTransferPayloadCid = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafytest',
      tokenIds: [TOKEN_A_ID],
    };
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(payload, SENDER, lru);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED');
    // LRU MUST NOT be marked for a deferred branch.
    expect(lru.has(SENDER, 'bafytest')).toBe(false);
  });
});

// =============================================================================
// 3. Root-CID mismatch
// =============================================================================

describe('acquireBundle — root-CID mismatch', () => {
  it('rejects with BUNDLE_REJECTED_ROOT_CID_MISMATCH when bundleCid disagrees', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
      bundleCidOverride:
        'bafyreid7gzkd7m2ovmh7y4hgsthhqhwlrbeenoaq2obuycoswbsedfsy5e',
    });
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(payload, SENDER, lru);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_ROOT_CID_MISMATCH');
    expect(caught.message).toContain(payload.bundleCid);
  });

  it('LRU is NOT marked when root-CID mismatch fails', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
      bundleCidOverride:
        'bafyreid7gzkd7m2ovmh7y4hgsthhqhwlrbeenoaq2obuycoswbsedfsy5e',
    });
    const lru = new ReplayLRU();
    try {
      await acquireBundle(payload, SENDER, lru);
    } catch {
      /* expected */
    }
    expect(lru.totalEntries).toBe(0);
  });
});

// =============================================================================
// 4. Replay short-circuit
// =============================================================================

describe('acquireBundle — replay LRU short-circuit', () => {
  it('second arrival of the same (sender, bundleCid) returns ReplayOutcome', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
    });
    const lru = new ReplayLRU();

    const first = await acquireBundle(payload, SENDER, lru);
    expect(isReplayOutcome(first)).toBe(false);

    const second = await acquireBundle(payload, SENDER, lru);
    expect(isReplayOutcome(second)).toBe(true);
    if (!isReplayOutcome(second)) throw new Error('unreachable');
    expect(second.replay).toBe(true);
    expect(second.bundleCid).toBe(payload.bundleCid);
  });

  it('different sender, same bundleCid: NOT a replay (separate buckets)', async () => {
    const payload = await buildCarPayload({
      tokens: [TOKEN_A],
      claimedTokenIds: [TOKEN_A_ID],
    });
    const lru = new ReplayLRU();
    await acquireBundle(payload, SENDER, lru);
    const otherSender = 'b'.repeat(64);
    const result = await acquireBundle(payload, otherSender, lru);
    // Per Note N5: same CID from a different sender is processed
    // afresh — it goes into the second sender's private bucket.
    expect(isReplayOutcome(result)).toBe(false);
  });
});

// =============================================================================
// 5. Malformed inputs (legacy / unknown / invalid CAR)
// =============================================================================

describe('acquireBundle — malformed envelope inputs', () => {
  it('rejects legacy-shape payload (no kind discriminator)', async () => {
    // Legacy SDK shape — `{token, proof}`.
    const legacy = {
      token: { foo: 'bar' },
      proof: { baz: 'qux' },
    } as unknown as UxfTransferPayload;
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(legacy, SENDER, lru);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
  });

  it('rejects payload with non-base64 carBase64', async () => {
    const bogus: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafytest',
      tokenIds: [],
      carBase64: '!!! not base64 !!!',
    };
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(bogus, SENDER, lru);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
  });

  it('rejects payload with invalid (truncated) CAR bytes', async () => {
    // Valid base64, but the bytes don't parse as CAR.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const bogus: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafytest',
      tokenIds: [],
      carBase64: carBytesToBase64(garbage),
    };
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(bogus, SENDER, lru);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_INVALID_CAR');
  });
});
