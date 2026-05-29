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
  // Sender keypair. Use canonical createFromSecret factory (P4 conformance:
  // raw `new SigningService(...)` is forbidden outside the ignorelist).
  const senderPrivKey = SigningService.generatePrivateKey();
  const senderSigningService = await SigningService.createFromSecret(senderPrivKey);

  // Recipient keypair.
  const recipientPrivKey = SigningService.generatePrivateKey();
  const recipientSigningService = await SigningService.createFromSecret(recipientPrivKey);

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

  it('HELPER FIXTURE ONLY: synthetic bundle exposes data.authenticator (legacy fixture; production senders do NOT embed)', async () => {
    // Wave 7 hygiene: this test exercises the test-only helper
    // `buildRealisticTransferTxJson()`, which constructs a bundle by
    // hand-mounting `data.authenticator`. It is NOT representative of
    // production behaviour: Wave 6 reverted Wave 5's sender-side embed
    // because the IPLD wire format (deconstructTransferData →
    // assembleTransactionData) does not preserve any
    // `data.authenticator` field. Real production bundles round-tripped
    // through the UXF pool always have `authenticator` absent at the
    // recipient, and the recipient deliberately stores `authenticator
    // = ''` in its queue entry. The §6.1 race-lost binding is
    // transactionHash-only; canonicalAuthenticatorEquals returns
    // 'match' on empty side, degrading the §6.3 most-recent-proof
    // metadata compare without rejecting valid proofs.
    //
    // The assertions below verify only that the helper itself is
    // self-consistent, not that production extracts the field.
    const { transferTxJson, expectedAuthenticatorJson } = await buildRealisticTransferTxJson();

    const dataObj = transferTxJson.data;
    const rawAuth = (dataObj as Record<string, unknown>).authenticator;
    expect(rawAuth).toBeDefined();
    expect(rawAuth).not.toBeNull();
    expect(typeof rawAuth).toBe('object');

    const { Authenticator } = await import(
      '@unicitylabs/state-transition-sdk/lib/api/Authenticator'
    );
    const authObj = Authenticator.fromJSON(rawAuth);
    const canonicalAuthJson = JSON.stringify(authObj.toJSON());

    expect(canonicalAuthJson).toBe(expectedAuthenticatorJson);
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

    // Wave 5 invariant (kept for historical context): the synthetic
    // `expectedAuthenticatorJson` produced by the test fixture is non-
    // empty when constructed directly via SDK primitives. NOTE: in the
    // REAL UXF round-trip the authenticator is dropped by the IPLD
    // pool (see Section I below: "Wave 6 — REAL UXF round-trip"). The
    // Wave 6 recipient extraction therefore stores `authenticator = ''`
    // deliberately, and the importer's canonicalAuthenticatorEquals
    // returns `'match'` on empty queue-entry, degrading to
    // transactionHash-only binding (the load-bearing check).
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
    // Window widened in Wave 6 — the fix added power-of-two backoff
    // streak tracking + comment lines between the saveMsg log and the
    // emit() call.
    const pattern = /save\(\)\s*after\s*status\s*flip\s*threw[\s\S]{0,1600}emit\(\s*'transfer:operator-alert'/;
    expect(src.match(pattern)).not.toBeNull();
  });

  it('emits transfer:operator-alert when save() throws after finalization', () => {
    // Window expanded to 800 chars for Wave 5 — the fix added comment
    // lines between the saveMsg log and the emit() call.
    // Wave 6 — further widened for the saveFailureStreak backoff block.
    const pattern = /save\(\)\s*after\s*finalization\s*threw[\s\S]{0,1600}emit\(\s*'transfer:operator-alert'/;
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
    //
    // Issue #195 follow-up: the post-delete window inside the try was
    // widened from 400 to 1200 chars to accommodate the new
    // `transfer:confirmed` emit (plus its comment block) that fires AFTER
    // the delete inside the try. The structural invariant — delete is
    // AFTER save(), INSIDE the try — is unchanged.
    const fixPattern =
      /try\s*\{\s*await\s+save\(\)\s*;[\s\S]{0,600}recipientFinalizationContext\.delete\(tokenId\)\s*;[\s\S]{0,1200}\}\s*catch\s*\(\s*saveErr\s*\)/;
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

  it('multiple save() throws on same tokenId → power-of-two backoff (Wave 6), ctx still retained', async () => {
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

    // Wave 6 backoff: alerts only at power-of-two boundaries.
    // Three retries → alerts at attempts 1 and 2 (streak = 1, 2 are
    // powers of two). Attempt 3 (streak = 3) is NOT a power of two
    // and must be silenced.
    for (let i = 0; i < 3; i++) {
      await built.dispositionWriter.write('addr-test', {
        tokenId,
        disposition: 'VALID',
      } as never);
    }

    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBe(2);

    // Ctx MUST still be retained after multiple failures.
    expect(recipientFinalizationContext.has(tokenId)).toBe(true);
  });
});

// =============================================================================
// G. Wave 6 critical — fallback status-flip path delete-before-save fix
// =============================================================================
//
// The Wave 5 fix moved `delete(tokenId)` inside the try block on the MAIN
// success path (stClient/trustBase available). The FALLBACK path (when
// stClient/trustBase are missing) had the OLD bug: delete BEFORE save().
// If save() threw on the fallback path, ctx was already removed (no retry
// possible) AND the in-memory token flipped to 'confirmed' while storage
// still showed 'pending' — token permanently stuck on next reload.
//
// This block drives `buildDefaultFinalizationWorkerRecipient` with
// `getStateTransitionClient: () => undefined` to force the fallback path,
// then asserts the same retain-on-throw / delete-on-success contract.

describe('Wave 6 critical — dispositionWriter fallback status-flip ctx retention', () => {
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

  function makeFallbackBuilder(opts: {
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
      // Force the FALLBACK path — stClient/trustBase missing.
      getStateTransitionClient: () => undefined,
      getTrustBase: () => undefined,
      save: opts.saveImpl,
      emit: opts.emit,
    });

    return { built, tokens, recipientFinalizationContext };
  }

  it('FALLBACK: save() throws → ctx retained (Wave 6 critical fix)', async () => {
    const tokenId = 'tok-fb-001';
    const localTokenId = 'local-fb-001';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const { built, recipientFinalizationContext, tokens } = makeFallbackBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      tokenId,
      localTokenId,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    // Operator-alert MUST fire on save failure (first attempt = streak 1
    // = power-of-two boundary).
    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
    expect(alertCalls[0][1]).toMatchObject({
      code: 'structural',
      tokenId: localTokenId,
    });

    // Ctx MUST be retained — the Wave 6 critical invariant. Without
    // this, a save() throw on the fallback path made the token
    // permanently stuck (ctx gone, in-memory mutation lost on reload).
    expect(recipientFinalizationContext.has(tokenId)).toBe(true);

    // Wave 6 critical fix: in-memory token is rolled back to 'pending'
    // on save failure so the retry path can re-enter the
    // `status === 'pending'` guard. Without rollback, the second
    // retry would observe `status === 'confirmed'` and skip the
    // entire fallback block — never re-attempting save().
    expect(tokens.get(localTokenId)?.status).toBe('pending');
  });

  it('FALLBACK: save() succeeds → ctx deleted', async () => {
    const tokenId = 'tok-fb-002';
    const localTokenId = 'local-fb-002';
    const emit = vi.fn();

    const { built, recipientFinalizationContext } = makeFallbackBuilder({
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

    // Ctx MUST be cleaned up after persistence succeeds.
    expect(recipientFinalizationContext.has(tokenId)).toBe(false);
  });

  it('Wave 7 hygiene: clearSaveFailureStreak() wipes per-tokenId entries', async () => {
    // The closure-local `saveFailureStreak` Map accumulates entries
    // for tokens that hit save() failures and never reach success.
    // If the token leaves the wallet (tombstone, address switch),
    // the entry is orphaned. Wave 7 exposes a `clearSaveFailureStreak`
    // callback the PaymentsModule.destroy() path invokes so the Map
    // doesn't outlive the recipient context map.
    const tokenIds = ['tok-cleanup-1', 'tok-cleanup-2', 'tok-cleanup-3'];
    const emit = vi.fn();

    // Build with a long sequence of failures to populate the streak.
    const harness = makeFallbackBuilder({
      saveImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      emit,
      tokenId: tokenIds[0],
      localTokenId: 'local-cleanup-1',
    });
    // Drive multiple failures so the Map accumulates.
    for (let i = 0; i < 3; i++) {
      await harness.built.dispositionWriter.write('addr-test', {
        tokenId: tokenIds[0],
        disposition: 'VALID',
      } as never);
    }

    // The Map is closure-local; we can't observe its size directly.
    // But we CAN observe the alert pattern — power-of-two boundaries
    // (1, 2). Then clear, then drive again: the streak resets to 0
    // and a new failure-1 alert fires.
    const alertsBefore = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    ).length;
    expect(alertsBefore).toBeGreaterThanOrEqual(2);

    // Invoke the new cleanup callback.
    expect(typeof harness.built.clearSaveFailureStreak).toBe('function');
    harness.built.clearSaveFailureStreak();

    // Re-seed the context (the writer deletes ctx ONLY on save success;
    // since save kept throwing, ctx is still present per Wave 6 design).
    expect(harness.recipientFinalizationContext.has(tokenIds[0])).toBe(true);

    // Drive one more failure — the streak counter for this token was
    // wiped, so this is "first" again and an alert fires.
    emit.mockClear();
    await harness.built.dispositionWriter.write('addr-test', {
      tokenId: tokenIds[0],
      disposition: 'VALID',
    } as never);
    const alertsAfter = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    ).length;
    // Streak counter reset → first failure of new streak hits power-
    // of-two boundary (1) → alert fires.
    expect(alertsAfter).toBe(1);
  });

  it('Wave 7 CAS: rollback skips when concurrent mutation supplants `updatedFallback`', async () => {
    // Wave 6 rolled back the in-memory `tokens.set(localTokenId, stored)`
    // unconditionally on save() failure. If a concurrent mutation
    // landed during the await window — replacing our updated value
    // with a newer one — the rollback would clobber it. Wave 7 adds
    // CAS: only restore `stored` when the current Map value is still
    // our updated value.
    //
    // Reproduce by injecting a concurrent mutation inside the
    // simulated save() throw — the save promise rejects only after
    // we've installed a competing token shape.
    const tokenId = 'tok-fb-cas-001';
    const localTokenId = 'local-fb-cas-001';
    const emit = vi.fn();

    let tokensRef: Map<string, import('../../../types').Token> | null = null;

    // saveImpl that mutates `tokens` to a third value before throwing.
    const concurrentToken: import('../../../types').Token = {
      id: localTokenId,
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'Unicity',
      decimals: 8,
      // Sentinel value the rollback MUST NOT clobber.
      amount: 'CONCURRENT-WINS',
      sdkData: '{"concurrent":true}',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const saveImpl = vi.fn().mockImplementation(async () => {
      // Simulate a concurrent path winning during the await.
      tokensRef!.set(localTokenId, concurrentToken);
      throw new Error('disk full (after concurrent mutation)');
    });

    const harness = makeFallbackBuilder({
      saveImpl,
      emit,
      tokenId,
      localTokenId,
    });
    tokensRef = harness.tokens;

    await harness.built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    // The CAS rollback compared `tokens.get(localTokenId)` vs our
    // `updatedFallback` — they differed (concurrent mutation), so
    // the rollback was skipped. Concurrent mutation is preserved.
    const final = harness.tokens.get(localTokenId);
    expect(final).toBeDefined();
    expect(final?.amount).toBe('CONCURRENT-WINS');
    expect(final?.sdkData).toBe('{"concurrent":true}');
  });

  it('Wave 7 CAS: rollback proceeds when no concurrent mutation occurred', async () => {
    // Counter-test: the normal case where save() throws and no
    // concurrent path interfered. CAS observes our `updatedFallback`
    // is still current → rolls back to `stored` so the retry sees
    // `status === 'pending'` and re-enters the fallback block.
    const tokenId = 'tok-fb-cas-002';
    const localTokenId = 'local-fb-cas-002';
    const emit = vi.fn();

    const harness = makeFallbackBuilder({
      saveImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      emit,
      tokenId,
      localTokenId,
    });

    await harness.built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    const final = harness.tokens.get(localTokenId);
    expect(final).toBeDefined();
    expect(final?.status).toBe('pending');
  });

  it('FALLBACK: power-of-two save-failure backoff applies on the fallback path', async () => {
    const tokenId = 'tok-fb-003';
    const localTokenId = 'local-fb-003';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const { built, recipientFinalizationContext } = makeFallbackBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      tokenId,
      localTokenId,
    });

    // Three retries on same tokenId → alerts at streak=1 and streak=2
    // (powers of two), silenced at streak=3.
    for (let i = 0; i < 3; i++) {
      await built.dispositionWriter.write('addr-test', {
        tokenId,
        disposition: 'VALID',
      } as never);
    }

    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBe(2);

    // Ctx still retained after all retries.
    expect(recipientFinalizationContext.has(tokenId)).toBe(true);
  });
});

// =============================================================================
// H. Wave 6 — saveFailureStreak backoff (independent counters per tokenId)
// =============================================================================

describe('Wave 6 — dispositionWriter save-failure backoff', () => {
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

  function makeSharedBuilder(opts: {
    saveImpl: () => Promise<void>;
    emit: ReturnType<typeof vi.fn>;
    seedTokens: ReadonlyArray<{ tokenId: string; localTokenId: string }>;
  }) {
    const tokens = new Map<string, import('../../../types').Token>();
    const recipientFinalizationContext = new Map<string, unknown>();
    for (const seed of opts.seedTokens) {
      tokens.set(seed.localTokenId, {
        id: seed.localTokenId,
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
      recipientFinalizationContext.set(seed.tokenId, {
        localTokenId: seed.localTokenId,
        sourceTokenJson: { stub: 'src' },
        lastTxJson: { stub: 'lastTx' },
        requestIdHex: '00'.repeat(34),
      });
    }

    const oracle = {
      getProof: vi.fn().mockResolvedValue({ proof: { stub: 'proof' } }),
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
      getStateTransitionClient: vi.fn().mockReturnValue({}),
      getAggregatorClient: vi.fn().mockReturnValue({}),
      waitForProofSdk: vi.fn(),
    };

    return buildDefaultFinalizationWorkerRecipient({
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
  }

  it('save() throws repeatedly on same tokenId → alerts only at power-of-two boundaries (1, 2, 4, 8)', async () => {
    const tokenId = 'tok-streak-001';
    const localTokenId = 'local-streak-001';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const built = makeSharedBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      seedTokens: [{ tokenId, localTokenId }],
    });

    // 8 attempts → alerts at attempts 1, 2, 4, 8 = 4 alerts.
    for (let i = 0; i < 8; i++) {
      await built.dispositionWriter.write('addr-test', {
        tokenId,
        disposition: 'VALID',
      } as never);
    }

    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBe(4);
  });

  it('save() throws → succeeds → throws again → streak resets, alert fires on first throw of new streak', async () => {
    const tokenId = 'tok-streak-002';
    const localTokenId = 'local-streak-002';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    // Toggle save: throw, throw, succeed, throw
    let callCount = 0;
    const saveImpl = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 3) return; // succeeds
      throw saveErr;
    });

    const built = makeSharedBuilder({
      saveImpl,
      emit,
      seedTokens: [{ tokenId, localTokenId }],
    });

    // Attempt 1 → throw, streak=1, alert
    // Attempt 2 → throw, streak=2, alert
    // Attempt 3 → success, streak resets to 0, ctx deleted
    // (After ctx deleted, subsequent disposition writes early-return
    //  on the "no finalization context" branch — re-seed before next
    //  failure.)
    for (let i = 0; i < 3; i++) {
      await built.dispositionWriter.write('addr-test', {
        tokenId,
        disposition: 'VALID',
      } as never);
    }
    expect(emit.mock.calls.filter((c) => c[0] === 'transfer:operator-alert').length).toBe(2);

    // Streak reset semantic: simulate a NEW finalization round on the
    // same tokenId (re-seed ctx + token to pending) and assert the
    // first failure fires an alert (streak counter was reset on the
    // prior success). We re-build the worker so the ctx map is fresh.
    const emit2 = vi.fn();
    const built2 = makeSharedBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit: emit2,
      seedTokens: [{ tokenId, localTokenId }],
    });
    await built2.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);
    // Fresh streak in fresh builder → first failure = streak=1 = alert.
    expect(emit2.mock.calls.filter((c) => c[0] === 'transfer:operator-alert').length).toBe(1);
  });

  it('different tokenIds have independent counters — saveFailureStreak keyed per token', async () => {
    const tokenIdA = 'tok-streak-A';
    const localTokenIdA = 'local-streak-A';
    const tokenIdB = 'tok-streak-B';
    const localTokenIdB = 'local-streak-B';
    const emit = vi.fn();
    const saveErr = new Error('disk full');

    const built = makeSharedBuilder({
      saveImpl: vi.fn().mockRejectedValue(saveErr),
      emit,
      seedTokens: [
        { tokenId: tokenIdA, localTokenId: localTokenIdA },
        { tokenId: tokenIdB, localTokenId: localTokenIdB },
      ],
    });

    // Alternate A, A, A, B — A's streak is 3 (alerts at 1,2 only),
    // B's first attempt is streak=1 (independent counter, alerts).
    await built.dispositionWriter.write('addr-test', { tokenId: tokenIdA, disposition: 'VALID' } as never);
    await built.dispositionWriter.write('addr-test', { tokenId: tokenIdA, disposition: 'VALID' } as never);
    await built.dispositionWriter.write('addr-test', { tokenId: tokenIdA, disposition: 'VALID' } as never);
    await built.dispositionWriter.write('addr-test', { tokenId: tokenIdB, disposition: 'VALID' } as never);

    const alertCalls = emit.mock.calls.filter((c) => c[0] === 'transfer:operator-alert');
    // A: alerts at streak 1, 2 = 2 alerts.
    // B: alert at streak 1 = 1 alert.
    // Total = 3 alerts.
    expect(alertCalls.length).toBe(3);

    const alertsForA = alertCalls.filter((c) => (c[1] as { tokenId?: string }).tokenId === localTokenIdA);
    const alertsForB = alertCalls.filter((c) => (c[1] as { tokenId?: string }).tokenId === localTokenIdB);
    expect(alertsForA.length).toBe(2);
    expect(alertsForB.length).toBe(1);
  });
});

// =============================================================================
// I. Wave 6 — REAL UXF round-trip pipeline test (closes Wave 5 dead-code regression)
// =============================================================================
//
// This is the meta-fix for the Wave 5 regression. The Wave 5 byte-pattern
// + synthetic test gave false confidence: it built `transferTxJson`
// directly and ran the recipient extraction on it. It NEVER round-tripped
// through `pkg.ingestAll → pkg.toCar → UxfPackage.fromCar → pkg.assemble`.
//
// In production the bundle is handed to `pkg.ingestAll(...)` which calls
// `deconstructTransferData` (uxf/deconstruct.ts:486-512). That function
// only deconstructs the explicit fields {recipient, salt, recipientDataHash,
// message, nametagRefs} — `data.authenticator` is silently DROPPED from
// the IPLD pool. On the recipient side `pkg.assemble(tokenId)` calls
// `assembleTransactionData` (uxf/assemble.ts:361-398) which returns ONLY
// {sourceState, recipient, salt, recipientDataHash, message, nametags}.
//
// Therefore `lastTxJson.data.authenticator` is `undefined` for EVERY
// production bundle, and the Wave 5 sender-side embed was dead code.
//
// Wave 6 fix: degrade gracefully. The recipient sets `authenticator = ''`
// deliberately and `canonicalAuthenticatorEquals` treats empty queue-
// entry as `'match'`. The §6.1 race-lost binding is via `transactionHash`
// (load-bearing); §6.3 most-recent-proof binding compares aggregator-
// returned authenticators on both sides — the queue entry's is metadata
// only.

describe('Wave 6 — REAL UXF round-trip: pkg.ingestAll → toCar → fromCar → assemble', () => {
  it('proves the dead-code: round-trip drops `data.authenticator` from the IPLD pool', async () => {
    const { transferTxJson } = await buildRealisticTransferTxJson();

    // Confirm the input transferTxJson DOES carry data.authenticator
    // (Wave 5 sender-embed shape).
    expect(transferTxJson.data.authenticator).toBeDefined();
    expect(typeof transferTxJson.data.authenticator).toBe('object');

    // Build a containing token JSON. Use TOKEN_B as the template (it has
    // a non-empty transactions[] array) and replace the only transaction
    // with a hand-built one that carries `data.authenticator`. The
    // token's tokenId and predicates are taken from TOKEN_B — we only
    // inspect transaction[0].data post-round-trip.
    const { TOKEN_B } = await import('../../fixtures/uxf-mock-tokens');
    const tokenJson: Record<string, unknown> = JSON.parse(JSON.stringify(TOKEN_B));

    // Replace transactions[0].data — preserving TOKEN_B's sourceState
    // shape so the IPLD instance-chain check is satisfied. The crucial
    // additional field is `authenticator` (the Wave 5 sender embed).
    const txArr = tokenJson.transactions as Record<string, unknown>[];
    const origData = txArr[0]!.data as Record<string, unknown>;
    txArr[0] = {
      data: {
        ...origData,
        // Wave 5 sender embed (pre-Wave-6 fix). We assert this is
        // dropped on round-trip.
        authenticator: transferTxJson.data.authenticator,
      },
      inclusionProof: txArr[0]!.inclusionProof,
    };

    // Round-trip via ingestAll → toCar → fromCar → assemble.
    const { UxfPackage } = await import('../../../uxf/UxfPackage');
    const pkg = UxfPackage.create();
    pkg.ingestAll([tokenJson]);
    const carBytes = await pkg.toCar();
    const restored = await UxfPackage.fromCar(carBytes);
    const tokenId = (
      (tokenJson.genesis as Record<string, unknown>).data as Record<string, unknown>
    ).tokenId as string;
    const reassembled = restored.assemble(tokenId) as Record<string, unknown>;

    const reassembledTxs = reassembled.transactions as Record<string, unknown>[];
    expect(reassembledTxs.length).toBe(1);
    const reassembledData = reassembledTxs[0]!.data as Record<string, unknown>;

    // PROOF OF DEAD-CODE: data.authenticator is DROPPED by the IPLD
    // round-trip. This is the bug Wave 5 missed — its byte-pattern
    // test built transferTxJson standalone and never observed this drop.
    expect(reassembledData.authenticator).toBeUndefined();

    // The other fields ARE preserved by the IPLD round-trip.
    expect(reassembledData.recipient).toBe(origData.recipient);
    expect(reassembledData.salt).toBe(origData.salt);
  });

  it('Wave 6 recipient extraction: transactionHash + requestId derivable from round-tripped data', async () => {
    // Build a token whose sourceState IS the SDK-built canonical state
    // from buildRealisticTransferTxJson — so PredicateEngineService can
    // recover the sender's publicKey.
    const { transferTxJson, expectedTransactionHash, expectedRequestIdHex } =
      await buildRealisticTransferTxJson();

    const { TOKEN_B } = await import('../../fixtures/uxf-mock-tokens');
    const tokenJson: Record<string, unknown> = JSON.parse(JSON.stringify(TOKEN_B));
    const txArr = tokenJson.transactions as Record<string, unknown>[];
    txArr[0] = {
      data: {
        sourceState: (transferTxJson.data as Record<string, unknown>).sourceState,
        recipient: (transferTxJson.data as Record<string, unknown>).recipient,
        salt: (transferTxJson.data as Record<string, unknown>).salt,
        recipientDataHash:
          (transferTxJson.data as Record<string, unknown>).recipientDataHash ?? null,
        message: (transferTxJson.data as Record<string, unknown>).message ?? null,
        nametags: [],
      },
      inclusionProof: null,
    };

    const { UxfPackage } = await import('../../../uxf/UxfPackage');
    const pkg = UxfPackage.create();
    pkg.ingestAll([tokenJson]);
    const carBytes = await pkg.toCar();
    const restored = await UxfPackage.fromCar(carBytes);
    const tokenId = (
      (tokenJson.genesis as Record<string, unknown>).data as Record<string, unknown>
    ).tokenId as string;
    const reassembled = restored.assemble(tokenId) as Record<string, unknown>;

    const reassembledTxs = reassembled.transactions as Record<string, unknown>[];
    const reassembledData = reassembledTxs[0]!.data as Record<string, unknown>;

    // Run the Wave 6 recipient extraction logic on the ROUND-TRIPPED data.
    const txData = await TransferTransactionData.fromJSON(reassembledData);
    const txHashImprintHex = (await txData.calculateHash()).toJSON();
    const senderPredicate = await PredicateEngineService.createPredicate(
      txData.sourceState.predicate,
    );
    const senderPubkey = (senderPredicate as unknown as { publicKey: Uint8Array })
      .publicKey;
    const sourceStateHash = await txData.sourceState.calculateHash();
    const reqIdObj = await RequestId.create(senderPubkey, sourceStateHash);
    const reqIdHex = reqIdObj.toJSON();

    // The transactionHash + requestId ARE derivable from the round-
    // tripped data — they survive because sourceState + recipient +
    // salt + recipientDataHash + nametags all round-trip intact and
    // that's everything the canonical hash needs.
    expect(txHashImprintHex).toBe(expectedTransactionHash);
    expect(txHashImprintHex.length).toBe(68);
    expect(reqIdHex).toBe(expectedRequestIdHex);
    expect(reqIdHex.length).toBe(68);

    // The authenticator is ABSENT by design after round-trip. Wave 6
    // sets the queue entry's authenticator to '' and the importer's
    // canonicalAuthenticatorEquals treats this as 'match' (degrade to
    // transactionHash-only binding).
    expect(reassembledData.authenticator).toBeUndefined();
  });

  it('importInclusionProof: empty queue-entry authenticator → graft applied (Wave 6 graceful degradation)', async () => {
    // Drive importInclusionProof end-to-end with the production state:
    // queue entry has `authenticator: ''` (the post-round-trip state).
    // The importer must succeed via transactionHash-only binding.
    const {
      InclusionProofImporter,
    } = await import('../../../modules/payments/transfer/import-inclusion-proof');

    const TOKEN_HEX = 'aa'.repeat(32);
    const REQ_ID = 'rq-wave6';
    const TX_HASH = '0000' + 'ab'.repeat(32);

    const manifestEntries = new Map<string, unknown>();
    manifestEntries.set(`addr1:${TOKEN_HEX}`, {
      tokenId: TOKEN_HEX,
      status: 'pending',
      rootHash: 'aa'.repeat(32),
      bundleCid: '',
      senderTransportPubkey: '',
      cidEpoch: 0,
      lamport: 0,
    });

    let graftCalled = false;
    const importer = new InclusionProofImporter({
      manifestStore: {
        readEntry: async (_addr: string, tid: string) =>
          manifestEntries.get(`${_addr}:${tid}`) as never,
      },
      dispositionStorage: {
        readRecord: async () => undefined,
        writeRecord: async () => undefined,
        deleteRecord: async () => undefined,
      } as never,
      queueScanner: {
        lookupByTokenId: async () => [
          {
            entryId: 'e1',
            tokenId: TOKEN_HEX,
            commitmentRequestId: REQ_ID,
            transactionHash: TX_HASH,
            authenticator: '', // production state post-round-trip
            txIndex: 0,
            status: 'pending' as const,
          },
        ],
      },
      verifyProof: async () => 'OK' as const,
      graftCallback: {
        graft: async () => {
          graftCalled = true;
        },
      },
      overrideCallback: {
        applyOverride: async () => undefined,
      },
      emit: () => undefined,
    });

    const result = await importer.importInclusionProof('addr1', TOKEN_HEX, {
      requestId: REQ_ID,
      transactionHash: TX_HASH,
      authenticator: 'any-authenticator-from-aggregator-anchored-proof',
      proof: { stub: true },
    });

    // CRITICAL: with the Wave 6 fix the import succeeds — the empty
    // queue-entry authenticator degrades to transactionHash-only
    // binding (the load-bearing check).
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition).toBe('pending→valid');
    }
    expect(graftCalled).toBe(true);
  });

  it('importInclusionProof: empty queue-entry authenticator + transactionHash MISMATCH → proof-binding-mismatch', async () => {
    // The transactionHash check is load-bearing. Even with the Wave 6
    // graceful degradation for authenticator, a transactionHash mismatch
    // MUST fail the binding.
    const {
      InclusionProofImporter,
    } = await import('../../../modules/payments/transfer/import-inclusion-proof');

    const TOKEN_HEX = 'bb'.repeat(32);
    const REQ_ID = 'rq-wave6-tx-mm';

    const manifestEntries = new Map<string, unknown>();
    manifestEntries.set(`addr1:${TOKEN_HEX}`, {
      tokenId: TOKEN_HEX,
      status: 'pending',
      rootHash: 'bb'.repeat(32),
      bundleCid: '',
      senderTransportPubkey: '',
      cidEpoch: 0,
      lamport: 0,
    });

    let graftCalled = false;
    const importer = new InclusionProofImporter({
      manifestStore: {
        readEntry: async (_addr: string, tid: string) =>
          manifestEntries.get(`${_addr}:${tid}`) as never,
      },
      dispositionStorage: {
        readRecord: async () => undefined,
        writeRecord: async () => undefined,
        deleteRecord: async () => undefined,
      } as never,
      queueScanner: {
        lookupByTokenId: async () => [
          {
            entryId: 'e1',
            tokenId: TOKEN_HEX,
            commitmentRequestId: REQ_ID,
            transactionHash: '0000' + 'ab'.repeat(32),
            authenticator: '',
            txIndex: 0,
            status: 'pending' as const,
          },
        ],
      },
      verifyProof: async () => 'OK' as const,
      graftCallback: {
        graft: async () => {
          graftCalled = true;
        },
      },
      overrideCallback: {
        applyOverride: async () => undefined,
      },
      emit: () => undefined,
    });

    const result = await importer.importInclusionProof('addr1', TOKEN_HEX, {
      requestId: REQ_ID,
      // Different transactionHash (load-bearing check binds).
      transactionHash: '0000' + 'cd'.repeat(32),
      authenticator: 'whatever',
      proof: { stub: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('proof-binding-mismatch');
    }
    expect(graftCalled).toBe(false);
  });
});

// =============================================================================
// I. Issue #195 follow-up — dispositionWriter emits `transfer:confirmed`
// =============================================================================
//
// Pins the contract added by commit 360ed22 (`fix(payments)(#195): emit
// transfer:confirmed from recipient dispositionWriter`): both the main
// success path AND the stClient/trustBase-missing fallback path MUST emit
// `transfer:confirmed` after `await save()` succeeds, so listeners
// (notably AccountingModule) learn the inbound deposit token is now
// aggregator-confirmed and `invoice:covered` can re-fire with
// `confirmed: true`.
//
// Without this emit, the escrow swap orchestrator hangs at
// PARTIAL_DEPOSIT even after the CAS-mismatch fix unblocks step 5 —
// see sphere-sdk issue #195 and sphere-cli PR #16 / issue #163.
//
// Reuses the module-level mocks declared at the top of section F.

describe('Issue #195 — dispositionWriter emits transfer:confirmed', () => {
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

  /**
   * Build a builder configured for the issue #195 follow-up tests.
   * Mirrors the section-F `makeBuilder` shape but parameterises whether
   * `getStateTransitionClient` returns a stub (main path) or undefined
   * (fallback path).
   */
  function makeBuilder(opts: {
    saveImpl: () => Promise<void>;
    emit: ReturnType<typeof vi.fn>;
    tokenId: string;
    localTokenId: string;
    stClientAvailable: boolean;
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
      // Returning undefined here forces the fallback path; returning a
      // stub object exercises the main success path. The trustBase
      // companion getter follows the same toggle.
      getStateTransitionClient: () => (opts.stClientAvailable ? ({} as unknown) : undefined),
      getTrustBase: () => (opts.stClientAvailable ? ({}) : undefined),
      save: opts.saveImpl,
      emit: opts.emit,
    });

    return { built, tokens };
  }

  it('main success path → emits transfer:confirmed with the updated token', async () => {
    const tokenId = 'tok-issue195-main';
    const localTokenId = 'local-issue195-main';
    const emit = vi.fn();

    const { built, tokens } = makeBuilder({
      saveImpl: vi.fn().mockResolvedValue(undefined),
      emit,
      tokenId,
      localTokenId,
      stClientAvailable: true,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    const confirmedCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:confirmed',
    );
    expect(confirmedCalls).toHaveLength(1);

    const payload = confirmedCalls[0][1];
    expect(payload).toMatchObject({
      status: 'completed',
    });
    expect(typeof payload.id).toBe('string');
    expect(payload.id.length).toBeGreaterThan(0);
    expect(payload.tokens).toHaveLength(1);
    expect(payload.tokens[0]).toMatchObject({
      id: localTokenId,
      status: 'confirmed',
    });
    // The main path overwrites sdkData with the finalized form before
    // emitting — distinct from the fallback path which preserves the
    // sender-predicate sdkData.
    expect(payload.tokens[0].sdkData).toBe(
      JSON.stringify({ stub: 'finalized-token' }),
    );
    expect(payload.tokenTransfers).toEqual([]);

    // Local token also reflects the confirmed state.
    expect(tokens.get(localTokenId)?.status).toBe('confirmed');
  });

  it('stClient-fallback path (stClient/trustBase missing) → emits transfer:confirmed with sender-predicate sdkData', async () => {
    const tokenId = 'tok-issue195-fallback';
    const localTokenId = 'local-issue195-fallback';
    const emit = vi.fn();

    const { built, tokens } = makeBuilder({
      saveImpl: vi.fn().mockResolvedValue(undefined),
      emit,
      tokenId,
      localTokenId,
      stClientAvailable: false,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    const confirmedCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:confirmed',
    );
    expect(confirmedCalls).toHaveLength(1);

    const payload = confirmedCalls[0][1];
    expect(payload.tokens[0]).toMatchObject({
      id: localTokenId,
      status: 'confirmed',
    });
    // CAVEAT (pinned by the in-source comment): the fallback path does
    // NOT re-finalize sdkData — it stays in sender-predicate form. The
    // emit is for accounting attribution only; subsequent spend MUST
    // wait until the NOSTR-FIRST finalization path overwrites sdkData.
    expect(payload.tokens[0].sdkData).toBe('{}');

    expect(tokens.get(localTokenId)?.status).toBe('confirmed');
  });

  it('main path save() throws → no transfer:confirmed emit (emit is INSIDE try, after save)', async () => {
    const tokenId = 'tok-issue195-save-throws-main';
    const localTokenId = 'local-issue195-save-throws-main';
    const emit = vi.fn();

    const { built } = makeBuilder({
      saveImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      emit,
      tokenId,
      localTokenId,
      stClientAvailable: true,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    // The emit lives inside `try { await save(); ... emit(...); }` so a
    // save throw skips the emit entirely. Pinning this prevents future
    // regressions that move the emit before save() or out of the try.
    const confirmedCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:confirmed',
    );
    expect(confirmedCalls).toHaveLength(0);

    // operator-alert MUST still fire so persistence failures are visible.
    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('fallback path save() throws → no transfer:confirmed emit', async () => {
    const tokenId = 'tok-issue195-save-throws-fallback';
    const localTokenId = 'local-issue195-save-throws-fallback';
    const emit = vi.fn();

    const { built } = makeBuilder({
      saveImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      emit,
      tokenId,
      localTokenId,
      stClientAvailable: false,
    });

    await built.dispositionWriter.write('addr-test', {
      tokenId,
      disposition: 'VALID',
    } as never);

    const confirmedCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:confirmed',
    );
    expect(confirmedCalls).toHaveLength(0);

    const alertCalls = emit.mock.calls.filter(
      (call) => call[0] === 'transfer:operator-alert',
    );
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
  });
});
