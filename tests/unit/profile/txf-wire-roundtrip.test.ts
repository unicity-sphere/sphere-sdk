/**
 * Backward-compatibility: TXF wire format survives the UXF storage round-trip.
 *
 * Send / receive between wallets uses TXF objects as the wire format
 * (see modules/payments/PaymentsModule.ts — the outgoing payload is
 * `{ sourceToken: JSON.stringify(sdkToken.toJSON()), transferTx: ... }`
 * and the incoming parser calls `SdkToken.fromJSON()` on the parsed
 * sourceToken). That JSON is the TXF shape: `{version, state, genesis,
 * transactions, nametags?}`.
 *
 * The UXF storage layer packages tokens by deconstructing them into
 * content-addressed elements, then reassembles on load. For backward
 * compatibility with peers that only understand TXF (older Sphere
 * versions, third-party wallets), the round-trip MUST preserve every
 * field an SDK Token reconstructor relies on.
 *
 * This suite is the explicit compat gate: any change that silently
 * drops or alters a TXF field will fail here.
 */

import { describe, it, expect } from 'vitest';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import { TOKEN_A, TOKEN_B, TOKEN_C, NAMETAG_ALICE } from '../../fixtures/uxf-mock-tokens.js';

function tokenId(t: Record<string, unknown>): string {
  return ((t.genesis as Record<string, unknown>).data as Record<string, unknown>).tokenId as string;
}

function assertGenesisPreserved(
  original: Record<string, unknown>,
  restored: Record<string, unknown>,
): void {
  const origGenesis = original.genesis as Record<string, unknown>;
  const origData = origGenesis.data as Record<string, unknown>;
  const origProof = origGenesis.inclusionProof as Record<string, unknown>;

  const restGenesis = restored.genesis as Record<string, unknown>;
  const restData = restGenesis.data as Record<string, unknown>;
  const restProof = restGenesis.inclusionProof as Record<string, unknown>;

  // Genesis data — every field the wire protocol expects
  expect(restData.tokenId).toBe(origData.tokenId);
  expect(restData.tokenType).toBe(origData.tokenType);
  expect(restData.coinData).toEqual(origData.coinData);
  expect(restData.tokenData).toBe(origData.tokenData);
  expect(restData.salt).toBe(origData.salt);
  expect(restData.recipient).toBe(origData.recipient);
  expect(restData.recipientDataHash).toBe(origData.recipientDataHash);
  expect(restData.reason).toBe(origData.reason);

  // Genesis inclusion proof (required by SDK validation)
  if (origProof) {
    expect(restProof).toBeDefined();
    expect(restProof.authenticator).toEqual(origProof.authenticator);
    expect(restProof.merkleTreePath).toEqual(origProof.merkleTreePath);
    expect(restProof.transactionHash).toBe(origProof.transactionHash);
    expect(restProof.unicityCertificate).toBe(origProof.unicityCertificate);
  }
}

function assertStatePreserved(
  original: Record<string, unknown>,
  restored: Record<string, unknown>,
): void {
  const origState = original.state as Record<string, unknown>;
  const restState = restored.state as Record<string, unknown>;
  expect(restState.predicate).toBe(origState.predicate);
  expect(restState.data).toEqual(origState.data);
}

function assertTransactionsPreserved(
  original: Record<string, unknown>,
  restored: Record<string, unknown>,
): void {
  const origTxns = (original.transactions as unknown[]) ?? [];
  const restTxns = (restored.transactions as unknown[]) ?? [];
  expect(restTxns.length).toBe(origTxns.length);
  for (let i = 0; i < origTxns.length; i++) {
    const ot = origTxns[i] as Record<string, unknown>;
    const rt = restTxns[i] as Record<string, unknown>;
    // Every field SDK fromJSON walks on a transaction
    for (const field of ['sourceState', 'destinationState', 'data', 'inclusionProof', 'recipient']) {
      if (field in ot) {
        expect(rt[field]).toEqual(ot[field]);
      }
    }
  }
}

describe('TXF wire-format backward compatibility through UxfPackage', () => {
  it('TOKEN_A (fungible, 0 transactions) round-trips through ingest→assemble', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    const restored = pkg.assemble(tokenId(TOKEN_A)) as Record<string, unknown>;

    expect(restored.version).toBe(TOKEN_A.version);
    assertGenesisPreserved(TOKEN_A, restored);
    assertStatePreserved(TOKEN_A, restored);
    assertTransactionsPreserved(TOKEN_A, restored);
  });

  it('TOKEN_B round-trips through ingest→assemble', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_B);
    const restored = pkg.assemble(tokenId(TOKEN_B)) as Record<string, unknown>;
    expect(restored.version).toBe(TOKEN_B.version);
    assertGenesisPreserved(TOKEN_B, restored);
    assertStatePreserved(TOKEN_B, restored);
    assertTransactionsPreserved(TOKEN_B, restored);
  });

  it('TOKEN_C (with multiple transactions) preserves every tx in order', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_C);
    const restored = pkg.assemble(tokenId(TOKEN_C)) as Record<string, unknown>;

    assertGenesisPreserved(TOKEN_C, restored);
    assertStatePreserved(TOKEN_C, restored);
    // TOKEN_C has 3 transactions (see fixtures); all must survive.
    assertTransactionsPreserved(TOKEN_C, restored);
    expect((restored.transactions as unknown[]).length).toBeGreaterThan(0);
  });

  it('NAMETAG_ALICE (nametag-type token) round-trips preserving tokenData', () => {
    // Nametag tokens carry human-readable names in tokenData (hex-encoded).
    // If this field is lost, nametag resolution breaks for any peer that
    // receives our bundle.
    const pkg = UxfPackage.create();
    pkg.ingest(NAMETAG_ALICE);
    const restored = pkg.assemble(tokenId(NAMETAG_ALICE)) as Record<string, unknown>;
    assertGenesisPreserved(NAMETAG_ALICE, restored);
    // Explicit tokenData check (the name payload)
    const origData = (NAMETAG_ALICE.genesis as Record<string, unknown>).data as Record<string, unknown>;
    const restData = (restored.genesis as Record<string, unknown>).data as Record<string, unknown>;
    expect(restData.tokenData).toBe(origData.tokenData);
  });

  it('CAR serialization round-trip preserves all wire-format fields', async () => {
    // Full storage path: ingest → toCar → fromCar → assemble. This is
    // what ProfileTokenStorageProvider does on save+load.
    const pkg = UxfPackage.create();
    pkg.ingestAll([TOKEN_A, TOKEN_B, TOKEN_C]);

    const car = await pkg.toCar();
    const restored = await UxfPackage.fromCar(car);

    for (const original of [TOKEN_A, TOKEN_B, TOKEN_C]) {
      const rebuilt = restored.assemble(tokenId(original)) as Record<string, unknown>;
      assertGenesisPreserved(original, rebuilt);
      assertStatePreserved(original, rebuilt);
      assertTransactionsPreserved(original, rebuilt);
    }
  });

  it('rebuilt token can be JSON.stringified for wire transmission', () => {
    // The PaymentsModule send path calls `JSON.stringify(sdkToken.toJSON())`.
    // The SDK Token is reconstructed from the same TXF shape our storage
    // emits. Proof: round-tripping the reassembled TXF back to a JSON
    // string must produce a non-empty, parseable representation whose
    // shape matches the input.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    const restored = pkg.assemble(tokenId(TOKEN_A));

    const wireJson = JSON.stringify(restored);
    expect(wireJson.length).toBeGreaterThan(0);

    const reparsed = JSON.parse(wireJson) as Record<string, unknown>;
    assertGenesisPreserved(TOKEN_A, reparsed);
    assertStatePreserved(TOKEN_A, reparsed);
  });
});

describe('TXF serialization helpers (tokenToTxf / txfToToken) compatibility', () => {
  // These are the direct-to-wire helpers used by legacy send paths.
  // Import lazily inside the test so we can comment on their role.
  it('tokenToTxf extracts wire-compatible TxfToken from a UI Token sdkData', async () => {
    const { tokenToTxf } = await import('../../../serialization/txf-serializer');
    const uiToken = {
      id: 'local-uuid-1',
      amount: '1000000',
      coinId: 'UCT',
      symbol: 'UCT',
      decimals: 6,
      status: 'confirmed' as const,
      sdkData: JSON.stringify(TOKEN_A),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const txf = tokenToTxf(uiToken);
    expect(txf).not.toBeNull();
    // Every genesis field used by the wire receiver must be present
    expect(txf!.genesis.data.tokenId).toBe((TOKEN_A.genesis as any).data.tokenId);
    expect(txf!.genesis.data.coinData).toEqual((TOKEN_A.genesis as any).data.coinData);
    expect(txf!.state.predicate).toBe((TOKEN_A.state as any).predicate);
  });

  it('txfToToken reconstructs a UI Token whose sdkData can be parsed back to TXF', async () => {
    const { txfToToken, tokenToTxf } = await import('../../../serialization/txf-serializer');
    // Round-trip: TxfToken → UI Token → TxfToken
    const uiToken = txfToToken('local-uuid-2', TOKEN_A as any);
    expect(uiToken.sdkData).toBeDefined();
    const reextracted = tokenToTxf(uiToken);
    expect(reextracted).not.toBeNull();
    expect(reextracted!.genesis.data.tokenId).toBe((TOKEN_A.genesis as any).data.tokenId);
  });
});
