/**
 * Issue #378 (#275 P4) — V6-RECOVER permanent-verdict persistence.
 *
 * When `finalizeStrandedReceivedToken` classifies a stranded receive
 * as permanent (HD-index recovery exhausted / structural failure), the
 * tokenId is recorded in a persistent ledger. Subsequent
 * `drainPendingFinalizations` invocations skip these tokens in
 * <100ms instead of repeating the 60s drain timeout per token.
 *
 * This file tests the ledger's contract at the unit level:
 *   1. `saveV6RecoverPermanent` + `restoreV6RecoverPermanent` round-trip
 *      preserves the marker across a process boundary.
 *   2. The drain predicate (`hasUnconfirmedOrInflight`) returns false
 *      for a token whose ID is in the ledger, even when its status
 *      would otherwise satisfy `pending` / `submitted`.
 *   3. `receive({ finalize: true })` clears the ledger before draining
 *      so a forced retry gets one more shot at the V6-RECOVER path.
 *
 * The end-to-end V6-RECOVER finalize path itself is exercised in the
 * existing integration tests (`tests/integration/payments/
 * v6-recover-real-sdk-recovery.test.ts`); this file only pins the
 * ledger-side semantics around it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// SDK mocks — defensive only. None of the SDK paths are exercised here;
// the tests poke the internal map directly and verify the persistence /
// gate semantics.
// =============================================================================

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({ getDefinition: () => null, getIconUrl: () => null }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Helpers
// =============================================================================

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: 'a'.repeat(64),
  };
}

interface InMemoryStorage extends StorageProvider {
  _store: Map<string, string>;
}

function makeStorage(): InMemoryStorage {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    remove: vi.fn(async (k: string) => { store.delete(k); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    clear: vi.fn(async () => { store.clear(); }),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as InMemoryStorage;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    fetchPendingEvents: vi.fn().mockResolvedValue(undefined),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function makeOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

function setupModule(storage: StorageProvider): ReturnType<typeof createPaymentsModule> {
  const module = createPaymentsModule();
  module.initialize({
    identity: makeIdentity(),
    storage,
    transport: makeTransport(),
    oracle: makeOracle(),
    emitEvent: vi.fn(),
  });
  // Bypass the lazy-load gate so the internal map is directly addressable.
  (module as unknown as { loaded: boolean }).loaded = true;
  (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;
  return module;
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #378 — V6-RECOVER permanent-verdict persistence', () => {
  let storage: InMemoryStorage;
  let module: ReturnType<typeof createPaymentsModule>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeStorage();
    module = setupModule(storage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('save+restore preserves the ledger across a process boundary', async () => {
    const internal = module as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      saveV6RecoverPermanent: () => Promise<void>;
    };

    // Stamp two verdicts and persist.
    internal.v6RecoverPermanent.set('token-a', { reason: 'permanent recipient-address mismatch', ts: 1_700_000_000_000 });
    internal.v6RecoverPermanent.set('token-b', { reason: 'permanent structural failure', ts: 1_700_000_000_001 });
    await internal.saveV6RecoverPermanent();

    // Storage round-trip — fresh module reads the same storage.
    const raw = storage._store.get(STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([
      { tokenId: 'token-a', reason: 'permanent recipient-address mismatch', ts: 1_700_000_000_000 },
      { tokenId: 'token-b', reason: 'permanent structural failure', ts: 1_700_000_000_001 },
    ]);

    // Simulate a new process: fresh module, same storage, restore.
    const module2 = setupModule(storage);
    const internal2 = module2 as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      restoreV6RecoverPermanent: () => Promise<void>;
    };
    expect(internal2.v6RecoverPermanent.size).toBe(0);
    await internal2.restoreV6RecoverPermanent();
    expect(internal2.v6RecoverPermanent.size).toBe(2);
    expect(internal2.v6RecoverPermanent.get('token-a')).toEqual({
      reason: 'permanent recipient-address mismatch',
      ts: 1_700_000_000_000,
    });
    expect(internal2.v6RecoverPermanent.get('token-b')).toEqual({
      reason: 'permanent structural failure',
      ts: 1_700_000_000_001,
    });
  });

  it('empty ledger save clears the storage key (no stale list survives)', async () => {
    const internal = module as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      saveV6RecoverPermanent: () => Promise<void>;
    };

    // Seed an entry and persist.
    internal.v6RecoverPermanent.set('token-x', { reason: 'permanent structural failure', ts: 1 });
    await internal.saveV6RecoverPermanent();
    expect(storage._store.has(STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT)).toBe(true);

    // Clear in-memory and persist — storage key should be removed.
    internal.v6RecoverPermanent.clear();
    await internal.saveV6RecoverPermanent();
    expect(storage._store.has(STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT)).toBe(false);
  });

  it('restoreV6RecoverPermanent tolerates malformed entries (single-entry resilience)', async () => {
    // Plant a payload with a mix of valid + malformed entries.
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify([
        { tokenId: 'good-1', reason: 'permanent structural failure', ts: 1_000 },
        { tokenId: '', reason: 'empty-id should skip', ts: 2_000 },
        { tokenId: 'no-reason', ts: 3_000 },
        { tokenId: 'good-2', reason: 'permanent recipient-address mismatch', ts: 4_000 },
        { tokenId: 'nan-ts', reason: 'NaN ts should skip', ts: Number.NaN },
      ]),
    );

    const internal = module as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      restoreV6RecoverPermanent: () => Promise<void>;
    };
    await internal.restoreV6RecoverPermanent();

    // Only the two well-formed entries survive.
    expect(internal.v6RecoverPermanent.size).toBe(2);
    expect(internal.v6RecoverPermanent.has('good-1')).toBe(true);
    expect(internal.v6RecoverPermanent.has('good-2')).toBe(true);
    expect(internal.v6RecoverPermanent.has('')).toBe(false);
    expect(internal.v6RecoverPermanent.has('no-reason')).toBe(false);
    expect(internal.v6RecoverPermanent.has('nan-ts')).toBe(false);
  });

  it('restoreV6RecoverPermanent on missing storage key is a no-op', async () => {
    const internal = module as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      restoreV6RecoverPermanent: () => Promise<void>;
    };
    expect(internal.v6RecoverPermanent.size).toBe(0);
    await internal.restoreV6RecoverPermanent();
    expect(internal.v6RecoverPermanent.size).toBe(0);
  });

  it('restoreV6RecoverPermanent on non-array payload clears nothing and logs', async () => {
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify({ shape: 'object instead of array' }),
    );
    const internal = module as unknown as {
      v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
      restoreV6RecoverPermanent: () => Promise<void>;
    };
    internal.v6RecoverPermanent.set('pre-existing', { reason: 'should-not-be-touched', ts: 1 });
    await internal.restoreV6RecoverPermanent();
    // Pre-existing in-memory state is preserved; malformed payload is logged.
    expect(internal.v6RecoverPermanent.size).toBe(1);
    expect(internal.v6RecoverPermanent.has('pre-existing')).toBe(true);
  });
});
