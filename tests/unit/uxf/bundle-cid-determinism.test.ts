/**
 * `UxfPackage.create({ createdAt, updatedAt })` determinism contract.
 *
 * Why this exists
 * ---------------
 * The CAR root CID of a UXF bundle is the dag-cbor SHA-256 of the
 * envelope block, which embeds `createdAt` and `updatedAt`. Without
 * caller control of these fields, two `UxfPackage.create()` calls
 * straddling a wall-clock second boundary produce different envelope
 * bytes → different bundleCids. That breaks systems keyed on
 * `bundleCid` for idempotency:
 *
 *   - replay-LRU at the recipient (T.3.A)
 *   - IPFS pin reuse (re-publishing the same bundle should hit the
 *     existing pin, not create a duplicate)
 *   - sender-side outbox dedup ("this is the same retry, not a new
 *     send")
 *   - audit-#333 H3 `mergePkg` `targetExisting === sourceIncoming`
 *     fast-path
 *
 * Concretely: `tests/integration/transfer/crash-recovery.test.ts:726`
 * flaked on slow CI runs (notably Node 20) before the fix because
 * its resume call hit `UxfPackage.create()` in a different wall-clock
 * second than the first attempt.
 *
 * This file is the dedicated regression surface: same-input
 * `create()` calls MUST produce bit-identical envelope bytes (and
 * therefore identical CAR root CIDs) when the timestamp is locked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';
import { extractCarRootCid } from '../../../extensions/uxf/bundle/transfer-payload';

describe('UxfPackage.create — bundleCid determinism (post-#362)', () => {
  describe('locked createdAt', () => {
    it('two calls with the SAME explicit `createdAt` produce identical CAR root CIDs', async () => {
      const lockedAt = 1700000000; // unix seconds, arbitrary fixed value

      const pkgA = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'aa'.repeat(32),
        createdAt: lockedAt,
      });
      pkgA.ingest(TOKEN_A, { updatedAt: lockedAt });

      const pkgB = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'aa'.repeat(32),
        createdAt: lockedAt,
      });
      pkgB.ingest(TOKEN_A, { updatedAt: lockedAt });

      const carA = await pkgA.toCar();
      const carB = await pkgB.toCar();

      const cidA = await extractCarRootCid(carA);
      const cidB = await extractCarRootCid(carB);

      expect(cidA).toBe(cidB);
    });

    it('two calls with DIFFERENT explicit `createdAt` produce DIFFERENT CAR root CIDs', async () => {
      // Sanity that the fix did not accidentally strip the timestamp
      // from the envelope.
      const pkgA = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'aa'.repeat(32),
        createdAt: 1700000000,
      });
      pkgA.ingest(TOKEN_A, { updatedAt: 1700000000 });

      const pkgB = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'aa'.repeat(32),
        createdAt: 1700000001, // 1 second later
      });
      pkgB.ingest(TOKEN_A, { updatedAt: 1700000001 });

      const carA = await pkgA.toCar();
      const carB = await pkgB.toCar();

      expect(await extractCarRootCid(carA)).not.toBe(await extractCarRootCid(carB));
    });

    it('explicit `updatedAt` independently controls the envelope updatedAt field', async () => {
      const pkgA = UxfPackage.create({
        createdAt: 1700000000,
        updatedAt: 1700000005,
      });
      const pkgB = UxfPackage.create({
        createdAt: 1700000000,
        updatedAt: 1700000010, // different updatedAt
      });
      // Different updatedAt → different envelope → different CID.
      const cidA = await extractCarRootCid(await pkgA.toCar());
      const cidB = await extractCarRootCid(await pkgB.toCar());
      expect(cidA).not.toBe(cidB);
    });

    it('omitted `updatedAt` defaults to `createdAt` (post-create state)', async () => {
      // Acceptance: a freshly-created package has updatedAt === createdAt.
      // The audit-#333 H3 fast path (`targetExisting === sourceIncoming`)
      // relies on this for round-trip identity through ingest →
      // toCar → fromCar → no mutating merge.
      const pkg = UxfPackage.create({ createdAt: 1700000000 });
      expect(pkg.packageData.envelope.createdAt).toBe(1700000000);
      expect(pkg.packageData.envelope.updatedAt).toBe(1700000000);
    });
  });

  describe('cross-attempt determinism (the production scenario)', () => {
    // Drive the exact failure mode that `crash-recovery.test.ts:726`
    // hits: two create() calls running in different wall-clock seconds.
    // Without locking, the bundleCids would differ.

    let originalDateNow: typeof Date.now;
    let clock: number;

    beforeEach(() => {
      originalDateNow = Date.now;
      clock = 1_700_000_000_500; // 1 sec + 500 ms past T0
      Date.now = vi.fn(() => clock);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    it('caller-locked timestamp produces identical CIDs even when Date.now() drifts across calls', async () => {
      // First attempt: caller locks T0 (in seconds).
      const lockedAt = Math.floor(clock / 1000);
      const pkgFirst = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'bb'.repeat(32),
        createdAt: lockedAt,
      });
      pkgFirst.ingest(TOKEN_A, { updatedAt: lockedAt });
      const cidFirst = await extractCarRootCid(await pkgFirst.toCar());

      // Simulate the wall clock advancing across a second boundary
      // before the resume call (the exact flake condition).
      clock = 1_700_000_001_750; // now 1.75 sec past T0 — crossed boundary

      // Resume attempt: caller passes the original lockedAt.
      const pkgResume = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'bb'.repeat(32),
        createdAt: lockedAt,
      });
      pkgResume.ingest(TOKEN_A, { updatedAt: lockedAt });
      const cidResume = await extractCarRootCid(await pkgResume.toCar());

      expect(cidResume).toBe(cidFirst);
    });

    it('contrast: unlocked Date.now() across the same boundary produces DIFFERENT CIDs (validates the bug exists without the fix)', async () => {
      // No explicit createdAt → falls back to Math.floor(Date.now()/1000).
      const pkgFirst = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'cc'.repeat(32),
      });
      pkgFirst.ingest(TOKEN_A);
      const cidFirst = await extractCarRootCid(await pkgFirst.toCar());

      // Advance the clock across a second boundary.
      clock = 1_700_000_001_750;

      const pkgResume = UxfPackage.create({
        description: 'inter-wallet-transfer',
        creator: '02' + 'cc'.repeat(32),
      });
      pkgResume.ingest(TOKEN_A);
      const cidResume = await extractCarRootCid(await pkgResume.toCar());

      // Different second-resolution stamps → different envelopes →
      // different CIDs. This is the bug the production fix prevents.
      expect(cidResume).not.toBe(cidFirst);
    });
  });
});
