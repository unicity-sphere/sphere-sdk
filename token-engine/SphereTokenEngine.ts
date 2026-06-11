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
import { TransferConflictError } from './errors';
import { deriveDirectAddress, UNICITY_TOKEN_TYPE_HEX } from './identity';
import { deriveRealization } from './realization';
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
}

/** Canonical lowercase UUID — the spec's `transferId` wire form (sdk-changes E.1). */
const TRANSFER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    const stateMask = deriveRealization(this.privateKeyHex, transferId, 0, 'stateMask');

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
      deriveRealization(this.privateKeyHex, transferId, 0, 'burn'),
    );

    // 1. Burn the source: certify the burn transfer and append it -> burntToken.
    const burnUnlock = await SignaturePredicateUnlockScript.create(split.burn.transaction, this.deps.signingService);
    const burnCert = await CertificationData.fromTransaction(split.burn.transaction, burnUnlock);
    const burnProof = await this.submitAndAwaitProof(
      burnCert,
      split.burn.transaction,
      'Split burn failed',
      'TRANSFER_FAILED',
      options,
    );
    const burnCertified = await split.burn.transaction.toCertifiedTransaction(
      this.deps.trustBase,
      this.deps.predicateVerifier,
      burnProof,
    );
    const burntToken = await params.token.sdkToken.transfer(
      this.deps.trustBase,
      this.deps.predicateVerifier,
      burnCertified,
    );

    // 2. Mint each output, justified by the burnt token + its split proofs.
    const outputs: SphereToken[] = [];
    for (let i = 0; i < split.tokens.length; i++) {
      const splitToken = split.tokens[i];
      // split.tokens preserves requests order, so the per-output memo maps by index.
      const data = await SpherePaymentData.create(splitToken.assets, params.outputs[i].data ?? null).encode();
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
      const proof = await this.submitAndAwaitProof(certData, mintTx, 'Split mint failed', 'AGGREGATOR_ERROR', options);
      const certified = await mintTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
      const token = await Token.mint(
        this.deps.trustBase,
        this.deps.predicateVerifier,
        this.deps.mintJustificationVerifier,
        certified,
      );
      outputs.push(this.wrapToken(token));
    }

    return { outputs };
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
  private resolveTransferId(options?: EngineOpOptions): string {
    const transferId = options?.transferId ?? crypto.randomUUID();
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
    try {
      const response = await this.deps.client.submitCertificationRequest(certificationData);
      if (response.status !== CertificationStatus.SUCCESS) {
        submitError = new SphereError(`${failLabel}: ${response.status}`, failCode);
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
      // No certification materialized and the submit itself had failed.
      if (submitError !== null) throw submitError;
      throw err;
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
