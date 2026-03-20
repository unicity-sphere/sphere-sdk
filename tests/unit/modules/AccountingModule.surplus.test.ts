/**
 * Comprehensive tests for AccountingModule balance-computer surplus assignment logic
 *
 * Tests the freezeBalances() and freezeCoinAsset() functions, specifically
 * validating the post-fix surplus distribution algorithm:
 *
 * 1. Latest sender gets min(surplus, their_net_contribution)
 * 2. Remaining surplus distributed to other senders in reverse iteration order
 * 3. Each sender capped at their net contribution
 * 4. Surplus prevents exploitation (1-unit last payment cannot capture entire surplus)
 *
 * @see docs/ACCOUNTING-SPEC.md §5.2, §7.3
 */

import { describe, it, expect } from 'vitest';
import { computeInvoiceStatus, freezeBalances } from '../../../modules/accounting/balance-computer.js';
import type {
  InvoiceTransferRef,
  InvoiceTerms,
  InvoiceStatus,
  InvoiceCoinAssetStatus,
  FrozenSenderBalance,
} from '../../../modules/accounting/types.js';

// =============================================================================
// Helpers for constructing test data
// =============================================================================

/**
 * Create a test InvoiceTransferRef (forward payment)
 */
function createForwardTransfer(
  transferId: string,
  senderAddress: string,
  destinationAddress: string,
  coinId: string,
  amount: string,
  timestamp: number = Date.now(),
): InvoiceTransferRef {
  return {
    transferId,
    direction: 'inbound',
    paymentDirection: 'forward',
    coinId,
    amount,
    destinationAddress,
    timestamp,
    confirmed: true,
    senderAddress,
  };
}

/**
 * Create a test InvoiceTransferRef (return payment)
 */
function createReturnTransfer(
  transferId: string,
  senderAddress: string, // target address (return goes FROM target)
  destinationAddress: string, // payer address (return goes TO payer)
  coinId: string,
  amount: string,
  timestamp: number = Date.now(),
): InvoiceTransferRef {
  return {
    transferId,
    direction: 'outbound',
    paymentDirection: 'back',
    coinId,
    amount,
    destinationAddress,
    timestamp,
    confirmed: true,
    senderAddress,
  };
}

/**
 * Create a test InvoiceTerms with single target, single coin
 */
function createTerms(
  targetAddress: string,
  coinId: string,
  requestedAmount: string,
  createdAt: number = Date.now(),
): InvoiceTerms {
  return {
    createdAt,
    targets: [
      {
        address: targetAddress,
        assets: [
          {
            coin: [coinId, requestedAmount],
          },
        ],
      },
    ],
  };
}

/**
 * Create a test InvoiceTerms with single target, multiple coins
 */
function createTermsMultiCoin(
  targetAddress: string,
  coins: Array<[coinId: string, amount: string]>,
  createdAt: number = Date.now(),
): InvoiceTerms {
  return {
    createdAt,
    targets: [
      {
        address: targetAddress,
        assets: coins.map(([coinId, amount]) => ({
          coin: [coinId, amount],
        })),
      },
    ],
  };
}

/**
 * Create a test InvoiceTerms with multiple targets
 */
function createTermsMultiTarget(
  targets: Array<[address: string, coins: Array<[coinId: string, amount: string]>]>,
  createdAt: number = Date.now(),
): InvoiceTerms {
  return {
    createdAt,
    targets: targets.map(([address, coins]) => ({
      address,
      assets: coins.map(([coinId, amount]) => ({
        coin: [coinId, amount],
      })),
    })),
  };
}

/**
 * Extract frozen sender balances by address from the frozen invoice
 */
function getFrozenBalances(status: InvoiceStatus, targetIndex: number, coinIndex: number): Map<string, string> {
  const target = status.targets[targetIndex]!;
  const coinAsset = target.coinAssets[coinIndex]!;
  // Note: after freezeBalances, the status is reconstructed and frozen balances
  // are converted to senderBalances. We reconstruct the original frozen values.
  const result = new Map<string, string>();
  for (const sb of coinAsset.senderBalances) {
    result.set(sb.senderAddress, sb.netBalance);
  }
  return result;
}

// =============================================================================
// Tests
// =============================================================================

describe('AccountingModule.surplus.test - freezeBalances() surplus assignment', () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: Single sender, single target, single coin
  // Sender pays 150 for 100 requested → surplus=50, sender gets 50
  // ---------------------------------------------------------------------------
  it('Scenario 1: Single sender, single target, single coin - surplus fully assigned', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '150'),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('50');

    // Freeze with latest sender = alice
    const latestSenderMap = new Map([['UCT', 'DIRECT://alice']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://alice')).toBe('50');
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Two senders, last sender small payment
  // Sender A pays 90, Sender B pays 20 for 100 requested → surplus=10
  // B (latest) gets min(10, 20)=10. A gets 0.
  // ---------------------------------------------------------------------------
  it('Scenario 2: Two senders, last sender small payment - capped at contribution', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '90', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '20', 200), // Bob is latest
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('10');

    // Freeze with latest sender = bob
    const latestSenderMap = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://bob')).toBe('10'); // min(10, 20)
    expect(frozenSenders.get('DIRECT://alice')).toBe('0'); // no surplus left
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Two senders, last sender 1-unit exploit attempt
  // Sender A pays 100, Sender B pays 1 for 100 requested → surplus=1
  // B (latest) gets min(1, 1)=1. A gets 0.
  // ---------------------------------------------------------------------------
  it('Scenario 3: One-unit exploit prevented - latest sender capped at contribution', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '100', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '1', 200), // Bob is latest
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('1');

    // Freeze with latest sender = bob
    const latestSenderMap = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://bob')).toBe('1'); // min(1, 1) = 1 (not full 1)
    expect(frozenSenders.get('DIRECT://alice')).toBe('0'); // no surplus left
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Latest sender contributes less than surplus
  // Sender A pays 200, Sender B pays 5 for 100 requested → surplus=105
  // B (latest) gets min(105, 5)=5. A gets min(100, 200)=100. Total distributed=105.
  // ---------------------------------------------------------------------------
  it('Scenario 4: Latest contribution less than surplus - cascaded to earlier senders', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '200', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '5', 200), // Bob is latest
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('105');

    // Freeze with latest sender = bob
    const latestSenderMap = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://bob')).toBe('5'); // min(105, 5)
    expect(frozenSenders.get('DIRECT://alice')).toBe('100'); // min(100, 200) from remaining 100
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Three senders, cascading surplus
  // A=50, B=30, C=40 for 100 requested → surplus=20
  // C (latest) gets min(20, 40)=20. A, B get 0.
  // ---------------------------------------------------------------------------
  it('Scenario 5: Three senders, surplus fully assigned to latest sender', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '50', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '30', 200),
      createForwardTransfer('txn003', 'DIRECT://charlie', targetAddr, 'UCT', '40', 300), // Charlie is latest
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('20');

    // Freeze with latest sender = charlie
    const latestSenderMap = new Map([['UCT', 'DIRECT://charlie']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://charlie')).toBe('20'); // min(20, 40)
    expect(frozenSenders.get('DIRECT://bob')).toBe('0');
    expect(frozenSenders.get('DIRECT://alice')).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Three senders, largest surplus exceeds all contributors
  // A=10, B=10, C=5 for 5 requested → surplus=20
  // C (latest) gets min(20, 5)=5. B gets min(15, 10)=10. A gets min(5, 10)=5.
  // Total distributed=20.
  // ---------------------------------------------------------------------------
  it('Scenario 6: Surplus exceeds all contributors - distributed across all senders', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '5');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '10', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '10', 200),
      createForwardTransfer('txn003', 'DIRECT://charlie', targetAddr, 'UCT', '5', 300), // Charlie is latest
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('20');

    // Freeze with latest sender = charlie
    const latestSenderMap = new Map([['UCT', 'DIRECT://charlie']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://charlie')).toBe('5'); // min(20, 5)
    expect(frozenSenders.get('DIRECT://bob')).toBe('10'); // min(15, 10) from remaining 15
    expect(frozenSenders.get('DIRECT://alice')).toBe('5'); // min(5, 10) from remaining 5
    // Total: 5+10+5 = 20 ✓
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Multi-target, different surplus per target
  // Target1 requested 100 (A pays 150→surplus 50)
  // Target2 requested 200 (B pays 300→surplus 100)
  // Each target's surplus is independent.
  // ---------------------------------------------------------------------------
  it('Scenario 7: Multi-target with independent surplus per target', () => {
    const target1Addr = 'DIRECT://target1';
    const target2Addr = 'DIRECT://target2';
    const terms = createTermsMultiTarget([
      [target1Addr, [['UCT', '100']]],
      [target2Addr, [['UCT', '200']]],
    ]);

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', target1Addr, 'UCT', '150', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', target2Addr, 'UCT', '300', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('50');
    expect(status.targets[1]!.coinAssets[0]!.surplusAmount).toBe('100');

    const latestSenderMap1 = new Map([['UCT', 'DIRECT://alice']]);
    const latestSenderMap2 = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([
        [target1Addr, latestSenderMap1],
        [target2Addr, latestSenderMap2],
      ]),
    );

    // Target1 surplus allocation
    const frozen1 = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozen1Senders = new Map(frozen1.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozen1Senders.get('DIRECT://alice')).toBe('50');

    // Target2 surplus allocation
    const frozen2 = frozenBalances.targets[1]!.coinAssets[0]!;
    const frozen2Senders = new Map(frozen2.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozen2Senders.get('DIRECT://bob')).toBe('100');
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Multi-coin per target
  // Target1 requests [UCT=100, USDU=200]
  // UCT covered by A=120 (surplus 20)
  // USDU covered by B=250 (surplus 50)
  // Surpluses are per-coin independent.
  // ---------------------------------------------------------------------------
  it('Scenario 8: Multi-coin per target with independent surplus per coin', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTermsMultiCoin(targetAddr, [
      ['UCT', '100'],
      ['USDU', '200'],
    ]);

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '120', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'USDU', '250', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.coin[0]).toBe('UCT');
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('20');
    expect(status.targets[0]!.coinAssets[1]!.coin[0]).toBe('USDU');
    expect(status.targets[0]!.coinAssets[1]!.surplusAmount).toBe('50');

    const latestSenderMap = new Map([
      ['UCT', 'DIRECT://alice'],
      ['USDU', 'DIRECT://bob'],
    ]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    // UCT surplus allocation
    const frozenUCT = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenUCTSenders = new Map(frozenUCT.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozenUCTSenders.get('DIRECT://alice')).toBe('20');

    // USDU surplus allocation
    const frozenUSDU = frozenBalances.targets[0]!.coinAssets[1]!;
    const frozenUSDUSenders = new Map(frozenUSDU.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozenUSDUSenders.get('DIRECT://bob')).toBe('50');
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: Multi-token payment causing combined surplus
  // Single sender pays 150 via multiple tokens (token1=80, token2=70) for 100
  // requested → surplus=50, sender gets 50
  // (The sender accumulator combines amounts from multiple tokens.)
  // ---------------------------------------------------------------------------
  it('Scenario 9: Multi-token payment - combined amounts correctly accumulated', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '80', 100),
      createForwardTransfer('txn002', 'DIRECT://alice', targetAddr, 'UCT', '70', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.coveredAmount).toBe('150');
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('50');

    const latestSenderMap = new Map([['UCT', 'DIRECT://alice']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://alice')).toBe('50');
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: CANCELLED state preserves all balances
  // Same setup as Scenario 4 but CANCELLED → all sender balances preserved,
  // no surplus redistribution.
  // ---------------------------------------------------------------------------
  it('Scenario 10: CANCELLED state preserves all sender balances', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '200', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '5', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('105');

    // Freeze as CANCELLED (latestSenderMap irrelevant)
    const frozenBalances = freezeBalances(terms, status, 'CANCELLED', true);

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    // CANCELLED preserves original net balances
    expect(frozenSenders.get('DIRECT://alice')).toBe('200'); // full net contribution
    expect(frozenSenders.get('DIRECT://bob')).toBe('5'); // full net contribution
  });

  // ---------------------------------------------------------------------------
  // Scenario 11: No surplus (exact payment)
  // A=50, B=50 for 100 → surplus=0. All frozen balances = 0.
  // ---------------------------------------------------------------------------
  it('Scenario 11: Exact payment - no surplus to distribute', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '50', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '50', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('0');

    const latestSenderMap = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://alice')).toBe('0');
    expect(frozenSenders.get('DIRECT://bob')).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // Scenario 12: No surplus (underpayment)
  // A=30, B=20 for 100 → surplus=0, netCovered=50. All frozen balances = 0.
  // ---------------------------------------------------------------------------
  it('Scenario 12: Underpayment - no surplus to distribute', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '30', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', targetAddr, 'UCT', '20', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('0');
    expect(status.targets[0]!.coinAssets[0]!.isCovered).toBe(false);

    const latestSenderMap = new Map([['UCT', 'DIRECT://bob']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://alice')).toBe('0');
    expect(frozenSenders.get('DIRECT://bob')).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // Scenario 13: Sender with returns
  // A forwarded 150, returned 30 → netBalance=120. For requested=100,
  // surplus=20. A gets 20.
  // ---------------------------------------------------------------------------
  it('Scenario 13: Sender with returns - net balance respects returns', () => {
    const targetAddr = 'DIRECT://target1';
    const terms = createTerms(targetAddr, 'UCT', '100');

    const transfers: InvoiceTransferRef[] = [
      createForwardTransfer('txn001', 'DIRECT://alice', targetAddr, 'UCT', '150', 100),
      createReturnTransfer('txn002', targetAddr, 'DIRECT://alice', 'UCT', '30', 200),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());
    expect(status.targets[0]!.coinAssets[0]!.coveredAmount).toBe('150');
    expect(status.targets[0]!.coinAssets[0]!.returnedAmount).toBe('30');
    expect(status.targets[0]!.coinAssets[0]!.netCoveredAmount).toBe('120');
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('20');

    const latestSenderMap = new Map([['UCT', 'DIRECT://alice']]);
    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([[targetAddr, latestSenderMap]]),
    );

    const frozenCoinAsset = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenSenders = new Map(frozenCoinAsset.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));

    expect(frozenSenders.get('DIRECT://alice')).toBe('20');
  });

  // ---------------------------------------------------------------------------
  // Scenario 14: Complex multi-coin multi-target multi-sender scenario
  // Target1 (DIRECT://t1): UCT=100, USDU=50
  // Target2 (DIRECT://t2): UCT=200
  // Senders: A sends UCT to Target1 (80), B sends UCT to Target1 (40)
  //          → UCT surplus on T1 = 20
  // Senders: C sends USDU to Target1 (60) → USDU surplus on T1 = 10
  // Senders: D sends UCT to Target2 (250) → UCT surplus on T2 = 50
  // Verify each target:coin has independent surplus assignment
  // ---------------------------------------------------------------------------
  it('Scenario 14: Complex multi-coin multi-target multi-sender full scenario', () => {
    const target1Addr = 'DIRECT://t1';
    const target2Addr = 'DIRECT://t2';
    const terms = createTermsMultiTarget([
      [target1Addr, [['UCT', '100'], ['USDU', '50']]],
      [target2Addr, [['UCT', '200']]],
    ]);

    const transfers: InvoiceTransferRef[] = [
      // Target1, UCT: A=80, B=40 → surplus=20
      createForwardTransfer('txn001', 'DIRECT://alice', target1Addr, 'UCT', '80', 100),
      createForwardTransfer('txn002', 'DIRECT://bob', target1Addr, 'UCT', '40', 200),
      // Target1, USDU: C=60 → surplus=10
      createForwardTransfer('txn003', 'DIRECT://charlie', target1Addr, 'USDU', '60', 300),
      // Target2, UCT: D=250 → surplus=50
      createForwardTransfer('txn004', 'DIRECT://diana', target2Addr, 'UCT', '250', 400),
    ];

    const status = computeInvoiceStatus('invoice001', terms, transfers, null, new Set());

    // Verify surpluses
    const target1 = status.targets[0]!;
    const uct1 = target1.coinAssets.find((ca) => ca.coin[0] === 'UCT')!;
    const usdu1 = target1.coinAssets.find((ca) => ca.coin[0] === 'USDU')!;
    const target2 = status.targets[1]!;
    const uct2 = target2.coinAssets[0]!;

    expect(uct1.surplusAmount).toBe('20');
    expect(usdu1.surplusAmount).toBe('10');
    expect(uct2.surplusAmount).toBe('50');

    // Freeze with appropriate latest senders per target:coin
    const target1LatestMap = new Map([
      ['UCT', 'DIRECT://bob'], // B is latest for UCT on T1
      ['USDU', 'DIRECT://charlie'], // C is latest for USDU on T1
    ]);
    const target2LatestMap = new Map([['UCT', 'DIRECT://diana']]);

    const frozenBalances = freezeBalances(
      terms,
      status,
      'CLOSED',
      true,
      new Map([
        [target1Addr, target1LatestMap],
        [target2Addr, target2LatestMap],
      ]),
    );

    // Verify T1:UCT surplus assignment
    const frozenT1UCT = frozenBalances.targets[0]!.coinAssets[0]!;
    const frozenT1UCTSenders = new Map(frozenT1UCT.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozenT1UCTSenders.get('DIRECT://bob')).toBe('20'); // min(20, 40) - latest gets surplus
    expect(frozenT1UCTSenders.get('DIRECT://alice')).toBe('0');

    // Verify T1:USDU surplus assignment
    const frozenT1USDU = frozenBalances.targets[0]!.coinAssets[1]!;
    const frozenT1USDUSenders = new Map(frozenT1USDU.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozenT1USDUSenders.get('DIRECT://charlie')).toBe('10');

    // Verify T2:UCT surplus assignment
    const frozenT2UCT = frozenBalances.targets[1]!.coinAssets[0]!;
    const frozenT2UCTSenders = new Map(frozenT2UCT.frozenSenderBalances.map((fsb) => [fsb.senderAddress, fsb.netBalance]));
    expect(frozenT2UCTSenders.get('DIRECT://diana')).toBe('50');
  });

  // =============================================================================
  // Edge cases identified by adversarial review
  // =============================================================================

  it('Edge 1: Zero-net latest sender with surplus=0 — latestSenderAddress still annotated', () => {
    const target = 'DIRECT://target_e1';
    const terms = createTerms(target, 'UCT', '100');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e1a', 'DIRECT://alice', target, 'UCT', '100', 100),
      createForwardTransfer('tx_e1b', 'DIRECT://bob', target, 'UCT', '50', 200),
      createReturnTransfer('tx_e1c', target, 'DIRECT://bob', 'UCT', '50', 300),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e1', terms, entries, null, walletAddresses);
    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://bob']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    // surplus = 0 (netCovered=100, requested=100)
    expect(frozenCoin.surplusAmount).toBe('0');
    const senders = new Map(frozenCoin.frozenSenderBalances.map((f) => [f.senderAddress, f.netBalance]));
    expect(senders.get('DIRECT://alice')).toBe('0');
    expect(senders.get('DIRECT://bob')).toBe('0');
    // latestSenderAddress is still written at the coin asset level
    expect(frozenCoin.latestSenderAddress).toBe('DIRECT://bob');
  });

  it('Edge 2: Ghost latestSender (not in senderBalances) — surplus spills to real senders', () => {
    const target = 'DIRECT://target_e2';
    const terms = createTerms(target, 'UCT', '100');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e2a', 'DIRECT://alice', target, 'UCT', '150', 100),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e2', terms, entries, null, walletAddresses);
    // latestSenderMap points to a sender NOT in senderBalances
    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://ghost']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    expect(frozenCoin.surplusAmount).toBe('50');
    // Alice should get the surplus via second-pass (ghost skipped in first pass)
    const aliceFrozen = frozenCoin.frozenSenderBalances.find((f) => f.senderAddress === 'DIRECT://alice');
    expect(aliceFrozen).toBeDefined();
    expect(aliceFrozen!.netBalance).toBe('50');
    // latestSenderAddress annotation still points to ghost
    expect(frozenCoin.latestSenderAddress).toBe('DIRECT://ghost');
  });

  it('Edge 3: Surplus exactly equals latest sender net (boundary — cap bites exactly)', () => {
    const target = 'DIRECT://target_e3';
    const terms = createTerms(target, 'UCT', '50');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e3a', 'DIRECT://alice', target, 'UCT', '50', 100),
      createForwardTransfer('tx_e3b', 'DIRECT://bob', target, 'UCT', '50', 200),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e3', terms, entries, null, walletAddresses);
    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://bob']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    // surplus=50, bob.net=50 → min(50,50)=50, remainder=0
    const senders = new Map(frozenCoin.frozenSenderBalances.map((f) => [f.senderAddress, f.netBalance]));
    expect(senders.get('DIRECT://bob')).toBe('50');
    expect(senders.get('DIRECT://alice')).toBe('0');
  });

  it('Edge 4: Three senders, surplus spills from latest through second to oldest', () => {
    const target = 'DIRECT://target_e4';
    const terms = createTerms(target, 'UCT', '100');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e4a', 'DIRECT://alice', target, 'UCT', '60', 100),
      createForwardTransfer('tx_e4b', 'DIRECT://bob', target, 'UCT', '60', 200),
      createForwardTransfer('tx_e4c', 'DIRECT://charlie', target, 'UCT', '30', 300),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e4', terms, entries, null, walletAddresses);
    // surplus = 50 (150 - 100)
    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://charlie']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    const senders = new Map(frozenCoin.frozenSenderBalances.map((f) => [f.senderAddress, f.netBalance]));
    // Charlie (latest) gets min(50,30)=30, remainder=20
    // Reverse pass: bob (index 1) gets min(20,60)=20, remainder=0
    // Alice (index 0): 0
    expect(senders.get('DIRECT://charlie')).toBe('30');
    expect(senders.get('DIRECT://bob')).toBe('20');
    expect(senders.get('DIRECT://alice')).toBe('0');
  });

  it('Edge 5: undefined latestSenderMap for CLOSED — surplus distributed via second pass only', () => {
    const target = 'DIRECT://target_e5';
    const terms = createTerms(target, 'UCT', '100');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e5a', 'DIRECT://alice', target, 'UCT', '80', 100),
      createForwardTransfer('tx_e5b', 'DIRECT://bob', target, 'UCT', '70', 200),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e5', terms, entries, null, walletAddresses);
    // surplus = 50 (150-100). No latestSenderMap provided.
    const frozen = freezeBalances(terms, status, 'CLOSED', true, undefined);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    const senders = new Map(frozenCoin.frozenSenderBalances.map((f) => [f.senderAddress, f.netBalance]));
    // First pass skipped (latestSender undefined). Second pass reverse:
    // bob (index 1): min(50,70)=50, remainder=0
    // alice (index 0): 0
    expect(senders.get('DIRECT://bob')).toBe('50');
    expect(senders.get('DIRECT://alice')).toBe('0');
    // No latestSenderAddress annotation
    expect(frozenCoin.latestSenderAddress).toBeUndefined();
  });

  it('Edge 6: Return exceeds forward (negative net floored to 0) — no surplus amplification', () => {
    const target = 'DIRECT://target_e6';
    const terms = createTerms(target, 'UCT', '50');
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e6a', 'DIRECT://alice', target, 'UCT', '100', 100),
      // Over-return: target returns 60 to alice (more than alice's net would suggest)
      createReturnTransfer('tx_e6b', target, 'DIRECT://alice', 'UCT', '120', 200),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e6', terms, entries, null, walletAddresses);
    // netCovered = max(0, 100-120) = 0. surplus = 0.
    const frozenCoin = freezeBalances(terms, status, 'CLOSED', true, undefined).targets[0]!.coinAssets[0]!;
    expect(frozenCoin.surplusAmount).toBe('0');
    // Alice's netBalance in senderBalances is max(0, 100-120) = 0
    const aliceFrozen = frozenCoin.frozenSenderBalances.find((f) => f.senderAddress === 'DIRECT://alice');
    expect(aliceFrozen).toBeDefined();
    expect(aliceFrozen!.netBalance).toBe('0');
  });

  it('Edge 7: Empty senderBalances (null sender) but surplus > 0 — surplus stays undistributed', () => {
    const target = 'DIRECT://target_e7';
    const terms = createTerms(target, 'UCT', '50');
    // Transfer with null senderAddress and no refundAddress → excluded from per-sender tracking
    const entries: InvoiceTransferRef[] = [
      {
        transferId: 'tx_e7a',
        direction: 'inbound' as const,
        paymentDirection: 'forward' as const,
        coinId: 'UCT',
        amount: '100',
        destinationAddress: target,
        timestamp: 100,
        confirmed: true,
        senderAddress: null,
      },
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e7', terms, entries, null, walletAddresses);
    // coveredAmount=100, netCovered=100, surplus=50
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe('50');
    // senderBalances is empty (null sender excluded from tracking)
    expect(status.targets[0]!.coinAssets[0]!.senderBalances).toHaveLength(0);

    const frozenCoin = freezeBalances(terms, status, 'CLOSED', true, undefined).targets[0]!.coinAssets[0]!;
    // Surplus is undistributed — no senders to assign to
    expect(frozenCoin.frozenSenderBalances).toHaveLength(0);
    expect(frozenCoin.surplusAmount).toBe('50');
  });

  it('Edge 8: Same sender contributes to two independent targets — no cross-contamination', () => {
    const t1 = 'DIRECT://target_e8a';
    const t2 = 'DIRECT://target_e8b';
    const terms = createTermsMultiTarget([
      [t1, [['UCT', '50']]],
      [t2, [['UCT', '50']]],
    ]);
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e8a', 'DIRECT://alice', t1, 'UCT', '80', 100),
      createForwardTransfer('tx_e8b', 'DIRECT://alice', t2, 'UCT', '80', 200),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e8', terms, entries, null, walletAddresses);
    const latestSenderMap = new Map([
      [t1, new Map([['UCT', 'DIRECT://alice']])],
      [t2, new Map([['UCT', 'DIRECT://alice']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    // T1: surplus=30, alice gets min(30,80)=30
    const frozenT1 = frozen.targets[0]!.coinAssets[0]!;
    expect(frozenT1.frozenSenderBalances[0]!.netBalance).toBe('30');
    // T2: surplus=30, alice gets min(30,80)=30 (independent of T1)
    const frozenT2 = frozen.targets[1]!.coinAssets[0]!;
    expect(frozenT2.frozenSenderBalances[0]!.netBalance).toBe('30');
  });

  it('Edge 9: Multi-coin target with different latestSenders per coin — independent treatment', () => {
    const target = 'DIRECT://target_e9';
    const terms = createTermsMultiCoin(target, [['UCT', '100'], ['USDU', '50']]);
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e9a', 'DIRECT://alice', target, 'UCT', '150', 100),
      createForwardTransfer('tx_e9b', 'DIRECT://bob', target, 'USDU', '80', 200),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e9', terms, entries, null, walletAddresses);
    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://alice'], ['USDU', 'DIRECT://bob']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    // UCT: surplus=50, alice gets min(50,150)=50
    const uctCoin = frozen.targets[0]!.coinAssets[0]!;
    expect(uctCoin.latestSenderAddress).toBe('DIRECT://alice');
    expect(uctCoin.frozenSenderBalances[0]!.netBalance).toBe('50');
    // USDU: surplus=30, bob gets min(30,80)=30
    const usduCoin = frozen.targets[0]!.coinAssets[1]!;
    expect(usduCoin.latestSenderAddress).toBe('DIRECT://bob');
    expect(usduCoin.frozenSenderBalances[0]!.netBalance).toBe('30');
  });

  it('Edge 10: Multi-transfer same sender — accumulation into single senderBalance entry', () => {
    const target = 'DIRECT://target_e10';
    const terms = createTerms(target, 'UCT', '100');
    // Same sender sends 3 separate transfers (multi-token scenario)
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e10a', 'DIRECT://alice', target, 'UCT', '40', 100),
      createForwardTransfer('tx_e10b', 'DIRECT://alice', target, 'UCT', '40', 200),
      createForwardTransfer('tx_e10c', 'DIRECT://alice', target, 'UCT', '40', 300),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e10', terms, entries, null, walletAddresses);
    // Alice appears once in senderBalances with forwarded=120, net=120
    expect(status.targets[0]!.coinAssets[0]!.senderBalances).toHaveLength(1);
    expect(status.targets[0]!.coinAssets[0]!.senderBalances[0]!.netBalance).toBe('120');

    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://alice']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    // surplus=20 (120-100), alice gets min(20,120)=20
    expect(frozenCoin.surplusAmount).toBe('20');
    expect(frozenCoin.frozenSenderBalances).toHaveLength(1);
    expect(frozenCoin.frozenSenderBalances[0]!.netBalance).toBe('20');
  });

  it('Edge 11: 78-digit BigInt boundary — maximum valid amount through surplus distribution', () => {
    const target = 'DIRECT://target_e11';
    // Requested = 1 smallest unit
    const terms = createTerms(target, 'UCT', '1');
    // 78 nines = maximum valid amount per isValidAmount (length <= 78)
    const maxAmount = '9'.repeat(78);
    const entries: InvoiceTransferRef[] = [
      createForwardTransfer('tx_e11a', 'DIRECT://alice', target, 'UCT', maxAmount, 100),
    ];
    const walletAddresses = new Set<string>();
    const status = computeInvoiceStatus('inv_e11', terms, entries, null, walletAddresses);
    // surplus = 78-nines - 1
    const expectedSurplus = (BigInt(maxAmount) - 1n).toString();
    expect(status.targets[0]!.coinAssets[0]!.surplusAmount).toBe(expectedSurplus);

    const latestSenderMap = new Map([
      [target, new Map([['UCT', 'DIRECT://alice']])],
    ]);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);
    const frozenCoin = frozen.targets[0]!.coinAssets[0]!;
    // Alice gets min(surplus, 78-nines) = surplus (since 78-nines > surplus)
    expect(frozenCoin.frozenSenderBalances[0]!.netBalance).toBe(expectedSurplus);
  });
});
