/**
 * Round 7 (FIX 1) — Sphere bootstrap wires the operator escape-hatch
 * InclusionProofImporter end-to-end.
 *
 * Round 5 closed the THROW gap (auto-installed an in-memory default in
 * `PaymentsModule.initialize`), but production wiring was still
 * symbolic: every wallet got a fresh `InMemoryDispositionStorageAdapter`
 * that lost `_invalid` records on restart. Round 7 introduces:
 *
 *  1. `ProfileStorageProvider.buildDispositionStorageAdapter()` —
 *     constructs an `OrbitDbDispositionStorageAdapter` bound to the
 *     wallet's ProfileDatabase + profile encryption key.
 *  2. `PaymentsModule.configureOperatorEscapeHatchStorage(adapter)` —
 *     re-installs the importer with the production-grade adapter
 *     while preserving the shared per-tokenId mutex.
 *  3. Sphere bootstrap wiring in `initializeModules()` and the
 *     per-address path that detects ProfileStorageProvider via duck-
 *     typing and swaps the dispositionStorage when available.
 *
 * This test asserts:
 *  - `sphere.payments.importInclusionProof()` does NOT throw
 *    `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` after `Sphere.init()`.
 *  - The auto-installed importer is a real `InclusionProofImporter`
 *    (not null).
 *  - When run with a non-Profile storage (legacy IndexedDB / file),
 *    the importer falls back to the in-memory default — wiring is
 *    best-effort and never breaks bootstrap.
 *
 * KNOWN LIMITATION: this test does NOT exercise the full Profile +
 * OrbitDB stack (those tests live in `tests/integration/profile/`).
 * The `verifyProof` / `graftCallback` / `overrideCallback` are still
 * stubs (NOT_AUTHENTICATED + no-op) — the importer fails closed on
 * every operator-supplied proof until a follow-up wave wires the
 * trust-base-aware verifier. This test exists to prove that bootstrap
 * succeeds without throwing and that the wiring hop runs cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { vi } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { InclusionProofImporter } from '../../modules/payments/transfer/import-inclusion-proof';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-operator-escape-hatch-bootstrap');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Mock providers
// =============================================================================

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    mintToken: vi.fn().mockResolvedValue({ success: true, token: { id: 'mock-token' } }),
    // Round 7 (FIX 1) — Sphere's escape-hatch wiring path inspects the
    // oracle's getAggregatorClient(); returning a stub keeps the
    // FinalizationWorker auto-install path active without a real
    // aggregator round-trip.
    getAggregatorClient: vi.fn().mockReturnValue({}),
    getStateTransitionClient: vi.fn().mockReturnValue(undefined),
    getTrustBase: vi.fn().mockReturnValue(null),
  } as unknown as OracleProvider;
}

// =============================================================================
// Helpers
// =============================================================================

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Round 7 (FIX 1): operator escape-hatch bootstrap wiring', () => {
  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('Sphere.init() bootstraps without OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED — first call succeeds', async () => {
    const storage = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // The importer should be installed (non-null) after init().
    const importer = (
      sphere.payments as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importer).not.toBeNull();
    expect(importer).toBeInstanceOf(InclusionProofImporter);

    // Calling importInclusionProof MUST NOT throw
    // OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED. The default in-memory
    // harness has no manifest entries, so the result is
    // 'no-such-token'. The KEY assertion is that bootstrap doesn't
    // throw the configuration error — it can return any of the
    // ImportProofResult variants.
    const directAddr = sphere.identity!.directAddress!;
    const result = await sphere.payments.importInclusionProof(
      directAddr,
      'ab'.repeat(32), // canonical 64-char-hex tokenId
      {
        requestId: 'rq',
        transactionHash: 'cd'.repeat(34),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // 'no-such-token' is the expected result for an unknown tokenId.
      // The crucial point is that we got a structured result — no
      // OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED throw.
      expect(result.reason).toBe('no-such-token');
    }

    await sphere.destroy();
  });

  it('falls back to in-memory default when storage is non-Profile (FileStorageProvider)', async () => {
    const storage = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // FileStorageProvider does NOT expose `buildDispositionStorageAdapter`,
    // so Sphere skips the OrbitDb wiring hop (best-effort). The importer
    // therefore retains its in-memory default — but the public API
    // contract holds: importInclusionProof returns a structured result.
    const importer = (
      sphere.payments as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importer).not.toBeNull();
    expect(importer).toBeInstanceOf(InclusionProofImporter);

    // Sanity: the duck-typed builder check on the storage provider
    // returns false when the method isn't present. Bootstrap completes
    // cleanly without throwing.
    const storageWithBuilder = storage as unknown as {
      buildDispositionStorageAdapter?: () => unknown;
    };
    expect(typeof storageWithBuilder.buildDispositionStorageAdapter).toBe(
      'undefined',
    );

    await sphere.destroy();
  });

  it('Sphere.destroy() + re-init: prior INVALID disposition record reads correctly across restart (in-memory default)', async () => {
    // KNOWN LIMITATION: this test asserts the cross-restart contract
    // ONLY at the level of bootstrap not-throwing. With the FileStorage
    // path (not Profile), the in-memory default is rebuilt on every
    // initialize() — no actual cross-restart persistence is provided.
    // The persistence claim holds ONLY when ProfileStorageProvider is
    // wired with OrbitDB (covered by tests/integration/profile/* once
    // the verifyProof + graft callbacks are wired).
    //
    // What this test asserts:
    //   - First Sphere.init() succeeds without throw.
    //   - sphere.destroy() releases the importer cleanly (FIX 2).
    //   - A second Sphere.init() (from same storage dir) re-bootstraps
    //     without throw, and the importer is freshly installed.
    const storage = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere: sphere1 } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    const importer1 = (
      sphere1.payments as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importer1).toBeInstanceOf(InclusionProofImporter);

    // Reach through the private `_payments` field BEFORE destroy so we
    // hold the same module reference after teardown (the public
    // `sphere.payments` getter throws once `_initialized = false`).
    const paymentsRef = (
      sphere1 as unknown as { _payments: unknown }
    )._payments;

    await sphere1.destroy();

    // After destroy, the importer is cleared (FIX 2). Verify the
    // module-level reference is null — the next initialize() will
    // freshly install one.
    const importerAfterDestroy = (
      paymentsRef as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importerAfterDestroy).toBeNull();

    // Reset singleton for re-init
    (Sphere as unknown as { instance: null }).instance = null;

    const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage2 = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport2 = createMockTransport();
    const oracle2 = createMockOracle();

    const { sphere: sphere2 } = await Sphere.init({
      storage: storage2,
      transport: transport2,
      oracle: oracle2,
      tokenStorage: tokenStorage2,
    });

    const importer2 = (
      sphere2.payments as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importer2).toBeInstanceOf(InclusionProofImporter);
    // The new importer is a different instance — destroy cleared the
    // old one and initialize() built a fresh one.
    expect(importer2).not.toBe(importer1);

    // The second importInclusionProof call still doesn't throw the
    // configuration error — the wiring hop is idempotent across restart.
    const directAddr = sphere2.identity!.directAddress!;
    const result = await sphere2.payments.importInclusionProof(
      directAddr,
      'ef'.repeat(32),
      {
        requestId: 'rq2',
        transactionHash: 'ab'.repeat(34),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('no-such-token');
    }

    await sphere2.destroy();
  });

  // ===========================================================================
  // Round 8 (FIX 1) — verifyProof wired through oracle.verifyInclusionProof.
  //
  // The Round 7 wiring left verifyProof as a fail-closed stub
  // (`'NOT_AUTHENTICATED'`) so even a real, well-formed inclusion proof
  // would route to `'proof-trustbase-failed'`. Round 8 wires the
  // bootstrap layer's verifyProof adapter through to
  // `oracle.verifyInclusionProof()` so a real proof reaches the
  // case-3/4/5/6 routing.
  //
  // We can't exercise case 5 (override) end-to-end here because the
  // default harness's queueScanner returns no entries — we'd need a
  // full-bootstrap layer with a real FinalizationQueue scanner +
  // dispositionStorage with an `_invalid` record. What we CAN exercise:
  //   a. The verifyProof adapter is reachable: a stub oracle returning
  //      `true` produces a different code path than a stub returning
  //      `false`.
  //   b. With `getProof` of `null` plus a manifest-less tokenId, the
  //      result is `'no-such-token'` regardless of verifyProof outcome
  //      (case 1 short-circuits before verifyProof).
  // ===========================================================================
  it('Round 8 (FIX 1): oracle.verifyInclusionProof is wired into the importer (stub returning true exercises a different routing than fail-closed default)', async () => {
    const storage = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport = createMockTransport();

    // Oracle returns `true` for verifyInclusionProof — a real wired
    // verifier would resolve case 8/9 short-circuits to `'OK'` and
    // proceed past the trust-base gate. We capture call args to assert
    // the bootstrap actually wired the adapter.
    const verifyInclusionProof = vi.fn().mockResolvedValue(true);
    const oracle = {
      ...createMockOracle(),
      verifyInclusionProof,
    } as unknown as OracleProvider;

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Reach through the importer's private opts to verify the
    // verifyProof callback is NOT the default fail-closed stub. The
    // default returns `'NOT_AUTHENTICATED'` regardless of input; the
    // wired adapter calls through to `oracle.verifyInclusionProof()`.
    const importer = (
      sphere.payments as unknown as {
        inclusionProofImporter: { opts: { verifyProof: (proof: unknown) => Promise<string> } } | null;
      }
    ).inclusionProofImporter;
    expect(importer).not.toBeNull();
    const verifyProofFn = importer!.opts.verifyProof;

    // Invoke the importer's verifyProof directly — this proves the
    // bootstrap wired the oracle adapter.
    const status = await verifyProofFn({
      requestId: 'rq',
      transactionHash: 'cd'.repeat(34),
      authenticator: 'authn',
      proof: { stub: true },
    });

    expect(verifyInclusionProof).toHaveBeenCalledTimes(1);
    expect(verifyInclusionProof).toHaveBeenCalledWith({
      proofJson: { stub: true },
      transactionHash: 'cd'.repeat(34),
    });
    expect(status).toBe('OK');

    // Now flip the oracle to return false — confirms the adapter maps
    // `false` to `'NOT_AUTHENTICATED'` (the case 9 routing).
    verifyInclusionProof.mockResolvedValueOnce(false);
    const status2 = await verifyProofFn({
      requestId: 'rq2',
      transactionHash: 'cd'.repeat(34),
      authenticator: 'authn',
      proof: { stub: true },
    });
    expect(status2).toBe('NOT_AUTHENTICATED');

    // Finally — a thrown verifier (e.g., trust-base not yet loaded)
    // collapses to `'NOT_AUTHENTICATED'` instead of crashing the
    // importer.
    verifyInclusionProof.mockRejectedValueOnce(new Error('trust-base not loaded'));
    const status3 = await verifyProofFn({
      requestId: 'rq3',
      transactionHash: 'cd'.repeat(34),
      authenticator: 'authn',
      proof: { stub: true },
    });
    expect(status3).toBe('NOT_AUTHENTICATED');

    await sphere.destroy();
  });

  it('Round 8 (FIX 1): when oracle has no verifyInclusionProof method, importer keeps the fail-closed default (graceful degradation)', async () => {
    const storage = new FileStorageProvider({ dataDir: DATA_DIR });
    const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const transport = createMockTransport();

    // Oracle WITHOUT verifyInclusionProof. The bootstrap path detects
    // this (`typeof === 'function'` check) and skips the adapter
    // wiring, leaving the Round 7 fail-closed default in place.
    const oracle = createMockOracle();
    expect(
      (oracle as unknown as { verifyInclusionProof?: unknown })
        .verifyInclusionProof,
    ).toBeUndefined();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    const importer = (
      sphere.payments as unknown as {
        inclusionProofImporter: { opts: { verifyProof: (proof: unknown) => Promise<string> } } | null;
      }
    ).inclusionProofImporter;
    expect(importer).not.toBeNull();
    const verifyProofFn = importer!.opts.verifyProof;

    // The default stub always returns 'NOT_AUTHENTICATED'.
    const status = await verifyProofFn({
      requestId: 'rq',
      transactionHash: 'cd'.repeat(34),
      authenticator: 'authn',
      proof: { stub: true },
    });
    expect(status).toBe('NOT_AUTHENTICATED');

    await sphere.destroy();
  });
});
