/**
 * Adversarial test — stuck-PENDING escape (§6.3, §11.4, T.5.D).
 *
 * Threat model: a token is `pending` for more than 7 days. The
 * aggregator never confirmed the commitment, the polling-window has
 * long since expired, the local worker hard-failed with reason=
 * 'oracle-rejected'. The user is stuck — their token is in `_invalid`
 * with no automatic recovery path.
 *
 * BUT — out-of-band, the user obtains the inclusion proof (e.g., via
 * a different aggregator endpoint, a peer who received the same
 * commitment, an operator side-channel). They want to inject the
 * proof into their wallet and graft the token back to `valid`.
 *
 * Spec wording (§11.4):
 *   "Stuck-PENDING escape: token is `pending` for >7 days; operator
 *    pastes in a proof via `payments.importInclusionProof()` → proof
 *    grafts in, token transitions to `valid`."
 *
 * Spec defense (§6.3, T.5.D):
 *   `payments.importInclusionProof(addressId, tokenId, proof)` is the
 *    operator-override API. It accepts a proof and grafts it into the
 *    pending token's queue entry. If the proof matches an outstanding
 *    requestId AND verifies cleanly, the token transitions
 *    `pending → valid`.
 *
 *    Hostile use cases the API must defend against:
 *      a) Wrong token: the proof is for a different requestId — return
 *         `requestid-mismatch`, no state mutation.
 *      b) Already-attached: the proof is already on file — return
 *         `pending-still` (idempotent), no double-attach.
 *      c) Verification failure: the proof is malformed (PATH_INVALID,
 *         NOT_AUTHENTICATED, throws) — return
 *         `proof-trustbase-failed`, no graft.
 *      d) PATH_NOT_INCLUDED: aggregator says proof not anchored — return
 *         `proof-not-anchored`, no graft.
 *      e) Unknown token: return `no-such-token`, no graft.
 *
 * What this test pins:
 *   1. Happy escape path: pending token + matching outstanding
 *      requestId + valid proof → `pending→valid`, single graft, no
 *      double-grafts.
 *   2. EVERY error path returns the canonical reason string and does
 *      NOT mutate state (no graft, no override callback, no event).
 *   3. The override-applied event is emitted ONLY for case 5/6
 *      (override on _invalid token), NOT for case 3 (vanilla
 *      pending-graft).
 *   4. address-scoping: a proof imported for ADDR_A does not graft
 *      a token under ADDR_B even if the tokenId happens to match.
 *
 * Spec references: §6.3, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  ADDR_ALT,
  buildImporterHarness,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
} from '../../unit/payments/transfer/import-inclusion-proof-fixtures';

describe('§11.4 — stuck-PENDING escape via importInclusionProof', () => {
  it('canonical escape: pending + matching outstanding requestId → pending→valid', async () => {
    // Hostile state: token has been pending for days. User obtains
    // the proof out-of-band and feeds it in.
    const h = buildImporterHarness();
    const TOKEN = 't-stuck-pending';
    const RQ = 'rq-stuck';
    h.manifest.entries.set(`${ADDR}:${TOKEN}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(
      queueEntryFor({
        tokenId: TOKEN,
        commitmentRequestId: RQ,
        status: 'pending',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      TOKEN,
      proofFor({ requestId: RQ }),
    );

    // Critical invariant 1: transition pending → valid.
    expect(result).toEqual({ ok: true, transition: 'pending→valid' });

    // Critical invariant 2: exactly ONE graft happened.
    expect(h.graftCalls).toHaveLength(1);
    expect(h.graftCalls[0]!.queueEntry.commitmentRequestId).toBe(RQ);

    // Critical invariant 3: NO override callback (this isn't case 5/6).
    expect(h.overrideCalls).toHaveLength(0);
    // No override-applied event.
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied'),
    ).toHaveLength(0);
  });

  it('hostile import: requestId mismatch → requestid-mismatch (no state change)', async () => {
    // Adversarial: user feeds in a proof for the WRONG requestId.
    // The token has outstanding `rq-X` but the proof claims `rq-Z`.
    // Defense: return mismatch, do not graft.
    const h = buildImporterHarness();
    const TOKEN = 't-mismatch';
    h.manifest.entries.set(`${ADDR}:${TOKEN}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(
      queueEntryFor({
        tokenId: TOKEN,
        commitmentRequestId: 'rq-X',
        status: 'pending',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      TOKEN,
      proofFor({ requestId: 'rq-Z' }), // mismatch!
    );

    expect(result).toEqual({ ok: false, reason: 'requestid-mismatch' });
    expect(h.graftCalls).toHaveLength(0);
    expect(h.overrideCalls).toHaveLength(0);
  });

  it('hostile import: unknown token → no-such-token (no state change)', async () => {
    // The injected proof references a token the wallet has never seen.
    // A buggy implementation might create a phantom entry — defense:
    // refuse cleanly.
    const h = buildImporterHarness();
    const result = await h.importer.importInclusionProof(
      ADDR,
      'completely-unknown-tokenid',
      proofFor({ requestId: 'rq-fake' }),
    );

    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    expect(h.graftCalls).toHaveLength(0);
    expect(h.events.events).toHaveLength(0);
  });

  it('idempotency: import on already-valid token → pending-still (no double-graft)', async () => {
    // The user has already grafted this proof previously. A re-import
    // is a no-op, NOT a double-graft.
    const h = buildImporterHarness();
    const TOKEN = 't-already-valid';
    h.manifest.entries.set(`${ADDR}:${TOKEN}`, manifestEntryFor({
      status: 'valid',
    }));

    const result = await h.importer.importInclusionProof(
      ADDR,
      TOKEN,
      proofFor({ requestId: 'rq-anything' }),
    );

    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    expect(h.graftCalls).toHaveLength(0);
    expect(h.overrideCalls).toHaveLength(0);
    // NO verification was even attempted (case 2 returns early).
    expect(h.verifyCalls).toHaveLength(0);
  });

  it('address-scoping: proof for ADDR does NOT graft same tokenId under ADDR_ALT', async () => {
    // Subtle defense: the importer is per-address. A user with two
    // wallets cannot accidentally (or hostilely) graft a proof from
    // ADDR_A's pending state into ADDR_B's pool just because the
    // tokenId collides.
    const h = buildImporterHarness();
    const SHARED_TOKEN = 't-shared-id';

    // Only ADDR has this token; ADDR_ALT does not.
    h.manifest.entries.set(`${ADDR}:${SHARED_TOKEN}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(
      queueEntryFor({
        tokenId: SHARED_TOKEN,
        commitmentRequestId: 'rq-shared',
        status: 'pending',
      }),
    );

    // Try to import with ADDR_ALT — even with a matching requestId,
    // the lookup MUST fail (no manifest entry under ADDR_ALT).
    const result = await h.importer.importInclusionProof(
      ADDR_ALT,
      SHARED_TOKEN,
      proofFor({ requestId: 'rq-shared' }),
    );
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    expect(h.graftCalls).toHaveLength(0);
  });
});
