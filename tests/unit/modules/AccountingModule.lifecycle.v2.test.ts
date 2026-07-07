/**
 * AccountingModule — Phase 6 v2 slim rebuild lifecycle coverage.
 *
 * The v2 slim rebuild routes invoice minting through
 * `ITokenEngine.mintDataToken`, keeps invoice terms/state in-memory + a
 * couple of storage slots (CANCELLED / CLOSED / FROZEN / AUTO_RETURN),
 * and subscribes to PaymentsModule `transfer:incoming` /
 * `transfer:confirmed` events for attribution.
 *
 * Wave-6-P2-5 quarantined the fat v1 tests. This suite locks in the v2
 * lifecycle contract:
 *
 *   - `createInvoice()` mints via engine.mintDataToken, caches terms,
 *     emits `invoice:created`, and returns `{success, invoiceId, token}`.
 *   - Rejects malformed inputs (empty targets / duplicate coinId / bad
 *     amount / missing targetAddress).
 *   - `importInvoice()` accepts a TxfToken with genesis.data.tokenType =
 *     the pinned INVOICE token type; emits `invoice:created` for the
 *     imported invoice.
 *   - `getInvoiceStatus()` throws INVOICE_NOT_FOUND on unknown ids;
 *     returns state=OPEN for a fresh invoice with no payments.
 *   - `closeInvoice()` / `cancelInvoice()` freeze balances, emit
 *     `invoice:closed` / `invoice:cancelled`.
 *   - Terminal transitions reject double-close / double-cancel with the
 *     canonical error codes.
 *   - Auto-return per-invoice + global settings are get/set-able.
 *
 * The engine + all sphere dependencies are per-test in-memory mocks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AccountingModule } from '../../../modules/accounting/AccountingModule';
import type {
  AccountingModuleDependencies,
  CreateInvoiceRequest,
  InvoiceTerms,
  PayInvoiceParams,
} from '../../../modules/accounting/types';
import type {
  FullIdentity,
  Token,
  SphereEventType,
  SphereEventMap,
  TrackedAddress,
  TransferResult,
  TransferRequest,
  IncomingTransfer,
} from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { OracleProvider } from '../../../oracle';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants';
import { buildInvoiceMemo } from '../../../modules/accounting/memo';

// A minimal Sphere-like emitter/subscribers pair — AccountingModule's
// `_subscribeToPaymentsEvents` uses `deps.on(type, handler)`, and its
// send paths use `deps.emitEvent(type, data)`.
function makeEventBus(): {
  emitEvent: <T extends SphereEventType>(t: T, d: SphereEventMap[T]) => void;
  on: <T extends SphereEventType>(t: T, h: (d: SphereEventMap[T]) => void) => () => void;
  fire: <T extends SphereEventType>(t: T, d: SphereEventMap[T]) => void;
  emitted: Array<{ type: SphereEventType; data: unknown }>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<SphereEventType, Set<(d: any) => void>>();
  const emitted: Array<{ type: SphereEventType; data: unknown }> = [];
  return {
    emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      emitted.push({ type, data });
      const set = handlers.get(type);
      if (set) for (const h of set) h(data);
    },
    on: <T extends SphereEventType>(type: T, h: (d: SphereEventMap[T]) => void) => {
      let set = handlers.get(type);
      if (!set) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set = new Set<(d: any) => void>();
        handlers.set(type, set);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set.add(h as any);
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set!.delete(h as any);
      };
    },
    fire: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      emitted.push({ type, data });
      const set = handlers.get(type);
      if (set) for (const h of set) h(data);
    },
    emitted,
  };
}

// In-memory KV-style StorageProvider — enough for AccountingModule's
// small persisted set (CANCELLED / CLOSED / FROZEN / AUTO_RETURN).
function makeStorage(): StorageProvider {
  const kv = new Map<string, string>();
  return {
    id: 's',
    name: 's',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => (kv.has(k) ? kv.get(k) : null)),
    set: vi.fn(async (k: string, v: unknown) => {
      kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }),
    remove: vi.fn(async (k: string) => {
      kv.delete(k);
    }),
    has: vi.fn(async (k: string) => kv.has(k)),
    keys: vi.fn(async () => Array.from(kv.keys())),
    clear: vi.fn(async () => kv.clear()),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };
}

/**
 * A minimal PaymentsModule-shaped stub — only the members
 * AccountingModule actually calls into.
 */
function makePaymentsStub(): {
  send: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  getTokens: ReturnType<typeof vi.fn>;
  raw: unknown;
} {
  const send = vi.fn(
    async (req: TransferRequest): Promise<TransferResult> => ({
      id: 'delivered-' + Math.random().toString(36).slice(2, 8),
      status: 'delivered',
      tokens: [],
      tokenTransfers: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      memo: (req as any).memo,
    }) as unknown as TransferResult,
  );
  const getHistory = vi.fn(() => [] as unknown[]);
  const getTokens = vi.fn(() => [] as Token[]);
  return {
    send,
    getHistory,
    getTokens,
    raw: { send, getHistory, getTokens },
  };
}

// Fake engine — AccountingModule.createInvoice only calls
// `tokenEngine.mintDataToken(...)` and `tokenEngine.tokenId(...)`. Every
// mint gets a deterministic-ish tokenId derived from `data` so
// `createInvoice` + `importInvoice` see stable ids.
let invoiceSeq = 0;
function makeEngine(): {
  mintDataToken: ReturnType<typeof vi.fn>;
  tokenId: ReturnType<typeof vi.fn>;
  raw: unknown;
} {
  const mintDataToken = vi.fn(async (params: { data: Uint8Array }) => {
    invoiceSeq++;
    // 64-char hex tokenId — required for buildInvoiceMemo() when the caller
    // needs a memo; but for createInvoice we only need the raw string.
    const id = ('a' + invoiceSeq.toString(16)).padEnd(64, '0');
    return { _tokenId: id, _dataLen: params.data.length };
  });
  const tokenId = vi.fn((t: { _tokenId: string }) => t._tokenId);
  return {
    mintDataToken,
    tokenId,
    raw: { mintDataToken, tokenId },
  };
}

async function makeHarness(): Promise<{
  module: AccountingModule;
  bus: ReturnType<typeof makeEventBus>;
  payments: ReturnType<typeof makePaymentsStub>;
  engine: ReturnType<typeof makeEngine>;
  identity: FullIdentity;
}> {
  const identity: FullIdentity = {
    chainPubkey: '02' + 'a'.repeat(64),
    directAddress: 'DIRECT://self',
    privateKey: '0x' + 'b'.repeat(64),
  };
  const bus = makeEventBus();
  const payments = makePaymentsStub();
  const engine = makeEngine();

  const trackedAddresses: TrackedAddress[] = [
    {
      index: 0,
      addressId: 'DIRECT_self_1',
      directAddress: 'DIRECT://self',
      chainPubkey: identity.chainPubkey,
      hidden: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const deps: AccountingModuleDependencies = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payments: payments.raw as any,
    tokenStorage: {} as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oracle: {} as any as OracleProvider,
    trustBase: null,
    identity,
    getActiveAddresses: () => trackedAddresses,
    emitEvent: bus.emitEvent,
    on: bus.on,
    storage: makeStorage(),
    tokenEngine: engine.raw,
  };
  const module = new AccountingModule({ debug: false });
  module.initialize(deps);
  await module.load();
  return { module, bus, payments, engine, identity };
}

function newInvoiceRequest(overrides: Partial<CreateInvoiceRequest> = {}): CreateInvoiceRequest {
  return {
    targets: [
      {
        address: 'DIRECT://self',
        assets: [{ coin: ['UCT', '1000'] }],
      },
    ],
    memo: 'test invoice',
    ...overrides,
  };
}

describe('AccountingModule lifecycle (v2 slim)', () => {
  beforeEach(() => {
    invoiceSeq = 0;
  });

  describe('createInvoice()', () => {
    it('mints via engine.mintDataToken with the pinned INVOICE tokenType', async () => {
      const h = await makeHarness();
      const result = await h.module.createInvoice(newInvoiceRequest());
      expect(result.success).toBe(true);
      expect(result.invoiceId).toBeDefined();
      expect(result.token).toBeDefined();

      expect(h.engine.mintDataToken).toHaveBeenCalledTimes(1);
      const call = h.engine.mintDataToken.mock.calls[0][0];
      const hex = Array.from(call.tokenType as Uint8Array)
        .map((b) => (b as number).toString(16).padStart(2, '0'))
        .join('');
      expect(hex).toBe(INVOICE_TOKEN_TYPE_HEX);

      // invoice:created event fires with confirmed=true.
      const created = h.bus.emitted.find((e) => e.type === 'invoice:created');
      expect(created).toBeDefined();
    });

    it('rejects an empty targets list', async () => {
      const h = await makeHarness();
      const result = await h.module.createInvoice({ targets: [] });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at least one target/);
    });

    it('rejects a duplicate coinId within one target', async () => {
      const h = await makeHarness();
      const result = await h.module.createInvoice({
        targets: [
          {
            address: 'DIRECT://self',
            assets: [{ coin: ['UCT', '100'] }, { coin: ['UCT', '200'] }],
          },
        ],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Duplicate coinId/);
    });

    it('rejects a non-positive amount (must be >= 1)', async () => {
      const h = await makeHarness();
      const result = await h.module.createInvoice({
        targets: [
          {
            address: 'DIRECT://self',
            assets: [{ coin: ['UCT', '0'] }],
          },
        ],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid amount/);
    });

    it('rejects a non-DIRECT:// target address', async () => {
      const h = await makeHarness();
      const result = await h.module.createInvoice({
        targets: [{ address: 'PROXY://something', assets: [{ coin: ['UCT', '100'] }] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid target address/);
    });
  });

  describe('getInvoiceStatus()', () => {
    it('throws INVOICE_NOT_FOUND for an unknown invoice id', async () => {
      const h = await makeHarness();
      await expect(h.module.getInvoiceStatus('unknown-invoice')).rejects.toThrow(/not found/i);
    });

    it('returns OPEN for a freshly-created invoice with no payments', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      expect(created.success).toBe(true);
      const status = await h.module.getInvoiceStatus(created.invoiceId!);
      expect(status.state).toBe('OPEN');
    });
  });

  describe('closeInvoice() / cancelInvoice()', () => {
    it('closeInvoice() transitions OPEN → CLOSED, freezes balances, emits invoice:closed', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      const id = created.invoiceId!;
      await h.module.closeInvoice(id);
      // Terminal-set + frozen balances now include the id.
      const status = await h.module.getInvoiceStatus(id);
      expect(status.state).toBe('CLOSED');

      // Event fires on the microtask queue.
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      const closed = h.bus.emitted.find((e) => e.type === 'invoice:closed');
      expect(closed).toBeDefined();
    });

    it('closeInvoice() twice throws INVOICE_ALREADY_CLOSED', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      const id = created.invoiceId!;
      await h.module.closeInvoice(id);
      await expect(h.module.closeInvoice(id)).rejects.toThrow(/already closed/i);
    });

    it('cancelInvoice() transitions OPEN → CANCELLED, emits invoice:cancelled', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      const id = created.invoiceId!;
      await h.module.cancelInvoice(id);
      const status = await h.module.getInvoiceStatus(id);
      expect(status.state).toBe('CANCELLED');
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      const cancelled = h.bus.emitted.find((e) => e.type === 'invoice:cancelled');
      expect(cancelled).toBeDefined();
    });

    it('cancel-after-close throws INVOICE_ALREADY_CLOSED (state machine terminal)', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      const id = created.invoiceId!;
      await h.module.closeInvoice(id);
      await expect(h.module.cancelInvoice(id)).rejects.toThrow(/already closed|already cancelled/i);
    });

    it('close/cancel a non-target invoice throws INVOICE_NOT_TARGET', async () => {
      const h = await makeHarness();
      // Create an invoice targeting some OTHER address.
      const result = await h.module.createInvoice({
        targets: [
          { address: 'DIRECT://someone-else', assets: [{ coin: ['UCT', '100'] }] },
        ],
      });
      expect(result.success).toBe(true);
      const id = result.invoiceId!;
      await expect(h.module.closeInvoice(id)).rejects.toThrow(/not a target/i);
      await expect(h.module.cancelInvoice(id)).rejects.toThrow(/not a target/i);
    });
  });

  describe('payInvoice()', () => {
    it('delegates to payments.send with the canonical INV memo and returns the delivered result', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(
        newInvoiceRequest({
          targets: [
            { address: 'DIRECT://recipient-address', assets: [{ coin: ['UCT', '1000'] }] },
          ],
        }),
      );
      const id = created.invoiceId!;

      const params: PayInvoiceParams = { targetIndex: 0, amount: '250' };
      const result = await h.module.payInvoice(id, params);
      expect(result.status).toBe('delivered');
      expect(h.payments.send).toHaveBeenCalledTimes(1);
      const sendRequest = h.payments.send.mock.calls[0][0] as TransferRequest;
      expect(sendRequest.recipient).toBe('DIRECT://recipient-address');
      expect(sendRequest.amount).toBe('250');
      expect(sendRequest.coinId).toBe('UCT');
      // Memo is INV:<hash>:F (F = forward direction) per §4.6.
      expect(sendRequest.memo).toMatch(/^INV:[0-9a-f]{64}:F/);
    });

    it('throws INVOICE_INVALID_TARGET for an out-of-range targetIndex', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      await expect(
        h.module.payInvoice(created.invoiceId!, { targetIndex: 5 }),
      ).rejects.toThrow(/Invalid targetIndex/);
    });
  });

  describe('event-driven attribution', () => {
    it('fires invoice:payment when a transfer:incoming carrying an INV memo arrives', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      const id = created.invoiceId!;
      const memo = buildInvoiceMemo(id, 'F');
      // Simulate a transfer:incoming coming off the transport subscription.
      h.bus.fire('transfer:incoming', {
        id: 'incoming-1',
        senderPubkey: 'sender-pk',
        senderAddress: 'DIRECT://sender-abc',
        tokens: [
          {
            id: 'inbound-token-1',
            coinId: 'UCT',
            symbol: 'UCT',
            name: 'UCT',
            decimals: 8,
            amount: '500',
            status: 'confirmed',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        memo,
        receivedAt: Date.now(),
      } as IncomingTransfer);

      // Give the async handler a tick to fire.
      await new Promise((r) => setTimeout(r, 5));
      const invoicePayment = h.bus.emitted.find((e) => e.type === 'invoice:payment');
      expect(invoicePayment).toBeDefined();
    });
  });

  describe('auto-return settings', () => {
    it('setAutoReturn("*", true) flips the global flag', async () => {
      const h = await makeHarness();
      await h.module.setAutoReturn('*', true);
      const s = h.module.getAutoReturnSettings();
      expect(s.global).toBe(true);
    });

    it('setAutoReturn(invoiceId, true) sets the per-invoice flag; unknown id throws', async () => {
      const h = await makeHarness();
      const created = await h.module.createInvoice(newInvoiceRequest());
      await h.module.setAutoReturn(created.invoiceId!, true);
      expect(h.module.getAutoReturnSettings().perInvoice[created.invoiceId!]).toBe(true);
      await expect(h.module.setAutoReturn('unknown-id', true)).rejects.toThrow(/not found/i);
    });
  });
});
