/**
 * Test helpers for SwapModule unit tests.
 *
 * Provides mock factories, fixture factories, DM simulation helpers, and
 * the orchestrator function used across all swap test files.
 *
 * @see docs/SWAP-TEST-SPEC.md section 2
 */

import { vi } from 'vitest';
import { SwapModule, createSwapModule } from '../../../modules/swap/index.js';
import { computeSwapId, buildManifest } from '../../../modules/swap/manifest.js';
import {
  buildProposalDM,
  buildAcceptanceDM,
  buildRejectionDM,
} from '../../../modules/swap/dm-protocol.js';
import type {
  SwapModuleConfig,
  SwapModuleDependencies,
  SwapRef,
  SwapDeal,
  SwapManifest,
  SwapProgress,
  SwapRole,
  EscrowAnnounceResult,
  EscrowInvoiceDelivery,
  EscrowSwapCancelled,
} from '../../../modules/swap/types.js';
import type {
  FullIdentity,
  TrackedAddress,
  TransferResult,
  Token,
  SphereEventType,
  SphereEventMap,
  DirectMessage,
} from '../../../types/index.js';
import type { StorageProvider } from '../../../storage/storage-provider.js';
import type { PeerInfo } from '../../../transport/transport-provider.js';
import type { InvoiceTerms, InvoiceTransferRef } from '../../../modules/accounting/types.js';
import { SphereError } from '../../../core/errors.js';

// Re-export for convenience in test files
export { SphereError };

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_TEST_PARTY_A_PUBKEY = '02' + 'a'.repeat(64);
export const DEFAULT_TEST_PARTY_A_ADDRESS = 'DIRECT://party_a_aaa111';
export const DEFAULT_TEST_PARTY_B_PUBKEY = '02' + 'b'.repeat(64);
export const DEFAULT_TEST_PARTY_B_ADDRESS = 'DIRECT://party_b_bbb222';
export const DEFAULT_TEST_ESCROW_PUBKEY = '02' + 'e'.repeat(64);
export const DEFAULT_TEST_ESCROW_ADDRESS = 'DIRECT://escrow_eee333';

export const DEFAULT_TEST_IDENTITY: FullIdentity = {
  chainPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
  directAddress: DEFAULT_TEST_PARTY_A_ADDRESS,
  l1Address: 'alpha1partyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  nametag: 'alice',
  privateKey: 'a'.repeat(64),
};

// =============================================================================
// Utility: random hex
// =============================================================================

function randomHex64(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// =============================================================================
// Mock: AccountingModule
// =============================================================================

export interface MockAccountingModule {
  importInvoice: ReturnType<typeof vi.fn>;
  getInvoice: ReturnType<typeof vi.fn>;
  getInvoiceStatus: ReturnType<typeof vi.fn>;
  payInvoice: ReturnType<typeof vi.fn>;
  closeInvoice: ReturnType<typeof vi.fn>;
  cancelInvoice: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  // Test helpers
  _emit: (event: string, data: unknown) => void;
  _invoices: Map<string, unknown>;
  _statuses: Map<string, unknown>;
  _handlers: Map<string, Array<(data: unknown) => void>>;
  _payResult: TransferResult;
}

export function createMockAccountingModule(): MockAccountingModule {
  const invoices = new Map<string, unknown>();
  const statuses = new Map<string, unknown>();
  const handlers = new Map<string, Array<(data: unknown) => void>>();

  const defaultPayResult: TransferResult = {
    id: 'mock-pay-transfer-id',
    status: 'completed',
    tokens: [],
    tokenTransfers: [],
  };

  let payResult = { ...defaultPayResult };

  const defaultInvoiceTerms: InvoiceTerms = {
    creator: DEFAULT_TEST_ESCROW_PUBKEY,
    createdAt: Date.now(),
    targets: [
      {
        address: DEFAULT_TEST_ESCROW_ADDRESS,
        assets: [{ coin: ['UCT', '1000000'] }],
      },
    ],
    memo: 'test-invoice',
  };

  const importInvoice = vi.fn().mockImplementation((token: unknown): Promise<unknown> => {
    return Promise.resolve(defaultInvoiceTerms);
  });

  const getInvoice = vi.fn().mockImplementation((invoiceId: string): unknown | null => {
    return invoices.get(invoiceId) ?? null;
  });

  const getInvoiceStatus = vi.fn().mockImplementation((invoiceId: string): unknown => {
    return statuses.get(invoiceId) ?? {
      invoiceId,
      state: 'OPEN',
      targets: [],
      totalForward: {},
      totalBack: {},
      allConfirmed: false,
      lastActivityAt: Date.now(),
    };
  });

  const payInvoice = vi.fn().mockImplementation((_invoiceId: string, _params: unknown): Promise<TransferResult> => {
    return Promise.resolve(mock._payResult);
  });

  const closeInvoice = vi.fn().mockResolvedValue(undefined);
  const cancelInvoice = vi.fn().mockResolvedValue(undefined);

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

  const mock: MockAccountingModule = {
    importInvoice,
    getInvoice,
    getInvoiceStatus,
    payInvoice,
    closeInvoice,
    cancelInvoice,
    on,
    _emit,
    _invoices: invoices,
    _statuses: statuses,
    _handlers: handlers,
    get _payResult(): TransferResult {
      return payResult;
    },
    set _payResult(value: TransferResult) {
      payResult = value;
    },
  };

  return mock;
}

// =============================================================================
// Mock: CommunicationsModule
// =============================================================================

export interface MockCommunicationsModule {
  sendDM: ReturnType<typeof vi.fn>;
  onDirectMessage: ReturnType<typeof vi.fn>;
  // Test helpers
  _sentDMs: Array<{ recipient: string; content: string }>;
  _dmHandlers: Array<(message: { senderPubkey: string; senderNametag?: string; content: string; timestamp: number }) => void>;
  _simulateIncomingDM: (content: string, senderPubkey: string, senderNametag?: string) => void;
}

export function createMockCommunicationsModule(): MockCommunicationsModule {
  const sentDMs: Array<{ recipient: string; content: string }> = [];
  let dmHandlers: Array<(message: { senderPubkey: string; senderNametag?: string; content: string; timestamp: number }) => void> = [];

  const sendDM = vi.fn().mockImplementation((recipientPubkey: string, content: string): Promise<{ eventId: string }> => {
    sentDMs.push({ recipient: recipientPubkey, content });
    return Promise.resolve({ eventId: 'mock-event-' + Math.random().toString(36).slice(2) });
  });

  const onDirectMessage = vi.fn().mockImplementation(
    (handler: (message: { senderPubkey: string; senderNametag?: string; content: string; timestamp: number }) => void): (() => void) => {
      dmHandlers.push(handler);
      return () => {
        dmHandlers = dmHandlers.filter(h => h !== handler);
      };
    },
  );

  const _simulateIncomingDM = (content: string, senderPubkey: string, senderNametag?: string): void => {
    for (const handler of dmHandlers) {
      handler({
        senderPubkey,
        senderNametag,
        content,
        timestamp: Date.now(),
      });
    }
  };

  return {
    sendDM,
    onDirectMessage,
    _sentDMs: sentDMs,
    get _dmHandlers() {
      return dmHandlers;
    },
    _simulateIncomingDM,
  };
}

// =============================================================================
// Mock: PaymentsModule
// =============================================================================

export interface MockPaymentsModule {
  validate: ReturnType<typeof vi.fn>;
}

export function createMockPaymentsModule(): MockPaymentsModule {
  return {
    validate: vi.fn().mockResolvedValue({ valid: [], invalid: [] }),
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
// Mock: resolve (transport-level peer resolution)
// =============================================================================

export interface MockResolve {
  (identifier: string): Promise<PeerInfo | null>;
  _peers: Map<string, PeerInfo>;
}

export function createMockResolve(): MockResolve {
  const peers = new Map<string, PeerInfo>();

  // Pre-populate with party A, party B, and escrow
  const partyAPeer: PeerInfo = {
    chainPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
    directAddress: DEFAULT_TEST_PARTY_A_ADDRESS,
    transportPubkey: 'a'.repeat(64),
    l1Address: 'alpha1partyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nametag: 'alice',
    timestamp: Date.now(),
  };
  peers.set(DEFAULT_TEST_PARTY_A_PUBKEY, partyAPeer);
  peers.set(DEFAULT_TEST_PARTY_A_ADDRESS, partyAPeer);
  peers.set('@alice', partyAPeer);

  const partyBPeer: PeerInfo = {
    chainPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    directAddress: DEFAULT_TEST_PARTY_B_ADDRESS,
    transportPubkey: 'b'.repeat(64),
    l1Address: 'alpha1partybbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nametag: 'bob',
    timestamp: Date.now(),
  };
  peers.set(DEFAULT_TEST_PARTY_B_PUBKEY, partyBPeer);
  peers.set(DEFAULT_TEST_PARTY_B_ADDRESS, partyBPeer);
  peers.set('@bob', partyBPeer);

  const escrowPeer: PeerInfo = {
    chainPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
    directAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    transportPubkey: 'e'.repeat(64),
    l1Address: 'alpha1escroweeeeeeeeeeeeeeeeeeeeeeeeeeee',
    nametag: 'escrow',
    timestamp: Date.now(),
  };
  peers.set(DEFAULT_TEST_ESCROW_PUBKEY, escrowPeer);
  peers.set(DEFAULT_TEST_ESCROW_ADDRESS, escrowPeer);
  peers.set('@escrow', escrowPeer);

  const fn = vi.fn().mockImplementation((identifier: string): Promise<PeerInfo | null> => {
    return Promise.resolve(fn._peers.get(identifier) ?? null);
  }) as unknown as MockResolve;

  fn._peers = peers;

  return fn;
}

// =============================================================================
// Mock: emitEvent
// =============================================================================

export interface MockEmitEvent {
  <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  _calls: Array<[string, unknown]>;
}

export function createMockEmitEvent(): MockEmitEvent {
  const calls: Array<[string, unknown]> = [];

  const fn = vi.fn().mockImplementation((type: string, data: unknown): void => {
    calls.push([type, data]);
  }) as unknown as MockEmitEvent;

  fn._calls = calls;

  return fn;
}

// =============================================================================
// Orchestrator: createTestSwapModule
// =============================================================================

export interface TestSwapModuleMocks {
  accounting: MockAccountingModule;
  payments: MockPaymentsModule;
  communications: MockCommunicationsModule;
  storage: MockStorageProvider;
  emitEvent: MockEmitEvent;
  resolve: MockResolve;
  identity: FullIdentity;
}

/**
 * Create a fully-configured SwapModule with mock dependencies.
 *
 * Calls `initialize()` with all mock deps but does NOT call `load()` --
 * tests that need loaded state should call `await module.load()` explicitly.
 *
 * @param configOverrides - Optional SwapModuleConfig overrides.
 * @returns The SwapModule instance and all mock dependencies.
 */
export function createTestSwapModule(configOverrides?: Partial<SwapModuleConfig>): {
  module: SwapModule;
  mocks: TestSwapModuleMocks;
} {
  const accounting = createMockAccountingModule();
  const payments = createMockPaymentsModule();
  const communications = createMockCommunicationsModule();
  const storage = createMockStorageProvider();
  const emitEvent = createMockEmitEvent();
  const resolve = createMockResolve();
  const identity = { ...DEFAULT_TEST_IDENTITY };

  const defaultTrackedAddress: TrackedAddress = {
    index: 0,
    addressId: 'DIRECT_party_a_aaa111',
    l1Address: identity.l1Address,
    directAddress: identity.directAddress!,
    chainPubkey: identity.chainPubkey,
    nametag: identity.nametag,
    hidden: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const config: SwapModuleConfig = {
    debug: false,
    defaultEscrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    ...configOverrides,
  };

  const module = createSwapModule(config);

  const deps: SwapModuleDependencies = {
    accounting,
    payments,
    communications,
    storage,
    identity,
    emitEvent: emitEvent as <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void,
    resolve: resolve as (identifier: string) => Promise<PeerInfo | null>,
    getActiveAddresses: () => [defaultTrackedAddress],
  };

  module.initialize(deps);

  const mocks: TestSwapModuleMocks = {
    accounting,
    payments,
    communications,
    storage,
    emitEvent,
    resolve,
    identity,
  };

  return { module, mocks };
}

// =============================================================================
// Fixture Factory: SwapDeal
// =============================================================================

/**
 * Returns a minimal valid `SwapDeal` with sensible defaults.
 * Uses DIRECT:// addresses so no transport resolution is needed.
 *
 * @param overrides - Partial overrides to merge with defaults.
 */
export function createTestSwapDeal(overrides?: Partial<SwapDeal>): SwapDeal {
  return {
    partyA: DEFAULT_TEST_PARTY_A_ADDRESS,
    partyB: DEFAULT_TEST_PARTY_B_ADDRESS,
    partyACurrency: 'UCT',
    partyAAmount: '1000000',
    partyBCurrency: 'USDU',
    partyBAmount: '500000',
    timeout: 300,
    escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    ...overrides,
  };
}

// =============================================================================
// Fixture Factory: SwapManifest
// =============================================================================

/**
 * Build a valid SwapManifest from a SwapDeal.
 * Uses the real `computeSwapId` from manifest.ts so swap IDs are
 * deterministic and correct.
 *
 * @param deal - SwapDeal to build manifest from. Defaults to createTestSwapDeal().
 */
export function createTestManifest(deal?: SwapDeal): SwapManifest {
  const d = deal ?? createTestSwapDeal();
  // buildManifest uses the real computeSwapId internally
  return buildManifest(
    d.partyA.startsWith('DIRECT://') ? d.partyA : DEFAULT_TEST_PARTY_A_ADDRESS,
    d.partyB.startsWith('DIRECT://') ? d.partyB : DEFAULT_TEST_PARTY_B_ADDRESS,
    d,
    d.timeout,
  );
}

// =============================================================================
// Fixture Factory: SwapRef
// =============================================================================

/**
 * Create a test SwapRef with sensible defaults.
 * Manifest and swapId are computed from the deal using the real hash function.
 *
 * @param overrides - Partial overrides. The `deal` override will also affect
 *   the manifest and swapId unless `manifest` is explicitly provided.
 */
export function createTestSwapRef(overrides?: Partial<SwapRef>): SwapRef {
  const deal = overrides?.deal ?? createTestSwapDeal();
  const manifest = overrides?.manifest ?? createTestManifest(deal);
  const now = Date.now();

  return {
    swapId: manifest.swap_id,
    deal,
    manifest,
    role: 'proposer' as SwapRole,
    progress: 'proposed' as SwapProgress,
    counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
    escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    payoutVerified: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // Ensure swapId matches manifest even if overrides changed the deal
    ...(overrides?.swapId ? {} : { swapId: manifest.swap_id }),
  };
}

// =============================================================================
// Inject Helper: directly inject SwapRef into module internals
// =============================================================================

/**
 * Directly inject a SwapRef into the module's internal swap map.
 * This bypasses the normal create/load flow for test setup.
 *
 * WARNING: This accesses private fields. Use only in tests.
 *
 * @param module - The SwapModule instance.
 * @param ref - The SwapRef to inject.
 */
export function injectSwapRef(module: SwapModule, ref: SwapRef): void {
  // Access private `swaps` map via bracket notation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = module as any;
  if (!m.swaps) {
    m.swaps = new Map();
  }
  m.swaps.set(ref.swapId, ref);

  // Also update invoiceToSwapIndex if deposit or payout invoice is set
  if (ref.depositInvoiceId && m.invoiceToSwapIndex) {
    m.invoiceToSwapIndex.set(ref.depositInvoiceId, ref.swapId);
  }
  if (ref.payoutInvoiceId && m.invoiceToSwapIndex) {
    m.invoiceToSwapIndex.set(ref.payoutInvoiceId, ref.swapId);
  }
}

// =============================================================================
// DM Simulation Helpers
// =============================================================================

/**
 * Create a mock swap proposal DM content string.
 * Uses the real `buildProposalDM` from dm-protocol.ts.
 *
 * @param manifest - The swap manifest to include in the proposal.
 * @param escrow - Escrow address (defaults to DEFAULT_TEST_ESCROW_ADDRESS).
 * @param message - Optional human-readable message.
 */
export function createMockProposalDM(manifest: SwapManifest, escrow?: string, message?: string): string {
  return buildProposalDM(manifest, escrow ?? DEFAULT_TEST_ESCROW_ADDRESS, message);
}

/**
 * Create a mock swap acceptance DM content string.
 * Uses the real `buildAcceptanceDM` from dm-protocol.ts.
 *
 * @param swapId - The swap ID being accepted.
 */
export function createMockAcceptanceDM(swapId: string): string {
  return buildAcceptanceDM(swapId);
}

/**
 * Create a mock swap rejection DM content string.
 * Uses the real `buildRejectionDM` from dm-protocol.ts.
 *
 * @param swapId - The swap ID being rejected.
 * @param reason - Optional rejection reason.
 */
export function createMockRejectionDM(swapId: string, reason?: string): string {
  return buildRejectionDM(swapId, reason);
}

/**
 * Create a mock escrow announce_result DM content string.
 *
 * @param swapId - The swap ID.
 * @param depositInvoiceId - Deposit invoice ID (defaults to a random ID).
 */
export function createMockAnnounceResultDM(swapId: string, depositInvoiceId?: string): string {
  const payload: EscrowAnnounceResult = {
    type: 'announce_result',
    swap_id: swapId,
    state: 'ANNOUNCED',
    deposit_invoice_id: depositInvoiceId ?? 'mock-deposit-invoice-' + randomHex64().slice(0, 16),
    is_new: true,
    created_at: Date.now(),
  };
  return JSON.stringify(payload);
}

/**
 * Create a mock escrow invoice_delivery DM content string.
 *
 * @param swapId - The swap ID.
 * @param type - Whether this is a deposit or payout invoice delivery.
 * @param invoiceId - Optional invoice ID.
 */
export function createMockInvoiceDeliveryDM(
  swapId: string,
  type: 'deposit' | 'payout',
  invoiceId?: string,
): string {
  const payload: EscrowInvoiceDelivery = {
    type: 'invoice_delivery',
    swap_id: swapId,
    invoice_type: type,
    invoice_id: invoiceId ?? `mock-${type}-invoice-` + randomHex64().slice(0, 16),
    invoice_token: {
      version: '2.0',
      genesis: {
        data: {
          tokenId: randomHex64(),
          tokenType: '00',
          coinData: [],
          tokenData: '{}',
          salt: randomHex64(),
          recipient: DEFAULT_TEST_ESCROW_ADDRESS,
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: {
            algorithm: 'secp256k1',
            publicKey: DEFAULT_TEST_ESCROW_PUBKEY,
            signature: randomHex64() + randomHex64(),
            stateHash: randomHex64(),
          },
          merkleTreePath: { root: randomHex64(), steps: [] },
          transactionHash: randomHex64(),
          unicityCertificate: randomHex64() + randomHex64() + randomHex64() + randomHex64(),
        },
      },
      state: { data: randomHex64(), predicate: randomHex64().slice(0, 64) },
      transactions: [],
    },
    payment_instructions: {
      your_currency: 'UCT',
      your_amount: '1000000',
      memo: `swap:${swapId}`,
    },
  };
  return JSON.stringify(payload);
}

/**
 * Create a mock escrow swap_cancelled DM content string.
 *
 * @param swapId - The swap ID.
 * @param reason - Cancellation reason (defaults to 'timeout').
 * @param depositsReturned - Whether deposits were returned.
 */
export function createMockSwapCancelledDM(
  swapId: string,
  reason?: string,
  depositsReturned?: boolean,
): string {
  const payload: EscrowSwapCancelled = {
    type: 'swap_cancelled',
    swap_id: swapId,
    reason: reason ?? 'timeout',
    deposits_returned: depositsReturned ?? true,
  };
  return JSON.stringify(payload);
}

/**
 * Create a mock escrow status_result DM content string.
 *
 * @param swapId - The swap ID.
 * @param state - The escrow state to report.
 */
export function createMockStatusResultDM(swapId: string, state: string): string {
  return JSON.stringify({
    type: 'status_result',
    swap_id: swapId,
    state,
  });
}

/**
 * Create a mock escrow payment_confirmation DM content string.
 *
 * @param swapId - The swap ID.
 * @param party - Which party's payment was confirmed.
 */
export function createMockPaymentConfirmationDM(swapId: string, party?: string): string {
  return JSON.stringify({
    type: 'payment_confirmation',
    swap_id: swapId,
    ...(party ? { party } : {}),
  });
}

/**
 * Create a mock escrow bounce_notification DM content string.
 *
 * @param swapId - The swap ID.
 * @param reason - Bounce reason.
 * @param returnedAmount - Amount returned.
 * @param returnedCurrency - Currency returned.
 */
export function createMockBounceNotificationDM(
  swapId: string,
  reason: string,
  returnedAmount: string,
  returnedCurrency: string,
): string {
  return JSON.stringify({
    type: 'bounce_notification',
    swap_id: swapId,
    reason,
    returned_amount: returnedAmount,
    returned_currency: returnedCurrency,
  });
}

/**
 * Create a mock escrow error DM content string.
 *
 * @param error - Error message.
 * @param swapId - Optional swap ID.
 */
export function createMockEscrowErrorDM(error: string, swapId?: string): string {
  return JSON.stringify({
    type: 'error',
    error,
    ...(swapId ? { swap_id: swapId } : {}),
  });
}
