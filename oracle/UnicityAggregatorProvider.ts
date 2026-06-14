/**
 * Unicity Aggregator Provider
 * Platform-independent implementation using @unicitylabs/state-transition-sdk
 *
 * The oracle is a trusted service that provides verifiable truth
 * about token state through cryptographic inclusion proofs.
 *
 * TrustBaseLoader is injected for platform-specific loading:
 * - Browser: fetch from URL
 * - Node.js: read from file
 */

import { logger } from '../core/logger';
import { incr, time } from '../core/perf-counters';
import type { ProviderStatus } from '../types';
import type {
  OracleProvider,
  TransferCommitment,
  SubmitResult,
  InclusionProof,
  WaitOptions,
  ValidationResult,
  TokenState,
  MintParams,
  MintResult,
  OracleEvent,
  OracleEventCallback,
  TrustBaseLoader,
} from './oracle-provider';
import { DEFAULT_AGGREGATOR_TIMEOUT, TIMEOUTS } from '../constants';
import { SphereError } from '../core/errors';

// SDK imports - using direct imports from the SDK
import { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient';
import { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { TransferCommitment as SdkTransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import {
  InclusionProof as SdkInclusionProof,
  InclusionProofVerificationStatus,
} from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash';
import { hexToBytes, bytesToHex } from '../core/hex';

// SDK MintCommitment type - using interface to avoid generic complexity
interface SdkMintCommitment {
  requestId?: { toString(): string };
  [key: string]: unknown;
}

// =============================================================================
// Configuration
// =============================================================================

export interface UnicityAggregatorProviderConfig {
  /** Aggregator URL */
  url: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout (ms) */
  timeout?: number;
  /** Skip trust base verification (dev only) */
  skipVerification?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Trust base loader (platform-specific) */
  trustBaseLoader?: TrustBaseLoader;
}

// =============================================================================
// RPC Response Types
// =============================================================================

interface RpcSubmitResponse {
  requestId?: string;
}

/**
 * Response shape from the aggregator's `get_inclusion_proof` RPC.
 * The aggregator returns `{ inclusionProof: { authenticator, merkleTreePath,
 * transactionHash, unicityCertificate } }` — the historical Sphere wrapper
 * incorrectly looked for a top-level `proof` field, so every poll returned
 * null and instant-mode finalization never converged. Both fields are now
 * accepted (proof for legacy / mainnet shapes, inclusionProof for testnet).
 */
interface RpcProofResponse {
  /** Canonical aggregator shape (testnet, current). */
  inclusionProof?: unknown;
  /** Historical / fallback shape — kept for compatibility. */
  proof?: unknown;
  roundNumber?: number;
}

interface RpcValidateResponse {
  valid?: boolean;
  spent?: boolean;
  stateHash?: string;
  error?: string;
}

interface RpcSpentResponse {
  spent?: boolean;
}

interface RpcTokenStateResponse {
  state?: {
    stateHash?: string;
    spent?: boolean;
    roundNumber?: number;
  };
}

interface RpcMintResponse {
  requestId?: string;
  tokenId?: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Unicity Aggregator Provider
 * Concrete implementation of OracleProvider using Unicity's aggregator service
 */
export class UnicityAggregatorProvider implements OracleProvider {
  readonly id = 'unicity-aggregator';
  readonly name = 'Unicity Aggregator';
  readonly type = 'network' as const;
  readonly description = 'Unicity state transition aggregator (oracle implementation)';

  private config: Required<Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'>> & {
    trustBaseLoader?: TrustBaseLoader;
  };
  private status: ProviderStatus = 'disconnected';
  private eventCallbacks: Set<OracleEventCallback> = new Set();

  // SDK clients
  private aggregatorClient: AggregatorClient | null = null;
  private stateTransitionClient: StateTransitionClient | null = null;
  private trustBase: RootTrustBase | null = null;

  /** Get the current trust base */
  getTrustBase(): RootTrustBase | null {
    return this.trustBase;
  }

  /**
   * Get the bundled RootTrustBase (H6 — SPEC §8.4.2).
   *
   * Alias for getTrustBase(), exposed under the spec-canonical name so the
   * pointer layer can consume the same bundled trust base as L4.
   */
  getRootTrustBase(): RootTrustBase | null {
    return this.trustBase;
  }

  /** Get the state transition client */
  getStateTransitionClient(): StateTransitionClient | null {
    return this.stateTransitionClient;
  }

  /** Get the aggregator client */
  getAggregatorClient(): AggregatorClient | null {
    return this.aggregatorClient;
  }

  // Cache for spent states (immutable). Wave L: capped at 4096 with
  // delete-oldest LRU eviction to prevent unbounded growth. Spent
  // states are immutable so caching is safe; the cap protects long-
  // running wallet processes that observe many unique stateHashes
  // (transfers, validate() loops, cross-wallet sync) from gradual
  // memory bloat.
  private spentCache: Map<string, boolean> = new Map();
  private static SPENT_CACHE_MAX = 4096;

  /** Wave L: bounded cache insert. */
  private cacheSpent(stateHash: string): void {
    if (this.spentCache.size >= UnicityAggregatorProvider.SPENT_CACHE_MAX) {
      const firstKey = this.spentCache.keys().next().value;
      if (firstKey !== undefined) this.spentCache.delete(firstKey);
    }
    this.spentCache.set(stateHash, true);
  }

  constructor(config: UnicityAggregatorProviderConfig) {
    this.config = {
      url: config.url,
      apiKey: config.apiKey ?? '',
      timeout: config.timeout ?? DEFAULT_AGGREGATOR_TIMEOUT,
      skipVerification: config.skipVerification ?? false,
      debug: config.debug ?? false,
      trustBaseLoader: config.trustBaseLoader,
    };
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    // Mark as connected - actual connectivity will be verified on first operation
    // The aggregator requires requestId in params even for status checks,
    // which the SDK client doesn't support directly
    this.status = 'connected';
    this.emitEvent({ type: 'oracle:connected', timestamp: Date.now() });
    this.log('Connected to oracle:', this.config.url);
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
    this.emitEvent({ type: 'oracle:disconnected', timestamp: Date.now() });
    this.log('Disconnected from oracle');
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // OracleProvider Implementation
  // ===========================================================================

  async initialize(trustBase?: RootTrustBase): Promise<void> {
    // Wave G.3: clear the inclusion-proof cache on (re)initialize.
    // Trust-base rotation invalidates verification results — a proof
    // that was OK under epoch N may be PATH_INVALID under epoch N+1.
    this.inclusionProofCache.clear();
    // Initialize SDK clients with optional API key
    this.aggregatorClient = new AggregatorClient(
      this.config.url,
      this.config.apiKey || null
    );
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);

    if (trustBase) {
      this.trustBase = trustBase;
    } else if (!this.config.skipVerification && this.config.trustBaseLoader) {
      // Steelman finding #156: trust-base load failures MUST NOT be
      // silently swallowed. The historical implementation logged at
      // debug level and left `this.trustBase = null`, which then
      // forced every downstream `verifyInclusionProof` to fail closed
      // (returning `false` for a verify call is indistinguishable
      // from "we proved this proof is invalid"). An attacker who
      // can poison the trust-base loader (DNS hijack, file system
      // permissions, MITM on the bundled URL) flips the SDK into
      // a degraded crypto state where every legitimate proof is
      // refused.
      //
      // Fail loudly: surface the underlying failure as a SphereError
      // so callers can route around or escalate. `Sphere.init` /
      // adapter wiring catches this and refuses to come up — better
      // than booting in a state where every verification is silently
      // wrong.
      try {
        const trustBaseJson = await this.config.trustBaseLoader.load();
        if (trustBaseJson) {
          this.trustBase = RootTrustBase.fromJSON(trustBaseJson);
        } else {
          throw new SphereError(
            'TrustBaseLoader.load() returned null/undefined — cannot verify proofs',
            'NOT_INITIALIZED',
          );
        }
      } catch (error) {
        // Don't double-wrap an existing SphereError; preserve forensic detail
        // in `cause` for non-SphereError errors so the caller can drill in.
        if (error instanceof SphereError) {
          throw error;
        }
        throw new SphereError(
          `Failed to load trust base — refusing to initialize aggregator: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'NOT_INITIALIZED',
          error,
        );
      }
    }

    await this.connect();
    this.log('Initialized with trust base:', !!this.trustBase);
  }

  /**
   * Submit a transfer commitment to the aggregator.
   * Accepts either an SDK TransferCommitment or a simple commitment object.
   */
  async submitCommitment(commitment: TransferCommitment | SdkTransferCommitment): Promise<SubmitResult> {
    return time('aggregator.submitCommitment', () => this._submitCommitmentImpl(commitment));
  }
  private async _submitCommitmentImpl(commitment: TransferCommitment | SdkTransferCommitment): Promise<SubmitResult> {
    this.ensureConnected();

    try {
      let requestId: string;

      // Check if it's an SDK commitment (has submitTransferCommitment method signature)
      if (this.isSdkTransferCommitment(commitment)) {
        // Use SDK client directly
        const response = await this.stateTransitionClient!.submitTransferCommitment(commitment);
        // Steelman fix (warning 6e): mirror PaymentsModule's 6-site
        // `toJSON ?? String(...)` pattern. SDK requestIds are objects
        // with a custom `toJSON` that yields the canonical hex
        // imprint; bare `toString()` falls back to the object's
        // default `[object Object]` for objects that don't override
        // it. Always prefer `toJSON()`, fall back to `String(...)`.
        requestId =
          (typeof commitment.requestId === 'object' &&
            commitment.requestId !== null &&
            typeof (commitment.requestId as { toJSON?: () => string }).toJSON === 'function'
            ? (commitment.requestId as { toJSON: () => string }).toJSON()
            : commitment.requestId !== undefined
              ? String(commitment.requestId)
              : response.status);
      } else {
        // Fallback to RPC for simple commitment objects
        const response = await this.rpcCall<RpcSubmitResponse>('submit_commitment', {
          sourceToken: commitment.sourceToken,
          recipient: commitment.recipient,
          salt: Array.from(commitment.salt),
          data: commitment.data,
        });
        requestId = response.requestId ?? '';
      }

      this.emitEvent({
        type: 'commitment:submitted',
        timestamp: Date.now(),
        data: { requestId },
      });

      return {
        success: true,
        requestId,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Submit a mint commitment to the aggregator (SDK only)
   * @param commitment - SDK MintCommitment instance
   */
  async submitMintCommitment(commitment: SdkMintCommitment): Promise<SubmitResult> {
    return time('aggregator.submitMintCommitment', () => this._submitMintCommitmentImpl(commitment));
  }
  private async _submitMintCommitmentImpl(commitment: SdkMintCommitment): Promise<SubmitResult> {
    this.ensureConnected();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.stateTransitionClient!.submitMintCommitment(commitment as any);
      // Steelman fix (warning 6e): mirror PaymentsModule's 6-site pattern.
      // See submitCommitment above for rationale.
      const requestId =
        (typeof commitment.requestId === 'object' &&
          commitment.requestId !== null &&
          typeof (commitment.requestId as { toJSON?: () => string }).toJSON === 'function'
          ? (commitment.requestId as { toJSON: () => string }).toJSON()
          : commitment.requestId !== undefined
            ? String(commitment.requestId)
            : response.status);

      this.emitEvent({
        type: 'commitment:submitted',
        timestamp: Date.now(),
        data: { requestId },
      });

      return {
        success: true,
        requestId,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  private isSdkTransferCommitment(commitment: unknown): commitment is SdkTransferCommitment {
    return (
      commitment !== null &&
      typeof commitment === 'object' &&
      'requestId' in commitment &&
      typeof (commitment as SdkTransferCommitment).requestId?.toString === 'function'
    );
  }

  async getProof(requestId: string): Promise<InclusionProof | null> {
    return time('aggregator.getProof', () => this._getProofImpl(requestId));
  }
  private async _getProofImpl(requestId: string): Promise<InclusionProof | null> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcProofResponse>('get_inclusion_proof', { requestId });

      // The aggregator returns `inclusionProof` (canonical, current);
      // some legacy / mock responders use `proof`. Accept either.
      const proof = response.inclusionProof ?? response.proof;
      if (!proof) {
        return null;
      }

      // Steelman finding #157: shape-validate the aggregator's proof
      // payload before handing it back to callers. A malicious or
      // misbehaving aggregator can return arbitrary JSON
      // (`{inclusionProof: true}`, `{inclusionProof: {}}`,
      // `{inclusionProof: "string"}`, etc.). Without validation the
      // historical caller treats every non-null payload as a successful
      // proof, which silently drives finalization, race-lost detection,
      // and Rule-4 enrichment off forged shapes.
      //
      // Two-layer validation:
      //   1. Structural pre-check: must be a plain object (not primitive,
      //      not array) and carry every field required by the SDK's
      //      `IInclusionProofJson` (`authenticator`, `merkleTreePath`,
      //      `transactionHash`, `unicityCertificate`).
      //   2. Cryptographic parse: try `SdkInclusionProof.fromJSON(proof)`.
      //      The SDK enforces invariants the aggregator wrapper cannot
      //      (auth+tx pairing, merkle-path well-formedness, etc.). On
      //      throw, return null (logged at WARN). getProof is allowed
      //      to return null for "no proof yet" so callers retry; throwing
      //      here would break poll loops.
      if (
        typeof proof !== 'object' ||
        proof === null ||
        Array.isArray(proof)
      ) {
        logger.warn(
          'Aggregator',
          `getProof: rejected non-object inclusion proof shape (got ${
            Array.isArray(proof) ? 'array' : typeof proof
          })`,
        );
        return null;
      }
      const proofObj = proof as Record<string, unknown>;
      const requiredKeys = [
        'authenticator',
        'merkleTreePath',
        'transactionHash',
        'unicityCertificate',
      ] as const;
      for (const k of requiredKeys) {
        if (!(k in proofObj)) {
          logger.warn(
            'Aggregator',
            `getProof: rejected inclusion proof missing required field "${k}"`,
          );
          return null;
        }
      }
      try {
        // Cryptographic structure check. The parsed instance is not
        // retained here — callers consume the JSON shape — but a
        // throw on fromJSON proves the payload is structurally
        // SDK-valid. Verification against the trust base happens in
        // `verifyInclusionProof` at the caller.
        SdkInclusionProof.fromJSON(proof);
      } catch (parseErr) {
        logger.warn(
          'Aggregator',
          'getProof: SDK fromJSON rejected inclusion proof shape',
          parseErr,
        );
        return null;
      }

      return {
        requestId,
        roundNumber: response.roundNumber ?? 0,
        proof,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.warn('Aggregator', 'getProof failed', error);
      return null;
    }
  }

  async waitForProof(requestId: string, options?: WaitOptions): Promise<InclusionProof> {
    return time('aggregator.waitForProof', () => this._waitForProofImpl(requestId, options));
  }
  private async _waitForProofImpl(requestId: string, options?: WaitOptions): Promise<InclusionProof> {
    const timeout = options?.timeout ?? this.config.timeout;
    const pollInterval = options?.pollInterval ?? TIMEOUTS.PROOF_POLL_INTERVAL;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
      options?.onPoll?.(++attempt);

      const proof = await this.getProof(requestId);
      if (proof) {
        this.emitEvent({
          type: 'proof:received',
          timestamp: Date.now(),
          data: { requestId, roundNumber: proof.roundNumber },
        });
        return proof;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new SphereError(`Timeout waiting for proof: ${requestId}`, 'TIMEOUT');
  }

  async validateToken(tokenData: unknown): Promise<ValidationResult> {
    return time('aggregator.validateToken', () => this._validateTokenImpl(tokenData));
  }
  private async _validateTokenImpl(tokenData: unknown): Promise<ValidationResult> {
    this.ensureConnected();

    // Issue #245 #5 — parse the SDK token ONCE so we can reuse it for
    // (a) SDK-path verification AND (b) deriving the predicate
    // publicKey for the spent-cache key. Aligning the cache key with
    // `isSpent`'s `${publicKey}:${stateHash}` format lets a
    // validateToken-driven spent decision short-circuit a subsequent
    // `isSpent(pubkey, sameHash)` call (and vice versa).
    //
    // Normalize input shape: callers pass either the parsed token object
    // (UXF receive / transfer-in paths build it from `.toJSON()`) OR a
    // JSON string (PaymentsModule.validate() pulls `token.sdkData` straight
    // from storage). state-transition-sdk's `Token.fromJSON` checks
    // `'transactions' in input` and throws InvalidJsonStructureError for
    // string input — silently dropping us to the RPC fallback. The
    // aggregator does not expose a `validateToken` JSON-RPC method (see
    // rpcCall site below), so that fallback always returns invalid. The
    // net effect was that `payments.validate()` reported every token
    // invalid, which permanently broke `SwapModule.verifyPayout`'s retry
    // loop. Parse once here so the SDK path runs with pure local crypto.
    const parsedTokenData =
      typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
    let sdkToken: Awaited<ReturnType<typeof SdkToken.fromJSON>> | null = null;
    try {
      sdkToken = await SdkToken.fromJSON(parsedTokenData);
    } catch {
      // Pre-parse still failed (malformed token JSON) — SDK path will
      // skip via the `sdkToken !== null` guard and fall through to RPC.
    }

    try {
      // Try SDK validation first if we have trust base
      if (this.trustBase && !this.config.skipVerification && sdkToken !== null) {
        try {
          const verifyResult = await sdkToken.verify(this.trustBase);

          // Calculate state hash
          const stateHash = await sdkToken.state.calculateHash();
          const stateHashStr = stateHash.toJSON();

          const valid = verifyResult.isSuccessful;

          this.emitEvent({
            type: 'validation:completed',
            timestamp: Date.now(),
            data: { valid },
          });

          return {
            valid,
            spent: false, // Spend check is separate
            stateHash: stateHashStr,
            error: valid ? undefined : 'SDK verification failed',
          };
        } catch (sdkError) {
          this.log('SDK validation failed, falling back to RPC:', sdkError);
        }
      }

      // Fallback to RPC validation
      const response = await this.rpcCall<RpcValidateResponse>('validateToken', { token: parsedTokenData });

      const valid = response.valid ?? false;
      const spent = response.spent ?? false;

      this.emitEvent({
        type: 'validation:completed',
        timestamp: Date.now(),
        data: { valid },
      });

      // Cache spent state if spent (Wave L: bounded with LRU eviction).
      // Issue #245 #5 — key under `${publicKey}:${stateHash}` when the
      // predicate publicKey can be derived, matching `isSpent`'s key
      // namespace so cache hits transfer between the two paths.
      if (response.stateHash && spent) {
        const pubkeyHex = await this.derivePredicatePublicKeyHex(sdkToken);
        const cacheKey =
          pubkeyHex !== null
            ? `${pubkeyHex}:${response.stateHash}`
            : response.stateHash;
        this.cacheSpent(cacheKey);
      }

      return {
        valid,
        spent,
        stateHash: response.stateHash,
        error: response.error,
      };
    } catch (error) {
      return {
        valid: false,
        spent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Issue #245 #5 — derive the hex-encoded publicKey from a parsed
   * SDK Token's current state predicate. Best-effort; returns `null`
   * when the predicate is missing or cannot be materialized.
   *
   * Same recipe as PaymentsModule's
   * `extractCurrentStatePublicKeyHexFromSdkData` but operates on an
   * already-parsed `SdkToken` (validateToken parses once and shares).
   */
  private async derivePredicatePublicKeyHex(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkToken: any,
  ): Promise<string | null> {
    if (sdkToken === null || sdkToken === undefined) return null;
    const statePredicate = sdkToken?.state?.predicate;
    if (statePredicate === undefined || statePredicate === null) return null;
    let predicate;
    try {
      predicate = await PredicateEngineService.createPredicate(statePredicate);
    } catch {
      return null;
    }
    const pubkey = (predicate as unknown as { publicKey?: Uint8Array }).publicKey;
    if (!(pubkey instanceof Uint8Array) || pubkey.length === 0) return null;
    return bytesToHex(pubkey);
  }

  /**
   * Wait for inclusion proof using SDK (for SDK commitments)
   */
  async waitForProofSdk(
    commitment: SdkTransferCommitment | SdkMintCommitment,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return time('aggregator.waitForProofSdk', () => this._waitForProofSdkImpl(commitment, signal));
  }
  private async _waitForProofSdkImpl(
    commitment: SdkTransferCommitment | SdkMintCommitment,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.ensureConnected();

    if (!this.trustBase) {
      throw new SphereError('Trust base not initialized', 'NOT_INITIALIZED');
    }

    return await waitInclusionProof(
      this.trustBase,
      this.stateTransitionClient!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commitment as any,
      signal
    );
  }

  /**
   * Wave G.3: cryptographic verification of an inclusion proof for
   * the UXF Rule 4 enrichment gate.
   *
   * Reconstructs the SDK `InclusionProof` from the supplied JSON
   * shape, derives the `RequestId` from the proof's authenticator
   * (publicKey + stateHash imprint), and calls `proof.verify()`
   * against the bundled `RootTrustBase`. Returns true ONLY on
   * `OK` — anything else (PATH_NOT_INCLUDED / PATH_INVALID /
   * NOT_AUTHENTICATED / thrown) returns false so a buggy or
   * forged proof can never be lifted into a synthetic token-root.
   *
   * Cache: results are memoized by transactionHash since proof
   * verification is deterministic given (proofJson, trustBase,
   * tx). The cache is bounded; a Profile-level merge typically
   * runs verifyInclusionProof O(N) times where N = number of
   * unique tx-proof pairs in the merge candidates, often
   * single-digit.
   */
  private inclusionProofCache: Map<string, boolean> = new Map();
  private static INCLUSION_PROOF_CACHE_MAX = 1024;

  async verifyInclusionProof(input: {
    proofJson: unknown;
    transactionHash: string;
    proofHash?: string;
  }): Promise<boolean> {
    return time('aggregator.verifyInclusionProof', () => this._verifyInclusionProofImpl(input));
  }
  private async _verifyInclusionProofImpl(input: {
    proofJson: unknown;
    transactionHash: string;
    proofHash?: string;
  }): Promise<boolean> {
    // Steelman finding #156: don't silently return false when the
    // trust base never loaded — that masks an init-time failure as a
    // crypto-time invalid proof. Callers who interpret `false` as
    // "this proof is invalid" make the wrong decision (e.g., dropping
    // a perfectly valid proof from the merge candidates) when the
    // real cause is "we never bootstrapped". Throw NOT_INITIALIZED
    // so callers either (a) escalate, or (b) explicitly catch and
    // treat it as a soft failure with eyes open.
    if (this.trustBase === null) {
      throw new SphereError(
        'verifyInclusionProof: trustBase not loaded — call initialize() first',
        'NOT_INITIALIZED',
      );
    }
    // Wave I.6 + Wave J: sanity-check that transactionHash looks
    // like a DataHash imprint hex (algorithm-prefix + digest). The
    // SDK currently emits 68 chars (sha2-256 = 2-byte prefix + 32-
    // byte digest), but other algorithms in HashAlgorithm.js produce
    // different imprint lengths (sha224 → 60, sha384 → 100, sha512
    // → 132, ripemd160 → 44). Hardcoding length=68 silently rejected
    // every non-sha256 imprint. Now check format only — non-empty
    // even-length lowercase-hex with length >= 4 (smallest possible
    // imprint = 1-byte multihash code + 1-byte length + 0-byte
    // digest, fictional but lower bound). The byte-comparison at
    // line ~545 catches genuine value mismatches.
    if (
      typeof input.transactionHash !== 'string' ||
      input.transactionHash.length < 4 ||
      input.transactionHash.length % 2 !== 0 ||
      !/^[0-9a-f]+$/.test(input.transactionHash)
    ) {
      logger.debug(
        'Aggregator',
        'verifyInclusionProof: transactionHash must be even-length lowercase hex (got=' +
          (typeof input.transactionHash === 'string' ? input.transactionHash : typeof input.transactionHash) +
          ')',
      );
      return false;
    }
    // Wave I.7: cache key composes proofHash (when supplied) with
    // transactionHash so two distinct proofs attesting the same tx
    // do not collide. A forged proof returning false → cached →
    // genuine proof for same tx returns false-from-cache scenario
    // is closed by including the proof's own ContentHash in the key.
    const cacheKey = input.proofHash
      ? `${input.proofHash}:${input.transactionHash}`
      : input.transactionHash;
    const cached = this.inclusionProofCache.get(cacheKey);
    if (cached !== undefined) {
      // Wave I.4-related: refresh insertion order so the cache
      // approximates LRU semantics. Map.set on an existing key does
      // NOT change insertion order; delete-then-set does.
      this.inclusionProofCache.delete(cacheKey);
      this.inclusionProofCache.set(cacheKey, cached);
      return cached;
    }

    let result = false;
    try {
      const proof = SdkInclusionProof.fromJSON(input.proofJson);
      // Without a bound authenticator, no requestId can be derived;
      // a non-inclusion proof would lack an authenticator and is
      // not a candidate for Rule 4 enrichment anyway. Fail-closed.
      if (!proof.authenticator) {
        result = false;
      } else {
        // Defense: bind the proof to the transactionHash the caller
        // claims it attests. If the proof's transactionHash field
        // is null (non-inclusion shape) or doesn't match, refuse.
        const proofTxHashHex = proof.transactionHash
          ? Array.from(proof.transactionHash.imprint as Uint8Array)
              .map((b: number) => b.toString(16).padStart(2, '0'))
              .join('')
          : null;
        if (proofTxHashHex === null) {
          result = false;
        } else if (
          !input.transactionHash ||
          input.transactionHash.toLowerCase() !== proofTxHashHex.toLowerCase()
        ) {
          // The proof attests a DIFFERENT tx than the caller claimed
          // — replay/grafting attempt. Refuse.
          //
          // Wave J.b: log the mismatch at debug level. Surfaces the
          // common bug of passing a 64-char digest hex instead of a
          // 68-char DataHash imprint hex (a relaxed format check
          // accepts both lengths but the byte comparison must
          // genuinely match, so a digest-only input produces a
          // length mismatch that's worth diagnosing).
          logger.debug(
            'Aggregator',
            `verifyInclusionProof: transactionHash mismatch (input=${input.transactionHash}, ` +
              `proof.transactionHash.imprint=${proofTxHashHex}). ` +
              `Hint: callers must pass the SDK-encoded DataHash imprint ` +
              `(typically 68 chars for sha2-256), not the 64-char digest.`,
          );
          result = false;
        } else {
          const requestId = await RequestId.create(
            proof.authenticator.publicKey,
            proof.authenticator.stateHash,
          );
          const status = await proof.verify(this.trustBase, requestId);
          result = status === InclusionProofVerificationStatus.OK;
        }
      }
    } catch (err) {
      logger.debug('Aggregator', 'verifyInclusionProof failed (treated as invalid)', err);
      result = false;
    }

    // Bound the cache; evict oldest entries on overflow.
    if (this.inclusionProofCache.size >= UnicityAggregatorProvider.INCLUSION_PROOF_CACHE_MAX) {
      const firstKey = this.inclusionProofCache.keys().next().value;
      if (firstKey !== undefined) this.inclusionProofCache.delete(firstKey);
    }
    this.inclusionProofCache.set(cacheKey, result);
    return result;
  }

  async isSpent(publicKey: string, stateHash: string): Promise<boolean> {
    return time('aggregator.isSpent', () => this._isSpentImpl(publicKey, stateHash));
  }
  private async _isSpentImpl(publicKey: string, stateHash: string): Promise<boolean> {
    // Cache key binds publicKey + stateHash. A given stateHash may
    // be commit-checked under multiple pubkeys in a multi-address
    // wallet; we MUST NOT cross-pollinate cache hits between keys.
    const cacheKey = `${publicKey}:${stateHash}`;
    if (this.spentCache.has(cacheKey)) {
      const cached = this.spentCache.get(cacheKey)!;
      this.spentCache.delete(cacheKey);
      this.spentCache.set(cacheKey, cached);
      return cached;
    }

    this.ensureConnected();

    // Issue #243 fix — the canonical aggregator (aggregator-go) has no
    // `isSpent` JSON-RPC method. It indexes commitments by `requestId
    // = SHA256(publicKey || stateHash)` and exposes only
    // `submit_commitment`, `get_inclusion_proof`,
    // `get_no_deletion_proof`, `get_block_height`. The previous
    // implementation hand-rolled a `{method: 'isSpent', params:
    // {stateHash}}` JSON-RPC request which the server rejected with
    // HTTP 400 ("JSON-RPC requests must include either requestId or
    // shardId") at the request-validation layer — every call failed,
    // and the spent-state rescan worker bumped per-token throw
    // counters until per-token backoff kicked in. The noise blocked
    // `manual-test-full-recovery.sh` at §C.2.
    //
    // The canonical check: derive `requestId` from `publicKey` (the
    // owner of the state) and the `stateHash`, then call
    // `get_inclusion_proof(requestId)`. The aggregator returns either:
    //   - A path-inclusion proof (transactionHash !== null) → the
    //     owner submitted a commit consuming this state → spent.
    //   - A path-non-inclusion proof (transactionHash === null) → no
    //     commit exists for this (pubkey, stateHash) pair → unspent.
    //
    // Wave 3 / steelman: do NOT fail-open on RPC failure (preserved).
    // The previous behaviour (`return false`) opened a double-spend
    // window when the aggregator was network-partitioned or a relay-
    // MitM dropped the request: the recipient would treat an
    // unverifiable state as "confirmed unspent" and accept the proof.
    // We PROPAGATE the failure as a typed `AGGREGATOR_ERROR`.
    //
    // Caching contract (unchanged): cache only `spent: true`
    // (immutable). Confirmed `false` is NOT cached because the answer
    // can change at any moment when the owner spends the state. A
    // throw here is NEVER cached — the next call retries the RPC.
    //
    // The disposition-engine's [E] hook (`oracleIsSpent`) already wraps
    // the call in try/catch and routes throws to STRUCTURAL_INVALID per
    // §5.3 [A] (see modules/payments/transfer/disposition-engine.ts:786
    // and :1020), so this change is non-breaking for the production
    // path and turns a silent fail-open into a deterministic
    // structural rejection that a later bundle can recover from.
    let requestIdHex: string;
    try {
      const pubkeyBytes = hexToBytes(publicKey);
      const stateHashDataHash = DataHash.fromJSON(stateHash);
      const requestId = await RequestId.create(pubkeyBytes, stateHashDataHash);
      requestIdHex = requestId.toJSON();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      // Structural failure to build requestId is a caller bug
      // (bad hex, wrong-length pubkey, malformed stateHash imprint),
      // not a transient RPC failure. Surface it as AGGREGATOR_ERROR
      // so the disposition-engine's catch routes it consistently.
      throw new SphereError(
        `isSpent: failed to derive requestId from publicKey/stateHash (${cause})`,
        'AGGREGATOR_ERROR',
        error,
      );
    }

    let response: RpcProofResponse;
    try {
      response = await this.rpcCall<RpcProofResponse>('get_inclusion_proof', {
        requestId: requestIdHex,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      logger.warn('Aggregator', 'isSpent RPC failed; refusing to fail-open', error);
      throw new SphereError(
        `isSpent: aggregator RPC failed (${cause})`,
        'AGGREGATOR_ERROR',
        error,
      );
    }

    // Accept canonical (`inclusionProof`) or legacy (`proof`) shape.
    // Defense in depth: an aggregator that returns neither field is
    // ambiguous — treat as "no proof yet" (unspent) rather than
    // throwing, matching the legacy isSpent's tolerant default but
    // KEEPING the fail-closed throw contract for transport errors.
    //
    // Issue #245 #4 — tighten the spent decision. Per the canonical
    // aggregator contract, `transactionHash` is either a non-empty
    // string hex (path-inclusion proof → spent) or null/undefined
    // (path-non-inclusion → unspent). A misbehaving aggregator that
    // returns `transactionHash: { unexpected: 'shape' }` would slip
    // past a bare `!== null && !== undefined` check and be classified
    // as spent. Require the canonical shape: non-empty string.
    const proof = (response.inclusionProof ?? response.proof) as
      | { transactionHash?: unknown }
      | null
      | undefined;
    let spent = false;
    if (proof !== undefined && proof !== null && typeof proof === 'object') {
      const txHash = (proof as { transactionHash?: unknown }).transactionHash;
      spent = typeof txHash === 'string' && txHash.length > 0;
    }

    // Cache result (Wave L: bounded with LRU eviction)
    if (spent) {
      this.cacheSpent(cacheKey);
    }

    return spent;
  }

  async getTokenState(tokenId: string): Promise<TokenState | null> {
    return time('aggregator.getTokenState', () => this._getTokenStateImpl(tokenId));
  }
  private async _getTokenStateImpl(tokenId: string): Promise<TokenState | null> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcTokenStateResponse>('getTokenState', { tokenId });

      if (!response.state) {
        return null;
      }

      return {
        tokenId,
        stateHash: response.state.stateHash ?? '',
        spent: response.state.spent ?? false,
        roundNumber: response.state.roundNumber,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      logger.warn('Aggregator', 'getTokenState failed', error);
      return null;
    }
  }

  async getCurrentRound(): Promise<number> {
    return time('aggregator.getCurrentRound', () => this._getCurrentRoundImpl());
  }
  private async _getCurrentRoundImpl(): Promise<number> {
    if (!this.aggregatorClient) {
      // Defensive: aggregator client is constructed in `initialize()`. If
      // `getCurrentRound()` is called before `initialize()` (or after a
      // failed init), we have no live RPC channel — surface that as a
      // throw so the AggregatorPinger correctly classifies the wallet as
      // `'down'` rather than silently treating "no client" as a numeric
      // round value. Prior code returned `0` here, which leaked the stub
      // sentinel into the connectivity layer and demoted a healthy
      // aggregator to `'degraded'` whenever any real-shard `0` round
      // looked indistinguishable from this fallback (issue: page top-bar
      // false-negative "Aggregator service unavailable").
      throw new Error('UnicityAggregatorProvider: aggregator client not initialized');
    }
    const blockHeight = await this.aggregatorClient.getBlockHeight();
    return Number(blockHeight);
  }

  async mint(params: MintParams): Promise<MintResult> {
    return time('aggregator.mint', () => this._mintImpl(params));
  }
  private async _mintImpl(params: MintParams): Promise<MintResult> {
    this.ensureConnected();

    try {
      const response = await this.rpcCall<RpcMintResponse>('mint', {
        coinId: params.coinId,
        amount: params.amount,
        recipientAddress: params.recipientAddress,
        recipientPubkey: params.recipientPubkey,
      });

      return {
        success: true,
        requestId: response.requestId,
        tokenId: response.tokenId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  onEvent(callback: OracleEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: RPC
  // ===========================================================================

  private async rpcCall<T>(method: string, params: unknown): Promise<T> {
    return time(`aggregator.rpc.${method}`, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeout);

      try {
        const response = await fetch(this.config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          incr(`aggregator.rpc.${method}.http_error`);
          throw new SphereError(`HTTP ${response.status}: ${response.statusText}`, 'AGGREGATOR_ERROR');
        }

        const result = await response.json();

        if (result.error) {
          incr(`aggregator.rpc.${method}.rpc_error`);
          throw new SphereError(result.error.message ?? 'RPC error', 'AGGREGATOR_ERROR');
        }

        return (result.result ?? {}) as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new SphereError('UnicityAggregatorProvider not connected', 'NOT_INITIALIZED');
    }
  }

  private emitEvent(event: OracleEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log('Event callback error:', error);
      }
    }
  }

  private log(message: string, ...args: unknown[]): void {
    logger.debug('Aggregator', message, ...args);
  }
}

// =============================================================================
// Backward Compatibility Aliases (Oracle -> Aggregator)
// =============================================================================

/** @deprecated Use UnicityAggregatorProvider instead */
export const UnicityOracleProvider = UnicityAggregatorProvider;
/** @deprecated Use UnicityAggregatorProviderConfig instead */
export type UnicityOracleProviderConfig = UnicityAggregatorProviderConfig;
