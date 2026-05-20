/**
 * Issue #195 — recipient default builder must NOT pre-seed the manifest
 * store with a placeholder entry; pre-timeout PerTokenMutex rejections
 * must NOT log "after timeout".
 *
 * Background.
 * The recipient finalization worker (T.5.C) auto-installed by
 * `buildDefaultFinalizationWorkerRecipient` previously wrote a
 * placeholder manifest entry (rootHash = 32 zero bytes, status =
 * 'pending') inside its `aggregatorClient.poll` callback whenever a
 * proof was returned for the first time on a tokenId. The §5.5 step 5
 * 4-step write order assigns ownership of the manifest entry to
 * `step2ManifestCidRewrite`, which uses the `RequestContext.previousCid`
 * as the CAS precondition. The recipient enqueue path populates
 * `RequestContext` with `previousCid: undefined` (genesis case), which
 * step 2 translates to `prev = null` — asserting "no entry exists" in
 * the manifest store.
 *
 * The placeholder write in the poll callback contradicted that contract:
 * by the time step 2 ran, `manifestCas.update(addr, tokenId, null, next)`
 * read the placeholder, saw `prev === null && observed !== undefined`,
 * returned `{ ok: false, reason: 'cas-mismatch', observed }`, and
 * step 2 threw `ManifestCidRewriteCasError` because the observed
 * `rootHash` (the placeholder) did not equal `newCid` (the requestId-
 * derived target).
 *
 * Symptom in the wild: escrow swap deposit invoices never flipped to
 * `'confirmed'`, leaving the swap stuck at `PARTIAL_DEPOSIT`.
 *
 * The fix removes the placeholder write. This file pins:
 *
 *  (1) Contract — with an empty manifest store, step 2 must accept
 *      `previousCid = undefined` and insert the first entry cleanly.
 *  (2) Contract — with a placeholder pre-seeded (the old bug shape),
 *      step 2 must throw `ManifestCidRewriteCasError`. Documents the
 *      reason removing the placeholder is correct, not gratuitous.
 *  (3) Source guard — `buildDefaultFinalizationWorkerRecipient` must
 *      not reintroduce the `placeholderRootHash` pattern.
 *  (4) PerTokenMutex log gating — a pre-timeout rejection must NOT
 *      emit a warning that claims the detached fn rejected "after
 *      timeout". A post-timeout rejection MUST still surface.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  performManifestCidRewrite,
  ManifestCidRewriteCasError,
  type ManifestCidRewriteContext,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
  type FinalizationQueueAdapter,
} from '../../../../modules/payments/transfer/manifest-cid-rewrite';
import {
  ManifestCas,
  type MinimalManifestStorage,
} from '../../../../profile/manifest-cas';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';
import type { InclusionProof } from '../../../../oracle/oracle-provider';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import { logger } from '../../../../core/logger';

// =============================================================================
// Shared helpers — minimal adapter set matching the recipient builder shape
// =============================================================================

const ADDR = 'DIRECT://addr-issue-195';
const TOKEN_ID = 'token-issue-195';
const NEW_CID = 'cid-new-issue-195';
const PLACEHOLDER_ROOT_HASH = '00'.repeat(32);
const QUEUE_REQ_ID = 'req-issue-195';

function buildAdapters(seedPlaceholder: boolean): {
  ctx: ManifestCidRewriteContext;
  manifestEntries: Map<string, TokenManifestEntry>;
} {
  const manifestEntries = new Map<string, TokenManifestEntry>();
  if (seedPlaceholder) {
    // Reproduce the pre-fix poll-callback side-effect verbatim.
    manifestEntries.set(`${ADDR}:${TOKEN_ID}`, {
      rootHash: PLACEHOLDER_ROOT_HASH,
      status: 'pending',
    });
  }
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };

  const poolAttached = new Set<string>();
  const pool: PoolWriteAdapter = {
    async isProofAttached(tokenId, reqId) {
      return poolAttached.has(`${tokenId}:${reqId}`);
    },
    async attachProof(tokenId, reqId) {
      poolAttached.add(`${tokenId}:${reqId}`);
    },
  };

  const tombstoneSet = new Set<string>();
  const tombstones: TombstoneWriteAdapter = {
    async hasTombstone(tokenId, cid) {
      return tombstoneSet.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId, cid) {
      tombstoneSet.add(`${tokenId}:${cid}`);
    },
  };

  const queueEntries = new Set<string>();
  queueEntries.add(`${ADDR}:${QUEUE_REQ_ID}`);
  const queue: FinalizationQueueAdapter = {
    async hasEntry(addr, reqId) {
      return queueEntries.has(`${addr}:${reqId}`);
    },
    async removeEntry(addr, reqId) {
      queueEntries.delete(`${addr}:${reqId}`);
    },
  };

  const proof: InclusionProof = {
    requestId: QUEUE_REQ_ID,
    roundNumber: 1,
    proof: { ok: true },
    timestamp: 1700000000000,
  };

  const ctx: ManifestCidRewriteContext = {
    addr: ADDR,
    tokenId: TOKEN_ID,
    proofToAttach: proof,
    newCid: NEW_CID,
    // Recipient genesis case — RequestContext.previousCid is undefined,
    // step2 translates to `prev = null`.
    previousCid: undefined,
    nextEntryRest: { status: 'valid' },
    queueEntryRequestId: QUEUE_REQ_ID,
    pool,
    manifestCas: new ManifestCas(manifestStorage),
    tombstones,
    queue,
  };

  return { ctx, manifestEntries };
}

// =============================================================================
// 1. Contract — empty manifest store + previousCid=undefined → success
// =============================================================================

describe('Issue #195 — manifest-cid-rewrite genesis contract', () => {
  it('with EMPTY manifest store, recipient genesis context (previousCid=undefined) succeeds and inserts the first entry', async () => {
    const { ctx, manifestEntries } = buildAdapters(/* seedPlaceholder */ false);

    const result = await performManifestCidRewrite(ctx);

    expect(result.result).toBe('ok');
    // Step 2 inserted the canonical first entry — rootHash = newCid (not
    // any placeholder).
    expect(manifestEntries.get(`${ADDR}:${TOKEN_ID}`)).toEqual({
      rootHash: NEW_CID,
      status: 'valid',
    });
  });

  it('with PLACEHOLDER pre-seeded (the pre-fix poll-callback bug shape), the same context throws ManifestCidRewriteCasError', async () => {
    // This is the buggy state the recipient builder used to produce
    // BEFORE the issue #195 fix: the poll callback wrote a zero-hash
    // placeholder into `manifestEntries` before step 2 ran. step 2 then
    // observed `prev=null` but `observed !== undefined`, failing CAS.
    // The observed.rootHash (placeholder) does not match newCid, so
    // step 2's "already-applied" idempotency branch does not fire — the
    // error propagates to the worker as a real CAS conflict.
    const { ctx } = buildAdapters(/* seedPlaceholder */ true);

    let caught: unknown;
    try {
      await performManifestCidRewrite(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ManifestCidRewriteCasError);
    const err = caught as ManifestCidRewriteCasError;
    expect(err.casReason).toBe('cas-mismatch');
    expect(err.observedCid).toBe(PLACEHOLDER_ROOT_HASH);
  });
});

// =============================================================================
// 2. Source guard — recipient default builder must not reintroduce the
//                    placeholder write pattern
// =============================================================================

describe('Issue #195 — buildDefaultFinalizationWorkerRecipient source guard', () => {
  const SRC_PATH = resolve(__dirname, '../../../../modules/payments/PaymentsModule.ts');
  const src = readFileSync(SRC_PATH, 'utf8');

  function extractRecipientBuilderBody(): string {
    const start = src.indexOf(
      'export function buildDefaultFinalizationWorkerRecipient',
    );
    expect(start).toBeGreaterThan(-1);
    // The builder ends with its sibling `export function ...` or the
    // file's terminal sender helpers; bound the search at the next
    // top-level `export function` declaration after the start.
    const nextExport = src.indexOf('\nexport function ', start + 1);
    const end = nextExport === -1 ? src.length : nextExport;
    return src.slice(start, end);
  }

  it('does NOT declare a `placeholderRootHash` symbol in the recipient builder', () => {
    const body = extractRecipientBuilderBody();
    expect(body).not.toMatch(/placeholderRootHash/);
  });

  it('does NOT pre-populate `manifestEntries` from the aggregator poll callback', () => {
    const body = extractRecipientBuilderBody();
    // The pre-fix pattern was: `if (!manifestEntries.has(...)) { manifestEntries.set(...) }`
    // inside the poll callback. After the fix, the only writes to
    // `manifestEntries` should come from `manifestStorage.writeEntry`
    // (called by ManifestCas) — not from a fall-through `.set` in the
    // poll producer.
    expect(body).not.toMatch(/manifestEntries\.set\(\s*`\$\{addressId\}:/);
  });
});

// =============================================================================
// 3. PerTokenMutex bounded-hold log gating
// =============================================================================

describe('Issue #195 — PerTokenMutex bounded-hold log gating', () => {
  it('pre-timeout rejection does NOT log "after timeout"', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const mutex = new PerTokenMutex();
      const err = new Error('synchronous-cas-mismatch');
      await expect(
        mutex.acquire(
          'token-pre-timeout',
          // fn rejects in microseconds — far below any sensible bounded-hold.
          async () => {
            throw err;
          },
          { strategy: 'bounded-hold', timeoutMs: 500 },
        ),
      ).rejects.toBe(err);

      // Yield a few ticks to ensure no late .catch fires (defensive).
      await new Promise<void>((r) => setTimeout(r, 50));

      // The fix: the pre-timeout `.catch` must not emit the misleading
      // "after timeout" warn. Operator dashboards previously logged
      // EVERY synchronous fn rejection as a bounded-hold blowup; this
      // assertion locks the new behavior.
      const matchedCalls = warnSpy.mock.calls.filter((call) => {
        const message = call.find((arg) =>
          typeof arg === 'string' && arg.includes('detached fn rejected after timeout'),
        );
        return message !== undefined;
      });
      expect(matchedCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('post-timeout rejection STILL logs "after timeout" (observability preserved)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const mutex = new PerTokenMutex();
      const lateErr = new Error('disk-full-arriving-late');

      // The acquire itself should reject with LOCK_BOUNDED_HOLD_FIRED;
      // we discard the awaiter's error so the test focuses on the
      // detached-fn .catch behavior.
      await expect(
        mutex.acquire(
          'token-post-timeout',
          async () => {
            // Hang past the timeout, then reject. The detached fn .catch
            // must surface this so disk-full / quota-exceeded failures
            // are visible to operators.
            await new Promise<void>((r) => setTimeout(r, 150));
            throw lateErr;
          },
          { strategy: 'bounded-hold', timeoutMs: 50 },
        ),
      ).rejects.toHaveProperty('code', 'LOCK_BOUNDED_HOLD_FIRED');

      // Yield long enough for the detached fn to reject (set to 150 ms
      // above; allow extra slack for CI).
      await new Promise<void>((r) => setTimeout(r, 250));

      const matchedCalls = warnSpy.mock.calls.filter((call) => {
        const matchedAfterTimeout = call.some((arg) =>
          typeof arg === 'string' &&
          arg.includes('detached fn rejected after timeout') &&
          arg.includes('disk-full-arriving-late'),
        );
        return matchedAfterTimeout;
      });
      expect(matchedCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
