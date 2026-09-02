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
  Secp256k1SignatureVerifier,
  SigningService,
  SplitMintJustificationVerifier,
  StateTransitionClient,
  TokenIssuanceVerifierService,
  UnicityCertificateVerifier,
  UnicitySealQuorumSignaturesVerificationRule,
  VerificationContext,
  VerifiedSealCache,
  WorkerTokenVerifier,
  type IWorker,
} from './sdk';
import { decodeSpherePaymentData } from './SpherePaymentData';
import { type DisposableTokenVerifier, type EngineDeps, SphereTokenEngine } from './SphereTokenEngine';
import type { EngineConfig, ITokenEngine, VerificationWorker, VerificationWorkerConfig } from './engine';

const DEFAULT_VERIFICATION_POOL_SIZE = 4;

/** #770(4): what a verification cancelled by `dispose()` rejects with. */
function disposedError(): SphereError {
  return new SphereError(
    'Verification worker pool disposed — the in-flight verification was cancelled',
    'MODULE_DESTROYED',
  );
}

/**
 * The consumer's worker factory, bound to the base SDK's pool verifier. The SDK
 * leaves `createWorker()` abstract so the platform choice stays with the consumer;
 * the cast is the port boundary (same web-`Worker` subset, payloads `unknown` on
 * our side so no SDK wire type escapes).
 *
 * ── #770(4): dispose() must SETTLE the in-flight batch ──────────────────────
 * The SDK's `WorkerPool.dispose()` (3.0.1) only calls `worker.terminate()` on
 * every worker it spawned. A dispatched task resolves ONLY from `worker.onmessage`,
 * which a terminated worker never posts, and queued tasks are never drained — so
 * `WorkerTokenVerifier.verify`, which awaits `Promise.all(pool.run(...))`, hangs
 * FOREVER. `pool` is `private readonly` upstream, so the settle has to live here.
 *
 * Reachable in production: `Sphere.setOracleApiKey` → `PaymentsFacade.setEngine`
 * disposes the engine it replaced while a receive drain may be mid-`verify`.
 *
 * The cancellation MUST REJECT — never resolve `{ ok: false }`. The only
 * `engine.verify` caller in the money path is `modules/payments-v2/receive/Receive.ts`
 * (`screen()`, the `const verdict = await engine.verify(token)` line): a falsy
 * verdict there is a PERMANENT `rejectAck(entry, 'invalid')`, i.e. a VALID
 * incoming token thrown away at the mailbox because an api-key change happened
 * to land mid-drain. A rejection instead propagates to the drain's catch, which
 * leaves the entry UNACKED so it re-lists on the next drain.
 */
class ConfiguredWorkerTokenVerifier extends WorkerTokenVerifier {
  private disposed = false;
  /** Lazily created so an idle verifier holds no promise at all. */
  private cancellation: { promise: Promise<never>; reject: (error: unknown) => void } | null = null;

  public constructor(
    private readonly spawn: () => VerificationWorker,
    poolSize: number
  ) {
    super(poolSize);
  }

  /** Rejects (see the class note) if `dispose()` lands before the pool answers. */
  public override verify(
    ...args: Parameters<WorkerTokenVerifier['verify']>
  ): ReturnType<WorkerTokenVerifier['verify']> {
    if (this.disposed) return Promise.reject(disposedError());
    return Promise.race([super.verify(...args), this.cancelSignal()]);
  }

  /** Idempotent — Sphere.setOracleApiKey disposes the replaced engine twice (facade + caller). */
  public override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose(); // terminate() every spawned worker, as before
    // Only AFTER the pool is down: settle whatever the terminated workers will
    // now never answer. A no-op when nothing was ever verified.
    this.cancellation?.reject(disposedError());
  }

  protected createWorker(): IWorker {
    // The SDK's dispose() leaves its `workers` array populated, so a task that
    // slips in afterwards would call acquire() → createWorker() and RESURRECT
    // the pool it just tore down. Fail instead.
    if (this.disposed) throw disposedError();
    return this.spawn() as unknown as IWorker;
  }

  private cancelSignal(): Promise<never> {
    if (this.cancellation === null) {
      let reject!: (error: unknown) => void;
      const promise = new Promise<never>((_resolve, rejectFn) => {
        reject = rejectFn;
      });
      // Belt and braces: today the only caller hands this straight to
      // `Promise.race`, which subscribes to it, so dispose()'s rejection is
      // always observed. Park a no-op handler anyway so a future caller that
      // drops the promise cannot turn a teardown into an unhandled rejection.
      void promise.catch(() => undefined);
      this.cancellation = { promise, reject };
    }
    return this.cancellation.promise;
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
  // st-sdk 2.1.0: seal verification is memoised per rule instance. Every leaf
  // certified in one aggregator round shares a seal, so a multi-token send's
  // proofs collapse onto a handful of seals instead of re-verifying each.
  const unicityCertificateVerifier = new UnicityCertificateVerifier(
    new UnicitySealQuorumSignaturesVerificationRule(new Secp256k1SignatureVerifier(), new VerifiedSealCache(256)),
  );
  const mintJustificationVerifier = new MintJustificationVerifierService();
  mintJustificationVerifier.register(
      new SplitMintJustificationVerifier(decodeSpherePaymentData),
  );

  const deps: EngineDeps = {
    client: new StateTransitionClient(new AggregatorClient(config.aggregatorUrl, config.apiKey ?? null)),
    trustBase,
    predicateVerifier,
    unicityCertificateVerifier,
    mintJustificationVerifier,
    verificationContext: new VerificationContext(
      trustBase,
      predicateVerifier,
      unicityCertificateVerifier,
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
    proofTimeoutMs: config.proofTimeoutMs, // #739: was declared but never wired
    // Opt-in parallel verification (2.0.2). Absent → the sequential verifier.
    ...(config.verification ? { tokenVerifier: createWorkerTokenVerifier(config.verification) } : {}),
  };

  return new SphereTokenEngine(deps);
}
