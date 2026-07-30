/**
 * token-engine/factory.ts — the real engine constructor (A4).
 *
 * `createSphereTokenEngine` is the public way to obtain an ITokenEngine. It maps
 * the sphere-domain EngineConfig to the SDK objects the engine needs: the
 * aggregator client (from `aggregatorUrl`), the trust base (parsed from
 * `trustBaseJson`), the wallet signing key (from `privateKey`), the network id,
 * and a mint-justification verifier with the split verifier registered (so
 * split-output tokens verify).
 *
 * Loading the trust base per environment (browser fetch / node file) stays with
 * the caller (impl/<env>/oracle, reusing the existing trust-base loaders); it
 * passes the parsed JSON in via `trustBaseJson`, keeping this factory env-agnostic.
 */

import { SphereError } from '../core/errors';
import { logger } from '../core/logger';
import {
  AggregatorClient,
  MintJustificationVerifierService,
  PredicateVerifierService,
  RootTrustBase,
  SigningService,
  SplitMintJustificationVerifier,
  StateTransitionClient,
  TokenIssuanceVerifierService,
  VerificationContext,
  WorkerTokenVerifier,
  type IWorker,
} from './sdk';
import { decodeSpherePaymentData } from './SpherePaymentData';
import { type DisposableTokenVerifier, type EngineDeps, SphereTokenEngine } from './SphereTokenEngine';
import type { EngineConfig, ITokenEngine, VerificationWorker, VerificationWorkerConfig } from './engine';

const DEFAULT_VERIFICATION_POOL_SIZE = 4;

/**
 * The consumer's worker factory, bound to the base SDK's pool verifier. The SDK
 * leaves `createWorker()` abstract so the platform choice stays with the consumer;
 * the cast is the port boundary (same web-`Worker` subset, payloads `unknown` on
 * our side so no SDK wire type escapes).
 */
class ConfiguredWorkerTokenVerifier extends WorkerTokenVerifier {
  public constructor(
    private readonly spawn: () => VerificationWorker,
    poolSize: number
  ) {
    super(poolSize);
  }

  protected createWorker(): IWorker {
    return this.spawn() as unknown as IWorker;
  }
}

/** Workers spawn LAZILY on first verify and are reused, so this costs nothing to build. */
export function createWorkerTokenVerifier(config: VerificationWorkerConfig): DisposableTokenVerifier {
  const poolSize = config.poolSize ?? DEFAULT_VERIFICATION_POOL_SIZE;
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new TypeError(`verification.poolSize must be a positive integer, got ${String(config.poolSize)}`);
  }
  return new ConfiguredWorkerTokenVerifier(config.createWorker, poolSize);
}

export async function createSphereTokenEngine(config: EngineConfig): Promise<ITokenEngine> {
  if (config.trustBaseJson == null) {
    throw new SphereError('Engine config requires a trust base (trustBaseJson)', 'INVALID_CONFIG');
  }

  if (!config.apiKey) {
    logger.warn(
      'TokenEngine',
      'No aggregator apiKey — pass config.oracle.apiKey (testnet2 value in .env.example; mainnet from a secret env var). Gateway requests will be unauthenticated.',
    );
  }

  const trustBase = RootTrustBase.fromJSON(config.trustBaseJson);
  const predicateVerifier = PredicateVerifierService.create();
  const mintJustificationVerifier = new MintJustificationVerifierService();
  mintJustificationVerifier.register(
      new SplitMintJustificationVerifier(decodeSpherePaymentData),
  );

  const deps: EngineDeps = {
    client: new StateTransitionClient(new AggregatorClient(config.aggregatorUrl, config.apiKey ?? null)),
    trustBase,
    predicateVerifier,
    mintJustificationVerifier,
    verificationContext: new VerificationContext(
      trustBase,
      predicateVerifier,
      mintJustificationVerifier,
      new TokenIssuanceVerifierService(false),
    ),
    signingService: new SigningService(config.privateKey),
    // Also the HKDF ikm for deterministic realization (Part E.1) — the
    // SigningService wraps the key but does not expose it back.
    privateKey: config.privateKey,
    // The trust base is the single source of truth for the network id (it carries
    // NetworkId.fromId, so any id works — e.g. testnet2 = 4 — with no enum entry).
    networkId: trustBase.networkId,
    // #683: forward the (optional) proof-poll cadence; undefined → the engine default.
    proofPollIntervalMs: config.proofPollIntervalMs,
    // Opt-in parallel verification (2.0.2). Absent → the sequential verifier.
    ...(config.verification ? { tokenVerifier: createWorkerTokenVerifier(config.verification) } : {}),
  };

  return new SphereTokenEngine(deps);
}
