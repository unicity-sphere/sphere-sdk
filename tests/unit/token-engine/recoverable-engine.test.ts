/**
 * Part E — recoverable engine (sdk-changes E.1/E.2/E.3, ARCHITECTURE §8.1).
 *
 * Runs the REAL SphereTokenEngine over the vendored in-memory
 * TestAggregatorClient, whose first-write-wins duplicate submit + proof
 * re-fetch is the target aggregator contract for E.2.
 *
 * Split legs note: per-output salts/tokenIds AND the burn mask are fully
 * deterministic (st-sdk#125 burnStateMask + EngineOpOptions.opIndex), so a
 * MID-split resume — re-running after the burn certified but before the mint
 * legs landed — completes. A FULL re-run after the mint legs certified is the
 * KNOWN GAP sphere-sdk#501: the aggregator rebuilds inclusion proofs from the
 * live tree per request (st-sdk#126, owner analysis), so rebuilt mint
 * transactions embed a byte-different burn proof and their hashes mismatch
 * the certified leaves → TransferConflictError. Both behaviors are pinned
 * below.
 */

import { describe, expect, it } from 'vitest';

import type { SplitCheckpointStore } from '../../../token-engine/engine';
import {
  CheckpointPersistFailedError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine/errors';
import { deriveRealization } from '../../../token-engine/realization';
import {
  CborSerializer,
  type CertificationData,
  type CertificationResponse,
  HexConverter,
  type IAggregatorClient,
  InclusionProofVerificationStatus,
  type InclusionProofResponse,
  PredicateVerifierService,
  SignaturePredicate,
  SigningService,
  type StateId,
  StateTransitionClient,
  StateMask,
  TransferTransaction,
  waitInclusionProof,
} from '../../../token-engine/sdk';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine, freshPubkey } from './test-engine';

const COIN = 'a'.repeat(64);

/** Forwards the submit, then throws — the "response-parse failure" shape of E.2
 * (e.g. the live gateway's transitional STATE_ID_EXISTS, which this SDK's
 * CertificationResponse.fromJSON cannot parse). The certification EXISTS. */
class SubmitForwardsThenThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public async submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    await this.inner.submitCertificationRequest(certificationData);
    throw new Error('CertificationResponse.fromJSON: unknown certification status STATE_ID_EXISTS');
  }
}

/** Forwards the FIRST submit (the burn), then crashes — a wallet dying
 * mid-split after the burn certified but before any mint leg reached the
 * aggregator. The resume-side of sphere-sdk#501's working case. */
class CrashAfterBurnClient implements IAggregatorClient {
  private submits = 0;

  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    if (this.submits++ > 0) {
      return Promise.reject(new Error('wallet crashed mid-split (simulated)'));
    }
    return this.inner.submitCertificationRequest(certificationData);
  }
}

/** Submit THROWS (unreachable / lost response) — INDETERMINATE: the POST may have been
 * processed server-side, so this is not a proven clean reject (#631). */
class SubmitUnreachableClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public submitCertificationRequest(): Promise<CertificationResponse> {
    return Promise.reject(new Error('aggregator unreachable (simulated)'));
  }
}

/** Submit LANDS (SUCCESS — the certification exists) but the PROOF FETCH throws: the
 * canonical #631 window — the source is consumed on-chain, yet no verdict is available. */
class GetInclusionProofThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    return this.inner.submitCertificationRequest(certificationData); // SUCCESS → certifies
  }

  public getInclusionProof(): Promise<InclusionProofResponse> {
    return Promise.reject(new Error('inclusion-proof fetch failed: 503 unavailable'));
  }
}

/** Submit resolves with a NON-VALIDATION status UNKNOWN to this SDK's enum (the transitional
 * `STATE_ID_EXISTS` — "a certification may already exist"), then the proof fetch throws. E.2 is
 * status-AGNOSTIC: this must be treated as possibly-certified (ProofUnconfirmedError), never a
 * clean reject — #631. `status` is a plain string, so unknown values parse fine (per the SDK). */
class UnknownStatusThenProofThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public submitCertificationRequest(): Promise<CertificationResponse> {
    return Promise.resolve({ status: 'STATE_ID_EXISTS' } as unknown as CertificationResponse);
  }

  public getInclusionProof(): Promise<InclusionProofResponse> {
    return Promise.reject(new Error('proof fetch failed (transient)'));
  }
}

/** Submit resolves with a KNOWN validation-reject status (nothing certified), then the proof fetch
 * throws. E.2 must surface the clean submit error (→ abort + restore), NOT ProofUnconfirmedError. */
class ValidationRejectThenProofThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public submitCertificationRequest(): Promise<CertificationResponse> {
    return Promise.resolve({ status: 'STATE_ID_MISMATCH' } as unknown as CertificationResponse);
  }

  public getInclusionProof(): Promise<InclusionProofResponse> {
    return Promise.reject(new Error('proof fetch failed (transient)'));
  }
}

/** In-memory SplitCheckpointStore (E.4): insert-once, first-write-wins — the wallet-api §16
 * intent-progress contract the engine builds against. `raw`/`putCalls` are test observers. */
class InMemoryCheckpointStore implements SplitCheckpointStore {
  public putCalls = 0;
  private readonly slots = new Map<string, Uint8Array>();

  private key(transferId: string, opIndex: number): string {
    return `${transferId}:${String(opIndex)}`;
  }

  public put(transferId: string, opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    this.putCalls++;
    const k = this.key(transferId, opIndex);
    const existing = this.slots.get(k);
    if (existing !== undefined) return Promise.resolve(existing); // first-write-wins
    this.slots.set(k, bytes);
    return Promise.resolve(bytes);
  }

  public get(transferId: string, opIndex: number): Promise<Uint8Array | null> {
    return Promise.resolve(this.slots.get(this.key(transferId, opIndex)) ?? null);
  }

  public raw(transferId: string, opIndex: number): Uint8Array | undefined {
    return this.slots.get(this.key(transferId, opIndex));
  }
}

/** `put` always rejects — the durable-ack gate must fail BEFORE any mint submit (E.4). */
class PersistFailingStore implements SplitCheckpointStore {
  public get(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  public put(): Promise<Uint8Array> {
    return Promise.reject(new Error('checkpoint store 503 (simulated)'));
  }
}

/** `get` serves corrupt bytes — a store may serve a non-array blob OR a well-framed 5-array whose
 * inner fields are wrong-typed (a bit-flip / tolerant re-encode that still parses as an array). */
class PoisonedStore implements SplitCheckpointStore {
  public constructor(private readonly poison: Uint8Array) {}

  public get(): Promise<Uint8Array | null> {
    return Promise.resolve(this.poison);
  }

  public put(_transferId: string, _opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(bytes);
  }
}

/** `get` null, but `put` returns a DIFFERENT authoritative record (a racing resumer won the slot). */
class AdoptStore implements SplitCheckpointStore {
  public constructor(private readonly winner: Uint8Array) {}

  public get(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  public put(): Promise<Uint8Array> {
    return Promise.resolve(this.winner); // first-write-wins: the caller MUST adopt these bytes
  }
}

/** `get` always returns the same fixed record (a device resuming from a server-stored checkpoint). */
class FixedGetStore implements SplitCheckpointStore {
  public constructor(private readonly record: Uint8Array) {}

  public get(): Promise<Uint8Array | null> {
    return Promise.resolve(this.record);
  }

  public put(_transferId: string, _opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(bytes);
  }
}

/** A non-4-byte, structurally-valid 5-element CBOR array whose version field is a TEXT string
 * (wrong major type) — parses as array(5) but the per-field decode throws a raw CborError. */
const WRONG_TYPED_CHECKPOINT = CborSerializer.encodeArray(
  CborSerializer.encodeTextString('not-an-int'), // field[0] should be a uint version
  CborSerializer.encodeTextString('sdk'),
  CborSerializer.encodeByteString(new Uint8Array([1])),
  CborSerializer.encodeByteString(new Uint8Array([2])),
  CborSerializer.encodeByteString(new Uint8Array([3])),
);

/** Counts submits so a test can prove ZERO mint legs were submitted (only the burn). */
class SubmitCountingClient implements IAggregatorClient {
  public submits = 0;

  public constructor(private readonly inner: IAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    this.submits++;
    return this.inner.submitCertificationRequest(certificationData);
  }
}

const SPLIT_OUTPUTS = (self: Uint8Array) => [
  { recipientPubkey: freshPubkey(), coinId: COIN, amount: 70n },
  { recipientPubkey: self, coinId: COIN, amount: 30n },
];

describe('recoverable engine (Part E) — real adapter over in-memory aggregator', () => {
  // AC-E1 (transfer leg) + the AC-E2 mock-resume shape: the duplicate submit is
  // absorbed first-write-wins, the existing proof match-verifies, and the
  // re-run returns the byte-identical finished token — no funds lost.
  it('AC-E1/AC-E2: re-running a transfer with the same transferId returns byte-identical results', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    const recipientPubkey = freshPubkey();
    const transferId = crypto.randomUUID();

    const first = await e.transfer({ token: src, recipientPubkey }, { transferId });
    // Same transferId + same inputs, against the same aggregator: this is the
    // resume path (an interrupted attempt whose certification already landed).
    const second = await e.transfer({ token: src, recipientPubkey }, { transferId });

    expect(second.blob.tokenId).toBe(first.blob.tokenId);
    expect(HexConverter.encode(second.blob.token)).toBe(HexConverter.encode(first.blob.token));
    expect((await e.verify(second)).ok).toBe(true);
  }, 20000);

  // AC-E4: the same source consumed under DIFFERENT transferIds is a lost race,
  // not a resume — the proof kept by the aggregator (first leaf wins) does not
  // match the second rebuilt transaction.
  it('AC-E4: a second transfer of the same source under a different transferId throws TransferConflictError', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    await e.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });

    const err = await e
      .transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(err).toBeInstanceOf(TransferConflictError);
    expect((err as TransferConflictError).code).toBe('TRANSFER_CONFLICT');

    // The race is lost for that source only: a re-plan under a new transferId
    // succeeds for the remaining sources.
    const other = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 5n }] },
    });
    const replanned = await e.transfer({ token: other, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });
    expect((await e.verify(replanned)).ok).toBe(true);
  }, 25000);

  // AC-E3: deterministic realization is invisible downstream — the transferred
  // token and every split output still fully verify.
  it('AC-E3: deterministically-realized transfer and split outputs pass engine.verify', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const transferId = crypto.randomUUID();

    const srcA = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 10n }] } });
    const transferred = await e.transfer({ token: srcA, recipientPubkey: freshPubkey() }, { transferId });
    expect((await e.verify(transferred)).ok).toBe(true);

    const srcB = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const { outputs } = await e.split(
      {
        token: srcB,
        outputs: [
          { recipientPubkey: freshPubkey(), coinId: COIN, amount: 60n },
          { recipientPubkey: self, coinId: COIN, amount: 40n },
        ],
      },
      { transferId: crypto.randomUUID() },
    );
    expect(outputs).toHaveLength(2);
    for (const o of outputs) {
      expect((await e.verify(o)).ok).toBe(true);
    }
  }, 30000);

  // Split determinism (burn excluded — #492): the same wallet key + transferId
  // reproduce the same per-output salts and (salt-derived) tokenIds on a second
  // device/chain. Two aggregators sharing one trust-base key stand in for
  // "another device rebuilding the same split".
  it('split: same transferId reproduces identical per-output salts and tokenIds', async () => {
    const aggregatorKey = SigningService.generatePrivateKey();
    const walletKey = SigningService.generatePrivateKey();
    const engineA = createTestEngine({ aggregator: TestAggregatorClient.create(aggregatorKey), privateKey: walletKey });
    const engineB = createTestEngine({ aggregator: TestAggregatorClient.create(aggregatorKey), privateKey: walletKey });

    const self = engineA.getIdentity().chainPubkey;
    const payee = freshPubkey();
    const srcA = await engineA.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const srcB = await engineB.decodeToken(engineA.encodeToken(srcA));

    const transferId = crypto.randomUUID();
    const outputs = [
      { recipientPubkey: payee, coinId: COIN, amount: 70n },
      { recipientPubkey: self, coinId: COIN, amount: 30n },
    ];
    const runA = await engineA.split({ token: srcA, outputs }, { transferId });
    const runB = await engineB.split({ token: srcB, outputs }, { transferId });

    expect(runA.outputs.map((o) => engineA.tokenId(o))).toEqual(runB.outputs.map((o) => engineB.tokenId(o)));
    for (let i = 0; i < runA.outputs.length; i++) {
      const saltA = runA.outputs[i].sdkToken.genesis.salt.toBytes();
      const saltB = runB.outputs[i].sdkToken.genesis.salt.toBytes();
      // Identical across runs AND equal to the spec derivation for index i.
      expect(HexConverter.encode(saltA)).toBe(HexConverter.encode(saltB));
      expect(HexConverter.encode(saltA)).toBe(
        HexConverter.encode(deriveRealization(HexConverter.encode(walletKey), transferId, i, 'salt')),
      );
    }
    // Distinct outputs of one split must not share a salt (index domain separation).
    expect(HexConverter.encode(runA.outputs[0].sdkToken.genesis.salt.toBytes())).not.toBe(
      HexConverter.encode(runA.outputs[1].sdkToken.genesis.salt.toBytes()),
    );

  }, 40000);

  // The WORKING split resume (sdk-changes E.2): the wallet dies after the
  // burn certified but before any mint leg landed. Re-running with the same
  // {transferId} rebuilds the byte-identical burn (deterministic
  // burnStateMask — duplicate submit absorbed first-write-wins, the
  // refetched proof match-verifies because the certified transactionHash is
  // stable), then submits the mint legs fresh: the split completes and every
  // output verifies. This is ALSO the burn-determinism proof — a random burn
  // mask would rebuild a different burn transaction and the resume would
  // throw TransferConflictError instead of completing.
  it('split resume: a crash after burn certification completes on re-run with the same transferId', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const crashing = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new CrashAfterBurnClient(aggregator),
    });
    const plain = createTestEngine({ aggregator, privateKey: walletKey });

    const self = plain.getIdentity().chainPubkey;
    const src = await plain.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = [
      { recipientPubkey: freshPubkey(), coinId: COIN, amount: 60n },
      { recipientPubkey: self, coinId: COIN, amount: 40n },
    ];

    const err = await crashing
      // Short proof-poll budget: the crashed mint submits leave no proof to find.
      .split({ token: src, outputs }, { transferId, signal: AbortSignal.timeout(2000) })
      .then(() => null, (caught: unknown) => caught);
    // #631: the mint submit crashed AFTER the burn certified — INDETERMINATE (the mint may have
    // been processed server-side). The engine raises ProofUnconfirmedError (keep-open), preserving
    // the crash as the cause; resume under the same transferId then completes (below).
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(String((err as { cause?: unknown }).cause)).toContain('wallet crashed mid-split (simulated)');

    const resumed = await plain.split({ token: src, outputs }, { transferId });
    expect(resumed.outputs).toHaveLength(2);
    expect(resumed.outputs.map((o) => plain.balanceOf(o, COIN))).toEqual([60n, 40n]);
    for (const o of resumed.outputs) {
      expect((await plain.verify(o)).ok).toBe(true);
    }
  }, 40000);

  // AC-E2 (split leg, sphere-sdk#501 FIXED via E.4): a FULL re-run after the
  // mint legs certified RECOVERS when a checkpoint store is supplied. The
  // aggregator rebuilds inclusion proofs from the live tree per request
  // (st-sdk#126 — only CertificationData is stable), so a refetched burn proof
  // is byte-different; recovery therefore CANNOT come from a refetch — it comes
  // from the stored burn checkpoint. The control below (no store → still
  // conflicts, same aggregator) proves the checkpoint is what flips the outcome.
  it('AC-E2: split full re-run after certified mints RECOVERS from the checkpoint (no funds lost)', async () => {
    const aggregator = TestAggregatorClient.create();
    const store = new InMemoryCheckpointStore();
    const engine = createTestEngine({ aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = SPLIT_OUTPUTS(self);

    const first = await engine.split({ token: src, outputs }, { transferId, checkpointStore: store });
    expect(first.outputs).toHaveLength(2);
    // The checkpoint was persisted exactly once (before the first mint), and holds real bytes.
    expect(store.putCalls).toBe(1);
    const stored = store.raw(transferId, 0);
    expect(stored).toBeInstanceOf(Uint8Array);
    const storedHex = HexConverter.encode(stored as Uint8Array);

    // Full re-run with the same transferId + the same store: the mint justification is rebuilt
    // from the STORED burn proof, so the already-certified legs match-verify and every output is
    // recovered — decimal-exact, fully verifying — NOT a TransferConflictError.
    const resumed = await engine.split({ token: src, outputs }, { transferId, checkpointStore: store });
    expect(resumed.outputs).toHaveLength(2);
    expect(resumed.outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([70n, 30n]);
    expect(resumed.outputs.map((o) => engine.tokenId(o))).toEqual(first.outputs.map((o) => engine.tokenId(o)));
    for (const o of resumed.outputs) {
      expect((await engine.verify(o)).ok).toBe(true);
    }
    // Insert-once: the resume read the checkpoint, never re-persisted it (still one put, same bytes).
    expect(store.putCalls).toBe(1);
    expect(HexConverter.encode(store.raw(transferId, 0) as Uint8Array)).toBe(storedHex);
  }, 40000);

  // The residual for fully-local compositions (no checkpoint store), pinned: a FULL re-run after
  // the mint legs certified does NOT recover — the refetched burn proof is byte-different (the
  // aggregator regenerates per request), so the rebuilt mint transactions mismatch the certified
  // leaves. It surfaces as the keep-open SplitCheckpointLostError (a mint-leg mismatch is NEVER a
  // foreign spend — its stateId is HKDF-derived — so never the abort-y TransferConflictError). This
  // is the SAME aggregator as the recovery test above; the ONLY difference is the presence of the
  // checkpoint — the proof that recovery came from stored bytes, not accidental refetch stability.
  it('residual: split full re-run WITHOUT a checkpoint store cannot recover (SplitCheckpointLostError)', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = SPLIT_OUTPUTS(self);

    const first = await engine.split({ token: src, outputs }, { transferId });
    expect(first.outputs).toHaveLength(2);

    const err = await engine.split({ token: src, outputs }, { transferId }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(SplitCheckpointLostError);
    expect((err as SplitCheckpointLostError).code).toBe('SPLIT_CHECKPOINT_LOST');
    expect(err).not.toBeInstanceOf(TransferConflictError);
  }, 40000);

  // AC-E6(a) — the durable-ack ordering gate: if the checkpoint cannot be persisted after the
  // burn certifies, the engine raises CheckpointPersistFailedError (keep-open) and submits ZERO
  // mint legs (only the burn reached the aggregator). Funds are in-flight, not lost.
  it('AC-E6: a checkpoint persist failure raises CheckpointPersistFailedError and submits no mint leg', async () => {
    const aggregator = TestAggregatorClient.create();
    const counting = new SubmitCountingClient(aggregator);
    const engine = createTestEngine({ aggregator, wireClient: counting });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const submitsAfterMint = counting.submits; // the source mint

    const err = await engine
      .split({ token: src, outputs: SPLIT_OUTPUTS(self) }, { transferId: crypto.randomUUID(), checkpointStore: new PersistFailingStore() })
      .then(() => null, (caught: unknown) => caught);

    expect(err).toBeInstanceOf(CheckpointPersistFailedError);
    expect((err as CheckpointPersistFailedError).code).toBe('CHECKPOINT_PERSIST_FAILED');
    expect((err as CheckpointPersistFailedError).mayHaveCertified).toBe(true);
    expect(String((err as { cause?: unknown }).cause)).toContain('checkpoint store 503');
    // exactly one submit after the source mint — the burn — and NO mint leg.
    expect(counting.submits).toBe(submitsAfterMint + 1);
  }, 40000);

  // AC-E6(b) — leg-0 pre-flight: a certified mint leaf with NO checkpoint (server data loss /
  // withholding) is genuinely unrecoverable. Resume with an empty store probes leg-0 (certified
  // on the shared aggregator) and raises SplitCheckpointLostError BEFORE any re-burn — never a
  // foreign-conflict, never a silent re-mint.
  it('AC-E6: a certified leg with a missing checkpoint raises SplitCheckpointLostError (leg-0 probe)', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = SPLIT_OUTPUTS(self);

    await engine.split({ token: src, outputs }, { transferId, checkpointStore: new InMemoryCheckpointStore() });

    // Resume under the same transferId but with a FRESH (empty) store — the checkpoint is gone.
    const err = await engine
      .split({ token: src, outputs }, { transferId, checkpointStore: new InMemoryCheckpointStore() })
      .then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(SplitCheckpointLostError);
    expect((err as SplitCheckpointLostError).code).toBe('SPLIT_CHECKPOINT_LOST');
  }, 40000);

  // AC-E6(c) — a corrupt / mis-served checkpoint record must never be minted from: decoding fails
  // and the engine raises SplitCheckpointLostError (keep-open), never a wrong-bytes mint. BOTH
  // corruption shapes are covered: a non-array blob, AND a well-framed 5-array with a wrong-typed
  // inner field (the field decoders throw a raw CborError that must still surface as the typed
  // keep-open error — a bit-flip / tolerant re-encode that this plaintext layer cannot pre-reject).
  it.each([
    ['non-array blob', new Uint8Array([0xff, 0x00, 0x13, 0x37])],
    ['5-array, wrong-typed version field', WRONG_TYPED_CHECKPOINT],
  ])('AC-E6: a poisoned checkpoint record (%s) raises SplitCheckpointLostError, never mints', async (_label, poison) => {
    const aggregator = TestAggregatorClient.create();
    const counting = new SubmitCountingClient(aggregator);
    const engine = createTestEngine({ aggregator, wireClient: counting });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const submitsAfterMint = counting.submits;

    const err = await engine
      .split({ token: src, outputs: SPLIT_OUTPUTS(self) }, { transferId: crypto.randomUUID(), checkpointStore: new PoisonedStore(poison) })
      .then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(SplitCheckpointLostError);
    // get() returned poison up front — nothing was submitted (no burn, no mint).
    expect(counting.submits).toBe(submitsAfterMint);
  }, 40000);

  // AC-E6(e) — insert-once ADOPT: two devices race the no-checkpoint path; the loser's put() gets
  // the WINNER's authoritative bytes back and MUST mint from those (decode-from-stored), not its
  // own pre-store burnt token — else the two devices would embed byte-different burn proofs and
  // diverge. Construction: engine A burns + checkpoints but crashes before minting (no leg
  // certified, checkpoint C captured); the tree is advanced so a fresh burn refetch is
  // byte-different; the loser adopts C via put() and mints; a reference device resuming from C
  // (get-path) mints the same legs — the outputs are byte-identical, proving the loser used C.
  it('AC-E6: a resumer that loses the put race adopts the winner checkpoint and converges', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const capture = new InMemoryCheckpointStore();
    const crashing = createTestEngine({ aggregator, privateKey: walletKey, wireClient: new CrashAfterBurnClient(aggregator) });
    const plain = createTestEngine({ aggregator, privateKey: walletKey });

    const self = plain.getIdentity().chainPubkey;
    const src = await plain.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = SPLIT_OUTPUTS(self);

    // A: burn certifies + checkpoint persists, then the mint submit crashes — no leg certified.
    await crashing
      .split({ token: src, outputs }, { transferId, checkpointStore: capture, signal: AbortSignal.timeout(2000) })
      .then(() => null, () => null);
    const winner = capture.raw(transferId, 0);
    expect(winner).toBeInstanceOf(Uint8Array);
    // Advance the tree so a fresh burn-proof refetch is byte-different from the captured one.
    await plain.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 1n }] } });

    // The LOSER: get() sees nothing, but put() returns the winner's bytes — it must mint from those.
    // It mints FIRST here, certifying the legs with whichever burn proof it used.
    const loser = await plain.split({ token: src, outputs }, { transferId, checkpointStore: new AdoptStore(winner as Uint8Array) });
    expect(loser.outputs.map((o) => plain.balanceOf(o, COIN))).toEqual([70n, 30n]);
    for (const o of loser.outputs) {
      expect((await plain.verify(o)).ok).toBe(true);
    }

    // The discriminator: a reference device resuming DIRECTLY from the winner checkpoint rebuilds
    // the winner's mint justification and re-submits the legs. It match-verifies (dup-OK) ONLY if
    // the loser certified them with the winner's burn proof — i.e. adopted it. Had the loser minted
    // from its OWN (byte-different, tree-advanced) burn proof, this resume would hit a mint-leg hash
    // mismatch and throw SplitCheckpointLostError. That it recovers is the proof of adoption.
    const reference = await plain.split({ token: src, outputs }, { transferId, checkpointStore: new FixedGetStore(winner as Uint8Array) });
    expect(reference.outputs.map((o) => plain.tokenId(o))).toEqual(loser.outputs.map((o) => plain.tokenId(o)));
    for (const o of reference.outputs) {
      expect((await plain.verify(o)).ok).toBe(true);
    }
  }, 40000);

  // AC-E6(d) — the happy path with a store: a first-time split persists the checkpoint (before the
  // first mint) and completes; every output verifies. Proves the store is written on the fresh
  // path, not only on resume.
  it('AC-E6: a first-time split with a checkpoint store completes and persists the checkpoint', async () => {
    const aggregator = TestAggregatorClient.create();
    const store = new InMemoryCheckpointStore();
    const engine = createTestEngine({ aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();

    const { outputs } = await engine.split({ token: src, outputs: SPLIT_OUTPUTS(self) }, { transferId, checkpointStore: store });
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([70n, 30n]);
    for (const o of outputs) {
      expect((await engine.verify(o)).ok).toBe(true);
    }
    expect(store.raw(transferId, 0)).toBeInstanceOf(Uint8Array);
  }, 40000);

  // E.2 status-agnostic submit: a submit that THROWS (response-parse failure)
  // after the certification landed is absorbed — the proof is fetched,
  // match-verified and applied. Resume never keys off a submit status.
  it('E.2: a throwing submit whose certification exists still completes via proof fetch + match-verify', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const flaky = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new SubmitForwardsThenThrowsClient(aggregator),
    });

    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 42n }] },
    });
    const finished = await flaky.transfer(
      { token: src, recipientPubkey: freshPubkey() },
      { transferId: crypto.randomUUID() },
    );
    expect(plain.balanceOf(finished, COIN)).toBe(42n);
    expect((await plain.verify(finished)).ok).toBe(true);
  }, 20000);

  // E.2 fourth arm (#631): a submit that THROWS (unreachable / lost response) is
  // INDETERMINATE — it may have been processed server-side — so the engine raises a typed
  // ProofUnconfirmedError (keep the intent OPEN + resume), preserving the submit error as
  // the cause. Only a well-formed non-SUCCESS status is a PROVEN clean reject.
  it('E.2 #631: a throwing/unreachable submit with no proof raises ProofUnconfirmedError (keep-open)', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const dead = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new SubmitUnreachableClient(aggregator),
    });

    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 1n }] },
    });
    const err = await dead
      .transfer(
        { token: src, recipientPubkey: freshPubkey() },
        // Short proof-poll budget: with no certification the probe can only time out.
        { transferId: crypto.randomUUID(), signal: AbortSignal.timeout(500) },
      )
      .then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).code).toBe('CERTIFICATION_UNCONFIRMED');
    expect((err as ProofUnconfirmedError).mayHaveCertified).toBe(true);
    expect(String((err as { cause?: unknown }).cause)).toContain('aggregator unreachable');
  }, 20000);

  // #631 canonical window: submit SUCCESS (the certification lands — the source is consumed
  // on-chain) but the proof FETCH throws. The engine must raise the typed keep-open signal
  // (ProofUnconfirmedError) — NOT a raw error, NOT TransferConflictError — so the caller keeps
  // the intent open and recovers via resume instead of orphaning a certified send.
  it('E.2 #631: submit SUCCESS then a throwing proof fetch raises ProofUnconfirmedError (source is spent)', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const flaky = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new GetInclusionProofThrowsClient(aggregator),
    });

    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 7n }] },
    });
    const err = await flaky
      .transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() })
      .then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).mayHaveCertified).toBe(true);
    expect(err).not.toBeInstanceOf(TransferConflictError);
    // the submit landed on the shared aggregator — the source IS spent on-chain, so a resume
    // under the same transferId can recover the proof (this is exactly why we keep the intent open).
    expect(await plain.isSpent(src)).toBe(true);
  }, 20000);

  // #631 status-agnostic classifier: an UNKNOWN/transitional non-SUCCESS status (e.g. STATE_ID_EXISTS
  // — "a certification may already exist") + a throwing proof fetch is INDETERMINATE and MUST raise
  // ProofUnconfirmedError (keep-open), NOT a clean abort. Guards against re-arming the #631 orphan on
  // the submit-status classifier: `!== SUCCESS` is not "proven clean reject".
  it('E.2 #631: an unknown non-SUCCESS submit status + throwing proof fetch → ProofUnconfirmedError (keep-open)', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const flaky = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new UnknownStatusThenProofThrowsClient(aggregator),
    });
    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 3n }] },
    });
    const err = await flaky
      .transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID(), signal: AbortSignal.timeout(500) })
      .then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).mayHaveCertified).toBe(true);
  }, 20000);

  // The other side of the classifier: a KNOWN validation-reject status PROVES nothing certified — it
  // must surface the clean submit error (→ abort + restore), NEVER ProofUnconfirmedError.
  it('E.2: a known validation-reject status + throwing proof fetch surfaces the clean submit error (abort)', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const rejecting = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new ValidationRejectThenProofThrowsClient(aggregator),
    });
    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 3n }] },
    });
    const err = await rejecting
      .transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID(), signal: AbortSignal.timeout(500) })
      .then(() => null, (caught: unknown) => caught);
    expect(err).not.toBeInstanceOf(ProofUnconfirmedError);
    expect(err).not.toBeInstanceOf(TransferConflictError);
    expect(String((err as Error).message)).toContain('STATE_ID_MISMATCH');
  }, 20000);

  // Pins the EXACT SDK error surface the engine maps to TransferConflictError:
  // waitInclusionProof rejects a mismatching proof with a generic Error whose
  // message embeds the verification status. If upstream changes this string,
  // this test fails loudly — update the mapping in SphereTokenEngine alongside.
  it('pins the SDK conflict surface: waitInclusionProof throws the TRANSACTION_HASH_MISMATCH message', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator });
    const src = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 9n }] },
    });
    await engine.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });

    // A DIFFERENT transaction for the already-consumed source state.
    const foreignTx = await TransferTransaction.create(
      src.sdkToken,
      SignaturePredicate.create(freshPubkey()),
      StateMask.fromBytes(new Uint8Array(32).fill(7)),
      null,
    );
    const err = await waitInclusionProof(
      new StateTransitionClient(aggregator),
      aggregator.rootTrustBase,
      PredicateVerifierService.create(),
      foreignTx,
      AbortSignal.timeout(2000),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `Invalid inclusion proof status: ${InclusionProofVerificationStatus.TRANSACTION_HASH_MISMATCH}`,
    );
  }, 20000);

  it('rejects a non-canonical transferId before any network work', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 1n }] },
    });
    for (const bad of ['not-a-uuid', '123E4567-E89B-42D3-A456-426614174000', 'a:b:c']) {
      await expect(e.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: bad })).rejects.toThrow(
        /canonical lowercase UUID/,
      );
    }
  }, 15000);
});
