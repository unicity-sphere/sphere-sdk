/**
 * #202 — UXF round-trip tests for V5-pending tokens.
 *
 * Pins the contract that lets cross-device profile sync and Nostr-shipped
 * UXF bundles carry tokens that have not yet been finalized on-chain:
 *
 *   1. A token with `genesis.inclusionProof: null` AND
 *      `transactions[0].inclusionProof: null` ingests, serializes to CAR,
 *      and round-trips back with both null markers preserved.
 *
 *   2. A token with `_pendingFinalization` at the top level no longer
 *      throws on ingest (the field is silently dropped on round-trip,
 *      consistent with all other non-schema top-level metadata).
 *
 *   3. A `transactions[0]._wallet.authenticator` field is preserved
 *      across CAR round-trip via the new `pending-authenticator` element
 *      type, so the sender-signed authenticator for an in-flight transfer
 *      survives even though `inclusionProof` is null.
 *
 * Pre-#202, all three behaviors failed:
 *   - (1) threw `TypeError: Cannot read properties of null` from
 *     deconstructGenesis passing null to deconstructInclusionProof
 *   - (2) threw `UxfError[INVALID_PACKAGE] Cannot ingest placeholder or
 *     pending finalization tokens` from the validator
 *   - (3) `_wallet.authenticator` was a top-level non-schema field and
 *     was silently dropped on deconstruct → assemble (UXF shreds tokens
 *     into typed element pools and doesn't preserve unknown fields).
 */

import { describe, it, expect } from 'vitest';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import {
  TOKEN_TYPE_FUNGIBLE,
  PUBKEY_ALICE,
  PREDICATE_A,
} from '../../fixtures/uxf-mock-tokens.js';

// -----------------------------------------------------------------------------
// Shared fixture helpers
// -----------------------------------------------------------------------------

const PENDING_TOKEN_ID =
  'aaaaaa00000000000000000000000000000000000000000000000000000000aa';

function makePendingV5Token(opts?: {
  withPendingFinalizationMarker?: boolean;
  withWalletAuthenticator?: boolean;
}): Record<string, unknown> {
  const token: Record<string, unknown> = {
    version: '2.0',
    state: {
      predicate: PREDICATE_A,
      data: null,
    },
    genesis: {
      data: {
        tokenId: PENDING_TOKEN_ID,
        tokenType: TOKEN_TYPE_FUNGIBLE,
        coinData: [['UCT', '1000000']],
        tokenData: '',
        salt: 'aaaaaa00000000000000000000000000000000000000000000000000000055aa',
        recipient: 'DIRECT://alice-pending-01',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: null, // V5 RECEIVED stage — mint not yet submitted
    },
    transactions: [
      {
        data: {
          sourceState: {
            predicate: PREDICATE_A,
            data: null,
          },
          recipient: 'DIRECT://bob-pending-01',
          salt: 'aaaaaa000000000000000000000000000000000000000000000000000099aa01',
          recipientDataHash: null,
          message: null,
          nametags: [],
        },
        inclusionProof: null, // transfer commitment not yet proven
        ...(opts?.withWalletAuthenticator
          ? {
              _wallet: {
                authenticator: {
                  algorithm: 'secp256k1',
                  publicKey: PUBKEY_ALICE,
                  signature:
                    '3045022100ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01022000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff',
                  stateHash:
                    'ee0000000000000000000000000000000000000000000000000000ee004a5401',
                },
              },
            }
          : {}),
      },
    ],
    nametags: [],
  };

  if (opts?.withPendingFinalizationMarker) {
    token._pendingFinalization = {
      type: 'v5_bundle',
      stage: 'RECEIVED',
      bundleJson: '{"version":"5.0","type":"INSTANT_SPLIT"}',
      senderPubkey: PUBKEY_ALICE,
      savedAt: 1700000000000,
      attemptCount: 0,
    };
  }

  return token;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('#202 — UXF round-trip for V5-pending tokens', () => {
  it('null genesis.inclusionProof + null transfer.inclusionProof: ingests and round-trips', async () => {
    const pkg = UxfPackage.create();
    const token = makePendingV5Token();

    pkg.ingestAll([token]);
    expect(pkg.tokenCount).toBe(1);

    const car = await pkg.toCar();
    const restored = await UxfPackage.fromCar(car);
    expect(restored.tokenCount).toBe(1);

    const assembled = restored.assemble(PENDING_TOKEN_ID) as Record<string, unknown>;
    const restoredGenesis = assembled.genesis as Record<string, unknown>;
    const restoredTxs = assembled.transactions as Array<Record<string, unknown>>;

    expect(restoredGenesis.inclusionProof).toBeNull();
    expect(restoredTxs).toHaveLength(1);
    expect(restoredTxs[0].inclusionProof).toBeNull();
  });

  it('_pendingFinalization at top level is ACCEPTED (not rejected) and silently dropped on assemble', async () => {
    const pkg = UxfPackage.create();
    const token = makePendingV5Token({ withPendingFinalizationMarker: true });

    // Pre-#202 this threw [UXF:INVALID_PACKAGE]. Now it ingests.
    expect(() => pkg.ingestAll([token])).not.toThrow();
    expect(pkg.tokenCount).toBe(1);

    const car = await pkg.toCar();
    const restored = await UxfPackage.fromCar(car);
    const assembled = restored.assemble(PENDING_TOKEN_ID) as Record<string, unknown>;

    // The `_pendingFinalization` field is wallet-internal metadata; UXF
    // deconstruct preserves only canonical typed elements. The marker is
    // expected to be dropped on round-trip. The wallet preserves this
    // field through its own KV storage (PENDING_V5_TOKENS).
    expect(assembled._pendingFinalization).toBeUndefined();

    // But the structural shape survives — that's what matters for
    // cross-device visibility.
    const restoredGenesis = assembled.genesis as Record<string, unknown>;
    expect(restoredGenesis.inclusionProof).toBeNull();
  });

  it('transactions[0]._wallet.authenticator survives CAR round-trip via pending-authenticator element', async () => {
    const pkg = UxfPackage.create();
    const token = makePendingV5Token({ withWalletAuthenticator: true });

    pkg.ingestAll([token]);

    const car = await pkg.toCar();
    const restored = await UxfPackage.fromCar(car);
    const assembled = restored.assemble(PENDING_TOKEN_ID) as Record<string, unknown>;
    const restoredTxs = assembled.transactions as Array<Record<string, unknown>>;

    expect(restoredTxs[0].inclusionProof).toBeNull();
    expect(restoredTxs[0]._wallet).toBeDefined();
    const wallet = restoredTxs[0]._wallet as { authenticator: Record<string, string> };
    expect(wallet.authenticator).toBeDefined();
    expect(wallet.authenticator.algorithm).toBe('secp256k1');
    expect(wallet.authenticator.publicKey).toBe(PUBKEY_ALICE.toLowerCase());
    expect(wallet.authenticator.signature).toMatch(/^3045022100ee01/);
    expect(wallet.authenticator.stateHash).toMatch(/^ee0000/);
  });

  it('transactions WITHOUT _wallet.authenticator do NOT get a pendingAuthenticator child (no element hash drift)', async () => {
    // Backwards-compat check: the very same input that worked pre-#202
    // (transaction with null inclusionProof, no _wallet field) must produce
    // a transaction element whose children object DOES NOT include the
    // optional `pendingAuthenticator` slot. Adding the slot unconditionally
    // would change the element hash for every existing transaction in the
    // wild — a silent content-address break that would invalidate every
    // already-pinned bundle CAR. We use the "omit when null" convention.
    const pkg = UxfPackage.create();
    const token = makePendingV5Token({ withWalletAuthenticator: false });

    pkg.ingestAll([token]);

    const car = await pkg.toCar();
    const restored = await UxfPackage.fromCar(car);
    const assembled = restored.assemble(PENDING_TOKEN_ID) as Record<string, unknown>;
    const restoredTxs = assembled.transactions as Array<Record<string, unknown>>;

    expect(restoredTxs[0]._wallet).toBeUndefined();
  });

  it('verify() succeeds for a fully-pending token', async () => {
    const pkg = UxfPackage.create();
    pkg.ingestAll([makePendingV5Token({ withWalletAuthenticator: true })]);

    const result = pkg.verify();
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });
});
