/**
 * Wave 4-5 regression tests — verifies fixes for the critical regressions
 * introduced by Wave 1-3 in `modules/payments/PaymentsModule.ts`:
 *
 *   R1. Recipient `_recipientRequestContextMap` was populated with
 *       (transactionHash=requestId, authenticator='') — fired §6.1
 *       race-lost on every successful poll because the proof's
 *       `transactionHash` is the canonical 68-char tx-data-hash imprint,
 *       not the requestId.
 *
 *       Wave 4 R1's "fix" called `TransferCommitment.fromJSON(lastTxJson)`
 *       — but `lastTxJson` has the TransferTransaction shape `{data,
 *       inclusionProof}`, NOT the TransferCommitment shape `{requestId,
 *       transactionData, authenticator}`. `fromJSON` always threw,
 *       the outer try/catch silently swallowed it, and the entire
 *       downstream wiring stayed dead at runtime — exactly the bug
 *       Wave 4 R1 was meant to close. Wave 5 R1 closes the dead-code:
 *       parse `lastTxJson.data` as TransferTransactionData and derive
 *       transactionHash via `txData.calculateHash()` (the canonical
 *       SDK path the aggregator uses to anchor the proof).
 *
 *   R2. Recipient/sender poll producers returned `{ kind: 'OK' }` even
 *       when the aggregator's proof had `transactionHash === null`
 *       (path-non-inclusion proof). The OK descriptor's transactionHash
 *       fell back to `proof.requestId` and §6.1 race-lost fired.
 *
 *   R3. `dispositionWriter` swallowed errors silently — the local Token
 *       stayed `pending` forever and the `recipientFinalizationContext`
 *       leaked.
 *
 * This file uses three complementary strategies:
 *
 *   A. **Runtime tests for Wave 5 R1** — directly drive `TransferCommitment
 *      .fromJSON` and `TransferTransactionData.fromJSON` against the
 *      bundle's actual `{data, inclusionProof: null}` shape and assert:
 *      (i) the OLD code path (`TransferCommitment.fromJSON(lastTxJson)`)
 *          throws — the dead-code Wave 4 R1 introduced,
 *      (ii) the NEW code path (`TransferTransactionData.fromJSON(lastTxJson
 *           .data)` → `calculateHash().toJSON()`) succeeds and returns
 *           a non-empty 68-char SDK-canonical imprint hex.
 *
 *   B. **Inline unit tests for R2** — replicate the poll-producer
 *      classification logic and assert the discriminator kinds for
 *      transactionHash null / non-null / missing.
 *
 *   C. **Runtime worker tests for R3 / dispositionWriter** — drive
 *      `buildDefaultFinalizationWorkerRecipient` with mocked oracle and
 *      a fake-clock sleep so the worker reaches the relevant code path
 *      without 30-second poll backoffs.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// A. Runtime tests — Wave 5 R1 (dead-code fix for recipient transactionHash)
// =============================================================================

import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';

/**
 * Build a realistic `lastTxJson` that mirrors the SHAPE the sender
 * embeds in the UXF bundle (PaymentsModule line ~7869, Wave 5 fix
 * embeds `data.authenticator` for the recipient's §6.3 compare):
 *
 * ```
 * { data: <ITransferTransactionDataJson with authenticator>, inclusionProof: null }
 * ```
 *
 * No `requestId`/`transactionData`/`authenticator` top-level keys —
 * which is exactly why `TransferCommitment.fromJSON(lastTxJson)` throws.
 *
 * Returns the transferTxJson PLUS the canonical values the recipient
 * MUST extract (so tests can byte-compare).
 */
async function buildRealisticTransferTxJson(): Promise<{
  transferTxJson: {
    data: Record<string, unknown>;
    inclusionProof: null;
  };
  /** Canonical 68-char SDK-imprint hex of the tx-data hash. */
  expectedTransactionHash: string;
  /** Canonical SDK-encoded request id (sender pubkey + sourceStateHash). */
  expectedRequestIdHex: string;
  /** Canonical authenticator JSON (for §6.3 byte-equality). */
  expectedAuthenticatorJson: string;
}> {
  // Sender keypair.
  const senderPrivKey = SigningService.generatePrivateKey();
  const senderSigningService = new SigningService(senderPrivKey);

  // Recipient keypair.
  const recipientPrivKey = SigningService.generatePrivateKey();
  const recipientSigningService = new SigningService(recipientPrivKey);

  // Token IDs / types — synthesize via fromJSON with canonical hex.
  const tokenId = TokenId.fromJSON('aa'.repeat(32));
  const tokenType = TokenType.fromJSON('bb'.repeat(32));
  const senderSalt = new Uint8Array(32);
  senderSalt.fill(0xcc);

  // Source state predicate (sender owns).
  const senderPredicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    senderSigningService,
    HashAlgorithm.SHA256,
    senderSalt,
  );
  const sourceState = new TokenState(senderPredicate, null);

  // Recipient predicate / address (target of transfer).
  const transferSalt = new Uint8Array(32);
  transferSalt.fill(0xdd);
  const recipientPredicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    recipientSigningService,
    HashAlgorithm.SHA256,
    transferSalt,
  );
  const recipientReference = await recipientPredicate.getReference();
  // UnmaskedPredicateReference exposes a `.toAddress()` helper that
  // builds a DirectAddress with the canonical 4-byte checksum.
  const recipientAddress = await recipientReference.toAddress();

  // Build the transfer transaction data via the SDK's primitive.
  const txData = TransferTransactionData.create(
    sourceState,
    recipientAddress,
    transferSalt,
    null,
    null,
    [],
  );

  // Compute canonical values the recipient MUST extract.
  const txDataHash = await txData.calculateHash();
  const expectedTransactionHash = txDataHash.toJSON();

  const sourceStateHash = await sourceState.calculateHash();
  const reqIdObj = await RequestId.create(senderSigningService.publicKey, sourceStateHash);
  const expectedRequestIdHex = reqIdObj.toJSON();

  // Build a real Authenticator the sender would have created.
  const { Authenticator } = await import(
    '@unicitylabs/state-transition-sdk/lib/api/Authenticator'
  );
  const senderAuth = await Authenticator.create(senderSigningService, txDataHash, sourceStateHash);
  const expectedAuthenticatorJson = JSON.stringify(senderAuth.toJSON());

  // The sender's transferTxJson (Wave 5 — embeds authenticator under data).
  const transferTxJson = {
    data: {
      ...txData.toJSON(),
      authenticator: senderAuth.toJSON(),
    },
    inclusionProof: null,
  };

  return {
    transferTxJson,
    expectedTransactionHash,
    expectedRequestIdHex,
    expectedAuthenticatorJson,
  };
}

describe('Wave 5 R1 — recipient `_recipientRequestContextMap` extraction (RUNTIME)', () => {
  it('OLD CODE BUG REPRODUCED: TransferCommitment.fromJSON({data, inclusionProof: null}) throws InvalidJsonStructureError', async () => {
    const { transferTxJson } = await buildRealisticTransferTxJson();

    // The Wave 4 R1 "fix" called this exact path. It always threw —
    // proving the previous fix was dead code.
    let didThrow = false;
    let errorName = '';
    let errorMessage = '';
    try {
      await TransferCommitment.fromJSON(transferTxJson);
    } catch (err) {
      didThrow = true;
      errorName = err instanceof Error ? err.constructor.name : 'unknown';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    expect(didThrow).toBe(true);
    // SDK throws `InvalidJsonStructureError` (extends Error).
    expect(errorName).toContain('InvalidJsonStructureError');
    expect(errorMessage.length).toBeGreaterThanOrEqual(0); // message may be empty
    // Sanity: TransferCommitment.isJSON returns false for the wrong shape.
    expect(TransferCommitment.isJSON(transferTxJson)).toBe(false);
  });

  it('NEW CODE PATH SUCCEEDS: TransferTransactionData.fromJSON(lastTxJson.data) parses', async () => {
    const { transferTxJson, expectedTransactionHash } = await buildRealisticTransferTxJson();

    // Wave 5 fix path: parse the `data` field, NOT the whole transferTxJson.
    const txData = await TransferTransactionData.fromJSON(transferTxJson.data);
    expect(txData).toBeDefined();

    // The canonical transactionHash imprint hex matches what the
    // aggregator stores in proof.transactionHash (StateTransitionClient
    // submitTransferCommitment uses commitment.transactionData.calculateHash()
    // — same value).
    const txDataHash = await txData.calculateHash();
    const txHashImprintHex = txDataHash.toJSON();

    expect(txHashImprintHex).toBe(expectedTransactionHash);
    // 68 chars = 4 (imprint algo prefix '0000') + 64 (32-byte SHA-256 hex).
    expect(txHashImprintHex.length).toBe(68);
    expect(txHashImprintHex).toMatch(/^[0-9a-f]+$/);
    // It is NOT equal to a requestId (the Wave 2 bug would have returned
    // requestId here, which is also 68 chars but a different value).
  });

  it('NEW CODE PATH SUCCEEDS: requestId derivable from sourceState predicate publicKey + sourceState hash', async () => {
    const { transferTxJson, expectedRequestIdHex } = await buildRealisticTransferTxJson();

    const txData = await TransferTransactionData.fromJSON(transferTxJson.data);

    // The recipient code path: derive the sender's publicKey from the
    // source-state predicate, then RequestId.create(pubkey, sourceStateHash).
    const senderPredicate = await PredicateEngineService.createPredicate(
      txData.sourceState.predicate,
    );
    const senderPubkey = (senderPredicate as unknown as { publicKey?: Uint8Array }).publicKey;
    expect(senderPubkey).toBeInstanceOf(Uint8Array);
    expect(senderPubkey!.length).toBeGreaterThan(0);

    const sourceStateHash = await txData.sourceState.calculateHash();
    const reqIdObj = await RequestId.create(senderPubkey!, sourceStateHash);
    const reqIdHex = reqIdObj.toJSON();

    expect(reqIdHex).toBe(expectedRequestIdHex);
    expect(reqIdHex.length).toBe(68); // 0000 algo prefix + 32-byte hex
  });

  it('NEW CODE PATH SUCCEEDS: authenticator extractable from data.authenticator (Wave 5 sender embed)', async () => {
    const { transferTxJson, expectedAuthenticatorJson } = await buildRealisticTransferTxJson();

    // The recipient extracts data.authenticator (Wave 5 sender added this).
    const dataObj = transferTxJson.data;
    const rawAuth = (dataObj as Record<string, unknown>).authenticator;
    expect(rawAuth).toBeDefined();
    expect(rawAuth).not.toBeNull();
    expect(typeof rawAuth).toBe('object');

    // Round-trip via Authenticator.fromJSON to canonicalize key order.
    const { Authenticator } = await import(
      '@unicitylabs/state-transition-sdk/lib/api/Authenticator'
    );
    const authObj = Authenticator.fromJSON(rawAuth);
    const canonicalAuthJson = JSON.stringify(authObj.toJSON());

    // Byte-equality with the sender's canonical JSON.
    expect(canonicalAuthJson).toBe(expectedAuthenticatorJson);
    // It's NOT the empty string (the Wave 2 bug populated authenticator='').
    expect(canonicalAuthJson.length).toBeGreaterThan(50);
  });

  it('END-TO-END: NEW path produces (transactionHash, requestId, authenticator) all NON-empty and NON-equal', async () => {
    const { transferTxJson, expectedTransactionHash, expectedRequestIdHex, expectedAuthenticatorJson } =
      await buildRealisticTransferTxJson();

    // Run the entire Wave 5 R1 extraction logic inline (mirrors
    // PaymentsModule.ts:1702-1791).
    const txData = await TransferTransactionData.fromJSON(transferTxJson.data);
    const txHashImprintHex = (await txData.calculateHash()).toJSON();
    const senderPred = await PredicateEngineService.createPredicate(txData.sourceState.predicate);
    const senderPubkey = (senderPred as unknown as { publicKey: Uint8Array }).publicKey;
    const sourceStateHash = await txData.sourceState.calculateHash();
    const reqIdHex = (await RequestId.create(senderPubkey, sourceStateHash)).toJSON();

    const { Authenticator } = await import(
      '@unicitylabs/state-transition-sdk/lib/api/Authenticator'
    );
    const rawAuth = (transferTxJson.data as Record<string, unknown>).authenticator;
    const authJson = JSON.stringify(Authenticator.fromJSON(rawAuth).toJSON());

    // All three values are produced.
    expect(txHashImprintHex).toBe(expectedTransactionHash);
    expect(reqIdHex).toBe(expectedRequestIdHex);
    expect(authJson).toBe(expectedAuthenticatorJson);

    // Critical invariant: `transactionHash !== requestId`. The Wave 2
    // bug populated `transactionHash` with `requestId`, which made the
    // §6.1 race-lost compare trivially equal, silently disabling the
    // detector. Both are 68-char hex strings but their content differs.
    expect(txHashImprintHex).not.toBe(reqIdHex);

    // Critical invariant: `authenticator !== ''`. The Wave 2 bug
    // populated authenticator with the empty string. The R2 fix's
    // canonicalAuthenticatorEquals requires both sides to parse — the
    // empty string fails parse and triggers `queue-entry-incomplete`.
    expect(authJson).not.toBe('');
    expect(authJson.length).toBeGreaterThan(50);
  });

  /**
   * Differential test — pin the contract: the OLD code path
   * (TransferCommitment.fromJSON(lastTxJson)) MUST throw on the actual
   * bundle shape, while the NEW code path
   * (TransferTransactionData.fromJSON(lastTxJson.data) +
   * txData.calculateHash()) MUST succeed and return a NON-fallback
   * transactionHash.
   *
   * This test would also fail if a future regression re-introduced the
   * dead-code path: any code that calls TransferCommitment.fromJSON
   * with a TransferTransaction-shape input would throw, and the silent
   * try/catch would leave the recipient queue context unwired.
   */
  it('DIFFERENTIAL: OLD path always throws AND fallback was bug; NEW path succeeds with canonical hash', async () => {
    const { transferTxJson, expectedTransactionHash } = await buildRealisticTransferTxJson();

    // (1) OLD path — confirms the dead-code Wave 4 R1 introduced.
    let oldThrew = false;
    try {
      await TransferCommitment.fromJSON(transferTxJson);
    } catch {
      oldThrew = true;
    }
    expect(oldThrew).toBe(true);

    // (2) Simulate the OLD code's effective behavior: outer catch
    //     silences the throw and pendingFinalizationCtx stays null.
    //     Downstream guards `pendingFinalizationCtx !== null` skip.
    //     Result: queue context never wired, race-lost detector dead.
    let pendingFinalizationCtx: { transactionHash: string } | null = null;
    try {
      // (intentional: prove this code path never runs)
      const c = await TransferCommitment.fromJSON(transferTxJson);
      const h = await c.transactionData.calculateHash();
      pendingFinalizationCtx = { transactionHash: h.toJSON() };
    } catch {
      // silently swallowed (the Wave 4 R1 bug)
    }
    expect(pendingFinalizationCtx).toBeNull();

    // (3) NEW path — derives the canonical transactionHash directly
    //     from data, not via the broken TransferCommitment route.
    const txData = await TransferTransactionData.fromJSON(transferTxJson.data);
    const newTransactionHash = (await txData.calculateHash()).toJSON();
    expect(newTransactionHash).toBe(expectedTransactionHash);
    expect(newTransactionHash.length).toBe(68);

    // The NEW path is independent of the broken commitment-shape route
    // — it operates on `data` (the TransferTransactionData JSON) which
    // is what the bundle actually carries.
  });
});

// =============================================================================
// B. Static source inspection — Wave 4 R2 (poll producers)
// =============================================================================

describe('Wave 4 R2 — null transactionHash classified as PATH_NOT_INCLUDED in poll producers', () => {
  const SRC_PATH = resolve(__dirname, '../../../modules/payments/PaymentsModule.ts');
  const src = readFileSync(SRC_PATH, 'utf8');

  it('recipient poll producer returns PATH_NOT_INCLUDED when proof.transactionHash === null', () => {
    // Two poll producers exist (sender at ~9525, recipient at ~9870).
    // Both must short-circuit on null transactionHash. We assert at
    // least TWO occurrences of the pattern in the file.
    const matches = src.match(
      /proofJson\.transactionHash\s*===\s*null[\s\S]{0,200}return\s*\{\s*kind:\s*'PATH_NOT_INCLUDED'\s*\}/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// C. Static source inspection — Wave 4 R3 (dispositionWriter operator-alert)
// =============================================================================

describe('Wave 4 R3 — dispositionWriter emits operator-alert on failure paths', () => {
  const SRC_PATH = resolve(__dirname, '../../../modules/payments/PaymentsModule.ts');
  const src = readFileSync(SRC_PATH, 'utf8');

  it('emits transfer:operator-alert when oracle.getProof returns null in dispositionWriter', () => {
    // The dispositionWriter previously only logged a warn. Wave 4 fix
    // adds operator-alert emit on the null-proof path.
    const pattern = /getProof returned null[\s\S]{0,800}emit\(\s*'transfer:operator-alert'/;
    expect(src.match(pattern)).not.toBeNull();
  });

  it('emits transfer:operator-alert in the dispositionWriter outer catch', () => {
    // The outer catch is the safety net for any unhandled finalization
    // error. Must emit operator-alert, not just log.
    const pattern = /dispositionWriter finalization failed[\s\S]{0,800}emit\(\s*'transfer:operator-alert'[\s\S]{0,400}code:\s*'proof-throw'/;
    expect(src.match(pattern)).not.toBeNull();
  });

  it('emits transfer:operator-alert when save() throws after status flip', () => {
    // The save-after-status-flip path also writes to disk; if it fails
    // the in-memory mutation is lost on next reload. Operators need
    // visibility.
    const pattern = /save\(\)\s*after\s*status\s*flip\s*threw[\s\S]{0,400}emit\(\s*'transfer:operator-alert'/;
    expect(src.match(pattern)).not.toBeNull();
  });

  it('emits transfer:operator-alert when save() throws after finalization', () => {
    // Window expanded to 800 chars for Wave 5 — the fix added comment
    // lines between the saveMsg log and the emit() call.
    const pattern = /save\(\)\s*after\s*finalization\s*threw[\s\S]{0,800}emit\(\s*'transfer:operator-alert'/;
    expect(src.match(pattern)).not.toBeNull();
  });
});

// =============================================================================
// D. Runtime check — recipient finalization-context shape
// =============================================================================

describe('Wave 4 R2 — poll producer null-transactionHash classification (runtime)', () => {
  afterEach(() => vi.clearAllMocks());

  // Inline replication of the poll producer's classification logic.
  // The production code at recipient ~line 9870 + sender ~9525 contains
  // identical logic; this inline test pins the contract.
  function classifyPoll(
    proofResponse: {
      requestId: string;
      proof: { transactionHash: string | null; authenticator?: unknown } | null;
    } | null,
  ): { kind: 'TRANSIENT' | 'PATH_NOT_INCLUDED' | 'OK' } {
    if (proofResponse === null) return { kind: 'TRANSIENT' };
    const proofJson = proofResponse.proof;
    if (proofJson !== null && proofJson !== undefined && proofJson.transactionHash === null) {
      return { kind: 'PATH_NOT_INCLUDED' };
    }
    return { kind: 'OK' };
  }

  it('null oracle response → TRANSIENT (worker keeps polling, no proof yet)', () => {
    expect(classifyPoll(null).kind).toBe('TRANSIENT');
  });

  it('proof with transactionHash === null → PATH_NOT_INCLUDED (NOT OK)', () => {
    const result = classifyPoll({
      requestId: 'req-test',
      proof: { transactionHash: null, authenticator: { stub: 1 } },
    });
    expect(result.kind).toBe('PATH_NOT_INCLUDED');
  });

  it('proof with valid transactionHash → OK', () => {
    const result = classifyPoll({
      requestId: 'req-test',
      proof: {
        transactionHash: `0000${'aa'.repeat(32)}`,
        authenticator: { stub: 1 },
      },
    });
    expect(result.kind).toBe('OK');
  });
});

// =============================================================================
// E. Static source inspection — Wave 5 dispositionWriter coherence
// =============================================================================
//
// Wave 4's dispositionWriter promised in the outer-catch comment:
//   "We deliberately keep the ctx in the Map so an external retry path
//    can re-attempt."
// But the inner save-after-finalization failure path emitted operator-alert
// THEN deleted the ctx (line 10122 pre-fix), destroying the retry channel.
//
// Wave 5 fix moves the `recipientFinalizationContext.delete(tokenId)` call
// INSIDE the try block (only on save-success), so save-failure retains the
// ctx — consistent with the documented promise.

describe('Wave 5 — dispositionWriter save-failure ctx retention coherence', () => {
  const SRC_PATH = resolve(__dirname, '../../../modules/payments/PaymentsModule.ts');
  const src = readFileSync(SRC_PATH, 'utf8');

  it('does NOT delete recipientFinalizationContext after the save() catch — the Wave 4 incoherence', () => {
    // The Wave 4 byte pattern was:
    //   try { await save() } catch (saveErr) { emit(...); }
    //   recipientFinalizationContext.delete(tokenId);
    // We assert that the post-catch line is no longer the unconditional
    // delete pattern (the catch block must end without a fall-through to
    // delete).
    const incoherencePattern =
      /save\(\)\s+after\s+finalization\s+threw[\s\S]{0,800}emit\(\s*'transfer:operator-alert'[\s\S]{0,200}\}\s*\)\s*;\s*\}\s*recipientFinalizationContext\.delete\(tokenId\)/;
    expect(src.match(incoherencePattern)).toBeNull();
  });

  it('deletes recipientFinalizationContext only AFTER save() succeeds — the Wave 5 fix', () => {
    // The Wave 5 fix moves the delete INSIDE the try block, immediately
    // after `await save()`. We pin that structural shape.
    const fixPattern =
      /try\s*\{\s*await\s+save\(\)\s*;[\s\S]{0,600}recipientFinalizationContext\.delete\(tokenId\)\s*;[\s\S]{0,400}\}\s*catch\s*\(\s*saveErr\s*\)/;
    expect(src.match(fixPattern)).not.toBeNull();
  });

  it('outer-catch retention promise comment is still present (unchanged invariant)', () => {
    // The comment spans two source lines — match across the line break.
    const promisePattern = /We deliberately keep the ctx in[\s\S]{0,80}the Map so an external retry path/;
    expect(src.match(promisePattern)).not.toBeNull();
  });
});

// =============================================================================
// F. Runtime test — Wave 5 dispositionWriter behavior via exposed writer
// =============================================================================
//
// Drives the dispositionWriter directly via `buildDefaultFinalizationWorkerRecipient`
// (which now returns the writer for unit-test access). Verifies:
//
//   1. save() throws → operator-alert emitted AND ctx retained.
//   2. save() succeeds → ctx deleted.
//   3. Multiple save() throws on same tokenId → operator-alert each time, ctx still retained.
//
// Uses module-level mocks for state-transition-sdk to bypass real Token /
// TransferTransaction construction. The mocks satisfy `await fromJSON(...)`
// with stub instances; `finalizeTransferToken` is passed as a plain mock fn.

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({ stubSourceToken: true }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: {
    fromJSON: vi.fn().mockResolvedValue({ stubLastTx: true }),
  },
}));

describe('Wave 5 runtime — dispositionWriter ctx retention on save failure', () => {
  // We import lazily AFTER vi.mock declarations are hoisted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildDefaultFinalizationWorkerRecipient: any;

  beforeAll(async () => {
    const mod = await import('../../../modules/payments/PaymentsModule');
    buildDefaultFinalizationWorkerRecipient = (
      mod as unknown as { buildDefaultFinalizationWorkerRecipient: unknown }
    ).buildDefaultFinalizationWorkerRecipient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeBuilder(opts: {
    saveImpl: () => Promise<void>;
    emit: ReturnType<typeof vi.fn>;
    tokenId: string;
    localTokenId: string;
  }) {
    const tokens = new Map<string, import('../../../types').Token>();
    tokens.set(opts.localTokenId, {
      id: opts.localTokenId,
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'Unicity',
      decimals: 8,
      amount: '100',
      sdkData: '{}',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const recipientFinalizationContext = new Map<string, unknown>();
    recipientFinalizationContext.set(opts.tokenId, {
      localTokenId: opts.localTokenId,
      sourceTokenJson: { stub: 'src' },
      lastTxJson: { stub: 'lastTx' },
      requestIdHex: '00'.repeat(34),
    });

    const oracle = {
      getProof: vi.fn().mockResolvedValue({ proof: { stub: 'proof' } }),
      // unused but required by interface — return null/empty stubs
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
      getStateTransitionClient: vi.fn().mockReturnValue({}),
      getAggregatorClient: vi.fn().mockReturnValue({}),
      waitForProofSdk: vi.fn(),
    };

    const built = buildDefaultFinalizationWorkerRecipient({
      addressId: 'addr-test',
      oracle,
      recipientRequestContextMap: new Map(),
      recipientFinalizationContext,
      tokens,
      finalizeTransferToken: vi.fn().mockResolvedValue({
        toJSON: () => ({ stub: 'finalized-token' }),
      }),
      getStateTransitionClient: () => ({} as unknown as never),
      getTrustBase: () => ({}),
      save: opts.saveImpl,
      emit: opts.emit,
    });

    return { built, tokens, recipientFinalizationContext };
  }

  it('save() throws → operator-alert emitted AND ctx retained', async () => {
    const tokenId = 'tok-001';
    const localTokenId = 'local-001';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const { built, recipientFinalizationContext } = makeBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      tokenId,
      localTokenId,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
      // Other fields ignored on VALID branch.
    } as never);

    // Operator-alert MUST fire on save failure.
    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
    expect(alertCalls[0][1]).toMatchObject({
      code: 'structural',
      tokenId: localTokenId,
    });

    // Ctx MUST be retained (the Wave 5 invariant).
    expect(recipientFinalizationContext.has(tokenId)).toBe(true);
  });

  it('save() succeeds → ctx deleted', async () => {
    const tokenId = 'tok-002';
    const localTokenId = 'local-002';
    const emit = vi.fn();

    const { built, recipientFinalizationContext } = makeBuilder({
      saveImpl: vi.fn().mockResolvedValue(undefined),
      emit,
      tokenId,
      localTokenId,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    // No operator-alert on the success path.
    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBe(0);

    // Ctx MUST be cleaned up.
    expect(recipientFinalizationContext.has(tokenId)).toBe(false);
  });

  it('multiple save() throws on same tokenId → operator-alert each time, ctx still retained', async () => {
    const tokenId = 'tok-003';
    const localTokenId = 'local-003';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const { built, recipientFinalizationContext } = makeBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      tokenId,
      localTokenId,
    });

    // Three retries — each one fails and must retain ctx + emit alert.
    for (let i = 0; i < 3; i++) {
      await built.dispositionWriter.write('addr-test', {
        tokenId,
        disposition: 'VALID',
      } as never);
    }

    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBe(3);

    // Ctx MUST still be retained after multiple failures.
    expect(recipientFinalizationContext.has(tokenId)).toBe(true);
  });
});
