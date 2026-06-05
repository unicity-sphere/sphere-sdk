/**
 * token-engine/types.ts — the FROZEN, sphere-domain contract surface.
 *
 * Design rule (anti-corruption): the public ITokenEngine port speaks ONLY
 * sphere-domain types — `Uint8Array` pubkeys, `string` coin ids, `bigint`
 * amounts, plain enums. The v2 state-transition SDK has exactly ONE foothold
 * here: `SphereToken.sdkToken`, an OPAQUE handle. Callers must treat it as
 * opaque (store it, hand it back to the engine) and never call methods on it —
 * they cannot, since the ESLint boundary forbids them importing the SDK.
 *
 * Both migration tracks freeze against this file:
 *   Track A implements it (token-engine internals).
 *   Track B codes callers against it (using FakeTokenEngine until A lands).
 */

import type { Token } from './sdk';

// ── identity / recipients ─────────────────────────────────────────────────────

/** The wallet identity at the engine boundary. The private key never appears in a DTO. */
export interface EngineIdentity {
  /** 33-byte compressed secp256k1 public key (stable across the migration — Path A). */
  readonly chainPubkey: Uint8Array;
}

/** Which Unicity network a token/engine lives on. Maps to the SDK NetworkId inside the engine. */
export type SphereNetwork = 'mainnet' | 'testnet' | 'local';

// ── value model ───────────────────────────────────────────────────────────────

/**
 * Coin identifier. Canonical form is the lowercase hex of the v2 AssetId;
 * human symbols (e.g. "ALPHA") are resolved to hex via the registry before use.
 */
export type CoinId = string;

/** One fungible position inside a token. */
export interface SphereAsset {
  readonly coinId: CoinId;
  readonly amount: bigint;
}

/** The decoded, app-defined value carried by a token (v2 Token itself is value-less). */
export interface SphereValue {
  readonly assets: readonly SphereAsset[];
}

// ── token ─────────────────────────────────────────────────────────────────────

/**
 * Storage-and-display token. Format version + network let storage migrate
 * independently of the SDK's own CBOR. The decoded value is re-derivable from
 * `token`, so it is NOT stored — only cached at runtime on SphereToken.value.
 */
export interface TokenBlob {
  /** Blob format version (sphere storage migrations; independent of SDK CBOR). */
  readonly v: number;
  /** NetworkId.id the token belongs to (mainnet=1 / testnet=2 / local=3). */
  readonly network: number;
  /** CBOR bytes of the v2 Token (`Token.toCBOR()`). */
  readonly token: Uint8Array;
}

/**
 * A wallet token. `sdkToken` is the OPAQUE engine handle (see file header) —
 * present for the engine to operate on, never to be touched by callers.
 */
export interface SphereToken {
  /** Opaque v2 SDK handle. Do not call methods on this outside token-engine/. */
  readonly sdkToken: Token;
  /** Serializable form for storage/transport. */
  readonly blob: TokenBlob;
  /** Decoded value (cached); null when the token carries no sphere payment data. */
  readonly value: SphereValue | null;
}

// ── operation params (sphere-domain in, SphereToken out) ──────────────────────

export interface MintParams {
  /** Recipient's 33-byte compressed chain pubkey; engine derives the predicate. */
  readonly recipientPubkey: Uint8Array;
  /** Value to embed in the mint; null mints a value-less token. */
  readonly value?: SphereValue | null;
}

export interface TransferParams {
  /** The token to spend (must be owned by this engine's identity). */
  readonly token: SphereToken;
  /** Recipient's 33-byte compressed chain pubkey. */
  readonly recipientPubkey: Uint8Array;
}

/**
 * One split output = one single-coin token. To split a multi-coin token, emit
 * one output per coin (the recipient receives the value as several tokens; the
 * SDK enforces per-coin conservation). If a single multi-coin output token is
 * ever needed, generalize this to `assets: readonly SphereAsset[]` (additive).
 */
export interface SplitOutput {
  readonly recipientPubkey: Uint8Array;
  readonly coinId: CoinId;
  readonly amount: bigint;
}

export interface SplitParams {
  /** The token to split (its total per coin must equal the sum of outputs). */
  readonly token: SphereToken;
  /** Desired outputs; value conservation is enforced by the SDK split. */
  readonly outputs: readonly SplitOutput[];
}

// ── results ───────────────────────────────────────────────────────────────────

/** Result of a split: one minted token per requested output, in input order. */
export interface SplitResult {
  readonly outputs: readonly SphereToken[];
}

/** Verification outcome, flattened to sphere-domain (no SDK status enum leaks). */
export interface EngineVerifyResult {
  readonly ok: boolean;
  /** Human-readable reason when `ok` is false (mapped from the SDK verification status). */
  readonly reason?: string;
}
