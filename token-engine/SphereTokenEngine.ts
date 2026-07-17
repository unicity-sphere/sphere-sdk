/**
 * token-engine/SphereTokenEngine.ts — the real ITokenEngine adapter (Track A).
 *
 * The full sender-driven engine over the v2 SDK: identity, value reads,
 * serialization, verification, mint, transfer, split and spent-status. All
 * crypto/value logic is the SDK's; this class orchestrates build → submit →
 * wait-proof → certify → realize, and maps SDK errors/states to the
 * sphere-domain ITokenEngine port.
 *
 * SDK objects are injected via `EngineDeps` (built by the factory in A4, or by
 * test wiring around TestAggregatorClient), keeping the engine logic independent
 * of how the aggregator/trust base are constructed.
 */

import { SphereError, type SphereErrorCode } from '../core/errors';
import { randomUUID } from '../core/uuid';
import {
  CheckpointPersistFailedError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from './errors';
import { deriveDirectAddress, UNICITY_TOKEN_TYPE_HEX } from './identity';
import { deriveDeliveryKeys } from './blob-keys';
import { deriveRealization } from './realization';
import { burntTokenFromCheckpoint, encodeCheckpoint } from './split-checkpoint';
import {
  CborDeserializer,
  CertificationData,
  CertificationStatus,
  EncodedPredicate,
  HexConverter,
  type InclusionProof,
  InclusionProofVerificationStatus,
  type ITransaction,
  type MintJustificationVerifierService,
  MintTransaction,
  type NetworkId,
  PaymentAssetCollection,
  type PredicateVerifierService,
  type RootTrustBase,
  SignaturePredicate,
  SignaturePredicateUnlockScript,
  type SigningService,
  SplitMintJustification,
  type SplitToken,
  SplitTokenRequest,
  StateId,
  type StateTransitionClient,
  Token,
  TokenSalt,
  TokenSplit,
  TokenType,
  TransferTransaction,
  VerificationStatus,
  waitInclusionProof,
} from './sdk';
import { decodeSpherePaymentData, SpherePaymentData, sphereAssetToSdk } from './SpherePaymentData';
import { TOKEN_BLOB_VERSION } from './token-blob';
import type { EngineOpOptions, ITokenEngine } from './engine';
import type {
  CoinId,
  EngineIdentity,
  EngineVerifyResult,
  MintDataTokenParams,
  MintParams,
  SphereToken,
  SphereValue,
  SplitParams,
  SplitResult,
  TokenBlob,
  TransferParams,
} from './types';

/** SDK objects the engine operates with; assembled by the factory (A4) or test wiring. */
export interface EngineDeps {
  readonly client: StateTransitionClient;
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly mintJustificationVerifier: MintJustificationVerifierService;
  /** The wallet's signing key (its identity + the spender for transfers it owns). */
  readonly signingService: SigningService;
  /**
   * The same key as raw bytes — the HKDF ikm for deterministic realization
   * (Part E.1; SigningService does not expose it back).
   */
  readonly privateKey: Uint8Array;
  readonly networkId: NetworkId;
  /**
   * Inclusion-proof poll cadence in ms (#683). The aggregator finalizes in ~1-1.5s,
   * but the state-transition-sdk's waitInclusionProof default is 1000ms, so the proof
   * is only caught at ~2s (poll granularity). A finer interval catches it ~0.5-0.75s
   * sooner PER proof round with zero correctness impact (waitInclusionProof returns
   * only an OK-verified proof regardless of poll frequency). Undefined → the tuned
   * default below.
   */
  readonly proofPollIntervalMs?: number;
}

/**
 * #683: default inclusion-proof poll interval (ms). Finer than the sdk's 1000ms
 * default so a ~1.2s finalization is caught near ~1.2-1.5s instead of at the 2s
 * poll boundary. Bounded by waitInclusionProof's 10s abort; the extra polls are
 * cheap read-only getInclusionProof calls confined to the ~1.5s finalization window.
 */
const DEFAULT_PROOF_POLL_INTERVAL_MS = 300;

/** Canonical lowercase UUID — the spec's `transferId` wire form (sdk-changes E.1). */
const TRANSFER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The KNOWN validation-reject submit statuses: a well-formed rejection that PROVES the
 * state was never certified (a byte-identical resume of a *valid* tx never later returns
 * a format/signature/state/shard-mismatch failure). E.2 is status-AGNOSTIC for everything
 * else: an UNKNOWN or transitional non-SUCCESS status (e.g. the gateway's transitional
 * `STATE_ID_EXISTS`) means "a certification for this state MAY already exist" — it must be
 * treated as possibly-certified (keep the intent OPEN — #631), NEVER a clean abort. Any
 * status outside this set therefore falls through to `ProofUnconfirmedError`.
 */
const CLEAN_REJECT_STATUSES: ReadonlySet<string> = new Set([
  CertificationStatus.STATE_ID_MISMATCH,
  CertificationStatus.SIGNATURE_VERIFICATION_FAILED,
  CertificationStatus.INVALID_SIGNATURE_FORMAT,
  CertificationStatus.INVALID_PUBLIC_KEY_FORMAT,
  CertificationStatus.INVALID_SOURCE_STATE_HASH_FORMAT,
  CertificationStatus.INVALID_TRANSACTION_HASH_FORMAT,
  CertificationStatus.UNSUPPORTED_ALGORITHM,
  CertificationStatus.INVALID_SHARD,
]);

/** The deterministic split plan (burn leg + per-output mint requests) — `TokenSplit.split`'s result. */
type SplitPlan = Awaited<ReturnType<typeof TokenSplit.split>>;

/** Threaded through the E.4 burnt-token resolution so its helpers stay within the max-params bound. */
interface SplitContext {
  readonly params: SplitParams;
  readonly split: SplitPlan;
  readonly transferId: string;
  readonly options?: EngineOpOptions | undefined;
}

export class SphereTokenEngine implements ITokenEngine {
  /** Hex form of the wallet key — deriveRealization's ikm input (Part E.1). */
  private readonly privateKeyHex: string;

  public constructor(private readonly deps: EngineDeps) {
    this.privateKeyHex = HexConverter.encode(deps.privateKey);
  }

  // ── identity ────────────────────────────────────────────────────────────────

  public getIdentity(): EngineIdentity {
    return { chainPubkey: new Uint8Array(this.deps.signingService.publicKey) };
  }

  /** Legacy DIRECT:// address (Path A). Async: the derivation hashes via the SDK. */
  public deriveIdentityAddress(pubkey?: Uint8Array): Promise<string> {
    return deriveDirectAddress(pubkey ?? this.deps.signingService.publicKey);
  }

  // ── value (read) ─────────────────────────────────────────────────────────────

  public readValue(token: SphereToken): SphereValue | null {
    return token.value;
  }

  public balanceOf(token: SphereToken, coinId: CoinId): bigint {
    let sum = 0n;
    for (const asset of token.value?.assets ?? []) {
      if (asset.coinId === coinId) sum += asset.amount;
    }
    return sum;
  }

  public tokenId(token: SphereToken): string {
    return token.blob.tokenId;
  }

  public readMemo(token: SphereToken): Uint8Array | null {
    const sdkToken = token.sdkToken;
    // A transferred token delivers its memo on the latest transfer.
    if (sdkToken.transactions.length > 0) {
      return sdkToken.latestTransaction.data;
    }
    // A minted output (e.g. a split output) carries the memo in its value envelope.
    const data = sdkToken.genesis.data;
    if (data && this.isSpherePaymentData(data)) {
      return SpherePaymentData.fromCBOR(data).memo;
    }
    return null;
  }

  public readTokenData(token: SphereToken): Uint8Array | null {
    const data = token.sdkToken.genesis.data;
    return data ? new Uint8Array(data) : null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  public async mint(params: MintParams, options?: EngineOpOptions): Promise<SphereToken> {
    const recipient = SignaturePredicate.create(params.recipientPubkey);
    const data = params.value ? await SpherePaymentData.fromValue(params.value).encode() : null;

    const mintTx = await MintTransaction.create(this.deps.networkId, recipient, data);
    const certificationData = await CertificationData.fromMintTransaction(mintTx);

    const response = await this.deps.client.submitCertificationRequest(certificationData);
    if (response.status !== CertificationStatus.SUCCESS) {
      throw new SphereError(`Mint certification failed: ${response.status}`, 'AGGREGATOR_ERROR');
    }

    const proof = await waitInclusionProof(
      this.deps.client,
      this.deps.trustBase,
      this.deps.predicateVerifier,
      mintTx,
      options?.signal,
      this.deps.proofPollIntervalMs ?? DEFAULT_PROOF_POLL_INTERVAL_MS, // #683 finer poll cadence
    );
    const certified = await mintTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
    const token = await Token.mint(
      this.deps.trustBase,
      this.deps.predicateVerifier,
      this.deps.mintJustificationVerifier,
      certified,
    );
    return this.wrapToken(token);
  }

  public async mintDataToken(params: MintDataTokenParams, options?: EngineOpOptions): Promise<SphereToken> {
    const recipient = SignaturePredicate.create(params.recipientPubkey);
    const tokenType = params.tokenType ? new TokenType(params.tokenType) : TokenType.generate();
    // A deterministic salt yields a stable, terms-derived tokenId (TokenId.fromSalt).
    const salt = params.salt ? TokenSalt.fromBytes(params.salt) : TokenSalt.generate();

    const mintTx = await MintTransaction.create(this.deps.networkId, recipient, params.data, tokenType, salt);
    const certificationData = await CertificationData.fromMintTransaction(mintTx);

    const response = await this.deps.client.submitCertificationRequest(certificationData);
    if (response.status !== CertificationStatus.SUCCESS) {
      throw new SphereError(`Data-token mint failed: ${response.status}`, 'AGGREGATOR_ERROR');
    }

    const proof = await waitInclusionProof(
      this.deps.client,
      this.deps.trustBase,
      this.deps.predicateVerifier,
      mintTx,
      options?.signal,
      this.deps.proofPollIntervalMs ?? DEFAULT_PROOF_POLL_INTERVAL_MS, // #683 finer poll cadence
    );
    const certified = await mintTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
    const token = await Token.mint(
      this.deps.trustBase,
      this.deps.predicateVerifier,
      this.deps.mintJustificationVerifier,
      certified,
    );
    return this.wrapToken(token);
  }

  public async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    this.assertOwned(params.token);
    const transferId = this.resolveTransferId(options);
    const recipient = SignaturePredicate.create(params.recipientPubkey);
    // E.1 deterministic realization: same transferId + inputs ⇒ byte-identical
    // transaction, so an interrupted transfer can be rebuilt and resumed (AC-E1/E2).
    const stateMask = deriveRealization(this.privateKeyHex, transferId, this.resolveOpIndex(options), 'stateMask');

    const transferTx = await TransferTransaction.create(params.token.sdkToken, recipient, stateMask, params.data ?? null);
    const unlockScript = await SignaturePredicateUnlockScript.create(transferTx, this.deps.signingService);
    const certificationData = await CertificationData.fromTransaction(transferTx, unlockScript);

    const proof = await this.submitAndAwaitProof(
      certificationData,
      transferTx,
      'Transfer certification failed',
      'TRANSFER_FAILED',
      options,
    );
    const certified = await transferTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
    const transferred = await params.token.sdkToken.transfer(this.deps.trustBase, this.deps.predicateVerifier, certified);
    return this.wrapToken(transferred);
  }

  public async split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult> {
    this.assertOwned(params.token);
    if (params.outputs.length === 0) {
      throw new SphereError('Split requires at least one output', 'VALIDATION_ERROR');
    }
    const transferId = this.resolveTransferId(options);

    // E.1 deterministic realization: a fixed token type + per-output HKDF salts
    // make every output's mint transaction (and its salt-derived tokenId)
    // reproducible from the wallet key + transferId.
    const tokenType = new TokenType(HexConverter.decode(UNICITY_TOKEN_TYPE_HEX));
    const requests = params.outputs.map((o, i) =>
      SplitTokenRequest.create(
        SignaturePredicate.create(o.recipientPubkey),
        PaymentAssetCollection.create(sphereAssetToSdk(o.coinId, o.amount)),
        tokenType,
        TokenSalt.fromBytes(deriveRealization(this.privateKeyHex, transferId, i, 'salt')),
      ),
    );

    // Value conservation is enforced inside the SDK split (root.value === source value).
    // E.1: the burn state mask is HKDF-derived, so the whole split — burn leg
    // included — is rebuildable from the wallet key + transferId (crash resume).
    const split = await TokenSplit.split(
      params.token.sdkToken,
      decodeSpherePaymentData,
      requests,
      deriveRealization(this.privateKeyHex, transferId, this.resolveOpIndex(options), 'burn'),
    );

    // 1. Resolve the burnt token: from a durable checkpoint on resume, else burn now and persist
    //    the checkpoint BEFORE any mint submit (E.4 — the burn proof is the one non-re-derivable
    //    split input; a mint certified against proof bytes that were never stored strands #501).
    const burntToken = await this.resolveBurntToken({ params, split, transferId, options });

    // 2. Mint every output IN PARALLEL (#684), each justified by the burnt token + its
    //    own split proofs. The mints are independent legs off the ONE already-certified,
    //    already-checkpointed burn (step 1, outside this fan-out — E.4 burn-before-mint
    //    is unchanged), so they carry no ordering constraint among themselves.
    //
    //    MONEY-SAFETY (identical semantics to the prior sequential loop):
    //    - `allSettled` waits for EVERY leg (never short-circuits) so an in-flight leg is
    //      not abandoned mid-submit; then we throw the LOWEST-index rejection's error —
    //      exactly the error the sequential loop would have surfaced (it failed at the
    //      first failing index and never attempted later legs). So the caller's keep-open
    //      classification (ProofUnconfirmedError / SplitCheckpointLostError / …) is byte-for-
    //      byte unchanged.
    //    - On any failure the intent stays OPEN (the burn is certified + checkpointed) and
    //      resume re-runs ALL legs from the durable checkpoint. A leg this fan-out already
    //      certified is recovered idempotently on resume (its stateId is HKDF-derived and
    //      deterministic; re-submit → the aggregator already holds it → waitInclusionProof
    //      returns the existing proof — the #631/E.2 resume contract). So legs the sequential
    //      loop would NOT have submitted, but this one did, are never lost — only recovered.
    const settled = await Promise.allSettled(
      split.tokens.map((token, i) =>
        this.mintSplitOutput(token, burntToken, params.outputs[i].data ?? null, options),
      ),
    );
    const firstRejected = settled.findIndex((r) => r.status === 'rejected');
    if (firstRejected !== -1) {
      throw (settled[firstRejected] as PromiseRejectedResult).reason;
    }
    const outputs = settled.map((r) => (r as PromiseFulfilledResult<SphereToken>).value);
    return { outputs };
  }

  /**
   * E.4 burnt-token resolution. With a checkpoint store: `get` → rebuild from the STORED proof on
   * resume; else a leg-0 pre-flight probe (a certified leaf with no checkpoint is unrecoverable),
   * then burn, persist the checkpoint (durable-ack gated), and adopt the authoritative stored
   * bytes. Without a store: burn as before (a documented residual for fully-local compositions).
   */
  private async resolveBurntToken(ctx: SplitContext): Promise<Token> {
    const store = ctx.options?.checkpointStore;
    const opIndex = this.resolveOpIndex(ctx.options);
    const source = ctx.params.token.sdkToken;
    if (store === undefined) {
      return (await this.burnSource(ctx)).burntToken;
    }
    const stored = await store.get(ctx.transferId, opIndex);
    if (stored !== null) {
      return burntTokenFromCheckpoint(this.deps, stored, ctx.split.burn.transaction, source);
    }
    await this.assertNoLegStranded(ctx);
    const { burntToken, burnProof } = await this.burnSource(ctx);
    const envelope = await encodeCheckpoint(ctx.split.burn.transaction, burnProof, burntToken);
    // The durable-ack gate: `put` resolving IS the ack, and NO mint has been submitted yet.
    let authoritative: Uint8Array;
    try {
      authoritative = await store.put(ctx.transferId, opIndex, envelope);
    } catch (err) {
      throw new CheckpointPersistFailedError(
        'split burn certified but its checkpoint could not be persisted — keep the intent open and resume',
        err,
      );
    }
    // Decode-from-stored discipline: mint from the AUTHORITATIVE bytes (ours, or a racing resumer's
    // that won the slot), never the pre-store in-memory burnt token — so concurrent resumers agree.
    return burntTokenFromCheckpoint(this.deps, authoritative, ctx.split.burn.transaction, source);
  }

  /** Burn the source: certify the burn transfer and append it -> burntToken (+ its proof). */
  private async burnSource(ctx: SplitContext): Promise<{ burntToken: Token; burnProof: InclusionProof }> {
    const burnTx = ctx.split.burn.transaction;
    const burnUnlock = await SignaturePredicateUnlockScript.create(burnTx, this.deps.signingService);
    const burnCert = await CertificationData.fromTransaction(burnTx, burnUnlock);
    const burnProof = await this.submitAndAwaitProof(burnCert, burnTx, 'Split burn failed', 'TRANSFER_FAILED', ctx.options);
    const burnCertified = await burnTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, burnProof);
    const burntToken = await ctx.params.token.sdkToken.transfer(this.deps.trustBase, this.deps.predicateVerifier, burnCertified);
    return { burntToken, burnProof };
  }

  /**
   * Pre-flight (no-checkpoint path): if ANY mint leaf is already certified on-chain while the
   * checkpoint is missing, the burn proof is genuinely unrecoverable — fail BEFORE any re-burn. A
   * mint's stateId is justification-INDEPENDENT (only the source state hash + salt-derived mask),
   * so a probe mint with a null justification derives the true on-chain key. Every leg is probed,
   * so correctness does NOT depend on the mint loop certifying leg 0 first (E.4 step 3).
   */
  private async assertNoLegStranded(ctx: SplitContext): Promise<void> {
    // #684: probe every leg's stateId IN PARALLEL — read-only getInclusionProof calls,
    // order-independent (it throws if ANY leg is already certified). Promise.all rejects
    // on the first stranded leg, same as the prior sequential loop.
    await Promise.all(
      ctx.split.tokens.map(async (leg, i) => {
        const data = await SpherePaymentData.create(leg.assets, ctx.params.outputs[i].data ?? null).encode();
        const probe = await MintTransaction.create(leg.networkId, leg.recipient, data, leg.tokenType, leg.salt, null);
        const response = await this.deps.client.getInclusionProof(await StateId.fromTransaction(probe));
        if (response.inclusionProof.inclusionCertificate !== null) {
          throw new SplitCheckpointLostError(
            'a split mint leaf is certified on-chain but no burn checkpoint exists — outputs are unrecoverable',
          );
        }
      }),
    );
  }

  /** One split output: build the justification from the burnt token, submit, certify, wrap. */
  private async mintSplitOutput(
    splitToken: SplitToken,
    burntToken: Token,
    memo: Uint8Array | null,
    options?: EngineOpOptions,
  ): Promise<SphereToken> {
    const data = await SpherePaymentData.create(splitToken.assets, memo).encode();
    const justification = SplitMintJustification.create(burntToken, splitToken.proofs).toCBOR();
    const mintTx = await MintTransaction.create(
      splitToken.networkId,
      splitToken.recipient,
      data,
      splitToken.tokenType,
      splitToken.salt,
      justification,
    );
    const certData = await CertificationData.fromMintTransaction(mintTx);
    const proof = await this.submitSplitMintLeg(certData, mintTx, options);
    const certified = await mintTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
    const token = await Token.mint(this.deps.trustBase, this.deps.predicateVerifier, this.deps.mintJustificationVerifier, certified);
    return this.wrapToken(token);
  }

  /**
   * Submit one split-mint leg. A `TRANSACTION_HASH_MISMATCH` on a mint leg is NOT a foreign spend
   * (its stateId is HKDF-derived from `(seed, transferId)`, so only a seed-holder under THIS
   * transferId could have certified a different leaf): the stored checkpoint no longer reproduces
   * the certified leaf → keep-open `SplitCheckpointLostError`, never the abort-and-re-plan
   * `TransferConflictError` (E.2/E.4 split-mint arm).
   */
  private async submitSplitMintLeg(
    certData: CertificationData,
    mintTx: MintTransaction,
    options?: EngineOpOptions,
  ): Promise<InclusionProof> {
    try {
      return await this.submitAndAwaitProof(certData, mintTx, 'Split mint failed', 'AGGREGATOR_ERROR', options);
    } catch (err) {
      if (err instanceof TransferConflictError) {
        throw new SplitCheckpointLostError(
          'a split mint leg no longer matches its certified leaf — the burn checkpoint is stale or lost',
          err,
        );
      }
      throw err;
    }
  }

  // ── verification ─────────────────────────────────────────────────────────────

  public async verify(token: SphereToken, _options?: EngineOpOptions): Promise<EngineVerifyResult> {
    const result = await token.sdkToken.verify(
      this.deps.trustBase,
      this.deps.predicateVerifier,
      this.deps.mintJustificationVerifier,
    );
    return result.status === VerificationStatus.OK ? { ok: true } : { ok: false, reason: String(result.status) };
  }

  public isOwnedBy(token: SphereToken, pubkey: Uint8Array): boolean {
    const owner = token.sdkToken.latestTransaction.recipient;
    const claimed = EncodedPredicate.fromPredicate(SignaturePredicate.create(pubkey));
    return EncodedPredicate.equals(owner, claimed);
  }

  public async isSpent(token: SphereToken, _options?: EngineOpOptions): Promise<boolean> {
    // The token's current state id = what a future transfer would spend. Derive it via a
    // probe transfer (never submitted) — StateId depends only on the source's lock script
    // and state hash, not on the recipient or state mask.
    const probe = await TransferTransaction.create(
      token.sdkToken,
      SignaturePredicate.create(this.deps.signingService.publicKey),
      new Uint8Array(32),
    );
    const stateId = await StateId.fromTransaction(probe);
    const response = await this.deps.client.getInclusionProof(stateId);
    // A present inclusion certificate means the state has already been consumed on-chain.
    return response.inclusionProof.inclusionCertificate !== null;
  }

  // ── serialization ────────────────────────────────────────────────────────────

  /** @inheritDoc — SDK-derived (Token.fromCBOR → latestTransaction.calculateStateHash().imprint). */
  public deliveryKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
    return deriveDeliveryKeys(blobBytes);
  }

  public encodeToken(token: SphereToken): TokenBlob {
    return token.blob;
  }

  public async decodeToken(blob: TokenBlob): Promise<SphereToken> {
    const sdkToken = await Token.fromCBOR(blob.token);
    if (sdkToken.genesis.networkId.id !== this.deps.networkId.id) {
      throw new SphereError(
        `Token network mismatch: token is on network ${sdkToken.genesis.networkId.id}, ` +
          `engine on ${this.deps.networkId.id}`,
        'VALIDATION_ERROR',
      );
    }
    return this.wrapToken(sdkToken);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * The effective realization seed for one transfer/split (Part E). A caller
   * that wants resumability supplies a pre-persisted UUIDv4 (sdk-changes E.3);
   * otherwise one is generated here — same derivation path, just non-resumable.
   * The canonical-lowercase-UUID check also keeps the HKDF info string
   * unambiguous (no ':' injection, no case-variant double derivations).
   */
  /** Validated op ordinal (§8.1 mask domain separation across ops of one send). */
  private resolveOpIndex(options?: EngineOpOptions): number {
    const opIndex = options?.opIndex ?? 0;
    if (!Number.isInteger(opIndex) || opIndex < 0) {
      throw new SphereError(`opIndex must be a non-negative integer, got ${String(opIndex)}`, 'VALIDATION_ERROR');
    }
    return opIndex;
  }

  private resolveTransferId(options?: EngineOpOptions): string {
    const transferId = options?.transferId ?? randomUUID();
    if (!TRANSFER_ID_RE.test(transferId)) {
      throw new SphereError(
        `transferId must be a canonical lowercase UUID string, got "${transferId}"`,
        'VALIDATION_ERROR',
      );
    }
    return transferId;
  }

  /**
   * E.2 — status-agnostic idempotent submit with conflict detection
   * (sdk-changes E.2, ARCHITECTURE §8.1).
   *
   * Submit the certification request and treat ANY outcome — success status,
   * error status, or a response-parse throw (the live gateway may still emit
   * statuses this SDK no longer parses, e.g. the transitional STATE_ID_EXISTS)
   * — as "a certification for this state may already exist". Then ALWAYS fetch
   * the inclusion proof and match-verify it against the rebuilt transaction
   * (`waitInclusionProof` only returns an OK-verified proof):
   *
   * - match (OK)                    → proceed; this is how an interrupted
   *                                   attempt with the same transferId resumes;
   * - mismatch (hash ≠ rebuilt tx)  → `TransferConflictError`: the source was
   *                                   consumed by a DIFFERENT transaction (lost
   *                                   race) — never applied, never retried;
   * - no proof & the submit failed  → the original submit error (a genuine
   *                                   failure, not a resume case).
   */
  private async submitAndAwaitProof(
    certificationData: CertificationData,
    transaction: ITransaction,
    failLabel: string,
    failCode: SphereErrorCode,
    options?: EngineOpOptions,
  ): Promise<InclusionProof> {
    let submitError: unknown = null;
    // true ONLY for a KNOWN validation-reject status — a PROVEN clean pre-certification
    // reject (nothing on-chain). Status-agnostic otherwise (E.2): an UNKNOWN/transitional
    // non-SUCCESS status may have certified, and a THROWN submit POST may have been
    // processed server-side — both stay INDETERMINATE (keep-open, #631).
    let submitRejectedCleanly = false;
    try {
      const response = await this.deps.client.submitCertificationRequest(certificationData);
      if (response.status !== CertificationStatus.SUCCESS) {
        submitError = new SphereError(`${failLabel}: ${response.status}`, failCode);
        submitRejectedCleanly = CLEAN_REJECT_STATUSES.has(response.status);
      }
    } catch (err) {
      submitError = err ?? new SphereError(`${failLabel}: submit failed`, failCode);
    }

    try {
      return await waitInclusionProof(
        this.deps.client,
        this.deps.trustBase,
        this.deps.predicateVerifier,
        transaction,
        options?.signal,
        this.deps.proofPollIntervalMs ?? DEFAULT_PROOF_POLL_INTERVAL_MS, // #683 finer poll cadence
      );
    } catch (err) {
      // The SDK surfaces a match-verify mismatch as a generic Error whose
      // message embeds the verification status. Mapping that fragile string is
      // done HERE — in the anti-corruption layer — and nowhere else; a test
      // pins the exact SDK message so an upstream change fails loudly.
      if (
        err instanceof Error &&
        err.message === `Invalid inclusion proof status: ${InclusionProofVerificationStatus.TRANSACTION_HASH_MISMATCH}`
      ) {
        throw new TransferConflictError(
          `${failLabel}: the source state was already consumed by a different transaction ` +
            '(lost race — abort this intent and re-plan under a new transferId)',
          err,
        );
      }
      // A PROVEN clean pre-certification reject (well-formed non-SUCCESS status)
      // → the state was genuinely never certified; surface the original error so
      // the caller aborts + restores the untouched source.
      if (submitRejectedCleanly) throw submitError;
      // Otherwise INDETERMINATE (#631): the submit returned SUCCESS (submitError
      // === null) and the proof fetch threw, OR the submit POST itself threw (may
      // have been processed server-side). The source spend MAY be on-chain under
      // THIS transferId — surface a typed keep-open signal so the caller keeps the
      // intent OPEN and resumes under the same transferId instead of aborting.
      throw new ProofUnconfirmedError(
        `${failLabel}: certification unconfirmed — the source spend may be on-chain; ` +
          'keep the intent open and resume under the same transferId',
        submitError ?? err,
      );
    }
  }

  /** Fail fast if this engine's key does not own the token's current state. */
  private assertOwned(token: SphereToken): void {
    if (!this.isOwnedBy(token, this.deps.signingService.publicKey)) {
      throw new SphereError('Cannot transfer a token not owned by this engine identity', 'VALIDATION_ERROR');
    }
  }

  /** Wrap an SDK token into a SphereToken: cache its blob (incl. stable tokenId) + decoded value. */
  private wrapToken(sdkToken: Token): SphereToken {
    const data = sdkToken.genesis.data;
    let value: SphereValue | null = null;
    // Only value tokens carry a SpherePaymentData envelope; data tokens (e.g. invoices)
    // leave value === null. A corrupt value envelope still errors loudly.
    if (data && this.isSpherePaymentData(data)) {
      try {
        value = SpherePaymentData.fromCBOR(data).toValue();
      } catch (err) {
        throw new SphereError(
          `Failed to decode token payment data: ${err instanceof Error ? err.message : String(err)}`,
          'VALIDATION_ERROR',
        );
      }
    }
    const blob: TokenBlob = {
      v: TOKEN_BLOB_VERSION,
      network: sdkToken.genesis.networkId.id,
      tokenId: HexConverter.encode(sdkToken.id.bytes),
      token: sdkToken.toCBOR(),
    };
    return { sdkToken, blob, value };
  }

  /** True if the bytes are a SpherePaymentData envelope (value token) vs a raw data token. */
  private isSpherePaymentData(data: Uint8Array): boolean {
    try {
      return CborDeserializer.decodeTag(data).tag === SpherePaymentData.CBOR_TAG;
    } catch {
      return false;
    }
  }
}
