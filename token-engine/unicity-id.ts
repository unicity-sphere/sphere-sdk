/**
 * token-engine/unicity-id.ts — self-issued v2 UnicityIdToken mint (the v2 analog
 * of the v1 nametag-token mint).
 *
 * User decision 2026-06-10: the on-chain Unicity ID claim is minted AND STORED
 * again at nametag registration (it was retired with v1 in Track B / D5), but it
 * is NOT used at runtime — name resolution stays Nostr-binding-only, receive
 * stays SignaturePredicate(chainPubkey), and no PROXY semantics return. The
 * token is kept for the future (e.g. an issuer/verification model).
 *
 * Trust model: SELF-ISSUED. The wallet's own key is the issuer lock script, the
 * recipient AND the target predicate (the v2 local-mint path — the issuer pin is
 * only meaningful when verifying third-party tokens). Because the issuer lock
 * script is part of the StateId, on-chain uniqueness is per-issuer only; GLOBAL
 * name uniqueness remains the Nostr first-seen-wins binding's job (unchanged).
 *
 * Determinism / idempotency: tokenId = SHA256(CBOR["NAMETAG_", null, name]),
 * tokenType is pinned (UNICITY_TOKEN_TYPE_HEX), and all predicates derive from
 * the wallet key — the whole mint transaction is reproducible byte-for-byte, so
 * a re-mint (e.g. after the token was lost from local storage) re-certifies the
 * same state and yields the identical token (the v1 REQUEST_ID_EXISTS recovery
 * analog).
 */

import { SphereError } from '../core/errors';
import { logger } from '../core/logger';
import {
  AggregatorClient,
  CertificationData,
  CertificationStatus,
  HexConverter,
  PredicateVerifierService,
  RootTrustBase,
  SignaturePredicate,
  SignaturePredicateUnlockScript,
  SigningService,
  StateTransitionClient,
  TokenType,
  UnicityId,
  UnicityIdMintTransaction,
  UnicityIdToken,
  waitInclusionProof,
} from './sdk';
import { UNICITY_TOKEN_TYPE_HEX } from './identity';
import type { EngineConfig, EngineOpOptions } from './engine';

export interface UnicityIdMintResult {
  /** UnicityIdToken CBOR, hex-encoded — the storable form (UnicityIdToken.fromCBOR round-trips it). */
  readonly tokenCborHex: string;
  /** 64-char hex token id, derived from the name (stable across re-mints). */
  readonly tokenId: string;
}

/** Self-issued Unicity ID (nametag) token minter. */
export interface IUnicityIdMinter {
  /**
   * Mint (or idempotently re-certify) the UnicityIdToken for `name`,
   * self-issued by this wallet's key. Network-bound: submits the certification
   * request and waits for the inclusion proof.
   */
  mintUnicityIdToken(name: string, options?: EngineOpOptions): Promise<UnicityIdMintResult>;
}

class SelfIssuedUnicityIdMinter implements IUnicityIdMinter {
  public constructor(
    private readonly client: StateTransitionClient,
    private readonly trustBase: RootTrustBase,
    private readonly predicateVerifier: PredicateVerifierService,
    private readonly signingService: SigningService,
  ) {}

  public async mintUnicityIdToken(name: string, options?: EngineOpOptions): Promise<UnicityIdMintResult> {
    const unicityId = new UnicityId(name);
    const self = SignaturePredicate.fromSigningService(this.signingService);

    // Deterministic per (name, wallet key): pinned token type, self predicates.
    const mintTx = await UnicityIdMintTransaction.create(
      self, // issuer lock script (self-issued)
      self, // recipient — locks the minted token state to this wallet
      unicityId,
      new TokenType(HexConverter.decode(UNICITY_TOKEN_TYPE_HEX)),
      self, // target predicate the unicity id resolves to
    );

    const certificationData = await CertificationData.fromTransaction(
      mintTx,
      await SignaturePredicateUnlockScript.create(mintTx, this.signingService),
    );

    const response = await this.client.submitCertificationRequest(certificationData);
    if (response.status !== CertificationStatus.SUCCESS) {
      // The transaction is deterministic: when this wallet minted the name
      // before, its certification is already on-chain and the proof below
      // still verifies (idempotent re-mint). Any genuine failure surfaces as
      // a proof-wait timeout/verification error instead.
      logger.warn(
        'UnicityIdMinter',
        `Certification request returned ${response.status} for "@${name}" — attempting proof recovery (idempotent re-mint).`,
      );
    }

    try {
      const proof = await waitInclusionProof(
        this.client,
        this.trustBase,
        this.predicateVerifier,
        mintTx,
        options?.signal,
      );
      const certified = await mintTx.toCertifiedTransaction(this.trustBase, this.predicateVerifier, proof);
      const token = await UnicityIdToken.mint(this.trustBase, this.predicateVerifier, certified);
      return {
        tokenCborHex: HexConverter.encode(token.toCBOR()),
        tokenId: HexConverter.encode(token.id.bytes),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SphereError(
        `Unicity ID mint failed for "@${name}": ${detail}` +
          (response.status !== CertificationStatus.SUCCESS ? ` (certification status: ${response.status})` : ''),
        'AGGREGATOR_ERROR',
      );
    }
  }
}

/** SDK objects the minter operates with (test seam; mirrors EngineDeps). */
export interface UnicityIdMinterDeps {
  readonly client: StateTransitionClient;
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly signingService: SigningService;
}

/** Build the minter from pre-constructed SDK objects (tests / shared wiring). */
export function createUnicityIdMinterFromDeps(deps: UnicityIdMinterDeps): IUnicityIdMinter {
  return new SelfIssuedUnicityIdMinter(deps.client, deps.trustBase, deps.predicateVerifier, deps.signingService);
}

/**
 * Build the self-issued Unicity ID minter from the same config the token engine
 * uses (trust base JSON + gateway URL + API key + wallet key).
 */
export function createUnicityIdMinter(config: EngineConfig): IUnicityIdMinter {
  if (config.trustBaseJson == null) {
    throw new SphereError('Unicity ID minter requires a trust base (trustBaseJson)', 'INVALID_CONFIG');
  }
  const trustBase = RootTrustBase.fromJSON(config.trustBaseJson);
  return new SelfIssuedUnicityIdMinter(
    new StateTransitionClient(new AggregatorClient(config.aggregatorUrl, config.apiKey ?? null)),
    trustBase,
    PredicateVerifierService.create(),
    new SigningService(config.privateKey),
  );
}
