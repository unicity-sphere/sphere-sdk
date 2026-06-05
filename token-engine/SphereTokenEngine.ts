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

import { SphereError } from '../core/errors';
import { deriveDirectAddress } from './identity';
import {
  CertificationData,
  CertificationStatus,
  EncodedPredicate,
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
  TokenSplit,
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
  readonly networkId: NetworkId;
}

export class SphereTokenEngine implements ITokenEngine {
  public constructor(private readonly deps: EngineDeps) {}

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

  public async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    this.assertOwned(params.token);
    const recipient = SignaturePredicate.create(params.recipientPubkey);
    const stateMask = crypto.getRandomValues(new Uint8Array(32));

    const transferTx = await TransferTransaction.create(params.token.sdkToken, recipient, stateMask, null);
    const unlockScript = await SignaturePredicateUnlockScript.create(transferTx, this.deps.signingService);
    const certificationData = await CertificationData.fromTransaction(transferTx, unlockScript);

    const response = await this.deps.client.submitCertificationRequest(certificationData);
    if (response.status !== CertificationStatus.SUCCESS) {
      throw new SphereError(`Transfer certification failed: ${response.status}`, 'TRANSFER_FAILED');
    }

    const proof = await waitInclusionProof(
      this.deps.client,
      this.deps.trustBase,
      this.deps.predicateVerifier,
      transferTx,
      options?.signal,
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

    const requests = params.outputs.map((o) =>
      SplitTokenRequest.create(
        SignaturePredicate.create(o.recipientPubkey),
        PaymentAssetCollection.create(sphereAssetToSdk(o.coinId, o.amount)),
      ),
    );

    // Value conservation is enforced inside the SDK split (root.value === source value).
    const split = await TokenSplit.split(params.token.sdkToken, decodeSpherePaymentData, requests);

    // 1. Burn the source: certify the burn transfer and append it -> burntToken.
    const burnUnlock = await SignaturePredicateUnlockScript.create(split.burn.transaction, this.deps.signingService);
    const burnCert = await CertificationData.fromTransaction(split.burn.transaction, burnUnlock);
    const burnResponse = await this.deps.client.submitCertificationRequest(burnCert);
    if (burnResponse.status !== CertificationStatus.SUCCESS) {
      throw new SphereError(`Split burn failed: ${burnResponse.status}`, 'TRANSFER_FAILED');
    }
    const burnProof = await waitInclusionProof(
      this.deps.client,
      this.deps.trustBase,
      this.deps.predicateVerifier,
      split.burn.transaction,
      options?.signal,
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
    for (const splitToken of split.tokens) {
      const data = await SpherePaymentData.create(splitToken.assets).encode();
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
      const response = await this.deps.client.submitCertificationRequest(certData);
      if (response.status !== CertificationStatus.SUCCESS) {
        throw new SphereError(`Split mint failed: ${response.status}`, 'AGGREGATOR_ERROR');
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

  /** Fail fast if this engine's key does not own the token's current state. */
  private assertOwned(token: SphereToken): void {
    const owner = token.sdkToken.latestTransaction.recipient;
    const mine = EncodedPredicate.fromPredicate(SignaturePredicate.create(this.deps.signingService.publicKey));
    if (!EncodedPredicate.equals(owner, mine)) {
      throw new SphereError('Cannot transfer a token not owned by this engine identity', 'VALIDATION_ERROR');
    }
  }

  /** Wrap an SDK token into a SphereToken: cache its blob + decoded value. */
  private wrapToken(sdkToken: Token): SphereToken {
    const data = sdkToken.genesis.data;
    let value: SphereValue | null = null;
    if (data) {
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
      token: sdkToken.toCBOR(),
    };
    return { sdkToken, blob, value };
  }
}
