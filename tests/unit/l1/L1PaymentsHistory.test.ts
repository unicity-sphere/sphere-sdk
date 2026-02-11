/**
 * Tests for L1PaymentsModule.getHistory()
 *
 * Covers the transaction classification logic that determines send vs receive
 * by resolving input addresses from previous transactions.
 *
 * Bug fix: The old code checked `vin.txid` (a transaction hash) against wallet
 * addresses, which never matched. The fix resolves vin inputs by looking up
 * the previous transaction's output to get the actual address.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the entire network module before importing the module under test
vi.mock('../../../l1/network', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn(() => true),
  getBalance: vi.fn(() => ({ confirmed: 0, unconfirmed: 0 })),
  getUtxo: vi.fn(() => []),
  getTransactionHistory: vi.fn(() => []),
  getTransaction: vi.fn(() => null),
  getCurrentBlockHeight: vi.fn(() => 100000),
  sendAlpha: vi.fn(),
  createTransactionPlan: vi.fn(),
  vestingClassifier: { initDB: vi.fn(), classifyUtxos: vi.fn(() => ({ vested: [], unvested: [] })) },
  VESTING_THRESHOLD: 280000,
}));

import {
  getTransactionHistory,
  getTransaction as l1GetTransaction,
  getCurrentBlockHeight,
} from '../../../l1/network';
import type { TransactionDetail } from '../../../l1/network';
import { L1PaymentsModule } from '../../../modules/payments/L1PaymentsModule';
import type { FullIdentity } from '../../../types';

// =============================================================================
// Helpers
// =============================================================================

const WALLET_ADDR = 'alpha1qwallet_addr_ours_aaa';
const CHANGE_ADDR = 'alpha1qchange_addr_ours_bbb';
const EXTERNAL_ADDR = 'alpha1qexternal_addr_ccc';

function makeTxDetail(overrides: Partial<TransactionDetail> & Pick<TransactionDetail, 'txid' | 'vin' | 'vout'>): TransactionDetail {
  return {
    version: 1,
    locktime: 0,
    time: 1700000000,
    ...overrides,
  };
}

function makeOutput(address: string, value: number, n = 0) {
  return {
    value,
    n,
    scriptPubKey: { hex: '', type: 'pubkeyhash', address },
  };
}

/** Creates a module initialized with our wallet addresses. */
async function createModule(addresses: string[] = [WALLET_ADDR, CHANGE_ADDR]): Promise<L1PaymentsModule> {
  const mod = new L1PaymentsModule({ enableVesting: false });
  const fakeIdentity: FullIdentity = {
    privateKey: '0'.repeat(64),
    chainPubkey: '02' + '0'.repeat(64),
    l1Address: addresses[0],
    nametag: undefined,
    nametagSignature: undefined,
    addressIndex: 0,
  } as unknown as FullIdentity;

  await mod.initialize({
    identity: fakeIdentity,
    addresses: addresses.slice(1),
  });
  return mod;
}

// =============================================================================
// Tests
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentBlockHeight).mockResolvedValue(100000);
});

describe('L1PaymentsModule.getHistory()', () => {
  describe('receive transactions', () => {
    it('classifies as receive when inputs are from external addresses', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_tx_external',
        vin: [],
        vout: [makeOutput(EXTERNAL_ADDR, 5.0)],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_receive',
        vin: [{ txid: 'prev_tx_external', vout: 0, sequence: 0xffffffff }],
        vout: [makeOutput(WALLET_ADDR, 0.001)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_receive', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_receive') return mainTx;
        if (txid === 'prev_tx_external') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('receive');
      expect(result[0].amount).toBe('100000'); // 0.001 * 1e8
      expect(result[0].address).toBe(WALLET_ADDR);
    });

    it('sums all outputs to our addresses for receive amount', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_ext',
        vin: [],
        vout: [makeOutput(EXTERNAL_ADDR, 10.0)],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_multi_recv',
        vin: [{ txid: 'prev_ext', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(WALLET_ADDR, 0.005, 0),
          makeOutput(CHANGE_ADDR, 0.003, 1),
          makeOutput(EXTERNAL_ADDR, 9.992, 2), // change back to sender
        ],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_multi_recv', height: 60000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_multi_recv') return mainTx;
        if (txid === 'prev_ext') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result[0].type).toBe('receive');
      expect(result[0].amount).toBe('800000'); // (0.005 + 0.003) * 1e8
    });
  });

  describe('send transactions', () => {
    it('classifies as send when input comes from our address', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_ours',
        vin: [],
        vout: [makeOutput(WALLET_ADDR, 1.0)],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_send',
        vin: [{ txid: 'prev_ours', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(EXTERNAL_ADDR, 0.0001, 0), // amount sent
          makeOutput(WALLET_ADDR, 0.9998, 1),    // change back
        ],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_send', height: 70000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_send') return mainTx;
        if (txid === 'prev_ours') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('send');
      expect(result[0].amount).toBe('10000'); // 0.0001 * 1e8
      expect(result[0].address).toBe(EXTERNAL_ADDR);
    });

    it('classifies as send when input comes from change address', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_change',
        vin: [],
        vout: [makeOutput(CHANGE_ADDR, 0.5)],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_send_from_change',
        vin: [{ txid: 'prev_change', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(EXTERNAL_ADDR, 0.002, 0),
          makeOutput(WALLET_ADDR, 0.4979, 1),
        ],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_send_from_change', height: 80000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_send_from_change') return mainTx;
        if (txid === 'prev_change') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result[0].type).toBe('send');
      expect(result[0].amount).toBe('200000');
    });

    it('amount excludes change: only counts outputs to external addresses', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_big',
        vin: [],
        vout: [makeOutput(WALLET_ADDR, 2.0)],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_send_multi',
        vin: [{ txid: 'prev_big', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(EXTERNAL_ADDR, 0.01, 0),
          makeOutput('alpha1qanother_external', 0.005, 1),
          makeOutput(CHANGE_ADDR, 1.984, 2), // change
        ],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_send_multi', height: 90000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_send_multi') return mainTx;
        if (txid === 'prev_big') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result[0].type).toBe('send');
      expect(result[0].amount).toBe('1500000'); // (0.01 + 0.005) * 1e8
    });
  });

  describe('edge cases', () => {
    it('handles unresolvable previous tx gracefully (treats as receive)', async () => {
      const mainTx = makeTxDetail({
        txid: 'tx_unknown_input',
        vin: [{ txid: 'unknown_prev', vout: 0, sequence: 0xffffffff }],
        vout: [makeOutput(WALLET_ADDR, 0.01)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_unknown_input', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_unknown_input') return mainTx;
        return null; // can't resolve prev tx
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result[0].type).toBe('receive');
      expect(result[0].amount).toBe('1000000');
    });

    it('uses correct vin.vout index to find the right previous output', async () => {
      // Previous tx has two outputs: index 0 = external, index 1 = ours
      const prevTx = makeTxDetail({
        txid: 'prev_multi_vout',
        vin: [],
        vout: [
          makeOutput(EXTERNAL_ADDR, 1.0, 0),
          makeOutput(WALLET_ADDR, 2.0, 1),
        ],
      });

      // Spending vout index 1 (ours) → should be classified as send
      const sendTx = makeTxDetail({
        txid: 'tx_spend_ours',
        vin: [{ txid: 'prev_multi_vout', vout: 1, sequence: 0xffffffff }],
        vout: [makeOutput(EXTERNAL_ADDR, 1.999)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_spend_ours', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_spend_ours') return sendTx;
        if (txid === 'prev_multi_vout') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();
      expect(result[0].type).toBe('send');
    });

    it('spending external vout from same prev tx is receive', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_multi_vout2',
        vin: [],
        vout: [
          makeOutput(EXTERNAL_ADDR, 1.0, 0),
          makeOutput(WALLET_ADDR, 2.0, 1),
        ],
      });

      // Spending vout index 0 (external) → not our input → receive
      const recvTx = makeTxDetail({
        txid: 'tx_spend_external',
        vin: [{ txid: 'prev_multi_vout2', vout: 0, sequence: 0xffffffff }],
        vout: [makeOutput(WALLET_ADDR, 0.999)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_spend_external', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_spend_external') return recvTx;
        if (txid === 'prev_multi_vout2') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();
      expect(result[0].type).toBe('receive');
    });

    it('handles scriptPubKey.addresses array format', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_arr',
        vin: [],
        vout: [{
          value: 1.0,
          n: 0,
          scriptPubKey: { hex: '', type: 'pubkeyhash', addresses: [WALLET_ADDR] },
        }],
      });

      const mainTx = makeTxDetail({
        txid: 'tx_arr_fmt',
        vin: [{ txid: 'prev_arr', vout: 0, sequence: 0xffffffff }],
        vout: [{
          value: 0.5,
          n: 0,
          scriptPubKey: { hex: '', type: 'pubkeyhash', addresses: [EXTERNAL_ADDR] },
        }],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_arr_fmt', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_arr_fmt') return mainTx;
        if (txid === 'prev_arr') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();
      expect(result[0].type).toBe('send');
    });

    it('deduplicates transactions across multiple addresses', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_dedup',
        vin: [],
        vout: [makeOutput(EXTERNAL_ADDR, 5.0)],
      });

      // This tx sends to both our addresses
      const mainTx = makeTxDetail({
        txid: 'tx_dedup',
        vin: [{ txid: 'prev_dedup', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(WALLET_ADDR, 0.001, 0),
          makeOutput(CHANGE_ADDR, 0.002, 1),
        ],
      });

      // getTransactionHistory returns this tx for BOTH addresses
      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_dedup', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_dedup') return mainTx;
        if (txid === 'prev_dedup') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      // Should appear only once despite being in history for both addresses
      expect(result).toHaveLength(1);
    });

    it('respects limit parameter', async () => {
      const prevTx = makeTxDetail({
        txid: 'prev_limit',
        vin: [],
        vout: [makeOutput(EXTERNAL_ADDR, 10.0)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_a', height: 50000 },
        { tx_hash: 'tx_b', height: 50001 },
        { tx_hash: 'tx_c', height: 50002 },
      ]);

      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'prev_limit') return prevTx;
        return makeTxDetail({
          txid,
          vin: [{ txid: 'prev_limit', vout: 0, sequence: 0xffffffff }],
          vout: [makeOutput(WALLET_ADDR, 0.001)],
        });
      });

      const mod = await createModule();
      const result = await mod.getHistory(2);
      expect(result).toHaveLength(2);
    });
  });

  describe('tx cache', () => {
    it('caches previous tx lookups (does not re-fetch same txid)', async () => {
      const sharedPrevTxId = 'shared_prev';
      const prevTx = makeTxDetail({
        txid: sharedPrevTxId,
        vin: [],
        vout: [makeOutput(EXTERNAL_ADDR, 10.0)],
      });

      const tx1 = makeTxDetail({
        txid: 'tx1',
        vin: [{ txid: sharedPrevTxId, vout: 0, sequence: 0xffffffff }],
        vout: [makeOutput(WALLET_ADDR, 0.001)],
      });
      const tx2 = makeTxDetail({
        txid: 'tx2',
        vin: [{ txid: sharedPrevTxId, vout: 0, sequence: 0xffffffff }],
        vout: [makeOutput(WALLET_ADDR, 0.002)],
      });

      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx1', height: 50000 },
        { tx_hash: 'tx2', height: 50001 },
      ]);

      const mockGetTx = vi.mocked(l1GetTransaction);
      mockGetTx.mockImplementation(async (txid: string) => {
        if (txid === 'tx1') return tx1;
        if (txid === 'tx2') return tx2;
        if (txid === sharedPrevTxId) return prevTx;
        return null;
      });

      const mod = await createModule();
      await mod.getHistory();

      // shared_prev should only be fetched once (cached on second use)
      const sharedCalls = mockGetTx.mock.calls.filter(([id]) => id === sharedPrevTxId);
      expect(sharedCalls).toHaveLength(1);
    });
  });

  describe('regression: vin.txid is NOT an address', () => {
    it('old bug: comparing vin.txid to addresses always yields receive', async () => {
      // Demonstrates the old bug: vin.txid is a tx hash, not an address.
      // The old code did: addresses.includes(vin.txid) which is always false.
      const prevTx = makeTxDetail({
        txid: 'aabbccdd',
        vin: [],
        vout: [makeOutput(WALLET_ADDR, 1.0)],
      });

      const sendTx = makeTxDetail({
        txid: 'tx_regression',
        vin: [{ txid: 'aabbccdd', vout: 0, sequence: 0xffffffff }],
        vout: [
          makeOutput(EXTERNAL_ADDR, 0.0001, 0),
          makeOutput(WALLET_ADDR, 0.9998, 1),
        ],
      });

      // Prove the old logic was wrong
      const addresses = [WALLET_ADDR, CHANGE_ADDR];
      const buggyIsSend = sendTx.vin.some((vin) => addresses.includes(vin.txid ?? ''));
      expect(buggyIsSend).toBe(false); // Old bug: always false

      // Now test the actual fixed module
      vi.mocked(getTransactionHistory).mockResolvedValue([
        { tx_hash: 'tx_regression', height: 50000 },
      ]);
      vi.mocked(l1GetTransaction).mockImplementation(async (txid: string) => {
        if (txid === 'tx_regression') return sendTx;
        if (txid === 'aabbccdd') return prevTx;
        return null;
      });

      const mod = await createModule();
      const result = await mod.getHistory();

      expect(result[0].type).toBe('send'); // Fixed!
      expect(result[0].amount).toBe('10000');
      expect(result[0].address).toBe(EXTERNAL_ADDR);
    });
  });
});
