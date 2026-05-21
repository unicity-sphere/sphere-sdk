/**
 * #207 PR-B — Unit tests for the V5-pending synthetic shape helpers.
 *
 * Pins:
 *   - `buildSyntheticV5PendingSdkData` produces the canonical
 *     UXF/TXF-valid shape with `inclusionProof: null` on both genesis
 *     and the synthetic transfer transaction.
 *   - The sender-signed transfer authenticator rides as
 *     `transactions[0]._wallet.authenticator`.
 *   - `_pendingFinalization` is retained at the top level for the
 *     single-device KV restore path.
 *   - `_integrity.currentStateHash` is set from the authenticator's
 *     `stateHash` (= source state hash).
 *   - The helper returns `{ok: false, error}` on malformed bundles —
 *     caller logs the error context + falls back to the legacy opaque
 *     shape (pin #207 review nit #5 + steelman diagnostic-visibility
 *     fix).
 *   - `readV5FinalizationInputsFromToken` round-trips the synthetic
 *     shape back into structured inputs, including derivable fields
 *     (`tokenTypeHex` from `genesis.data.tokenType`, `transferSaltHex`
 *     from `transactions[0].data.salt`, `recipientAddress` from
 *     `transactions[0].data.recipient`).
 *   - The reader returns `null` for legacy opaque shapes
 *     (`{_pendingFinalization: ...}`) → caller falls back to bundleJson.
 *   - Steelman strictening: reader rejects non-null inclusionProofs,
 *     non-hex tokenId/tokenType/salt, malformed authenticator,
 *     wrong-length publicKey.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSyntheticV5PendingSdkData,
  readV5FinalizationInputsFromToken,
} from '../../../modules/payments/v5-pending-shape';
import type {
  InstantSplitBundleV5,
  PendingV5Finalization,
} from '../../../types/instant-split';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const STATE_HASH = '0000ee0000000000000000000000000000000000000000000000000000000000';
const TOKEN_TYPE = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ID = 'aa00000000000000000000000000000000000000000000000000000000000099';
const SALT = '00aa000000000000000000000000000000000000000000000000000000000033';

function makeMintDataJson(): Record<string, unknown> {
  return {
    tokenId: TOKEN_ID,
    tokenType: TOKEN_TYPE,
    tokenData: null,
    coinData: [['UCT', '1000']],
    recipient: 'DIRECT://bob-pending-01',
    salt: '00bb000000000000000000000000000000000000000000000000000000000001',
    recipientDataHash: null,
    reason: null,
  };
}

function makeTransferAuthJson(): Record<string, unknown> {
  return {
    algorithm: 'secp256k1',
    publicKey: PUBKEY,
    signature:
      '3045022100ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01022000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff',
    stateHash: STATE_HASH,
  };
}

function makeTransferTxData(): Record<string, unknown> {
  return {
    sourceState: { predicate: 'aa', data: null },
    recipient: 'DIRECT://bob-pending-01',
    salt: SALT,
    recipientDataHash: null,
    message: null,
    nametags: [],
  };
}

function makeBundle(overrides: Partial<InstantSplitBundleV5> = {}): InstantSplitBundleV5 {
  const mintData = makeMintDataJson();
  const txData = makeTransferTxData();
  const auth = makeTransferAuthJson();
  return {
    version: '5.0',
    type: 'INSTANT_SPLIT',
    burnTransaction: '{}',
    recipientMintData: JSON.stringify(mintData),
    transferCommitment: JSON.stringify({
      requestId: 'aa00bb',
      transactionData: txData,
      authenticator: auth,
    }),
    amount: '1000',
    coinId: 'UCT',
    tokenTypeHex: TOKEN_TYPE,
    splitGroupId: 'group-aaaaaa',
    senderPubkey: PUBKEY,
    recipientSaltHex: '00cc',
    transferSaltHex: SALT,
    mintedTokenStateJson: JSON.stringify({ predicate: 'bb', data: null }),
    finalRecipientStateJson: '',
    recipientAddressJson: 'DIRECT://bob-pending-01',
    ...overrides,
  };
}

function makePending(): PendingV5Finalization {
  return {
    type: 'v5_bundle',
    stage: 'RECEIVED',
    bundleJson: '',
    senderPubkey: PUBKEY,
    savedAt: Date.now(),
    attemptCount: 0,
  };
}

function buildOk(bundle: InstantSplitBundleV5, pending: PendingV5Finalization): string {
  const r = buildSyntheticV5PendingSdkData(bundle, pending);
  if (!r.ok) {
    throw new Error(`buildSyntheticV5PendingSdkData unexpectedly failed: ${r.error}`);
  }
  return r.sdkData;
}

// -----------------------------------------------------------------------------
// buildSyntheticV5PendingSdkData
// -----------------------------------------------------------------------------

describe('#207 PR-B — buildSyntheticV5PendingSdkData', () => {
  it('produces a UXF/TXF-valid shape with null inclusionProofs', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed.version).toBe('2.0');
    expect(parsed.genesis.inclusionProof).toBeNull();
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].inclusionProof).toBeNull();
    expect(Array.isArray(parsed.nametags)).toBe(true);
  });

  it('places mint data in genesis.data and minted state in state', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed.genesis.data.tokenId).toBe(TOKEN_ID);
    expect(parsed.genesis.data.tokenType).toBe(TOKEN_TYPE);
    expect(parsed.state.predicate).toBe('bb');
  });

  it('carries transfer authenticator at transactions[0]._wallet.authenticator', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed.transactions[0]._wallet.authenticator.publicKey).toBe(PUBKEY);
    expect(parsed.transactions[0]._wallet.authenticator.stateHash).toBe(STATE_HASH);
  });

  it('places transfer transactionData at transactions[0].data', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed.transactions[0].data.recipient).toBe('DIRECT://bob-pending-01');
    expect(parsed.transactions[0].data.salt).toBe(SALT);
  });

  it('retains _pendingFinalization at top level for KV restore path', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed._pendingFinalization).toBeDefined();
    expect(parsed._pendingFinalization.type).toBe('v5_bundle');
    expect(parsed._pendingFinalization.stage).toBe('RECEIVED');
  });

  it('sets _integrity.currentStateHash from authenticator.stateHash', () => {
    const parsed = JSON.parse(buildOk(makeBundle(), makePending()));
    expect(parsed._integrity.currentStateHash).toBe(STATE_HASH);
  });

  it('returns {ok:false, error} when recipientMintData JSON is malformed', () => {
    const r = buildSyntheticV5PendingSdkData(makeBundle({ recipientMintData: '{not-json' }), makePending());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON|Unexpected/);
  });

  it('returns {ok:false, error} when transferCommitment JSON is malformed', () => {
    const r = buildSyntheticV5PendingSdkData(makeBundle({ transferCommitment: '{also-not-json' }), makePending());
    expect(r.ok).toBe(false);
  });

  it('returns {ok:false, error} when mintedTokenStateJson is malformed', () => {
    const r = buildSyntheticV5PendingSdkData(makeBundle({ mintedTokenStateJson: 'definitely-not-json' }), makePending());
    expect(r.ok).toBe(false);
  });

  it('tolerates legacy transferCommitment with `data` instead of `transactionData`', () => {
    const auth = makeTransferAuthJson();
    const txData = makeTransferTxData();
    const bundle = makeBundle({
      transferCommitment: JSON.stringify({
        requestId: 'aa00bb',
        data: txData,
        authenticator: auth,
      }),
    });
    const parsed = JSON.parse(buildOk(bundle, makePending()));
    expect(parsed.transactions[0].data.recipient).toBe('DIRECT://bob-pending-01');
  });
});

// -----------------------------------------------------------------------------
// readV5FinalizationInputsFromToken
// -----------------------------------------------------------------------------

describe('#207 PR-B — readV5FinalizationInputsFromToken', () => {
  it('round-trips through buildSyntheticV5PendingSdkData', () => {
    const sdkDataJson = buildOk(makeBundle(), makePending());
    const inputs = readV5FinalizationInputsFromToken(sdkDataJson);
    expect(inputs).not.toBeNull();
    expect(inputs!.tokenTypeHex).toBe(TOKEN_TYPE);
    expect(inputs!.transferSaltHex).toBe(SALT);
    expect(inputs!.recipientAddress).toBe('DIRECT://bob-pending-01');
    expect(inputs!.transferAuthenticatorJson.publicKey).toBe(PUBKEY);
    expect(inputs!.transferAuthenticatorJson.stateHash).toBe(STATE_HASH);
    expect(inputs!.mintedTokenStateJson).toBeDefined();
    expect(inputs!.mintDataJson.tokenId).toBe(TOKEN_ID);
  });

  it('returns null on legacy opaque shape ({_pendingFinalization: ...})', () => {
    const legacy = JSON.stringify({ _pendingFinalization: makePending() });
    expect(readV5FinalizationInputsFromToken(legacy)).toBeNull();
  });

  it('returns null when sdkData is empty/undefined', () => {
    expect(readV5FinalizationInputsFromToken(undefined)).toBeNull();
    expect(readV5FinalizationInputsFromToken('')).toBeNull();
    expect(readV5FinalizationInputsFromToken(null)).toBeNull();
  });

  it('returns null when sdkData is not parseable JSON', () => {
    expect(readV5FinalizationInputsFromToken('{not-json')).toBeNull();
  });

  it('returns null when transactions[0]._wallet.authenticator is missing', () => {
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [{ data: makeTransferTxData(), inclusionProof: null }],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when genesis.data is missing or malformed', () => {
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: null, inclusionProof: null },
      transactions: [],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when transactions array is empty', () => {
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  // -- steelman strictening --

  it('returns null when genesis.inclusionProof is non-null (post-mint-proven)', () => {
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: { some: 'proof' } },
      transactions: [
        {
          data: makeTransferTxData(),
          inclusionProof: null,
          _wallet: { authenticator: makeTransferAuthJson() },
        },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when transactions[0].inclusionProof is non-null (post-transfer-proven)', () => {
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [
        {
          data: makeTransferTxData(),
          inclusionProof: { some: 'proof' },
          _wallet: { authenticator: makeTransferAuthJson() },
        },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when tokenType is non-hex', () => {
    const bad = { ...makeMintDataJson(), tokenType: 'not-hex-zzz' };
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: bad, inclusionProof: null },
      transactions: [
        {
          data: makeTransferTxData(),
          inclusionProof: null,
          _wallet: { authenticator: makeTransferAuthJson() },
        },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when authenticator.publicKey has wrong length', () => {
    const badAuth = { ...makeTransferAuthJson(), publicKey: 'aabb' };
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [
        {
          data: makeTransferTxData(),
          inclusionProof: null,
          _wallet: { authenticator: badAuth },
        },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when authenticator missing algorithm/signature', () => {
    const badAuth: Record<string, unknown> = { publicKey: PUBKEY, stateHash: STATE_HASH };
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [
        {
          data: makeTransferTxData(),
          inclusionProof: null,
          _wallet: { authenticator: badAuth },
        },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when transfer recipient is empty string', () => {
    const badTx = { ...makeTransferTxData(), recipient: '' };
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [
        { data: badTx, inclusionProof: null, _wallet: { authenticator: makeTransferAuthJson() } },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });

  it('returns null when transfer salt is non-hex', () => {
    const badTx = { ...makeTransferTxData(), salt: 'not-hex' };
    const shape = {
      version: '2.0',
      state: { predicate: 'bb', data: null },
      genesis: { data: makeMintDataJson(), inclusionProof: null },
      transactions: [
        { data: badTx, inclusionProof: null, _wallet: { authenticator: makeTransferAuthJson() } },
      ],
      nametags: [],
    };
    expect(readV5FinalizationInputsFromToken(JSON.stringify(shape))).toBeNull();
  });
});
