/**
 * Round 3 — PaymentsModule.importInclusionProof tokenId case-normalization.
 *
 * Round 1 doc claimed "Wallet code lowercases SDK tokenIds before
 * passing them to the importer", but no such normalization existed in
 * the public PaymentsModule.importInclusionProof entry. Round 3 adds
 * the wrapper-level lowercase. This test asserts that uppercase /
 * mixed-case tokenIds flow through cleanly via the wrapper and reach
 * the importer with already-lowercase input (no `'invalid-tokenid'`
 * rejection).
 */

import { describe, it, expect, vi } from 'vitest';
import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import { InclusionProofImporter } from '../../../modules/payments/transfer/import-inclusion-proof';
import type { PaymentsModuleConfig } from '../../../modules/payments/PaymentsModule';

// =============================================================================
// Minimal PaymentsModule construction — only the importInclusionProof entry
// is exercised. We pass the smallest config that satisfies the constructor
// type and `installInclusionProofImporter()` an importer whose internal
// `importInclusionProof` is a spy.
// =============================================================================

function makeMinimalPayments(): PaymentsModule {
  // PaymentsModule has many required dependencies. To bypass full setup
  // for a focused test, we use the minimal required surface and rely on
  // the wrapper short-circuit before any side effect.
  const config: PaymentsModuleConfig = {
    storage: {
      async load() {
        return null;
      },
      async save() {
        /* no-op */
      },
      async clear() {
        /* no-op */
      },
      async listKeys() {
        return [];
      },
    } as never,
    tokenStorage: undefined as never,
    transport: {
      async resolve() {
        return null;
      },
      async destroy() {
        /* no-op */
      },
    } as never,
    oracle: undefined as never,
    addressIndex: 0,
    addressId: 'DIRECT://test',
    identity: {
      chainPubkey: 'aa'.repeat(33),
      l1Address: 'alpha1test',
      directAddress: 'DIRECT://test',
      privateKey: 'aa'.repeat(32),
    } as never,
    network: 'testnet' as never,
    l1: null,
    emit: () => undefined,
    on: () => () => {},
  };
  // PaymentsModule's constructor signature varies across versions; cast
  // the config and accept that we only exercise the public entry.
  return new PaymentsModule(config as never);
}

describe('Round 3: PaymentsModule.importInclusionProof normalizes tokenId case', () => {
  it('uppercase hex tokenId → lowercased before reaching importer (no invalid-tokenid rejection)', async () => {
    const payments = makeMinimalPayments();
    const upper = 'AB'.repeat(32);
    const lower = upper.toLowerCase();

    // Build an importer with a spy on the internal importInclusionProof
    // method. We don't need the full DI — the spy replaces the real
    // routing, and we assert the tokenId arrived lowercased.
    const importer = Object.create(InclusionProofImporter.prototype);
    const importSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, transition: 'pending-still' });
    Object.defineProperty(importer, 'importInclusionProof', {
      value: importSpy,
    });
    payments.installInclusionProofImporter(
      importer as InclusionProofImporter,
    );

    const result = await payments.importInclusionProof(
      'DIRECT://addr',
      upper,
      {
        requestId: 'rq',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    expect(importSpy).toHaveBeenCalledTimes(1);
    // Critical: the wrapper passes the LOWERCASE form through.
    const args = importSpy.mock.calls[0]!;
    expect(args[0]).toBe('DIRECT://addr');
    expect(args[1]).toBe(lower); // NOT `upper`
  });

  it('mixed-case hex tokenId → lowercased before reaching importer', async () => {
    const payments = makeMinimalPayments();
    const mixed =
      'aB'.repeat(16) + 'Cd'.repeat(16); // 64-char mixed
    const lower = mixed.toLowerCase();

    const importer = Object.create(InclusionProofImporter.prototype);
    const importSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, transition: 'pending-still' });
    Object.defineProperty(importer, 'importInclusionProof', {
      value: importSpy,
    });
    payments.installInclusionProofImporter(
      importer as InclusionProofImporter,
    );

    await payments.importInclusionProof(
      'DIRECT://addr',
      mixed,
      {
        requestId: 'rq',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    const args = importSpy.mock.calls[0]!;
    expect(args[1]).toBe(lower);
  });

  it('already-lowercase tokenId → passed through unchanged', async () => {
    const payments = makeMinimalPayments();
    const lower = 'ab'.repeat(32);

    const importer = Object.create(InclusionProofImporter.prototype);
    const importSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, transition: 'pending-still' });
    Object.defineProperty(importer, 'importInclusionProof', {
      value: importSpy,
    });
    payments.installInclusionProofImporter(
      importer as InclusionProofImporter,
    );

    await payments.importInclusionProof(
      'DIRECT://addr',
      lower,
      {
        requestId: 'rq',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    const args = importSpy.mock.calls[0]!;
    expect(args[1]).toBe(lower);
  });
});
