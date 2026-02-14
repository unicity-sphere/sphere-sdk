/**
 * Tests for l1/tx.ts
 * Covers transaction building functions (pure functions only, no network calls)
 */

import { describe, it, expect } from 'vitest';
import {
  createScriptPubKey,
  buildSegWitTransaction,
  collectUtxosForAmount,
} from '../../../l1/tx';
import { encodeBech32 } from '../../../core/bech32';
import elliptic from 'elliptic';

const ec = new elliptic.ec('secp256k1');

// =============================================================================
// Test Fixtures
// =============================================================================

// Create test addresses
const testProgram1 = new Uint8Array([
  0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23,
  0xf1, 0x43, 0x3b, 0xd6,
]);
const testProgram2 = new Uint8Array(20).fill(0xab);

const testAddress1 = encodeBech32('alpha', 0, testProgram1);
const testAddress2 = encodeBech32('alpha', 0, testProgram2);

// Test private key (for signing tests)
const testPrivateKey = '0000000000000000000000000000000000000000000000000000000000000001';
const testKeyPair = ec.keyFromPrivate(testPrivateKey, 'hex');
const testPublicKey = testKeyPair.getPublic(true, 'hex');

// Test UTXOs
const createTestUtxo = (value: number, txHash?: string, txPos?: number) => ({
  tx_hash: txHash || 'abcd1234'.repeat(8),
  tx_pos: txPos ?? 0,
  value,
  height: 100000,
  address: testAddress1,
});

// =============================================================================
// createScriptPubKey Tests
// =============================================================================

describe('createScriptPubKey()', () => {
  it('should create P2WPKH scriptPubKey for bech32 address', () => {
    const script = createScriptPubKey(testAddress1);

    // P2WPKH format: OP_0 (00) + PUSH20 (14) + 20-byte hash
    expect(script).toHaveLength(44); // 2 + 2 + 40 = 44 hex chars
    expect(script.startsWith('0014')).toBe(true);
  });

  it('should produce different scripts for different addresses', () => {
    const script1 = createScriptPubKey(testAddress1);
    const script2 = createScriptPubKey(testAddress2);

    expect(script1).not.toBe(script2);
  });

  it('should throw for invalid address', () => {
    expect(() => createScriptPubKey('invalid')).toThrow('Invalid bech32 address');
  });

  it('should throw for empty address', () => {
    expect(() => createScriptPubKey('')).toThrow();
  });

  it('should throw for null/undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createScriptPubKey(null as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createScriptPubKey(undefined as any)).toThrow();
  });
});

// =============================================================================
// buildSegWitTransaction Tests
// =============================================================================

describe('buildSegWitTransaction()', () => {
  const txPlan = {
    input: {
      tx_hash: 'a'.repeat(64), // 32 bytes
      tx_pos: 0,
      value: 100000000, // 1 ALPHA in sats
    },
    outputs: [
      { value: 50000000, address: testAddress2 },
      { value: 49990000, address: testAddress1 }, // Change
    ],
  };

  it('should build valid SegWit transaction', () => {
    const tx = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);

    expect(tx.hex).toBeDefined();
    expect(tx.txid).toBeDefined();
    expect(typeof tx.hex).toBe('string');
    expect(typeof tx.txid).toBe('string');
  });

  it('should produce valid hex format', () => {
    const tx = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);

    // Check it's valid hex
    expect(/^[0-9a-f]+$/i.test(tx.hex)).toBe(true);
    // Minimum transaction size
    expect(tx.hex.length).toBeGreaterThan(100);
  });

  it('should produce 64-char txid', () => {
    const tx = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);

    expect(tx.txid).toHaveLength(64);
    expect(/^[0-9a-f]+$/i.test(tx.txid)).toBe(true);
  });

  it('should produce deterministic txid for same inputs', () => {
    const tx1 = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);
    const tx2 = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);

    expect(tx1.txid).toBe(tx2.txid);
  });

  it('should include SegWit marker and flag', () => {
    const tx = buildSegWitTransaction(txPlan, testKeyPair, testPublicKey);

    // SegWit transactions have marker (00) and flag (01) after version
    // Version is 02000000 (4 bytes), then marker 00 and flag 01
    expect(tx.hex.substring(8, 12)).toBe('0001');
  });

  it('should handle single output', () => {
    const singleOutputPlan = {
      input: {
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        value: 50000,
      },
      outputs: [{ value: 40000, address: testAddress2 }],
    };

    const tx = buildSegWitTransaction(singleOutputPlan, testKeyPair, testPublicKey);
    expect(tx.hex).toBeDefined();
    expect(tx.txid).toBeDefined();
  });

  it('should handle different output amounts', () => {
    const plan1 = {
      input: { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 100000 },
      outputs: [{ value: 90000, address: testAddress2 }],
    };

    const plan2 = {
      input: { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 100000 },
      outputs: [{ value: 50000, address: testAddress2 }],
    };

    const tx1 = buildSegWitTransaction(plan1, testKeyPair, testPublicKey);
    const tx2 = buildSegWitTransaction(plan2, testKeyPair, testPublicKey);

    // Different outputs should produce different txids
    expect(tx1.txid).not.toBe(tx2.txid);
  });
});

// =============================================================================
// collectUtxosForAmount Tests
// =============================================================================

describe('collectUtxosForAmount()', () => {
  const FEE = 10000; // Standard fee
  const DUST = 546;

  it('should select single UTXO when sufficient', () => {
    const utxos = [
      createTestUtxo(1000000), // 0.01 ALPHA
    ];

    const plan = collectUtxosForAmount(utxos, 500000, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    expect(plan.transactions).toHaveLength(1);
    expect(plan.transactions[0].outputs[0].value).toBe(500000);
  });

  it('should include change output when above dust', () => {
    const utxos = [createTestUtxo(1000000)]; // 0.01 ALPHA
    const amount = 500000; // 0.005 ALPHA

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    // Should have 2 outputs: recipient + change
    const tx = plan.transactions[0];
    const changeAmount = tx.changeAmount || 0;

    if (changeAmount > DUST) {
      expect(tx.outputs).toHaveLength(2);
      expect(tx.outputs[1].address).toBe(testAddress1);
    }
  });

  it('should not include change output at or below dust threshold', () => {
    // Dust threshold is 546, so we need change < 546 to not be included
    const utxos = [createTestUtxo(19500)]; // 19500 sats
    const amount = 9000; // Will leave change of 500 (below 546 dust)

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    const tx = plan.transactions[0];
    // Change would be 19500 - 9000 - 10000 = 500 (below dust threshold of 546)
    // So should only have 1 output
    expect(tx.outputs).toHaveLength(1);
  });

  it('should fail with insufficient funds', () => {
    const utxos = [createTestUtxo(5000)]; // Too small

    const plan = collectUtxosForAmount(utxos, 100000, testAddress2, testAddress1);

    expect(plan.success).toBe(false);
    expect(plan.error).toContain('Insufficient funds');
  });

  it('should select smallest sufficient UTXO', () => {
    const utxos = [
      createTestUtxo(5000000, 'a'.repeat(64), 0), // 0.05 ALPHA
      createTestUtxo(1000000, 'b'.repeat(64), 0), // 0.01 ALPHA - smallest sufficient
      createTestUtxo(10000000, 'c'.repeat(64), 0), // 0.1 ALPHA
    ];
    const amount = 500000; // 0.005 ALPHA

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    expect(plan.transactions).toHaveLength(1);
    // Should use the 0.01 ALPHA UTXO (smallest that covers amount + fee)
    expect(plan.transactions[0].input.value).toBe(1000000);
  });

  it('should combine multiple UTXOs when needed', () => {
    const utxos = [
      createTestUtxo(30000, 'a'.repeat(64), 0),
      createTestUtxo(30000, 'b'.repeat(64), 0),
      createTestUtxo(30000, 'c'.repeat(64), 0),
    ];
    // Total: 90000, each UTXO can only contribute ~20000 after fee
    const amount = 50000; // More than any single UTXO can provide

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    // Should need multiple transactions
    expect(plan.transactions.length).toBeGreaterThan(1);
  });

  it('should handle empty UTXO list', () => {
    const plan = collectUtxosForAmount([], 100000, testAddress2, testAddress1);

    expect(plan.success).toBe(false);
    expect(plan.error).toContain('Insufficient funds');
  });

  it('should handle exact amount (no change)', () => {
    // UTXO value = amount + fee exactly
    const utxos = [createTestUtxo(100000 + FEE)]; // Exact match
    const amount = 100000;

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    expect(plan.transactions[0].changeAmount).toBe(0);
  });

  it('should set correct addresses in transaction', () => {
    const utxos = [createTestUtxo(1000000)];
    const amount = 500000;

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    const tx = plan.transactions[0];

    // Recipient output
    expect(tx.outputs[0].address).toBe(testAddress2);

    // Change address (if present)
    if (tx.outputs.length > 1) {
      expect(tx.outputs[1].address).toBe(testAddress1);
    }

    // Change address field
    expect(tx.changeAddress).toBe(testAddress1);
  });

  it('should handle large amounts', () => {
    const utxos = [createTestUtxo(100000000000)]; // 1000 ALPHA
    const amount = 50000000000; // 500 ALPHA

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    expect(plan.transactions[0].outputs[0].value).toBe(amount);
  });
});

// =============================================================================
// Fee Calculation Tests
// =============================================================================

describe('Fee handling', () => {
  it('should deduct 10000 sats fee', () => {
    const FEE = 10000;
    const utxos = [createTestUtxo(100000)];
    const amount = 50000;

    const plan = collectUtxosForAmount(utxos, amount, testAddress2, testAddress1);

    expect(plan.success).toBe(true);
    const tx = plan.transactions[0];
    expect(tx.fee).toBe(FEE);

    // Total outputs + fee should equal input
    const totalOutputs = tx.outputs.reduce((sum, o) => sum + o.value, 0);
    expect(totalOutputs + FEE).toBe(tx.input.value);
  });
});
