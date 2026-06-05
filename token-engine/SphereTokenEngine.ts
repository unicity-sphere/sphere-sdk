/**
 * token-engine/SphereTokenEngine.ts — the real ITokenEngine adapter (Track A).
 *
 * Work in progress: this commit implements identity, value reads, serialization,
 * verification, mint and transfer (A1 + A2). `split` and `isSpent` land in
 * follow-up commits, after which the class declares `implements ITokenEngine`.
 * Kept un-declared until then so every commit compiles green (the port cannot be
 * implemented half-way).
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
  type MintJustificationVerifierService,
  MintTransaction,
  type NetworkId,
  type PredicateVerifierService,
  type RootTrustBase,
  SignaturePredicate,
  SignaturePredicateUnlockScript,
  type SigningService,
  type StateTransitionClient,
  Token,
  TransferTransaction,
  VerificationStatus,
  waitInclusionProof,
} from './sdk';
import { SpherePaymentData } from './SpherePaymentData';
import { TOKEN_BLOB_VERSION } from './token-blob';
import type { EngineOpOptions } from './engine';
import type {
  CoinId,
  EngineIdentity,
  EngineVerifyResult,
  MintParams,
  SphereToken,
  SphereValue,
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

export class SphereTokenEngine {
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

  public async mint(params: MintParams, _options?: EngineOpOptions): Promise<SphereToken> {
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

  public async transfer(params: TransferParams, _options?: EngineOpOptions): Promise<SphereToken> {
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
    );
    const certified = await transferTx.toCertifiedTransaction(this.deps.trustBase, this.deps.predicateVerifier, proof);
    const transferred = await params.token.sdkToken.transfer(this.deps.trustBase, this.deps.predicateVerifier, certified);
    return this.wrapToken(transferred);
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

  // ── serialization ────────────────────────────────────────────────────────────

  public encodeToken(token: SphereToken): TokenBlob {
    return token.blob;
  }

  public async decodeToken(blob: TokenBlob): Promise<SphereToken> {
    return this.wrapToken(await Token.fromCBOR(blob.token));
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Wrap an SDK token into a SphereToken: cache its blob + decoded value. */
  private wrapToken(sdkToken: Token): SphereToken {
    const data = sdkToken.genesis.data;
    const value = data ? SpherePaymentData.fromCBOR(data).toValue() : null;
    const blob: TokenBlob = {
      v: TOKEN_BLOB_VERSION,
      network: sdkToken.genesis.networkId.id,
      token: sdkToken.toCBOR(),
    };
    return { sdkToken, blob, value };
  }
}
