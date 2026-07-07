/**
 * Round 5 (FIX 1) — auto-install of the operator escape-hatch
 * (T.5.D) InclusionProofImporter + RevalidateCascadedRunner.
 *
 * Before Round 5, no production code path called
 * `installInclusionProofImporter()` / `installRevalidateCascadedRunner()`,
 * so every wallet that bootstrapped through `Sphere.init()` threw
 * `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` on the first
 * `payments.importInclusionProof()` /
 * `payments.revalidateCascadedChildren()` call.
 *
 * This test exercises the new auto-install path:
 *  1. After `initialize()`, both the importer and runner are installed
 *     (non-null on the module).
 *  2. `payments.importInclusionProof()` does NOT throw
 *     `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED`. It MAY return any of the
 *     defined `ImportProofResult` variants — the default in-memory
 *     harness has no manifest entries, so it resolves to
 *     `'no-such-token'`.
 *  3. `payments.revalidateCascadedChildren()` does NOT throw
 *     `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED`. Returns
 *     `{ checked: 0, ... }` for the default empty scanner.
 *  4. Consumer override via `installInclusionProofImporter()` BEFORE
 *     `initialize()` wins (auto-install gate skipped).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import { InclusionProofImporter } from '../../../extensions/uxf/pipeline/import-inclusion-proof';
import { RevalidateCascadedRunner } from '../../../extensions/uxf/pipeline/revalidate-cascaded';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// Shared mocks (mirror the FinalizationWorker auto-install test pattern)
// =============================================================================

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../serialization/txf-serializer', () => ({
  tokenToTxf: vi.fn().mockReturnValue(null),
  txfToToken: vi.fn(),
  getCurrentStateHash: vi.fn().mockReturnValue(''),
  buildTxfStorageData: vi.fn().mockResolvedValue({}),
  parseTxfStorageData: vi
    .fn()
    .mockReturnValue({ tokens: [], tombstones: [], sent: [] }),
}));

// =============================================================================
// Helpers
// =============================================================================

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
    directAddress: 'DIRECT://test',
    privateKey: 'a'.repeat(64),
  };
}

function makeStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(async () => store.clear()),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as StorageProvider;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

/** Oracle with a non-null aggregator client (typical production shape). */
function makeOracle(): OracleProvider {
  const fakeAggregatorClient = {};
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    getAggregatorClient: vi.fn().mockReturnValue(fakeAggregatorClient),
    waitForProofSdk: vi.fn(),
    getProof: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;
}

// =============================================================================
// Tests
// =============================================================================

describe('Round 5 (FIX 1): operator escape-hatch auto-install', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('installs a default InclusionProofImporter on initialize()', () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    const importer = (
      module as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(importer).not.toBeNull();
    expect(importer).toBeInstanceOf(InclusionProofImporter);

    module.destroy();
  });

  it('installs a default RevalidateCascadedRunner on initialize()', () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    const runner = (
      module as unknown as { revalidateCascadedRunner: unknown }
    ).revalidateCascadedRunner;
    expect(runner).not.toBeNull();
    expect(runner).toBeInstanceOf(RevalidateCascadedRunner);

    module.destroy();
  });

  it('payments.importInclusionProof does NOT throw OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED after initialize()', async () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    // Use a canonical 64-char-hex tokenId so the importer's input
    // shape regex passes — we want to exercise the path beyond the
    // OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED guard, not stop at a
    // separate validation gate.
    const result = await module.importInclusionProof(
      'DIRECT://addr',
      'ab'.repeat(32),
      {
        requestId: 'rq',
        transactionHash: 'cd'.repeat(34),
        authenticator: 'authn',
        proof: { stub: true },
      },
    );

    // With the default in-memory harness, no manifest entry exists for
    // this tokenId, so the result is `'no-such-token'`. The KEY
    // assertion is that no `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` was
    // thrown.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('no-such-token');
    }

    module.destroy();
  });

  it('payments.revalidateCascadedChildren does NOT throw OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED after initialize()', async () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    const result = await module.revalidateCascadedChildren(
      'DIRECT://addr',
      'ab'.repeat(32),
    );

    // The default in-memory scanner returns no children, so all
    // counters are zero. The KEY assertion is that no
    // `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` was thrown.
    expect(result.checked).toBe(0);
    expect(result.revalidated).toBe(0);

    module.destroy();
  });

  it('consumer-installed importer wins over auto-install', () => {
    const module = createPaymentsModule();

    // Stub importer that satisfies the InclusionProofImporter type.
    const mockImporter = Object.create(InclusionProofImporter.prototype);
    Object.defineProperty(mockImporter, 'importInclusionProof', {
      value: vi.fn(),
    });

    module.installInclusionProofImporter(
      mockImporter as InclusionProofImporter,
    );
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    const installed = (
      module as unknown as { inclusionProofImporter: unknown }
    ).inclusionProofImporter;
    expect(installed).toBe(mockImporter);

    module.destroy();
  });

  it('consumer-installed runner wins over auto-install', () => {
    const module = createPaymentsModule();

    const mockRunner = Object.create(RevalidateCascadedRunner.prototype);
    Object.defineProperty(mockRunner, 'run', { value: vi.fn() });

    module.installRevalidateCascadedRunner(
      mockRunner as RevalidateCascadedRunner,
    );
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    const installed = (
      module as unknown as { revalidateCascadedRunner: unknown }
    ).revalidateCascadedRunner;
    expect(installed).toBe(mockRunner);

    module.destroy();
  });

  // ===========================================================================
  // Round 7 (FIX 2) — destroy() releases importer + runner references
  // ===========================================================================

  describe('FIX 2: destroy() clears importer/runner state', () => {
    it('destroy() sets inclusionProofImporter to null', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      const beforeDestroy = (
        module as unknown as { inclusionProofImporter: unknown }
      ).inclusionProofImporter;
      expect(beforeDestroy).not.toBeNull();

      module.destroy();

      const afterDestroy = (
        module as unknown as { inclusionProofImporter: unknown }
      ).inclusionProofImporter;
      expect(afterDestroy).toBeNull();
    });

    it('destroy() sets revalidateCascadedRunner to null', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      const beforeDestroy = (
        module as unknown as { revalidateCascadedRunner: unknown }
      ).revalidateCascadedRunner;
      expect(beforeDestroy).not.toBeNull();

      module.destroy();

      const afterDestroy = (
        module as unknown as { revalidateCascadedRunner: unknown }
      ).revalidateCascadedRunner;
      expect(afterDestroy).toBeNull();
    });

    it('destroy() clears the shared per-tokenId mutex', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      const mutexBefore = (
        module as unknown as { _sharedPerTokenMutex: unknown }
      )._sharedPerTokenMutex;
      expect(mutexBefore).not.toBeNull();

      module.destroy();

      const mutexAfter = (
        module as unknown as { _sharedPerTokenMutex: unknown }
      )._sharedPerTokenMutex;
      expect(mutexAfter).toBeNull();
    });

    it('destroy() then re-initialize() wires fresh importer/runner instances (no shared state)', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      const importer1 = (
        module as unknown as { inclusionProofImporter: unknown }
      ).inclusionProofImporter;
      const runner1 = (
        module as unknown as { revalidateCascadedRunner: unknown }
      ).revalidateCascadedRunner;
      const mutex1 = (
        module as unknown as { _sharedPerTokenMutex: unknown }
      )._sharedPerTokenMutex;

      module.destroy();

      // Re-initialize the same module instance — fresh defaults must
      // be wired (the destroy/initialize cycle doesn't share state).
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      const importer2 = (
        module as unknown as { inclusionProofImporter: unknown }
      ).inclusionProofImporter;
      const runner2 = (
        module as unknown as { revalidateCascadedRunner: unknown }
      ).revalidateCascadedRunner;
      const mutex2 = (
        module as unknown as { _sharedPerTokenMutex: unknown }
      )._sharedPerTokenMutex;

      expect(importer2).not.toBe(importer1);
      expect(runner2).not.toBe(runner1);
      expect(mutex2).not.toBe(mutex1);
      expect(importer2).toBeInstanceOf(InclusionProofImporter);
      expect(runner2).toBeInstanceOf(RevalidateCascadedRunner);

      module.destroy();
    });
  });

  // ===========================================================================
  // Round 7 (FIX 3) — shared per-tokenId mutex across workers + importer
  // ===========================================================================

  describe('FIX 3: shared PerTokenMutex across workers + importer', () => {
    it('initialize() constructs a single PerTokenMutex shared across importer/workers', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(),
        emitEvent: vi.fn(),
      });

      // The shared mutex must be set after initialize().
      const sharedMutex = (
        module as unknown as { _sharedPerTokenMutex: unknown }
      )._sharedPerTokenMutex;
      expect(sharedMutex).not.toBeNull();

      // The importer must hold a reference to the SAME mutex instance.
      // The default builder threads opts.perTokenMutex through to the
      // InclusionProofImporter constructor.
      const importer = (
        module as unknown as {
          inclusionProofImporter: { perTokenMutex: unknown } | null;
        }
      ).inclusionProofImporter;
      expect(importer).not.toBeNull();
      // Reach through the importer's private perTokenMutex field.
      const importerMutex = (importer as unknown as {
        perTokenMutex: unknown;
      }).perTokenMutex;
      expect(importerMutex).toBe(sharedMutex);

      module.destroy();
    });
  });

  // ===========================================================================
  // Round 7 (FIX 5) — MinimalManifestStorage lowercases tokenId keys
  // ===========================================================================

  describe('FIX 5: MinimalManifestStorage lowercases tokenId keys', () => {
    it('writeEntry with mixed-case tokenId is read back via lowercase tokenId', async () => {
      const { buildDefaultInclusionProofImporter } = await import(
        '../../../modules/payments/PaymentsModule'
      );
      const importer = buildDefaultInclusionProofImporter({
        emit: vi.fn(),
      });

      // Reach through the importer → manifestStore → underlying
      // MinimalManifestStorage. The store wraps the in-memory storage
      // adapter that's the target of FIX 5's lowercasing.
      const manifestStore = (importer as unknown as {
        opts: { manifestStore: unknown };
      }).opts.manifestStore;
      const minimalStorage = (manifestStore as unknown as {
        storage: { writeEntry: (addr: string, tokenId: string, entry: unknown) => Promise<void>; readEntry: (addr: string, tokenId: string) => Promise<unknown> };
      }).storage;

      const addr = 'DIRECT://test';
      const mixedCase = 'AbCd' + 'ab'.repeat(30);
      const lowerCase = mixedCase.toLowerCase();

      // Write with mixed-case tokenId — internal keying must lowercase
      // so the same entry is readable via either case form.
      await minimalStorage.writeEntry(addr, mixedCase, {
        rootHash: 'ab'.repeat(32),
        status: 'pending',
      });

      const readMixed = await minimalStorage.readEntry(addr, mixedCase);
      const readLower = await minimalStorage.readEntry(addr, lowerCase);

      expect(readMixed).toBeDefined();
      expect(readLower).toBeDefined();
      // Both forms read back the SAME entry (not split across two keys).
      expect(readMixed).toBe(readLower);
    });
  });
});
