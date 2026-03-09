/**
 * Test helpers for AccountingModule unit tests.
 *
 * Provides mock factories, fixture factories, and utility functions used
 * across all accounting test files.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §2
 */

import { vi } from 'vitest';
import { AccountingModule, createAccountingModule } from '../../../modules/accounting/index.js';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../modules/accounting/serialization.js';
import { encodeTransferMessage } from '../../../modules/accounting/memo.js';
import type {
  AccountingModuleConfig,
  AccountingModuleDependencies,
  CreateInvoiceRequest,
  InvoiceTerms,
  InvoiceTransferRef,
  TransferMessagePayload,
} from '../../../modules/accounting/types.js';
import type { FullIdentity, TrackedAddress, TransferResult, Token, Asset, DirectMessage } from '../../../types/index.js';
import type { TxfToken, TxfInclusionProof } from '../../../types/txf.js';
import type { StorageProvider } from '../../../storage/storage-provider.js';
import type { TokenStorageProvider, LoadResult, SaveResult, SyncResult } from '../../../storage/storage-provider.js';
import { SphereError } from '../../../core/errors.js';
import { getAddressId } from '../../../constants.js';

// Re-export for convenience in test files
export { SphereError, INVOICE_TOKEN_TYPE_HEX };

// =============================================================================
// Utility: random 64-char hex string
// =============================================================================

function randomHex64(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// =============================================================================
// Mock: PaymentsModule
// =============================================================================

/**
 * Minimal mock of a PaymentsModule-like object.
 *
 * Exposes vi.fn() stubs for every method used by AccountingModule and test
 * assertions. Private test-helper fields are prefixed with `_`.
 */
export interface MockPaymentsModule {
  // Public API stubs
  getTokens: ReturnType<typeof vi.fn>;
  getArchivedTokens: ReturnType<typeof vi.fn>;
  getAssets: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  onTokenChange: ReturnType<typeof vi.fn>;
  l1: null;
  // Test helpers
  _tokens: Token[];
  _archivedTokens: Map<string, unknown>;
  _sendResult: TransferResult;
  _handlers: Map<string, Array<(data: unknown) => void>>;
  _emit: (event: string, data: unknown) => void;
  _tokenChangeCallbacks: Array<(tokenId: string, sdkData: string) => void>;
  _notifyTokenChange: (tokenId: string, sdkData: string) => void;
}

export function createMockPaymentsModule(): MockPaymentsModule {
  const tokens: Token[] = [];
  const handlers = new Map<string, Array<(data: unknown) => void>>();

  const defaultSendResult: TransferResult = {
    id: 'mock-transfer-id',
    status: 'completed',
    tokens: [],
    tokenTransfers: [],
  };

  // Mutable send result — tests can reassign mock._sendResult
  let sendResult = { ...defaultSendResult };

  const archivedTokens = new Map<string, unknown>();

  const getTokens = vi.fn().mockImplementation((_filter?: unknown) => {
    return mock._tokens.slice();
  });

  const getArchivedTokens = vi.fn().mockImplementation(() => {
    return new Map(mock._archivedTokens);
  });

  const getAssets = vi.fn().mockImplementation((_coinId?: string): Asset[] => {
    return [];
  });

  const getHistory = vi.fn().mockImplementation(() => {
    return [];
  });

  const send = vi.fn().mockImplementation((_request: unknown): Promise<TransferResult> => {
    return Promise.resolve(mock._sendResult);
  });

  const on = vi.fn().mockImplementation((event: string, handler: (data: unknown) => void): (() => void) => {
    if (!handlers.has(event)) {
      handlers.set(event, []);
    }
    handlers.get(event)!.push(handler);
    return () => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  });

  const _emit = (event: string, data: unknown): void => {
    const list = handlers.get(event);
    if (list) {
      for (const h of list) h(data);
    }
  };

  const tokenChangeCallbacks: Array<(tokenId: string, sdkData: string) => void> = [];

  const onTokenChange = vi.fn().mockImplementation((cb: (tokenId: string, sdkData: string) => void): (() => void) => {
    tokenChangeCallbacks.push(cb);
    return () => {
      const idx = tokenChangeCallbacks.indexOf(cb);
      if (idx !== -1) tokenChangeCallbacks.splice(idx, 1);
    };
  });

  const _notifyTokenChange = (tokenId: string, sdkData: string): void => {
    for (const cb of tokenChangeCallbacks) cb(tokenId, sdkData);
  };

  const mock: MockPaymentsModule = {
    getTokens,
    getArchivedTokens,
    getAssets,
    getHistory,
    send,
    on,
    onTokenChange,
    l1: null,
    _tokens: tokens,
    _archivedTokens: archivedTokens,
    get _sendResult(): TransferResult {
      return sendResult;
    },
    set _sendResult(value: TransferResult) {
      sendResult = value;
    },
    _handlers: handlers,
    _emit,
    _tokenChangeCallbacks: tokenChangeCallbacks,
    _notifyTokenChange,
  };

  return mock;
}

// =============================================================================
// Mock: OracleProvider
// =============================================================================

/** Minimal mock inclusion proof returned by the mock state transition client. */
export function createMockInclusionProof(): TxfInclusionProof {
  return {
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: randomHex(128),
      stateHash: randomHex64(),
    },
    merkleTreePath: {
      root: randomHex64(),
      steps: [],
    },
    transactionHash: randomHex64(),
    unicityCertificate: randomHex(256),
  };
}

export interface MockStateTransitionClient {
  submitMintCommitment: ReturnType<typeof vi.fn>;
  submitTransferCommitment: ReturnType<typeof vi.fn>;
  waitInclusionProof: ReturnType<typeof vi.fn>;
  isMinted: ReturnType<typeof vi.fn>;
}

export interface MockOracleProvider {
  // OracleProvider base stubs
  id: string;
  name: string;
  type: 'network';
  description: string;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  submitCommitment: ReturnType<typeof vi.fn>;
  getProof: ReturnType<typeof vi.fn>;
  waitForProof: ReturnType<typeof vi.fn>;
  validateToken: ReturnType<typeof vi.fn>;
  isSpent: ReturnType<typeof vi.fn>;
  getTokenState: ReturnType<typeof vi.fn>;
  getCurrentRound: ReturnType<typeof vi.fn>;
  // AccountingModule-specific helpers
  getStateTransitionClient: ReturnType<typeof vi.fn>;
  getTrustBase: ReturnType<typeof vi.fn>;
  _stateTransitionClient: MockStateTransitionClient;
}

export function createMockOracleProvider(): MockOracleProvider {
  const mockProof = createMockInclusionProof();

  const stateTransitionClient: MockStateTransitionClient = {
    submitMintCommitment: vi.fn().mockResolvedValue({ requestId: 'test-request-id' }),
    submitTransferCommitment: vi.fn().mockResolvedValue({ requestId: 'test-transfer-request-id' }),
    waitInclusionProof: vi.fn().mockResolvedValue(mockProof),
    isMinted: vi.fn().mockResolvedValue(false),
  };

  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Mock oracle provider for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ success: true, requestId: 'test-request-id', timestamp: Date.now() }),
    getProof: vi.fn().mockResolvedValue(mockProof),
    waitForProof: vi.fn().mockResolvedValue(mockProof),
    validateToken: vi.fn().mockResolvedValue({ valid: true, spent: false }),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
    getStateTransitionClient: vi.fn().mockReturnValue(stateTransitionClient),
    getTrustBase: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    _stateTransitionClient: stateTransitionClient,
  };
}

// =============================================================================
// Mock: StorageProvider
// =============================================================================

export interface MockStorageProvider extends StorageProvider {
  _data: Map<string, string>;
}

export function createMockStorageProvider(): MockStorageProvider {
  const data = new Map<string, string>();

  return {
    // BaseProvider metadata
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    description: 'Mock storage provider backed by Map for testing',

    // BaseProvider lifecycle stubs
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),

    // StorageProvider interface
    setIdentity: vi.fn(),

    get: vi.fn().mockImplementation((key: string): Promise<string | null> => {
      return Promise.resolve(data.get(key) ?? null);
    }),

    set: vi.fn().mockImplementation((key: string, value: string): Promise<void> => {
      data.set(key, value);
      return Promise.resolve();
    }),

    remove: vi.fn().mockImplementation((key: string): Promise<void> => {
      data.delete(key);
      return Promise.resolve();
    }),

    has: vi.fn().mockImplementation((key: string): Promise<boolean> => {
      return Promise.resolve(data.has(key));
    }),

    keys: vi.fn().mockImplementation((prefix?: string): Promise<string[]> => {
      const all = Array.from(data.keys());
      if (prefix == null) return Promise.resolve(all);
      return Promise.resolve(all.filter((k) => k.startsWith(prefix)));
    }),

    clear: vi.fn().mockImplementation((prefix?: string): Promise<void> => {
      if (prefix == null) {
        data.clear();
      } else {
        for (const key of Array.from(data.keys())) {
          if (key.startsWith(prefix)) data.delete(key);
        }
      }
      return Promise.resolve();
    }),

    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),

    // Test helper: direct access to backing store
    _data: data,
  };
}

// =============================================================================
// Mock: TokenStorageProvider
// =============================================================================

export interface MockTokenStorageProvider extends TokenStorageProvider<unknown> {
  _tokens: Map<string, unknown>;
}

export function createMockTokenStorageProvider(): MockTokenStorageProvider {
  const tokens = new Map<string, unknown>();
  let storedData: unknown = null;

  return {
    // BaseProvider metadata
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    description: 'Mock token storage provider backed by Map for testing',

    // BaseProvider lifecycle stubs
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),

    // TokenStorageProvider interface
    setIdentity: vi.fn(),

    initialize: vi.fn().mockResolvedValue(true),

    shutdown: vi.fn().mockResolvedValue(undefined),

    save: vi.fn().mockImplementation((data: unknown): Promise<SaveResult> => {
      storedData = data;
      return Promise.resolve({
        success: true,
        timestamp: Date.now(),
      });
    }),

    load: vi.fn().mockImplementation((_identifier?: string): Promise<LoadResult<unknown>> => {
      return Promise.resolve({
        success: storedData !== null,
        data: storedData ?? undefined,
        source: 'local',
        timestamp: Date.now(),
      });
    }),

    sync: vi.fn().mockImplementation((_localData: unknown): Promise<SyncResult<unknown>> => {
      return Promise.resolve({
        success: true,
        added: 0,
        removed: 0,
        conflicts: 0,
      });
    }),

    addHistoryEntry: vi.fn().mockResolvedValue(undefined),
    getHistoryEntries: vi.fn().mockResolvedValue([]),

    // Test helper: backing token map (for direct assertion in tests)
    _tokens: tokens,
  };
}

// =============================================================================
// Mock: CommunicationsModule
// =============================================================================

export interface MockCommunicationsModule {
  sendDM: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  onDirectMessage: ReturnType<typeof vi.fn>;
  // Test helpers
  _sentDMs: Array<{ recipient: string; content: string }>;
  _handlers: Map<string, Array<(data: unknown) => void>>;
  _dmHandlers: Array<(message: DirectMessage) => void>;
  _emit: (event: string, data: unknown) => void;
}

export function createMockCommunicationsModule(): MockCommunicationsModule {
  const sentDMs: Array<{ recipient: string; content: string }> = [];
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const dmHandlers: Array<(message: DirectMessage) => void> = [];

  const sendDM = vi.fn().mockImplementation((recipient: string, content: string): Promise<DirectMessage> => {
    sentDMs.push({ recipient, content });
    const dm: DirectMessage = {
      id: 'mock-dm-' + Math.random().toString(36).slice(2),
      senderPubkey: '02' + 'a'.repeat(64),
      recipientPubkey: '02' + 'b'.repeat(64),
      content,
      timestamp: Date.now(),
      isRead: false,
    };
    return Promise.resolve(dm);
  });

  const getConversation = vi.fn().mockImplementation((_peer: string): DirectMessage[] => {
    return [];
  });

  const on = vi.fn().mockImplementation((event: string, handler: (data: unknown) => void): (() => void) => {
    if (!handlers.has(event)) {
      handlers.set(event, []);
    }
    handlers.get(event)!.push(handler);
    // Also wire 'message:dm' handlers to the onDirectMessage path
    if (event === 'message:dm') {
      dmHandlers.push(handler as (message: DirectMessage) => void);
    }
    return () => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
      if (event === 'message:dm') {
        const dmIdx = dmHandlers.indexOf(handler as (message: DirectMessage) => void);
        if (dmIdx !== -1) dmHandlers.splice(dmIdx, 1);
      }
    };
  });

  const onDirectMessage = vi.fn().mockImplementation((handler: (message: DirectMessage) => void): (() => void) => {
    dmHandlers.push(handler);
    return () => {
      const idx = dmHandlers.indexOf(handler);
      if (idx !== -1) dmHandlers.splice(idx, 1);
    };
  });

  const _emit = (event: string, data: unknown): void => {
    // Trigger generic event handlers
    const list = handlers.get(event);
    if (list) {
      for (const h of list) h(data);
    }
    // For 'message:dm', also trigger all onDirectMessage handlers that were
    // not already triggered through the generic handlers map
    if (event === 'message:dm') {
      for (const h of dmHandlers) {
        // Avoid double-firing if handler was registered via on('message:dm', ...) — those
        // were already added to dmHandlers but also called above via the handlers map.
        // We therefore deduplicate: fire dmHandlers only if NOT in the generic handler list.
        const genericList = handlers.get(event) ?? [];
        if (!genericList.includes(h as (data: unknown) => void)) {
          h(data as DirectMessage);
        }
      }
    }
  };

  return {
    sendDM,
    getConversation,
    on,
    onDirectMessage,
    _sentDMs: sentDMs,
    _handlers: handlers,
    _dmHandlers: dmHandlers,
    _emit,
  };
}

// =============================================================================
// Test Fixture: CreateInvoiceRequest
// =============================================================================

/**
 * Returns a minimal valid `CreateInvoiceRequest` with sensible defaults.
 *
 * Deep-merges provided overrides on top of the defaults so callers can supply
 * only the fields that need changing.
 *
 * @param overrides - Partial overrides to merge with defaults.
 */
export function createTestInvoice(overrides?: Partial<CreateInvoiceRequest>): CreateInvoiceRequest {
  const defaults: CreateInvoiceRequest = {
    targets: [
      {
        address: 'DIRECT://test_target_address_abc123',
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    dueDate: Date.now() + 86400000, // 1 day from now
    memo: 'Test invoice',
  };

  if (!overrides) return defaults;

  return {
    ...defaults,
    ...overrides,
    // Deep-merge targets if both present
    targets: overrides.targets ?? defaults.targets,
  };
}

// =============================================================================
// Test Fixture: TxfToken (invoice token)
// =============================================================================

/**
 * Creates a valid TxfToken representing a minted invoice token.
 *
 * @param terms - InvoiceTerms to embed in genesis.data.tokenData.
 * @param tokenId - Optional 64-char hex token ID. Randomly generated if omitted.
 */
export function createTestToken(terms: InvoiceTerms, tokenId?: string): TxfToken {
  const id = tokenId ?? randomHex64();

  const inclusionProof: TxfInclusionProof = {
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: randomHex(128),
      stateHash: randomHex64(),
    },
    merkleTreePath: {
      root: randomHex64(),
      steps: [],
    },
    transactionHash: randomHex64(),
    unicityCertificate: randomHex(256),
  };

  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: id,
        tokenType: INVOICE_TOKEN_TYPE_HEX,
        coinData: [],                            // Invoice tokens are non-fungible
        tokenData: JSON.stringify(terms),
        salt: randomHex64(),
        recipient: 'DIRECT://creator_address',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof,
    },
    state: {
      data: randomHex64(),
      predicate: randomHex(64),
    },
    transactions: [],
  };
}

// =============================================================================
// Test Fixture: TxfToken (transfer with on-chain invoice memo)
// =============================================================================

/**
 * Creates a TxfToken representing a fungible transfer that carries an
 * on-chain invoice reference in its first transaction entry's message field.
 *
 * The message is hex-encoded UTF-8 JSON of a `TransferMessagePayload`, matching
 * the format read by `InvoiceTransferIndex._processTokenTx()` (§4.1).
 *
 * @param invoiceId      - 64-char hex invoice ID.
 * @param direction      - Payment direction code: `'F'`, `'B'`, `'RC'`, or `'RX'`.
 * @param amount         - Amount string in smallest units (e.g. `'10000000'`).
 * @param coinId         - Coin identifier (defaults to `'UCT'`).
 * @param senderAddress  - Sender DIRECT:// address embedded in token recipient field.
 * @param recipientAddress - Recipient DIRECT:// address embedded in genesis.
 */
export function createTestTransfer(
  invoiceId: string,
  direction: 'F' | 'B' | 'RC' | 'RX',
  amount: string,
  coinId?: string,
  senderAddress?: string,
  recipientAddress?: string,
): TxfToken {
  const coin = coinId ?? 'UCT';
  const recipient = recipientAddress ?? 'DIRECT://test_target_address_abc123';
  const sender = senderAddress ?? 'DIRECT://sender_address_def456';

  const payload: TransferMessagePayload = {
    inv: { id: invoiceId.toLowerCase(), dir: direction },
  };
  const messageBytes = encodeTransferMessage(payload);
  // Hex-encode the UTF-8 JSON bytes — this is what InvoiceTransferIndex reads
  const messageHex = Array.from(messageBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const inclusionProof: TxfInclusionProof = {
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: randomHex(128),
      stateHash: randomHex64(),
    },
    merkleTreePath: {
      root: randomHex64(),
      steps: [],
    },
    transactionHash: randomHex64(),
    unicityCertificate: randomHex(256),
  };

  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: randomHex64(),
        tokenType: randomHex64(), // Non-invoice token type
        coinData: [[coin, amount]],
        tokenData: '',
        salt: randomHex64(),
        recipient,
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof,
    },
    state: {
      data: randomHex64(),
      predicate: randomHex(64),
    },
    transactions: [
      {
        previousStateHash: randomHex64(),
        newStateHash: randomHex64(),
        predicate: randomHex(64),
        inclusionProof,
        data: {
          message: messageHex,
          // W9 fix: include recipient in tx.data (read by _processTokenTransactions for destinationAddress)
          recipient,
        },
      },
    ],
  };
}

// =============================================================================
// Test Fixture: InvoiceTransferRef
// =============================================================================

/**
 * Creates a plain `InvoiceTransferRef` object with sensible defaults.
 *
 * @param invoiceId        - 64-char hex invoice ID (stored for context — not
 *                           a field on InvoiceTransferRef itself).
 * @param direction        - Invoice payment direction.
 * @param amount           - Amount in smallest units.
 * @param coinId           - Coin identifier (defaults to `'UCT'`).
 * @param overrides        - Optional field overrides.
 */
export function createTestTransferRef(
  invoiceId: string,
  direction: 'forward' | 'back' | 'return_closed' | 'return_cancelled',
  amount: string,
  coinId?: string,
  overrides?: Partial<InvoiceTransferRef>,
): InvoiceTransferRef {
  const base: InvoiceTransferRef = {
    transferId: 'transfer-' + randomHex(16),
    direction: 'inbound',
    paymentDirection: direction,
    coinId: coinId ?? 'UCT',
    amount,
    destinationAddress: 'DIRECT://test_target_address_abc123',
    timestamp: Date.now(),
    confirmed: true,
    senderAddress: 'DIRECT://sender_address_def456',
    ...overrides,
  };
  return base;
}

// =============================================================================
// Utility: advanceTime
// =============================================================================

/**
 * Mocks `Date.now()` to return a value advanced by `ms` milliseconds from the
 * time this function is called.
 *
 * Returns the mocked timestamp so callers can use it in assertions.
 * The spy is automatically restored by Vitest's `restoreAllMocks` / `clearAllMocks`
 * hooks if configured, or can be restored manually via `vi.restoreAllMocks()`.
 *
 * @param ms - Milliseconds to advance from the real current time.
 * @returns The mocked timestamp.
 */
export function advanceTime(ms: number): number {
  const now = Date.now() + ms;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  return now;
}

// =============================================================================
// Utility: resolveInvoicePrefix
// =============================================================================

/**
 * Simulates CLI prefix-based invoice resolution.
 *
 * Given an array of InvoiceRef-like objects (with an `invoiceId` field) and a
 * prefix string, returns all entries whose invoiceId starts with the prefix.
 *
 * @param invoices - Array of objects that have an `invoiceId` string field.
 * @param prefix   - Hex prefix to match against invoiceId.
 */
export function resolveInvoicePrefix<T extends { invoiceId: string }>(
  invoices: T[],
  prefix: string,
): T[] {
  return invoices.filter((inv) => inv.invoiceId.startsWith(prefix.toLowerCase()));
}

// =============================================================================
// Utility: resolveTerminalState
// =============================================================================

/**
 * Returns `'CLOSED'` or `'CANCELLED'` when the given state is terminal.
 *
 * @param state - Invoice state string.
 * @throws {Error} If the state is not a terminal value.
 */
export function resolveTerminalState(state: string): 'CLOSED' | 'CANCELLED' {
  if (state === 'CLOSED') return 'CLOSED';
  if (state === 'CANCELLED') return 'CANCELLED';
  throw new Error(`Expected terminal state (CLOSED or CANCELLED), got: ${state}`);
}

// =============================================================================
// Default test identity
// =============================================================================

/** Default FullIdentity used by createTestAccountingModule(). */
export const DEFAULT_TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'a'.repeat(64),
  l1Address: 'alpha1testaddr',
  directAddress: 'DIRECT://test_target_address_abc123',
  privateKey: 'deadbeef'.repeat(8),
};

/** Default TrackedAddress derived from DEFAULT_TEST_IDENTITY. */
export const DEFAULT_TEST_TRACKED_ADDRESS: TrackedAddress = {
  index: 0,
  addressId: getAddressId('DIRECT://test_target_address_abc123'),
  l1Address: 'alpha1testaddr',
  directAddress: 'DIRECT://test_target_address_abc123',
  chainPubkey: '02' + 'a'.repeat(64),
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
};

// =============================================================================
// createTestAccountingModule
// =============================================================================

/**
 * All mock dependencies created by createTestAccountingModule(), returned
 * alongside the AccountingModule instance for test assertions.
 */
export interface TestAccountingModuleMocks {
  payments: MockPaymentsModule;
  oracle: MockOracleProvider;
  storage: MockStorageProvider;
  tokenStorage: MockTokenStorageProvider;
  communications: MockCommunicationsModule;
  identity: FullIdentity;
}

/**
 * Creates a fully-configured AccountingModule with mock dependencies.
 *
 * Calls `initialize()` with all mock deps but does NOT call `load()` — tests
 * that need loaded state should call `await module.load()` explicitly after
 * this factory returns.
 *
 * @param overrides - Optional overrides for config or individual mock dependencies.
 * @returns The AccountingModule instance and all mock dependencies.
 *
 * @example
 * ```ts
 * const { module, mocks } = createTestAccountingModule();
 * await module.load();
 * // Now interact with module and assert on mocks
 * expect(mocks.storage.get).toHaveBeenCalled();
 * ```
 */
export function createTestAccountingModule(overrides?: {
  config?: Partial<AccountingModuleConfig>;
  payments?: MockPaymentsModule;
  oracle?: MockOracleProvider;
  storage?: MockStorageProvider;
  tokenStorage?: MockTokenStorageProvider;
  communications?: MockCommunicationsModule;
  identity?: FullIdentity;
  trackedAddresses?: TrackedAddress[];
  // C6-R17: Allow overriding trustBase for security tests (null/empty = rejection)
  trustBase?: unknown;
}): {
  module: AccountingModule;
  mocks: TestAccountingModuleMocks;
} {
  const payments = overrides?.payments ?? createMockPaymentsModule();
  const oracle = overrides?.oracle ?? createMockOracleProvider();
  const storage = overrides?.storage ?? createMockStorageProvider();
  const tokenStorage = overrides?.tokenStorage ?? createMockTokenStorageProvider();
  const communications = overrides?.communications ?? createMockCommunicationsModule();
  const identity = overrides?.identity ?? { ...DEFAULT_TEST_IDENTITY };
  const trackedAddresses = overrides?.trackedAddresses ?? [DEFAULT_TEST_TRACKED_ADDRESS];

  const module = createAccountingModule(overrides?.config);

  const deps: AccountingModuleDependencies = {
    // Cast to PaymentsModule — mock satisfies the subset of the interface used by AccountingModule
    payments: payments as unknown as AccountingModuleDependencies['payments'],
    tokenStorage: tokenStorage as unknown as AccountingModuleDependencies['tokenStorage'],
    oracle: oracle as unknown as AccountingModuleDependencies['oracle'],
    trustBase: overrides?.trustBase !== undefined ? overrides.trustBase : new Uint8Array([1, 2, 3]),
    identity,
    getActiveAddresses: vi.fn().mockReturnValue(trackedAddresses),
    emitEvent: vi.fn(),
    on: vi.fn().mockImplementation(
      <T extends string>(_type: T, _handler: (data: unknown) => void): (() => void) => {
        // Wire through to the payments mock's on() so tests can trigger events
        return payments.on(_type, _handler);
      },
    ),
    storage: storage as unknown as AccountingModuleDependencies['storage'],
    communications: communications as unknown as AccountingModuleDependencies['communications'],
  };

  module.initialize(deps);

  const mocks: TestAccountingModuleMocks = {
    payments,
    oracle,
    storage,
    tokenStorage,
    communications,
    identity,
  };

  return { module, mocks };
}
