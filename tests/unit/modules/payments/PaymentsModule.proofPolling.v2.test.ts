/**
 * PaymentsModule proof-polling + legacy install stubs — Phase 6 v2 slim
 * rebuild coverage.
 *
 * v2 dropped the v1 proof-polling worker (state-transition-sdk's
 * submitCertificationRequest is atomic in v2 — it returns proofs in one
 * shot). The slim rebuild retains a set of no-op `install*` methods so
 * consumer bootstrap code (Sphere.ts, AccountingModule, tests) keeps
 * compiling.
 *
 * This suite asserts:
 *
 *   1. Every `install*` no-op accepts arbitrary values and does NOT throw.
 *   2. Repeated install() calls do NOT accumulate or leak worker state.
 *   3. Send/receive still work after every install() has been called (the
 *      stubs must not corrupt the module's inner state).
 *   4. The atomic-return send path completes in ONE call — no polling loop,
 *      no delayed proof arrival, no `pending`-then-`confirmed` transition.
 *   5. `getPendingTransfers()` is empty AFTER a successful send (the slim
 *      pipeline clears its inflight map on delivery), but populated
 *      BRIEFLY during send when we introspect the async gap. On the happy
 *      path we can only inspect after settle.
 *   6. `detectOrphanSpendingTokens()` returns 0/[] on the slim path.
 *   7. `importInclusionProof()` returns a failure result (documented no-op).
 *   8. `revalidateCascadedChildren()` returns zero-revalidated.
 *   9. `awaitRecipientContextHydration()` and `waitForPendingOperations()`
 *      resolve immediately (< 100ms).
 *   10. `getWorkerAbortSignal()` returns undefined (no workers in slim).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  buildIncomingTransfer,
  DEFAULT_SENDER_PUBKEY,
  makeV2Harness,
  mint,
  resetTokenSeq,
} from './__fixtures__/v2-harness';

describe('PaymentsModule proof-polling + legacy install stubs (v2 slim)', () => {
  beforeEach(() => {
    resetTokenSeq();
  });

  it('every install* method is a no-op that does not throw', async () => {
    const h = await makeV2Harness();
    const noop = () => {};
    expect(() => h.module.installOutboxWriter(noop)).not.toThrow();
    expect(() => h.module.installSentLedgerWriter(noop)).not.toThrow();
    expect(() => h.module.installSpentStateAuditWriter(noop)).not.toThrow();
    expect(() => h.module.installInclusionProofImporter(noop)).not.toThrow();
    expect(() => h.module.installRevalidateCascadedRunner(noop)).not.toThrow();
    expect(() => h.module.installSendingRecoveryWorker(noop)).not.toThrow();
    expect(() => h.module.installSentReconciliationWorker(noop)).not.toThrow();
    expect(() => h.module.installNostrPersistenceVerifier(noop)).not.toThrow();
    expect(() => h.module.installSpentStateRescanWorker(noop)).not.toThrow();
    expect(() => h.module.installTombstoneGcWorker(noop)).not.toThrow();
    expect(() => h.module.installFinalizationWorkerSender(noop)).not.toThrow();
    expect(() => h.module.installFinalizationWorkerRecipient(noop)).not.toThrow();
    expect(() => h.module.installIngestWorkerPool(noop)).not.toThrow();
    expect(() => h.module.installLegacyShapeAdapter({ processLegacy: async () => {} })).not.toThrow();
    expect(() => h.module.setSpentStateRescanTransitionToAudit(noop)).not.toThrow();
    expect(() => h.module.configureRecipientPersistedStorage({})).not.toThrow();
    expect(() => h.module.configureOperatorEscapeHatchStorage({}, {})).not.toThrow();
  });

  it('repeated install() calls do not corrupt module state', async () => {
    const h = await makeV2Harness();
    for (let i = 0; i < 5; i++) {
      h.module.installOutboxWriter({ i });
      h.module.installSendingRecoveryWorker({ i });
    }
    // Module still functional after churn.
    await mint(h, 'UCT', 500n);
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '100',
    });
    expect(result.status).toBe('delivered');
  });

  it('send + receive still work after every install() has been called', async () => {
    const h = await makeV2Harness();
    const noop = () => {};
    h.module.installOutboxWriter(noop);
    h.module.installSentLedgerWriter(noop);
    h.module.installFinalizationWorkerSender(noop);
    h.module.installFinalizationWorkerRecipient(noop);

    await mint(h, 'UCT', 500n);
    const sendResult = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '100',
    });
    expect(sendResult.status).toBe('delivered');

    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { amount: 42n }));
    // Received token is present.
    const uct = h.module.getTokens({ coinId: 'UCT' });
    // 400 change from send + 42 received.
    expect(uct.length).toBe(2);
  });

  it('atomic-return send: no proof-polling loop; delivered in ONE call', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 500n);

    // Track engine.transfer calls — the slim pipeline invokes it exactly
    // once per source token (no retry loop).
    const transferSpy = vi.spyOn(h.engine, 'transfer');
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '500',
    });
    expect(result.status).toBe('delivered');
    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(h.sendTokenTransfer).toHaveBeenCalledTimes(1);
  });

  it('getPendingTransfers() is empty after a settled send (no polling backlog)', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 500n);
    const before = h.module.getPendingTransfers();
    expect(before).toEqual([]);

    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '100' });

    const after = h.module.getPendingTransfers();
    expect(after).toEqual([]);
  });

  it('detectOrphanSpendingTokens() returns 0/[] on the slim path (no OUTBOX worker)', async () => {
    const h = await makeV2Harness();
    const r = await h.module.detectOrphanSpendingTokens();
    expect(r).toEqual({ detected: 0, tokens: [] });
  });

  it('importInclusionProof() returns failure with a documented no-op reason', async () => {
    const h = await makeV2Harness();
    const r = await h.module.importInclusionProof('DIRECT_x_y', 'tok-1', {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/v2 slim|importInclusionProof/i);
  });

  it('revalidateCascadedChildren() returns 0 revalidated + no errors', async () => {
    const h = await makeV2Harness();
    const r = await h.module.revalidateCascadedChildren('tok-x');
    expect(r).toEqual({ revalidated: 0, errors: [] });
  });

  it('awaitRecipientContextHydration + waitForPendingOperations resolve immediately', async () => {
    const h = await makeV2Harness();
    const t0 = Date.now();
    await h.module.awaitRecipientContextHydration();
    await h.module.waitForPendingOperations();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('getWorkerAbortSignal() returns undefined (no workers in slim)', async () => {
    const h = await makeV2Harness();
    expect(h.module.getWorkerAbortSignal()).toBeUndefined();
  });

  it('installLegacyShapeAdapter accepts a runner and does not invoke it during ordinary send/receive', async () => {
    const h = await makeV2Harness();
    const processLegacy = vi.fn().mockResolvedValue(undefined);
    h.module.installLegacyShapeAdapter({ processLegacy });

    // Ordinary UXF flows should NOT call the legacy adapter.
    await mint(h, 'UCT', 500n);
    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '100' });
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY));
    expect(processLegacy).not.toHaveBeenCalled();
  });
});
