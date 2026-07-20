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
  SplitCheckpointStore,
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

// Typed error surface of the recoverable engine (Part E.2/E.4). TransferConflictError = the source
// was consumed by a DIFFERENT transaction (lost race — abort + re-plan). The rest are KEEP-OPEN
// (never abort): ProofUnconfirmedError (#631 indeterminate certification), and the split burn
// checkpoint family (sphere-sdk#501/E.4) that the wallet-api adapter + PaymentsModule must catch
// and dispose — CheckpointPersistFailedError, SplitCheckpointLostError, CheckpointTrustbaseMismatchError.
export {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from './errors';

// The SpherePaymentData codec (CBOR tag 39050) — the value envelope inside
// Sphere tokens. Exported via the `./token-engine` subpath so server-side
// consumers (wallet-api deposit validation) can decode token values without
// pulling the browser/IPFS/Nostr dependency closure of the root entry.
export {
  SpherePaymentData,
  decodeSpherePaymentData,
  sphereAssetToSdk,
} from './SpherePaymentData';
