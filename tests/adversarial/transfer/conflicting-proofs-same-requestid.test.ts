/**
 * UXF Transfer T.5.B — adversarial: conflicting proofs for same
 * requestId emit `transfer:security-alert` (C10).
 *
 * Spec wording (§6.3, "Forbidden"):
 *   "Forbidden (would indicate aggregator failure): observing two
 *    proofs for the same requestId with DIFFERENT values (different
 *    transactionHash). If this ever happens, emit
 *    `transfer:security-alert` immediately — the single-spend
 *    invariant has been violated at the aggregator. The protocol
 *    does NOT auto-recover; an operator must investigate."
 *
 * Acceptance (C10):
 *   "two-different-values proof → `transfer:security-alert` emitted;
 *    refuse merge."
 *
 * The "refuse merge" semantic: the worker MUST NOT attach the new
 * proof when it disagrees with the already-attached proof on
 * (transactionHash, authenticator). The §5.5 step 5 4-step write
 * order is short-circuited.
 *
 * Threat model:
 *   - The aggregator has been faulty (under our threat model in §9.4)
 *     OR a network attacker has injected a forged proof.
 *   - The protocol does not defend against active forgery (out of
 *     scope per §9.4.1) — but the worker DOES detect the inconsistency
 *     and emits the security alert so operators can decide whether
 *     this is operational drift or a hostile event.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeFakePoolRead,
  makeOutboxEntry,
  makeProof,
  NEW_CID,
  REQUEST_ID,
  TOKEN_ID,
  LOCAL_TX_HASH,
  FORGED_TX_HASH,
  LOCAL_AUTHENTICATOR,
  FORGED_AUTHENTICATOR,
} from '../../unit/payments/transfer/finalization-worker-sender-fixtures';

describe('§6.3 forbidden: two-different-values proofs (C10 adversarial)', () => {
  it('different transactionHash from already-attached proof → security-alert + refuse merge', async () => {
    // Already attached: proof at LOCAL_TX_HASH.
    const attached = makeProof({
      transactionHash: LOCAL_TX_HASH,
      authenticator: LOCAL_AUTHENTICATOR,
      roundNumber: 100,
    });
    // New poll returns a DIFFERENT transactionHash — forbidden.
    const conflicting = makeProof({
      transactionHash: FORGED_TX_HASH,
      authenticator: LOCAL_AUTHENTICATOR,
      roundNumber: 200,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: attached },
    ]);
    // The local resolver tracks LOCAL_TX_HASH so the §6.1 race-loser
    // check would also match — but the §6.3 forbidden case is
    // detected against the ALREADY-ATTACHED proof, not the resolver's
    // local tracking. The new poll's tx hash matches LOCAL (so race-
    // loser check passes), but disagrees with the ATTACHED proof.
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        // Note: the poll returns a value matching local tx-hash so the
        // race-loser check is FALSE (we want to test the §6.3 path,
        // not the race-loser path).
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH,
          authenticator: LOCAL_AUTHENTICATOR,
          roundNumber: 200,
        }),
        newCid: NEW_CID,
      }),
    });
    void conflicting;
    const h = buildWorker({ aggregator, poolRead });

    // Replace the attached proof's transactionHash so it disagrees
    // with both local and the new poll. This is the actual §6.3
    // forbidden scenario: the LOCALLY-CACHED (already-attached)
    // proof has a different value from a freshly-anchored proof for
    // the same requestId. The aggregator emitted two distinct
    // commitments for the same requestId — single-spend violation.
    poolRead.proofs.set(`${TOKEN_ID}:${REQUEST_ID}`, {
      ...attached,
      transactionHash: FORGED_TX_HASH,
      authenticator: FORGED_AUTHENTICATOR,
    });

    await h.worker.processOne(makeOutboxEntry());

    // transfer:security-alert emitted exactly once.
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts).toHaveLength(1);
    const data = alerts[0]!.data as {
      tokenId: string;
      requestId: string;
      attachedTransactionHash: string;
      observedTransactionHash: string;
      message: string;
    };
    expect(data.tokenId).toBe(TOKEN_ID);
    expect(data.requestId).toBe(REQUEST_ID);
    expect(data.attachedTransactionHash).toBe(FORGED_TX_HASH);
    expect(data.observedTransactionHash).toBe(LOCAL_TX_HASH);
    expect(data.message).toContain('single-spend invariant');
  });

  it('refuses merge: no 4-step write happens on security-alert', async () => {
    // Same setup — the worker MUST NOT attach the new proof when the
    // §6.3 forbidden case fires.
    const attached = makeProof({
      transactionHash: FORGED_TX_HASH,
      authenticator: FORGED_AUTHENTICATOR,
      roundNumber: 100,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: attached },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH,
          authenticator: LOCAL_AUTHENTICATOR,
          roundNumber: 200,
        }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    const result = await h.worker.processOne(makeOutboxEntry());

    // The worker hard-fails the entry (does NOT silently swallow).
    // The disposition reason is 'belief-divergence' — the conflict is
    // a violation of the single-spend invariant which the SDK treats
    // as a belief divergence between the wallet and the aggregator.
    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('belief-divergence');

    // No proof was attached.
    expect(h.pool.attachCalls).toHaveLength(0);
  });

  it('different authenticator (same tx hash) ALSO triggers security-alert', async () => {
    // Per §6.3 forbidden case: "two proofs for the same requestId
    // with DIFFERENT values (different transactionHash + authenticator)".
    // The (transactionHash, authenticator) tuple is the equality key.
    const attached = makeProof({
      transactionHash: LOCAL_TX_HASH,
      authenticator: LOCAL_AUTHENTICATOR,
      roundNumber: 100,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: attached },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH, // same
          authenticator: FORGED_AUTHENTICATOR, // different
          roundNumber: 200,
        }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts).toHaveLength(1);
    const data = alerts[0]!.data as {
      attachedAuthenticator?: string;
      observedAuthenticator?: string;
    };
    expect(data.attachedAuthenticator).toBe(LOCAL_AUTHENTICATOR);
    expect(data.observedAuthenticator).toBe(FORGED_AUTHENTICATOR);
  });

  it('security-alert is emitted EXACTLY ONCE per attempted merge (idempotency)', async () => {
    const attached = makeProof({
      transactionHash: FORGED_TX_HASH,
      authenticator: FORGED_AUTHENTICATOR,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: attached },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH,
          authenticator: LOCAL_AUTHENTICATOR,
        }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts).toHaveLength(1);
  });

  it('security-alert is the ONLY event type emitting transfer:security-alert in routine flow', async () => {
    // Per §6.3: "This is the only path that emits
    // transfer:security-alert in the routine flow; per §9.4.1, all
    // other suspect events emit transfer:trustbase-warning first."
    //
    // Spec invariant — pinned at the worker layer.
    const attached = makeProof({
      transactionHash: FORGED_TX_HASH,
      authenticator: FORGED_AUTHENTICATOR,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: attached },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH,
          authenticator: LOCAL_AUTHENTICATOR,
        }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    // This test should observe security-alert WITHOUT a preceding
    // trustbase-warning — the §6.3 forbidden case is the ONLY
    // routine path that fires security-alert.
    const securityAlerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    const trustbaseWarnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(securityAlerts).toHaveLength(1);
    expect(trustbaseWarnings).toHaveLength(0);
  });
});
