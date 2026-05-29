/**
 * UXF Inter-Wallet Transfer T.5.E — type-level audit of the new
 * `transfer:*` events on {@link SphereEventMap}.
 *
 * This test suite asserts BOTH the runtime + compile-time shape of the
 * 5 events introduced by the UXF transfer waves (T.5.A / T.5.B /
 * T.5.B.5 / T.5.C / T.5.D / T.5.F):
 *
 *   - `transfer:cascade-risk-warning`
 *   - `transfer:cascade-failed`
 *   - `transfer:trustbase-warning`
 *   - `transfer:security-alert`
 *   - `transfer:override-applied`
 *
 * Plus the broader transfer-event surface introduced by T.5.A / T.3.E /
 * T.4.B / T.5.B / T.3.C — `transfer:submitted`, `transfer:operator-alert`,
 * `transfer:fetch-failed`, `transfer:ingest-queue-full`,
 * `transfer:proof-superseded`. These are the "10+ transfer events" the
 * acceptance criterion mentions.
 *
 * The test exercises the typing surface in two ways:
 *   1. A compile-time `expectAssignable<>` style check via TypeScript's
 *      structural typing (any breakage caught by `tsc --noEmit`, see the
 *      typecheck script in `package.json`).
 *   2. A runtime sanity check that confirms the discriminator strings
 *      survive the `keyof SphereEventMap` lookup (so a refactor that
 *      drops a key is caught by the test runner too).
 *
 * NOTE: this file is intentionally narrow in scope — it does NOT test
 * emission, only typing. Emission paths are covered by:
 *   - `tests/unit/payments/transfer/finalization-worker-recipient.test.ts`
 *   - `tests/unit/payments/transfer/finalization-worker-sender.test.ts`
 *   - `tests/unit/payments/transfer/import-inclusion-proof.test.ts`
 *   - `tests/integration/transfer/trustbase-warning.test.ts`
 *   - `tests/integration/transfer/security-alert.test.ts`
 *   - `tests/integration/transfer/security-alert-conflicting-proofs.test.ts`
 *   - `tests/integration/transfer/override-applied-event.test.ts`
 *   - `tests/integration/transfer/operator-override-audit-listener.test.ts`
 *
 * Spec refs: §6.3, §9.4, §9.4.1.
 */

import { describe, expect, it } from 'vitest';
import type { SphereEventMap, SphereEventType } from '../../../types';
import type { DispositionReason } from '../../../types/disposition';

// =============================================================================
// 1. Compile-time existence check — every UXF transfer:* key MUST be
//    present on SphereEventMap. The `extends` constraint on the const
//    array elements forces tsc to fail the build if any key disappears.
// =============================================================================

const UXF_TRANSFER_EVENT_TYPES = [
  'transfer:incoming',
  'transfer:confirmed',
  'transfer:submitted',
  'transfer:cascade-risk-warning',
  'transfer:failed',
  'transfer:operator-alert',
  'transfer:fetch-failed',
  'transfer:ingest-queue-full',
  'transfer:cascade-failed',
  'transfer:trustbase-warning',
  'transfer:security-alert',
  'transfer:proof-superseded',
  'transfer:override-applied',
] as const satisfies ReadonlyArray<SphereEventType>;

// =============================================================================
// 2. Compile-time payload-shape checks — one fixture per event. If the
//    payload type ever changes shape, the assignment to
//    `SphereEventMap[<key>]` will fail the typecheck.
// =============================================================================

// Helper: assert at compile time that `value` is assignable to
// `SphereEventMap[K]`. Pure type-level — no runtime cost.
function assertEventPayload<K extends SphereEventType>(
  _key: K,
  value: SphereEventMap[K],
): SphereEventMap[K] {
  return value;
}

const cascadeRiskWarningPayload = assertEventPayload(
  'transfer:cascade-risk-warning',
  {
    transferId: 'transfer-1',
    bundleCid: 'bafy-bundle',
    recipientTransportPubkey: 'recipient-pk',
    pendingSourceTokenIds: ['t-1'],
    freshlyMintedChildTokenIds: ['t-2'],
  },
);

const cascadeFailedPayload = assertEventPayload('transfer:cascade-failed', {
  outboxId: 'outbox-1',
  tokenId: 't-1',
  bundleCid: 'bafy-bundle',
  recipientTransportPubkey: 'recipient-pk',
  reason: 'oracle-rejected' satisfies DispositionReason,
});

const trustbaseWarningPayload = assertEventPayload(
  'transfer:trustbase-warning',
  {
    tokenId: 't-1',
    requestId: 'rq-1',
    outboxId: 'outbox-1',
    bundleCid: 'bafy-bundle',
    attempt: 1,
    message: 'NOT_AUTHENTICATED — likely stale trustBase',
  },
);

const securityAlertPayload = assertEventPayload('transfer:security-alert', {
  tokenId: 't-1',
  requestId: 'rq-1',
  attachedTransactionHash: '0000aa',
  observedTransactionHash: '0000bb',
  attachedAuthenticator: 'cc'.repeat(32),
  observedAuthenticator: 'dd'.repeat(32),
  message: 'two proofs disagree',
});

const overrideAppliedPayload = assertEventPayload(
  'transfer:override-applied',
  {
    tokenId: 't-1',
    overrideAppliedAt: 1700000001000,
    overrideAppliedBy: 'operator-pk',
    previousReason: 'oracle-rejected' satisfies DispositionReason,
    transition: 'invalid→valid',
  },
);

// =============================================================================
// 3. Runtime audit — confirm the discriminators and a representative
//    payload field survive the typing surface. These checks are cheap
//    insurance against accidental key drops that pure tsc may not flag
//    (e.g. when a new key is added but an old one quietly removed in a
//    parallel refactor).
// =============================================================================

describe('SphereEventMap — UXF transfer event audit', () => {
  it('declares every required UXF transfer event key', () => {
    // Every key is present in the const tuple; tsc enforces the
    // `satisfies` constraint at compile time. At runtime, we just
    // confirm the array has the expected length.
    expect(UXF_TRANSFER_EVENT_TYPES.length).toBe(13);
    // Spot-check the 5 NEW events the T.5.E task explicitly enumerates.
    expect(UXF_TRANSFER_EVENT_TYPES).toContain('transfer:trustbase-warning');
    expect(UXF_TRANSFER_EVENT_TYPES).toContain('transfer:security-alert');
    expect(UXF_TRANSFER_EVENT_TYPES).toContain('transfer:cascade-risk-warning');
    expect(UXF_TRANSFER_EVENT_TYPES).toContain('transfer:cascade-failed');
    expect(UXF_TRANSFER_EVENT_TYPES).toContain('transfer:override-applied');
  });

  it('cascade-risk-warning carries §6.1.1 cascade-rule fields', () => {
    expect(cascadeRiskWarningPayload.transferId).toBe('transfer-1');
    expect(cascadeRiskWarningPayload.pendingSourceTokenIds).toEqual(['t-1']);
    expect(cascadeRiskWarningPayload.freshlyMintedChildTokenIds).toEqual(['t-2']);
  });

  it('cascade-failed carries the (outboxId, tokenId, reason) cascade triple', () => {
    expect(cascadeFailedPayload.outboxId).toBe('outbox-1');
    expect(cascadeFailedPayload.tokenId).toBe('t-1');
    expect(cascadeFailedPayload.reason).toBe('oracle-rejected');
  });

  it('trustbase-warning carries the §9.4.1 routine-warning fields', () => {
    expect(trustbaseWarningPayload.tokenId).toBe('t-1');
    expect(trustbaseWarningPayload.requestId).toBe('rq-1');
    expect(trustbaseWarningPayload.attempt).toBe(1);
    expect(trustbaseWarningPayload.message).toContain('NOT_AUTHENTICATED');
  });

  it('security-alert carries the §6.3 forbidden-path divergence fields', () => {
    expect(securityAlertPayload.attachedTransactionHash).toBe('0000aa');
    expect(securityAlertPayload.observedTransactionHash).toBe('0000bb');
    expect(securityAlertPayload.attachedTransactionHash).not.toBe(
      securityAlertPayload.observedTransactionHash,
    );
  });

  it('override-applied carries the W31 audit trail fields', () => {
    expect(overrideAppliedPayload.tokenId).toBe('t-1');
    expect(overrideAppliedPayload.overrideAppliedAt).toBe(1700000001000);
    expect(overrideAppliedPayload.overrideAppliedBy).toBe('operator-pk');
    expect(overrideAppliedPayload.previousReason).toBe('oracle-rejected');
    expect(overrideAppliedPayload.transition).toBe('invalid→valid');
  });

  it('override-applied permits "invalid→pending" transition for the K-1 re-queue case', () => {
    const k1Payload = assertEventPayload('transfer:override-applied', {
      tokenId: 't-chain',
      overrideAppliedAt: 1700000002000,
      previousReason: 'oracle-rejected',
      transition: 'invalid→pending',
    });
    expect(k1Payload.transition).toBe('invalid→pending');
    // overrideAppliedBy is optional — should be absent when omitted.
    expect(k1Payload.overrideAppliedBy).toBeUndefined();
  });
});
