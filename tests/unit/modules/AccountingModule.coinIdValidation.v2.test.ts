/**
 * AccountingModule — coinId validation coverage.
 *
 * Wave 6-P2-6b widened the createInvoice / importInvoice validators to
 * accept both v2 canonical coinIds (64-char lowercase hex) AND the legacy
 * v1 symbolic ids (up to 20 alphanumeric chars, e.g. "UCT", "USDU").
 *
 * The wave 6-P2-6 soak on testnet2 caught the v1-only reject when a real
 * testnet2 coinId flowed through `createInvoice`, so both forms had to
 * coexist during the migration window. This suite is the regression guard
 * so a future refactor doesn't silently narrow the accepted set.
 */

import { describe, it, expect, vi } from 'vitest';

import { AccountingModule } from '../../../modules/accounting/AccountingModule';
import type {
  AccountingModuleDependencies,
  CreateInvoiceRequest,
} from '../../../modules/accounting/types';
import type {
  FullIdentity,
  SphereEventType,
  SphereEventMap,
  TrackedAddress,
} from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { OracleProvider } from '../../../oracle';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants';

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

let seq = 0;
async function makeModule(): Promise<AccountingModule> {
  const identity: FullIdentity = {
    chainPubkey: '02' + 'a'.repeat(64),
    directAddress: 'DIRECT://self',
    privateKey: '0x' + 'b'.repeat(64),
  };
  const tracked: TrackedAddress[] = [
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
  const emitted: Array<{ type: SphereEventType; data: unknown }> = [];
  const emitEvent = <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
    emitted.push({ type, data });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = <T extends SphereEventType>(_type: T, _handler: any) => () => {};

  const engine = {
    mintDataToken: vi.fn(async () => {
      seq++;
      return { _tokenId: 'invoice-' + seq.toString(16).padStart(60, '0') };
    }),
    tokenId: vi.fn((t: { _tokenId: string }) => t._tokenId),
    // Wave 6-P2-18: envelope encoder for the v2
    // `SphereTokenPersistenceEntry` returned by createInvoice.
    encodeToken: vi.fn((t: { _tokenId: string }) => ({
      v: 1,
      network: 2,
      tokenId: t._tokenId,
      token: new Uint8Array([9, 9, 9, 9]),
    })),
  };

  const deps: AccountingModuleDependencies = {
    payments: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: vi.fn() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getHistory: vi.fn().mockReturnValue([]) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTokens: vi.fn().mockReturnValue([]) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    tokenStorage: {} as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oracle: {} as any as OracleProvider,
    trustBase: null,
    identity,
    getActiveAddresses: () => tracked,
    emitEvent,
    on,
    storage: makeStorage(),
    tokenEngine: engine,
  };
  const module = new AccountingModule({ debug: false });
  module.initialize(deps);
  await module.load();
  return module;
}

function req(coinId: string, amount = '100'): CreateInvoiceRequest {
  return {
    targets: [{ address: 'DIRECT://self', assets: [{ coin: [coinId, amount] }] }],
  };
}

describe('AccountingModule createInvoice — coinId validation', () => {
  it('ACCEPTS v2 canonical coinId (64-char lowercase hex)', async () => {
    const module = await makeModule();
    const coinId = 'a'.repeat(64);
    const result = await module.createInvoice(req(coinId));
    expect(result.success).toBe(true);
  });

  it('ACCEPTS the pinned INVOICE_TOKEN_TYPE_HEX as a coinId (64-char hex passes through)', async () => {
    const module = await makeModule();
    // This is the canonical shape a real testnet2 coinId takes.
    const result = await module.createInvoice(req(INVOICE_TOKEN_TYPE_HEX));
    expect(result.success).toBe(true);
  });

  it('ACCEPTS legacy short symbolic coinId (e.g. "UCT")', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('UCT'));
    expect(result.success).toBe(true);
  });

  it('ACCEPTS legacy 4-8 char alphanumeric coinIds', async () => {
    const module = await makeModule();
    for (const id of ['USDU', 'ALPHA', 'ETHX8']) {
      const result = await module.createInvoice(req(id));
      expect(result.success).toBe(true);
    }
  });

  it('REJECTS coinId containing special chars', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('BAD CHARS!'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid coinId/);
  });

  it('REJECTS coinId longer than 20 chars but shorter than 64 (neither legacy nor v2)', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('A'.repeat(30)));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid coinId/);
  });

  it('REJECTS coinId that is 64-char but includes uppercase (must be lowercase v2 hex)', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('A'.repeat(64)));
    // 64-char uppercase A: fails the v2 hex regex (requires lowercase); also
    // fails the legacy symbol regex (>20 chars). Widened validator: reject.
    expect(result.success).toBe(false);
  });

  it('REJECTS empty coinId', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req(''));
    expect(result.success).toBe(false);
  });

  it('REJECTS non-numeric amount', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('UCT', 'not-a-number'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid amount/);
  });

  it('REJECTS negative-looking amount (leading -)', async () => {
    const module = await makeModule();
    const result = await module.createInvoice(req('UCT', '-100'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid amount/);
  });
});
