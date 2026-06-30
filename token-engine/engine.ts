/**
 * token-engine/engine.ts — the FROZEN public port (ITokenEngine) + its config.
 *
 * This is the contract both migration tracks build against. It is sphere-domain
 * only (see types.ts). The granular, SDK-typed steps (buildMint, submit,
 * awaitProof, certify, …) are an INTERNAL concern of the real adapter and are
 * intentionally NOT part of this public interface.
 */

import type { IMintJustificationVerifier } from './sdk';
import type {
  EngineIdentity,
  CoinId,
  SphereValue,
  SphereToken,
  TokenBlob,
  MintParams,
  MintDataTokenParams,
  TransferParams,
  BridgeBurnParams,
  BridgeBurnResult,
  SplitParams,
  SplitResult,
  EngineVerifyResult,
} from './types';

/** Options common to the long-running, network-bound operations. */
export interface EngineOpOptions {
  /** Cancels the operation (including inclusion-proof polling). */
  readonly signal?: AbortSignal;
  /**
   * Realization seed for deterministic transfer/split (Part E, sdk-changes E.1/E.3):
   * a client-generated UUIDv4 in canonical lowercase string form. Every value the
   * transaction binds to (stateMask, per-output salts) is HKDF-derived from the
   * wallet key + this id, so re-calling the op with the same `transferId` and
   * inputs rebuilds the byte-identical transaction and resumes an interrupted
   * attempt instead of losing funds. Persist it BEFORE calling the engine.
   *
   * If absent, the engine generates one internally (`crypto.randomUUID()`) — the
   * derivation path is identical, but the call is NOT resumable (the seed is
   * gone if the process dies mid-op).
   */
  readonly transferId?: string;
  /**
   * Ordinal of this engine op WITHIN one logical send sharing a `transferId`
   * (ARCHITECTURE §7: D whole-token transfers + at most one split under ONE
   * intent). It indexes the op-level HKDF derivations (`stateMask`, the split
   * `burn` mask) so distinct ops never reuse a mask — §8.1's "per-transfer
   * unique". Per-output split salts are indexed by output ordinal in their own
   * `salt` field domain; callers MUST NOT run two splits under one transferId.
   * Default 0 (single-op sends). Resume MUST replay the same (transferId,
   * opIndex) pairing per source.
   */
  readonly opIndex?: number;
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
  /**
   * Genesis-stable token id — 64-char lowercase hex of the v2 TokenId (same
   * across every state). Use for dedup / history / tombstone keys. Synchronous.
   */
  tokenId(token: SphereToken): string;
  /** Decoded value of a token (cached). Synchronous. */
  readValue(token: SphereToken): SphereValue | null;
  /** Balance of a single coin within a token. Synchronous. */
  balanceOf(token: SphereToken, coinId: CoinId): bigint;
  /**
   * The opaque on-chain memo delivered with this token: the latest transfer's
   * data for a transferred token, else the memo in a minted output's value
   * envelope (split). Returns `null` when there is no memo — including for data
   * tokens (no value envelope; use `readTokenData`) and memo-less value tokens.
   * To tell a data token from a value token, check `readValue` (null ⇒
   * data/value-less token). Synchronous.
   */
  readMemo(token: SphereToken): Uint8Array | null;
  /** Raw genesis data of a token (e.g. a data-token's terms). `null` when absent. Synchronous. */
  readTokenData(token: SphereToken): Uint8Array | null;

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
  /**
   * Mint a NON-value (data) token: opaque `data` + custom `tokenType` + deterministic
   * `salt` → a stable, terms-derived `tokenId`. The result has `value === null`;
   * read its bytes via `readTokenData`. (Used e.g. for on-chain invoice tokens.)
   */
  mintDataToken(params: MintDataTokenParams, options?: EngineOpOptions): Promise<SphereToken>;
  /** Spend a token wholesale to a recipient pubkey; returns the recipient's finished token. */
  transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken>;
  /** Split a token into N value-conserving outputs (burn source + internally mint each output). */
  split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult>;
  /**
   * Bridge-back burn (06 §A1.2): spend a token to `BurnPredicate(reasonHash)` with
   * `reasonBytes` in the aux data, certify it, and return the burned blob + the
   * certified state id / tx hash (for nullifier/leaf derivation). The burn is
   * terminal — the token can never move again.
   */
  bridgeBurn(params: BridgeBurnParams, options?: EngineOpOptions): Promise<BridgeBurnResult>;

  // ── verification ──────────────────────────────────────────────────────────
  /** Fully verify a token against the trust base. */
  verify(token: SphereToken, options?: EngineOpOptions): Promise<EngineVerifyResult>;
  /** Whether the token's current state has already been spent on the network. */
  isSpent(token: SphereToken, options?: EngineOpOptions): Promise<boolean>;
  /**
   * Whether the token's CURRENT state is locked to `SignaturePredicate(pubkey)`.
   * Local + synchronous (predicate byte-compare, no network). The receive path
   * uses it to reject tokens that are not actually addressed to this wallet.
   */
  isOwnedBy(token: SphereToken, pubkey: Uint8Array): boolean;

  // ── serialization ──────────────────────────────────────────────────────────
  /** Serialize a token for storage/transport. Synchronous. */
  encodeToken(token: SphereToken): TokenBlob;
  /** Reconstruct a token from its blob (decodes embedded payment data). */
  decodeToken(blob: TokenBlob): Promise<SphereToken>;

  /**
   * The backend-true delivery keys for encoded TokenBlob bytes: the
   * genesis-stable tokenId and the SDK's PROTOCOL state hash of the latest
   * state (DataHash imprint, hex). wallet-api keys mailbox entries on exactly
   * this pair (entry_id = SHA-256(tokenId ‖ stateHash); §8.2 step 4 validates
   * a deposit's claimed stateHash against it) — a plain hash over the token
   * bytes is NOT this value and 422s on deposit. Delivery implementations MUST
   * derive their ids through this method, never locally.
   */
  deliveryKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }>;
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
  /** Aggregator (gateway) base URL the StateTransitionClient talks to. */
  readonly aggregatorUrl: string;
  /** Optional gateway API key (some gateways, e.g. testnet2, require it for auth). */
  readonly apiKey?: string;
  /** Wallet signing key (secp256k1 private scalar, 32 bytes). Held inside the engine only. */
  readonly privateKey: Uint8Array;
  /**
   * Root-trust-base JSON. The single source of truth for the network — the engine's
   * NetworkId is taken from it (`RootTrustBase.networkId` via `NetworkId.fromId`), so
   * any network id works (e.g. testnet2 = 4) with no enum entry. Typed `unknown` to
   * keep SDK types off the public surface (the factory parses it internally).
   */
  readonly trustBaseJson: unknown;
  /** Inclusion-proof poll cadence in ms (engine owns the await policy; Spike S1). */
  readonly proofPollIntervalMs?: number;
  /** Inclusion-proof overall timeout in ms (0/undefined = no engine-side cap). */
  readonly proofTimeoutMs?: number;
  /**
   * Per-asset bridged-token mint-reason verifiers (one per bridged asset, e.g.
   * `@unicitylabs/bridge-plugin-tron-usdt`). Registered into the engine's
   * mint-justification verifier so `verify()` re-checks bridge lock proofs on
   * every receive. Each is dispatched by its CBOR tag (must be unique). The
   * consumer constructs these — typically with `spherePaymentAmountExtractor`
   * so the token's declared value is checked against the locked amount.
   */
  readonly bridgeJustificationVerifiers?: readonly IMintJustificationVerifier[];
}

/** Factory signature for the real adapter (implemented in Track A). */
export type CreateTokenEngine = (config: EngineConfig) => Promise<ITokenEngine>;
