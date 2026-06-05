/**
 * token-engine/engine.ts — the FROZEN public port (ITokenEngine) + its config.
 *
 * This is the contract both migration tracks build against. It is sphere-domain
 * only (see types.ts). The granular, SDK-typed steps (buildMint, submit,
 * awaitProof, certify, …) are an INTERNAL concern of the real adapter and are
 * intentionally NOT part of this public interface.
 */

import type {
  EngineIdentity,
  CoinId,
  SphereValue,
  SphereToken,
  TokenBlob,
  SphereNetwork,
  MintParams,
  TransferParams,
  SplitParams,
  SplitResult,
  EngineVerifyResult,
} from './types';

/** Options common to the long-running, network-bound operations. */
export interface EngineOpOptions {
  /** Cancels the operation (including inclusion-proof polling). */
  readonly signal?: AbortSignal;
}

/**
 * The token engine port. The wallet's secp256k1 identity, the target network,
 * the aggregator client and the trust base are all bound at construction
 * (see EngineConfig); operations below take only sphere-domain arguments.
 */
export interface ITokenEngine {
  // ── identity / recipients ───────────────────────────────────────────────
  /** This engine's wallet identity (chain pubkey). Synchronous. */
  getIdentity(): EngineIdentity;

  /**
   * Legacy `DIRECT://` address for the given pubkey (defaults to this engine's
   * identity). This is the ONLY "address" in v2 and is kept stable across the
   * migration (Path A) so Quest XP / Unicity IDs keyed on it survive. Async —
   * the derivation hashes via the SDK.
   */
  deriveIdentityAddress(pubkey?: Uint8Array): Promise<string>;

  // ── value (read) ─────────────────────────────────────────────────────────
  /** Decoded value of a token (cached). Synchronous. */
  readValue(token: SphereToken): SphereValue | null;
  /** Balance of a single coin within a token. Synchronous. */
  balanceOf(token: SphereToken, coinId: CoinId): bigint;

  // ── lifecycle (sender-driven: build → submit → wait → certify → realize) ──
  /**
   * Mint (issue) a new token to a recipient pubkey. NOT a wallet end-user flow —
   * this is the issuer/developer capability: an app issuing its own tokens
   * (rewards, in-app currency, tickets) to users, or seeding test balances. v2
   * makes standalone mint first-class (Token.mint accepts a genesis with a null
   * justification). Split's per-output mint is a separate, internal path; the
   * Unicity-ID/nametag mint is a distinct identity surface (see migration plan §4.4).
   */
  mint(params: MintParams, options?: EngineOpOptions): Promise<SphereToken>;
  /** Spend a token wholesale to a recipient pubkey; returns the recipient's finished token. */
  transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken>;
  /** Split a token into N value-conserving outputs (burn source + internally mint each output). */
  split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult>;

  // ── verification ──────────────────────────────────────────────────────────
  /** Fully verify a token against the trust base. */
  verify(token: SphereToken, options?: EngineOpOptions): Promise<EngineVerifyResult>;
  /** Whether the token's current state has already been spent on the network. */
  isSpent(token: SphereToken, options?: EngineOpOptions): Promise<boolean>;

  // ── serialization ──────────────────────────────────────────────────────────
  /** Serialize a token for storage/transport. Synchronous. */
  encodeToken(token: SphereToken): TokenBlob;
  /** Reconstruct a token from its blob (decodes embedded payment data). */
  decodeToken(blob: TokenBlob): Promise<SphereToken>;
}

/**
 * Engine construction config. Sphere-domain inputs only: the factory maps
 * `network` → SDK NetworkId, builds the aggregator client from `aggregatorUrl`,
 * the signing service from `privateKey`, and loads the trust base internally.
 *
 * NOTE: trust-base sourcing + proof-policy defaults are finalized in Phase 0.8;
 * this shape may gain fields there without affecting the ITokenEngine contract.
 */
export interface EngineConfig {
  /** Target network; selects NetworkId and the default trust base. */
  readonly network: SphereNetwork;
  /** Aggregator (gateway) base URL the StateTransitionClient talks to. */
  readonly aggregatorUrl: string;
  /** Wallet signing key (secp256k1 private scalar, 32 bytes). Held inside the engine only. */
  readonly privateKey: Uint8Array;
  /**
   * Optional explicit root-trust-base JSON. When omitted, the factory uses the
   * built-in default for `network`. Typed `unknown` to keep SDK types out of
   * the public surface (the factory parses it internally).
   */
  readonly trustBaseJson?: unknown;
  /** Inclusion-proof poll cadence in ms (engine owns the await policy; Spike S1). */
  readonly proofPollIntervalMs?: number;
  /** Inclusion-proof overall timeout in ms (0/undefined = no engine-side cap). */
  readonly proofTimeoutMs?: number;
}

/** Factory signature for the real adapter (implemented in Track A). */
export type CreateTokenEngine = (config: EngineConfig) => Promise<ITokenEngine>;
