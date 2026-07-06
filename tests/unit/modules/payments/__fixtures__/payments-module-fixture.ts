/**
 * Shared helpers for PaymentsModule wiring tests (Issue #166).
 *
 * These tests assert side-effects of the writer install + SENT-ledger
 * code paths added in PR #97 (OUTBOX/SENT crash safety) and the round-1/
 * round-2 steelman fixes. The helpers consolidate the dependency-mock
 * scaffolding that would otherwise be duplicated across several test
 * files.
 *
 * **Note on `vi.mock` hoisting.** This file does NOT call `vi.mock` —
 * those calls are hoisted to the top of each test file at compile time
 * and cannot be packaged into a helper. Test files that need to mock
 * `@unicitylabs/state-transition-sdk` etc. must declare their own
 * `vi.mock` blocks at the top.
 *
 * **Address shape.** Every fixture uses the canonical
 * `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}` shape returned by
 * `constants.ts:getAddressId()`. Commit 5 of #166 P3+P4 tightens
 * `OutboxWriter`/`SentLedgerWriter` constructors to enforce this shape;
 * tests written against this fixture therefore continue passing after
 * the validation lands.
 */

import { vi } from 'vitest';

import { Lamport } from '../../../../../extensions/uxf/profile/lamport';
import { OutboxWriter } from '../../../../../extensions/uxf/profile/outbox-writer';
import { SentLedgerWriter } from '../../../../../extensions/uxf/profile/sent-ledger-writer';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../../../extensions/uxf/profile/types';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../../../../types';
import type { OracleProvider } from '../../../../../oracle';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../../../storage';
import type { TransportProvider } from '../../../../../transport';
import type { UxfTransferOutboxEntry } from '../../../../../types/uxf-outbox';
import type { SentLedgerWriteInput } from '../../../../../extensions/uxf/profile/sent-ledger-writer';

/** Canonical valid addressId used by every fixture. Matches the shape
 *  produced by `getAddressId()` (`constants.ts`). */
export const TEST_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';

/** Canonical valid recipient transport pubkey (64-hex). */
export const TEST_RECIPIENT_TRANSPORT_PUBKEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// ProfileDatabase mock (in-memory Map)
// ---------------------------------------------------------------------------

export interface MockProfileDb extends ProfileDatabase {
  readonly _store: Map<string, Uint8Array>;
}

export function createMockProfileDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_config: OrbitDbConfig): Promise<void> {},
    async put(k: string, v: Uint8Array): Promise<void> {
      store.set(k, v);
    },
    async get(k: string): Promise<Uint8Array | null> {
      return store.get(k) ?? null;
    },
    async del(k: string): Promise<void> {
      store.delete(k);
    },
    async all(prefix?: string): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close(): Promise<void> {},
    onReplication(): () => void {
      return () => {};
    },
    isConnected(): boolean {
      return true;
    },
  } as MockProfileDb;
}

// ---------------------------------------------------------------------------
// Writer construction
// ---------------------------------------------------------------------------

export interface WriterPair {
  readonly db: MockProfileDb;
  readonly outboxWriter: OutboxWriter;
  readonly sentLedgerWriter: SentLedgerWriter;
}

export function createWriterPair(
  addressId: string = TEST_ADDRESS_ID,
): WriterPair {
  const db = createMockProfileDb();
  return {
    db,
    outboxWriter: new OutboxWriter({
      db,
      encryptionKey: null,
      addressId,
      lamport: new Lamport(),
    }),
    sentLedgerWriter: new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId,
      lamport: new Lamport(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Entry factories
// ---------------------------------------------------------------------------

export function makeOutboxEntry(
  overrides: Partial<UxfTransferOutboxEntry> = {},
): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: overrides.id ?? 'outbox-1',
    bundleCid: 'bafy-bundle',
    tokenIds: ['token-1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: TEST_RECIPIENT_TRANSPORT_PUBKEY,
    mode: 'conservative',
    status: 'sending',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lamport: 1,
    ...overrides,
  };
}

export function makeSentEntryInput(
  overrides: Partial<SentLedgerWriteInput> = {},
): SentLedgerWriteInput {
  return {
    id: 'outbox-1',
    tokenIds: ['token-1'],
    bundleCid: 'bafy-bundle',
    recipientTransportPubkey: TEST_RECIPIENT_TRANSPORT_PUBKEY,
    recipient: '@bob',
    deliveryMethod: 'car-over-nostr',
    mode: 'conservative',
    sentAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeToken(
  id: string,
  status: Token['status'],
  overrides: Partial<Token> = {},
): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '100',
    status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Event recorder (mirror of sending-recovery-worker test pattern)
// ---------------------------------------------------------------------------

export interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

export interface EventRecorder {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
  readonly clear: () => void;
}

export function makeEventRecorder(): EventRecorder {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(
      type: T,
      data: SphereEventMap[T],
    ): void => {
      events.push({ type, data });
    },
    clear: (): void => {
      events.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// PaymentsModule dependency stubs (mirror of dual-mode.test.ts pattern)
// ---------------------------------------------------------------------------

export function createTestIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'aa'.repeat(32),
    directAddress: 'DIRECT://test',
    privateKey: '00' + '11'.repeat(31),
  };
}

export function createStubStorageProvider(): StorageProvider {
  const data = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => {
      data.clear();
    }),
  };
}

export function createStubTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
}

export function createStubOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
    // Default to "unspent" so flows that consult the aggregator
    // (e.g. defaultOrphanRecovery — OUTBOX-SEND-FOLLOWUPS item #1)
    // can complete the happy path. Tests that exercise the spent
    // or RPC-failure branches override this on the returned object.
    isSpent: vi.fn().mockResolvedValue(false),
  } as unknown as OracleProvider;
}

export function createStubTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> {
  let stored: TxfStorageDataBase | null = null;
  return {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(async () => ({
      success: stored !== null,
      data: stored ?? undefined,
      source: 'local' as const,
      timestamp: Date.now(),
    })),
    save: vi.fn(async (data: TxfStorageDataBase) => {
      stored = data;
      return { success: true, timestamp: Date.now() };
    }),
    sync: vi.fn(async () => ({
      success: true,
      added: 0,
      removed: 0,
      conflicts: 0,
    })),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}
