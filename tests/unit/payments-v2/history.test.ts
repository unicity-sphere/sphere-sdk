// §5.9 History — read-through mapping + client POSTs with the dedup keys.

import { describe, it, expect, vi } from 'vitest';

import {
  History,
  type HistoryClient,
  type HistoryWireRecord,
} from '../../../modules/payments-v2/history/History';
import { encryptField, decryptField } from '../../../core/field-encryption';
import { FakeWalletApi, type FakeCaller, type HistoryRecordInput } from './fakes/FakeWalletApi';

const PUB = '02' + '11'.repeat(32);
const PEER = '03' + '22'.repeat(32);
const COIN = 'aa'.repeat(32);
const COIN2 = 'bb'.repeat(32);
const TOKEN = 'cc'.repeat(32);
const STATE_A = 'dd'.repeat(32);
const STATE_B = 'ee'.repeat(32);
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

const OWN_KEY = new Uint8Array(32).fill(7);
const FOREIGN_KEY = new Uint8Array(32).fill(9);

const registry = {
  getSymbol: (coinId: string) => (coinId === COIN ? 'UCT' : coinId === COIN2 ? 'USDU' : ''),
};

interface Harness {
  history: History;
  fake: FakeWalletApi;
  caller: FakeCaller;
  emit: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  postResults: { inserted: number; deduped: number }[];
  setFailPosts: (fail: boolean) => void;
  serverRecords: () => Promise<readonly HistoryRecordInput[]>;
}

function makeHarness(): Harness {
  const fake = new FakeWalletApi();
  const caller: FakeCaller = { chainPubkey: PUB, network: 'testnet' };
  const postResults: { inserted: number; deduped: number }[] = [];
  let failPosts = false;
  // Thin client-shaped adapter over the fake (structural HistoryClient).
  const client: HistoryClient = {
    listHistory: async (options) => {
      const page = await fake.listHistory(caller, options ?? {});
      return {
        records: page.records.map((r) => ({ ...r, assets: [...r.assets] })) as HistoryWireRecord[],
        more: page.more,
        cursor: page.cursor,
      };
    },
    postHistory: async (records) => {
      if (failPosts) throw new Error('wallet-api 503');
      const result = await fake.appendHistory(caller, records);
      postResults.push(result);
      return result;
    },
  };
  const emit = vi.fn();
  const log = vi.fn();
  const history = new History({ client, fieldKey: OWN_KEY, registry, emit, log, now: () => NOW });
  return {
    history,
    fake,
    caller,
    emit,
    log,
    postResults,
    setFailPosts: (fail) => {
      failPosts = fail;
    },
    serverRecords: async () => (await fake.listHistory(caller)).records,
  };
}

function stubHistory(records: HistoryWireRecord[], emit = vi.fn()): History {
  const client: HistoryClient = {
    listHistory: async () => ({ records, more: false, cursor: null }),
    postHistory: async () => ({ inserted: records.length, deduped: 0 }),
  };
  return new History({ client, fieldKey: OWN_KEY, registry, emit });
}

function wire(overrides: Partial<HistoryWireRecord>): HistoryWireRecord {
  return {
    dedupKey: overrides.dedupKey ?? `k-${Math.random()}`,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    type: overrides.type ?? 'SENT',
    assets: overrides.assets ?? [{ coinId: COIN, amount: '1000' }],
    ts: overrides.ts ?? '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('History §5.9 — read-through mapping', () => {
  it('maps wire ts to epoch-ms timestamp, including explicit-offset forms', async () => {
    const history = stubHistory([
      wire({ id: 'a'.repeat(8) + '-0000-4000-8000-000000000001', ts: '2026-03-01T10:00:00.000Z' }),
      wire({ id: 'b'.repeat(8) + '-0000-4000-8000-000000000002', ts: '2026-03-01T12:00:00.000+02:00' }),
      wire({ id: 'c'.repeat(8) + '-0000-4000-8000-000000000003', ts: '2026-03-01T04:30:00.000-05:30' }),
    ]);
    const page = await history.page();
    expect(page.entries.map((e) => e.timestamp)).toEqual([
      Date.UTC(2026, 2, 1, 10, 0, 0),
      Date.UTC(2026, 2, 1, 10, 0, 0),
      Date.UTC(2026, 2, 1, 10, 0, 0),
    ]);
  });

  it('enriches symbol from the injected registry by coinId', async () => {
    const history = stubHistory([
      wire({ assets: [{ coinId: COIN, amount: '5' }] }),
      wire({ assets: [{ coinId: COIN2, amount: '6' }] }),
    ]);
    const page = await history.page();
    expect(page.entries.map((e) => e.symbol)).toEqual(['UCT', 'USDU']);
  });

  it('maps a multi-asset record to the FIRST asset amount and surfaces all assets in tokenIds[]', async () => {
    const history = stubHistory([
      wire({
        assets: [
          { coinId: COIN, amount: '100' },
          { coinId: COIN2, amount: '250' },
        ],
      }),
    ]);
    const [entry] = (await history.page()).entries;
    expect(entry.coinId).toBe(COIN);
    expect(entry.amount).toBe('100');
    expect(entry.tokenIds).toEqual([
      { id: COIN, amount: '100' },
      { id: COIN2, amount: '250' },
    ]);
  });

  it('single-asset records carry no tokenIds[]', async () => {
    const history = stubHistory([wire({})]);
    const [entry] = (await history.page()).entries;
    expect(entry.tokenIds).toBeUndefined();
  });

  it('routes counterpartyPubkey/nametag by type: sender for RECEIVED, recipient otherwise', async () => {
    const nametag = encryptField(OWN_KEY, 'bob');
    const history = stubHistory([
      wire({ type: 'RECEIVED', counterpartyPubkey: PEER, counterpartyNametag: nametag }),
      wire({ type: 'SENT', counterpartyPubkey: PEER, counterpartyNametag: nametag }),
    ]);
    const [received, sent] = (await history.page()).entries;
    expect(received.senderPubkey).toBe(PEER);
    expect(received.senderNametag).toBe('bob');
    expect(received.recipientPubkey).toBeUndefined();
    expect(sent.recipientPubkey).toBe(PEER);
    expect(sent.recipientNametag).toBe('bob');
    expect(sent.senderPubkey).toBeUndefined();
  });

  it('decrypts self-scoped memo; a foreign or undecryptable envelope yields undefined, never throws', async () => {
    const history = stubHistory([
      wire({ memo: encryptField(OWN_KEY, 'coffee') }),
      wire({ memo: encryptField(FOREIGN_KEY, 'secret') }),
      wire({ memo: 'enc1.%%%not-base64%%%' }),
      wire({ memo: 'plaintext memo, no envelope' }),
      wire({ counterpartyNametag: encryptField(FOREIGN_KEY, 'eve'), type: 'RECEIVED' }),
    ]);
    const page = await history.page();
    expect(page.entries[0].memo).toBe('coffee');
    expect(page.entries[1].memo).toBeUndefined();
    expect(page.entries[2].memo).toBeUndefined();
    expect(page.entries[3].memo).toBeUndefined();
    expect(page.entries[4].senderNametag).toBeUndefined();
  });

  it('amounts above 2^64 survive the round trip as exact decimal strings', async () => {
    const big = (BigInt(2) ** BigInt(128)).toString();
    const h = makeHarness();
    await h.history.recordSent({ transferId: 'f0000000-0000-4000-8000-000000000001', coinId: COIN, amount: big });
    const [entry] = (await h.history.page()).entries;
    expect(entry.amount).toBe(big);
    expect(BigInt(entry.amount)).toBe(BigInt(2) ** BigInt(128));
  });

  it('passes before/limit through and pages by the server keyset cursor', async () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) {
      await h.history.recordMint({ tokenId: `${i}${i}`.repeat(32), coinId: COIN, amount: '1', timestamp: NOW + i * 1000 });
    }
    const first = await h.history.page({ limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.more).toBe(true);
    expect(first.cursor).not.toBeNull();
    expect(first.entries[0].timestamp).toBeGreaterThan(first.entries[1].timestamp);
    const second = await h.history.page({ before: first.cursor!, limit: 2 });
    expect(second.entries).toHaveLength(2);
    expect(second.entries[0].timestamp).toBeLessThan(first.entries[1].timestamp);
  });
});

describe('History §5.9 — client POSTs and dedup keys', () => {
  it('SENT dedup key is the transferId — a resumed re-POST is a server no-op (one record)', async () => {
    const h = makeHarness();
    const transferId = 'a1111111-1111-4111-8111-111111111111';
    await h.history.recordSent({ transferId, coinId: COIN, amount: '100' });
    await h.history.recordSent({ transferId, coinId: COIN, amount: '100' });
    expect(h.postResults).toEqual([
      { inserted: 1, deduped: 0 },
      { inserted: 0, deduped: 1 },
    ]);
    const records = await h.serverRecords();
    expect(records).toHaveLength(1);
    expect(records[0].dedupKey).toBe(transferId);
  });

  it('RECEIVED dedup key is per (tokenId, stateHash): an A→B→A round-trip yields two records', async () => {
    const h = makeHarness();
    await h.history.recordReceived({ tokenId: TOKEN, stateHash: STATE_A, coinId: COIN, amount: '10' });
    await h.history.recordReceived({ tokenId: TOKEN, stateHash: STATE_B, coinId: COIN, amount: '10' });
    const records = await h.serverRecords();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.dedupKey))).toEqual(
      new Set([`RECEIVED:${TOKEN}:${STATE_A}`, `RECEIVED:${TOKEN}:${STATE_B}`])
    );
    // Redelivery of the same leg stays one record.
    await h.history.recordReceived({ tokenId: TOKEN, stateHash: STATE_A, coinId: COIN, amount: '10' });
    expect(await h.serverRecords()).toHaveLength(2);
  });

  it('MINT dedup key is MINT:tokenId — a replayed mint yields one record, lowercased on the wire', async () => {
    const h = makeHarness();
    const upper = 'CC'.repeat(32);
    await h.history.recordMint({ tokenId: upper, coinId: COIN, amount: '7' });
    await h.history.recordMint({ tokenId: upper, coinId: COIN, amount: '7' });
    const records = await h.serverRecords();
    expect(records).toHaveLength(1);
    expect(records[0].dedupKey).toBe(`MINT:${TOKEN}`);
    expect(records[0].tokenId).toBe(TOKEN);
  });

  it('a failed POST logs and resolves — it never throws into the money path and never emits', async () => {
    const h = makeHarness();
    h.setFailPosts(true);
    await expect(
      h.history.recordSent({ transferId: 'b2222222-2222-4222-8222-222222222222', coinId: COIN, amount: '1' })
    ).resolves.toBeUndefined();
    await expect(
      h.history.recordReceived({ tokenId: TOKEN, stateHash: STATE_A, coinId: COIN, amount: '1' })
    ).resolves.toBeUndefined();
    await expect(h.history.recordMint({ tokenId: TOKEN, coinId: COIN, amount: '1' })).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalledTimes(3);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('emits history:updated after each successful POST, carrying the recorded client-shaped entry', async () => {
    const h = makeHarness();
    await h.history.recordSent({ transferId: 'c3333333-3333-4333-8333-333333333333', coinId: COIN, amount: '1' });
    await h.history.recordReceived({ tokenId: TOKEN, stateHash: STATE_A, coinId: COIN, amount: '1' });
    await h.history.recordMint({ tokenId: TOKEN, coinId: COIN, amount: '1' });
    expect(h.emit).toHaveBeenCalledTimes(3);
    expect(h.emit.mock.calls.map((c) => [c[0], (c[1] as { type: string }).type])).toEqual([
      ['history:updated', 'SENT'],
      ['history:updated', 'RECEIVED'],
      ['history:updated', 'MINT'],
    ]);
  });

  it('a typed subscriber receives an entry it can dereference: decrypted memo/nametag, symbol, epoch-ms timestamp — the same mapping page() serves', async () => {
    const h = makeHarness();
    await h.history.recordSent({
      transferId: 'f6666666-6666-4666-8666-666666666666',
      coinId: COIN,
      amount: '450',
      memo: 'lunch',
      recipientPubkey: PEER,
      recipientNametag: 'bob',
    });
    const [event, entry] = h.emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('history:updated');
    expect(entry).toMatchObject({
      type: 'SENT',
      coinId: COIN,
      amount: '450',
      symbol: 'UCT',
      timestamp: NOW,
      transferId: 'f6666666-6666-4666-8666-666666666666',
      memo: 'lunch', // decrypted — never the enc1. wire envelope
      recipientPubkey: PEER,
      recipientNametag: 'bob',
    });
    // Identical to what the read-through serves for the same record.
    const [paged] = (await h.history.page()).entries;
    expect(entry).toEqual(paged);
  });

  it('encrypts memo and counterparty nametag before POST (enc1. on the wire, decrypted on read-through)', async () => {
    const h = makeHarness();
    await h.history.recordSent({
      transferId: 'd4444444-4444-4444-8444-444444444444',
      coinId: COIN,
      amount: '9',
      memo: 'order #42',
      recipientPubkey: PEER,
      recipientNametag: 'bob',
    });
    const [raw] = await h.serverRecords();
    expect(String(raw.memo).startsWith('enc1.')).toBe(true);
    expect(String(raw.counterpartyNametag).startsWith('enc1.')).toBe(true);
    expect(decryptField(OWN_KEY, String(raw.memo))).toBe('order #42');
    expect(decryptField(OWN_KEY, String(raw.counterpartyNametag))).toBe('bob');
    const [entry] = (await h.history.page()).entries;
    expect(entry.memo).toBe('order #42');
    expect(entry.recipientNametag).toBe('bob');
    expect(entry.recipientPubkey).toBe(PEER);
  });

  it('a counterparty that is not a compressed pubkey stays off the strict wire', async () => {
    const h = makeHarness();
    await h.history.recordSent({
      transferId: 'e5555555-5555-4555-8555-555555555555',
      coinId: COIN,
      amount: '2',
      recipientPubkey: '@bob',
      recipientNametag: 'bob',
    });
    const [raw] = await h.serverRecords();
    expect(raw.counterpartyPubkey).toBeUndefined();
    expect(String(raw.counterpartyNametag).startsWith('enc1.')).toBe(true);
  });
});
