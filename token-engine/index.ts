/**
 * token-engine — public entry point.
 *
 * The wallet's anti-corruption layer over the v2 state-transition SDK. Everything
 * outside this module imports the token engine from here (the ITokenEngine port
 * and sphere-domain types), never the SDK directly.
 *
 * The concrete adapter (`createSphereTokenEngine`) and the in-memory test double
 * (`FakeTokenEngine`) are exported here as they land in Phase 0 / Track A.
 */

// Frozen contract
export type {
  ITokenEngine,
  EngineConfig,
  EngineOpOptions,
  CreateTokenEngine,
} from './engine';

export type {
  EngineIdentity,
  SphereNetwork,
  CoinId,
  SphereAsset,
  SphereValue,
  TokenBlob,
  SphereToken,
  MintParams,
  MintDataTokenParams,
  TransferParams,
  SplitOutput,
  SplitParams,
  SplitResult,
  EngineVerifyResult,
} from './types';

// Identity (A6): legacy DIRECT:// address derivation (Path A — XP-invariant).
// Reused by core/Sphere (B6) and the engine's deriveIdentityAddress.
export { deriveDirectAddress } from './identity';

// The concrete adapter factory (A4) — the public way to obtain an ITokenEngine.
export { createSphereTokenEngine } from './factory';

// Typed conflict surface of the recoverable engine (Part E.2): the source state
// was consumed by a DIFFERENT transaction — a lost race, not a resume. Callers
// abort the intent and re-plan under a new transferId.
export { TransferConflictError } from './errors';

// Self-issued Unicity ID (nametag) token mint — the v2 analog of the v1
// nametag mint, stored at registration but unused at runtime (D5 + user
// decision 2026-06-10; see unicity-id.ts header).
export { createUnicityIdMinter } from './unicity-id';
export type { IUnicityIdMinter, UnicityIdMintResult } from './unicity-id';

// The SpherePaymentData codec (CBOR tag 39048) — the value envelope inside
// Sphere tokens. Exported via the `./token-engine` subpath so server-side
// consumers (wallet-api deposit validation) can decode token values without
// pulling the browser/IPFS/Nostr dependency closure of the root entry.
export {
  SpherePaymentData,
  decodeSpherePaymentData,
  spherePaymentAmountExtractor,
  sphereAssetToSdk,
} from './SpherePaymentData';
