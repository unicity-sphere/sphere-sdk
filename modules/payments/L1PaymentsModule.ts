/**
 * L1 Payments Sub-Module
 * Handles Layer 1 (ALPHA blockchain) transactions
 *
 * Integrates with existing L1 SDK:
 * - network.ts: getBalance, getUtxo, broadcast, getTransactionHistory
 * - tx.ts: sendAlpha, createTransactionPlan
 */

import type { FullIdentity } from '../../types';

// Import from existing L1 SDK
import {
  getUtxo,
  getBalance as l1GetBalance,
  getTransactionHistory,
  getTransaction as l1GetTransaction,
  getCurrentBlockHeight,
  connect as l1Connect,
  isWebSocketConnected,
  type TransactionHistoryItem,
  type TransactionDetail,
} from '../../../components/wallet/L1/sdk/network';
import {
  sendAlpha,
  createTransactionPlan,
} from '../../../components/wallet/L1/sdk/tx';
import type {
  Wallet as L1Wallet,
  UTXO,
  Transaction as L1TxPlanItem,
} from '../../../components/wallet/L1/sdk/types';

// Import vesting classifier
import {
  VestingClassifier,
  VESTING_THRESHOLD,
  type ClassifiedUTXO,
  InMemoryCacheProvider,
} from '../../../components/wallet/sdk/transaction/vesting';
// VestingClassifier only uses getTransaction and getCurrentBlockHeight
// We create a minimal adapter that satisfies those methods

// =============================================================================
// Types
// =============================================================================

export interface L1SendRequest {
  /** Recipient address */
  to: string;
  /** Amount in satoshis */
  amount: string;
  /** Fee rate in sat/byte */
  feeRate?: number;
  /** Use vested coins only */
  useVested?: boolean;
  /** Memo/OP_RETURN data */
  memo?: string;
}

export interface L1SendResult {
  success: boolean;
  txHash?: string;
  fee?: string;
  error?: string;
}

export interface L1Balance {
  confirmed: string;
  unconfirmed: string;
  vested: string;
  unvested: string;
  total: string;
}

export interface L1Utxo {
  txid: string;
  vout: number;
  amount: string;
  address: string;
  isVested: boolean;
  confirmations: number;
  coinbaseHeight?: number;
}

export interface L1Transaction {
  txid: string;
  type: 'send' | 'receive';
  amount: string;
  fee?: string;
  /** Counterparty address (recipient for send, sender for receive) */
  address: string;
  confirmations: number;
  timestamp: number;
  blockHeight?: number;
}

// =============================================================================
// Configuration
// =============================================================================

export interface L1PaymentsModuleConfig {
  /** Fulcrum server URL */
  electrumUrl?: string;
  /** Network: mainnet or testnet */
  network?: 'mainnet' | 'testnet';
  /** Default fee rate */
  defaultFeeRate?: number;
  /** Enable vesting classification */
  enableVesting?: boolean;
}

// =============================================================================
// Dependencies
// =============================================================================

export interface L1PaymentsModuleDependencies {
  identity: FullIdentity;
  /** Chain code for BIP32 derivation (optional) */
  chainCode?: string;
  /** Additional addresses to track */
  addresses?: string[];
}

// =============================================================================
// Network Provider Adapter
// =============================================================================

/**
 * Minimal network provider interface for VestingClassifier
 * Only includes the methods actually used by the classifier
 */
interface VestingNetworkProvider {
  getTransaction(txid: string): Promise<TransactionDetail>;
  getCurrentBlockHeight(): Promise<number>;
}

/**
 * Adapts existing L1 SDK network functions for VestingClassifier
 */
function createNetworkProviderAdapter(): VestingNetworkProvider {
  return {
    async getTransaction(txid: string): Promise<TransactionDetail> {
      const tx = await l1GetTransaction(txid);
      if (!tx) {
        throw new Error(`Transaction not found: ${txid}`);
      }
      return tx as TransactionDetail;
    },
    async getCurrentBlockHeight(): Promise<number> {
      return getCurrentBlockHeight();
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert SDK2 FullIdentity to L1 Wallet format
 * Creates a minimal wallet structure compatible with L1 SDK
 */
function identityToL1Wallet(identity: FullIdentity): L1Wallet {
  return {
    masterPrivateKey: identity.privateKey,
    addresses: [
      {
        address: identity.address,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        path: "m/84'/0'/0'/0/0",
        index: 0,
      },
    ],
    isBIP32: true,
  };
}

/**
 * Extract addresses from transaction outputs
 */
function getOutputAddresses(vout: TransactionDetail['vout']): string[] {
  const addresses: string[] = [];
  for (const output of vout) {
    if (output.scriptPubKey.address) {
      addresses.push(output.scriptPubKey.address);
    } else if (output.scriptPubKey.addresses?.length) {
      addresses.push(...output.scriptPubKey.addresses);
    }
  }
  return addresses;
}

/**
 * Calculate amount received by address from transaction outputs
 */
function calculateReceivedAmount(
  vout: TransactionDetail['vout'],
  address: string
): number {
  let amount = 0;
  for (const output of vout) {
    const outputAddresses = output.scriptPubKey.address
      ? [output.scriptPubKey.address]
      : output.scriptPubKey.addresses ?? [];
    if (outputAddresses.includes(address)) {
      amount += output.value;
    }
  }
  return amount;
}

// =============================================================================
// Implementation
// =============================================================================

export class L1PaymentsModule {
  private config: Required<L1PaymentsModuleConfig>;
  private deps: L1PaymentsModuleDependencies | null = null;
  private vestingClassifier: VestingClassifier | null = null;
  private addressSet: Set<string> = new Set();

  constructor(config?: L1PaymentsModuleConfig) {
    this.config = {
      electrumUrl: config?.electrumUrl ?? 'wss://fulcrum.unicity.network:50004',
      network: config?.network ?? 'mainnet',
      defaultFeeRate: config?.defaultFeeRate ?? 10,
      enableVesting: config?.enableVesting ?? true,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async initialize(deps: L1PaymentsModuleDependencies): Promise<void> {
    this.deps = deps;

    // Build address set for transaction analysis
    this.addressSet.clear();
    this.addressSet.add(deps.identity.address);
    if (deps.addresses) {
      for (const addr of deps.addresses) {
        this.addressSet.add(addr);
      }
    }

    // Initialize vesting classifier if enabled
    if (this.config.enableVesting) {
      // VestingClassifier only uses getTransaction and getCurrentBlockHeight internally
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const networkAdapter = createNetworkProviderAdapter() as any;
      const cacheProvider = new InMemoryCacheProvider();
      this.vestingClassifier = new VestingClassifier(networkAdapter, cacheProvider);
      await this.vestingClassifier.init();
    }
  }

  destroy(): void {
    this.deps = null;
    this.vestingClassifier = null;
    this.addressSet.clear();
  }

  // ===========================================================================
  // Network Connection
  // ===========================================================================

  private async ensureConnected(): Promise<void> {
    if (!isWebSocketConnected()) {
      await l1Connect(this.config.electrumUrl);
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Send L1 transaction
   */
  async send(request: L1SendRequest): Promise<L1SendResult> {
    this.ensureInitialized();

    try {
      await this.ensureConnected();

      const l1Wallet = identityToL1Wallet(this.deps!.identity);

      // Convert amount from satoshis string to ALPHA number
      const amountSats = BigInt(request.amount);
      const amountAlpha = Number(amountSats) / 100_000_000;

      // Use existing L1 SDK to send
      const results = await sendAlpha(
        l1Wallet,
        request.to,
        amountAlpha,
        this.deps!.identity.address
      );

      if (results.length === 0) {
        return {
          success: false,
          error: 'No transactions created',
        };
      }

      const firstResult = results[0];
      return {
        success: true,
        txHash: firstResult.txid,
        fee: '10000',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get L1 balance with vesting classification
   */
  async getBalance(): Promise<L1Balance> {
    this.ensureInitialized();
    await this.ensureConnected();

    const address = this.deps!.identity.address;

    // Get raw balance for confirmed amount
    const balanceAlpha = await l1GetBalance(address);
    const confirmedSats = Math.floor(balanceAlpha * 100_000_000);

    // Get UTXOs for vesting classification
    if (this.config.enableVesting && this.vestingClassifier) {
      const utxos = await this.getUtxos();

      let vestedSats = 0;
      let unvestedSats = 0;

      for (const utxo of utxos) {
        const amount = BigInt(utxo.amount);
        if (utxo.isVested) {
          vestedSats += Number(amount);
        } else {
          unvestedSats += Number(amount);
        }
      }

      return {
        confirmed: confirmedSats.toString(),
        unconfirmed: '0',
        vested: vestedSats.toString(),
        unvested: unvestedSats.toString(),
        total: confirmedSats.toString(),
      };
    }

    // Without vesting classification
    return {
      confirmed: confirmedSats.toString(),
      unconfirmed: '0',
      vested: '0',
      unvested: confirmedSats.toString(),
      total: confirmedSats.toString(),
    };
  }

  /**
   * Get L1 UTXOs with vesting classification
   */
  async getUtxos(): Promise<L1Utxo[]> {
    this.ensureInitialized();
    await this.ensureConnected();

    const address = this.deps!.identity.address;
    const utxos: UTXO[] = await getUtxo(address);

    // Classify UTXOs if vesting is enabled
    if (this.config.enableVesting && this.vestingClassifier) {
      const { vested, unvested } = await this.vestingClassifier.classifyUtxos(utxos);

      const mapClassified = (classified: ClassifiedUTXO[], isVested: boolean): L1Utxo[] =>
        classified.map((utxo) => ({
          txid: utxo.txid ?? utxo.tx_hash ?? '',
          vout: utxo.vout ?? utxo.tx_pos ?? 0,
          amount: utxo.value.toString(),
          address: utxo.address ?? address,
          isVested,
          confirmations: utxo.height ? 1 : 0,
          coinbaseHeight: utxo.coinbaseHeight ?? undefined,
        }));

      return [...mapClassified(vested, true), ...mapClassified(unvested, false)];
    }

    // Without vesting classification
    return utxos.map((utxo) => ({
      txid: utxo.txid ?? utxo.tx_hash ?? '',
      vout: utxo.vout ?? utxo.tx_pos ?? 0,
      amount: utxo.value.toString(),
      address: utxo.address ?? address,
      isVested: false,
      confirmations: utxo.height ? 1 : 0,
    }));
  }

  /**
   * Get L1 transaction history with full details
   */
  async getHistory(limit?: number): Promise<L1Transaction[]> {
    this.ensureInitialized();
    await this.ensureConnected();

    const address = this.deps!.identity.address;
    const history = await getTransactionHistory(address);
    const currentHeight = await getCurrentBlockHeight();

    // Fetch full details for each transaction
    const transactions: L1Transaction[] = [];

    const itemsToProcess = limit ? history.slice(0, limit) : history;

    for (const item of itemsToProcess) {
      try {
        const txDetail = await l1GetTransaction(item.tx_hash) as TransactionDetail;
        if (!txDetail) continue;

        const tx = this.parseTransaction(txDetail, address, currentHeight, item);
        transactions.push(tx);
      } catch {
        // Skip failed transactions
        continue;
      }
    }

    return transactions;
  }

  /**
   * Get specific transaction with full details
   */
  async getTransaction(txid: string): Promise<L1Transaction | null> {
    this.ensureInitialized();
    await this.ensureConnected();

    try {
      const txDetail = await l1GetTransaction(txid) as TransactionDetail;
      if (!txDetail) return null;

      const currentHeight = await getCurrentBlockHeight();
      const address = this.deps!.identity.address;

      return this.parseTransaction(txDetail, address, currentHeight);
    } catch {
      return null;
    }
  }

  /**
   * Estimate fee for transaction
   */
  async estimateFee(
    to: string,
    amount: string
  ): Promise<{ fee: string; feeRate: number }> {
    this.ensureInitialized();
    await this.ensureConnected();

    const FIXED_FEE = 10_000;

    const l1Wallet = identityToL1Wallet(this.deps!.identity);
    const amountSats = BigInt(amount);
    const amountAlpha = Number(amountSats) / 100_000_000;

    try {
      const plan = await createTransactionPlan(
        l1Wallet,
        to,
        amountAlpha,
        this.deps!.identity.address
      );

      if (!plan.success) {
        throw new Error(plan.error ?? 'Cannot create transaction plan');
      }

      const totalFee = plan.transactions.reduce(
        (sum: number, tx: L1TxPlanItem) => sum + tx.fee,
        0
      );

      return {
        fee: totalFee.toString(),
        feeRate: this.config.defaultFeeRate,
      };
    } catch {
      return {
        fee: FIXED_FEE.toString(),
        feeRate: this.config.defaultFeeRate,
      };
    }
  }

  /**
   * Get current addresses
   */
  getAddresses(): string[] {
    this.ensureInitialized();
    return Array.from(this.addressSet);
  }

  /**
   * Add address to track
   */
  addAddress(address: string): void {
    this.addressSet.add(address);
  }

  /**
   * Get vesting threshold constant
   */
  getVestingThreshold(): number {
    return VESTING_THRESHOLD;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Parse transaction detail into L1Transaction format
   */
  private parseTransaction(
    txDetail: TransactionDetail,
    primaryAddress: string,
    currentHeight: number,
    historyItem?: TransactionHistoryItem
  ): L1Transaction {
    // Calculate received amount to our addresses
    const receivedAmount = calculateReceivedAmount(txDetail.vout, primaryAddress);

    // Calculate total input value (for sends)
    // Note: We can't directly determine sent amount without fetching input transactions
    // For simplicity, if we received coins, it's a receive; otherwise check if we're in inputs

    // Get output addresses that are NOT ours (counterparty for sends)
    const outputAddresses = getOutputAddresses(txDetail.vout);
    const externalAddresses = outputAddresses.filter(
      (addr) => !this.addressSet.has(addr)
    );

    // Determine transaction type
    // If we received coins, it's likely a receive
    // This is simplified - full implementation would trace inputs
    const isReceive = receivedAmount > 0;
    const type: 'send' | 'receive' = isReceive ? 'receive' : 'send';

    // Amount in satoshis
    const amountSats = Math.floor(receivedAmount * 100_000_000);

    // Counterparty address
    const counterpartyAddress = isReceive
      ? txDetail.vin[0]?.txid
        ? 'unknown' // Would need to trace input to get sender
        : 'coinbase'
      : externalAddresses[0] ?? 'unknown';

    // Block height and confirmations
    const blockHeight = historyItem?.height ?? (txDetail.confirmations
      ? currentHeight - txDetail.confirmations + 1
      : 0);
    const confirmations = txDetail.confirmations ?? (historyItem?.height
      ? currentHeight - historyItem.height + 1
      : 0);

    // Timestamp from block time
    const timestamp = txDetail.blocktime
      ? txDetail.blocktime * 1000
      : txDetail.time
        ? txDetail.time * 1000
        : Date.now();

    return {
      txid: txDetail.txid,
      type,
      amount: amountSats.toString(),
      fee: historyItem?.fee?.toString(),
      address: counterpartyAddress,
      confirmations,
      timestamp,
      blockHeight: blockHeight > 0 ? blockHeight : undefined,
    };
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new Error('L1PaymentsModule not initialized');
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createL1PaymentsModule(
  config?: L1PaymentsModuleConfig
): L1PaymentsModule {
  return new L1PaymentsModule(config);
}
