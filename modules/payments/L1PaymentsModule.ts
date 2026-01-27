/**
 * L1 Payments Sub-Module
 *
 * Handles Layer 1 (ALPHA blockchain) transactions including:
 * - Balance queries
 * - UTXO management
 * - Transaction sending
 * - Vesting classification
 * - Transaction history
 */

import type { FullIdentity } from '../../types';
import {
  connect as l1Connect,
  disconnect as l1Disconnect,
  isWebSocketConnected,
  getUtxo,
  getBalance as l1GetBalance,
  getTransactionHistory,
  getTransaction as l1GetTransaction,
  getCurrentBlockHeight,
  sendAlpha as l1SendAlpha,
  createTransactionPlan as l1CreateTransactionPlan,
  vestingClassifier,
  VESTING_THRESHOLD,
  type UTXO,
  type Wallet,
  type TransactionHistoryItem,
  type TransactionDetail,
} from '../../l1';

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
  chainCode?: string;
  addresses?: string[];
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * L1 Payments Module - Full Implementation
 *
 * Handles all L1 (ALPHA blockchain) operations including balance queries,
 * transaction sending, UTXO management, and vesting classification.
 */
export class L1PaymentsModule {
  private _initialized = false;
  private _config: L1PaymentsModuleConfig;
  private _identity?: FullIdentity;
  private _chainCode?: string;
  private _addresses: string[] = [];
  private _wallet?: Wallet;

  constructor(config?: L1PaymentsModuleConfig) {
    this._config = {
      electrumUrl: config?.electrumUrl ?? 'wss://fulcrum.alpha.unicity.network:50004',
      network: config?.network ?? 'mainnet',
      defaultFeeRate: config?.defaultFeeRate ?? 10,
      enableVesting: config?.enableVesting ?? true,
    };
  }

  async initialize(deps: L1PaymentsModuleDependencies): Promise<void> {
    this._identity = deps.identity;
    this._chainCode = deps.chainCode;
    this._addresses = deps.addresses ?? [];

    // Build wallet object for L1 SDK functions
    this._wallet = {
      masterPrivateKey: deps.identity.privateKey,
      chainCode: deps.chainCode,
      addresses: [
        {
          address: deps.identity.address,
          publicKey: deps.identity.publicKey,
          privateKey: deps.identity.privateKey,
          path: 'm/0',
          index: 0,
        },
      ],
    };

    // Add additional addresses
    for (const addr of this._addresses) {
      if (addr !== deps.identity.address) {
        this._wallet.addresses.push({
          address: addr,
          path: null,
          index: this._wallet.addresses.length,
        });
      }
    }

    // Connect to Fulcrum WebSocket
    if (this._config.electrumUrl) {
      await l1Connect(this._config.electrumUrl);
    }

    this._initialized = true;
  }

  destroy(): void {
    if (isWebSocketConnected()) {
      l1Disconnect();
    }
    this._initialized = false;
    this._identity = undefined;
    this._chainCode = undefined;
    this._addresses = [];
    this._wallet = undefined;
  }

  async send(request: L1SendRequest): Promise<L1SendResult> {
    this.ensureInitialized();

    if (!this._wallet || !this._identity) {
      return { success: false, error: 'No wallet available' };
    }

    try {
      // Convert amount from satoshis to ALPHA
      const amountAlpha = parseInt(request.amount, 10) / 100_000_000;

      // Send using the L1 SDK
      const results = await l1SendAlpha(
        this._wallet,
        request.to,
        amountAlpha,
        this._identity.address
      );

      if (results && results.length > 0) {
        // Calculate total fee from all transactions
        const txids = results.map((r) => r.txid);
        return {
          success: true,
          txHash: txids[0], // Return first txid (usually only one)
        };
      } else {
        return {
          success: false,
          error: 'Transaction failed - no results returned',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getBalance(): Promise<L1Balance> {
    this.ensureInitialized();

    const addresses = this._getWatchedAddresses();
    let totalAlpha = 0;
    let vestedSats = BigInt(0);
    let unvestedSats = BigInt(0);

    // Get balance for all addresses
    for (const address of addresses) {
      const balance = await l1GetBalance(address);
      totalAlpha += balance;
    }

    const totalSats = BigInt(Math.floor(totalAlpha * 100_000_000));

    // Calculate vesting if enabled
    if (this._config.enableVesting) {
      await vestingClassifier.initDB();
      const allUtxos = await this._getAllUtxos();
      const classified = await vestingClassifier.classifyUtxos(allUtxos);

      for (const utxo of classified.vested) {
        vestedSats += BigInt(utxo.value);
      }
      for (const utxo of classified.unvested) {
        unvestedSats += BigInt(utxo.value);
      }
    }

    return {
      confirmed: totalSats.toString(),
      unconfirmed: '0', // Simplified - would need separate tracking
      vested: vestedSats.toString(),
      unvested: unvestedSats.toString(),
      total: totalSats.toString(),
    };
  }

  async getUtxos(): Promise<L1Utxo[]> {
    this.ensureInitialized();

    const result: L1Utxo[] = [];
    const currentHeight = await getCurrentBlockHeight();
    const allUtxos = await this._getAllUtxos();

    // Classify if vesting is enabled
    let classifiedVested: Set<string> = new Set();
    let classifiedCoinbaseHeights: Map<string, number | null> = new Map();

    if (this._config.enableVesting) {
      await vestingClassifier.initDB();
      const classified = await vestingClassifier.classifyUtxos(allUtxos);

      for (const utxo of classified.vested) {
        const key = `${utxo.tx_hash}:${utxo.tx_pos}`;
        classifiedVested.add(key);
        classifiedCoinbaseHeights.set(key, utxo.coinbaseHeight ?? null);
      }
      for (const utxo of classified.unvested) {
        const key = `${utxo.tx_hash}:${utxo.tx_pos}`;
        classifiedCoinbaseHeights.set(key, utxo.coinbaseHeight ?? null);
      }
    }

    for (const utxo of allUtxos) {
      const key = `${utxo.tx_hash}:${utxo.tx_pos}`;
      const isVested = classifiedVested.has(key);
      const coinbaseHeight = classifiedCoinbaseHeights.get(key) ?? undefined;

      result.push({
        txid: utxo.tx_hash ?? utxo.txid ?? '',
        vout: utxo.tx_pos ?? utxo.vout ?? 0,
        amount: utxo.value.toString(),
        address: utxo.address ?? '',
        isVested,
        confirmations: currentHeight - (utxo.height || currentHeight),
        coinbaseHeight: coinbaseHeight ?? undefined,
      });
    }

    return result;
  }

  async getHistory(limit?: number): Promise<L1Transaction[]> {
    this.ensureInitialized();

    const addresses = this._getWatchedAddresses();
    const transactions: L1Transaction[] = [];
    const seenTxids = new Set<string>();
    const currentHeight = await getCurrentBlockHeight();

    for (const address of addresses) {
      const history = await getTransactionHistory(address);

      for (const item of history) {
        if (seenTxids.has(item.tx_hash)) continue;
        seenTxids.add(item.tx_hash);

        const tx = (await l1GetTransaction(item.tx_hash)) as TransactionDetail | null;
        if (!tx) continue;

        // Determine if this is a send or receive
        const isSend = tx.vin?.some((vin) =>
          addresses.includes(vin.txid ?? '')
        );

        // Calculate amount from outputs going to our addresses
        let amount = '0';
        let txAddress = address;
        if (tx.vout) {
          for (const vout of tx.vout) {
            const voutAddresses = vout.scriptPubKey?.addresses ?? [];
            if (vout.scriptPubKey?.address) {
              voutAddresses.push(vout.scriptPubKey.address);
            }
            const matchedAddr = voutAddresses.find((a) => addresses.includes(a));
            if (matchedAddr) {
              amount = Math.floor((vout.value ?? 0) * 100_000_000).toString();
              txAddress = matchedAddr;
              break;
            }
          }
        }

        transactions.push({
          txid: item.tx_hash,
          type: isSend ? 'send' : 'receive',
          amount,
          address: txAddress,
          confirmations: item.height > 0 ? currentHeight - item.height : 0,
          timestamp: tx.time ? tx.time * 1000 : Date.now(),
          blockHeight: item.height > 0 ? item.height : undefined,
        });
      }
    }

    // Sort by block height descending
    transactions.sort((a, b) => (b.blockHeight ?? 0) - (a.blockHeight ?? 0));

    return limit ? transactions.slice(0, limit) : transactions;
  }

  async getTransaction(txid: string): Promise<L1Transaction | null> {
    this.ensureInitialized();

    const tx = (await l1GetTransaction(txid)) as TransactionDetail | null;
    if (!tx) return null;

    const addresses = this._getWatchedAddresses();
    const currentHeight = await getCurrentBlockHeight();

    // Determine if this is a send (our address in inputs)
    const isSend = tx.vin?.some((vin) =>
      addresses.includes(vin.txid ?? '')
    );

    let amount = '0';
    let txAddress = '';
    if (tx.vout) {
      for (const vout of tx.vout) {
        const voutAddresses = vout.scriptPubKey?.addresses ?? [];
        if (vout.scriptPubKey?.address) {
          voutAddresses.push(vout.scriptPubKey.address);
        }
        const matchedAddr = voutAddresses.find((a) => addresses.includes(a));
        if (matchedAddr) {
          amount = Math.floor((vout.value ?? 0) * 100_000_000).toString();
          txAddress = matchedAddr;
          break;
        }
      }
    }

    return {
      txid,
      type: isSend ? 'send' : 'receive',
      amount,
      address: txAddress,
      confirmations: tx.confirmations ?? 0,
      timestamp: tx.time ? tx.time * 1000 : Date.now(),
      blockHeight: tx.confirmations ? currentHeight - tx.confirmations + 1 : undefined,
    };
  }

  async estimateFee(
    to: string,
    amount: string
  ): Promise<{ fee: string; feeRate: number }> {
    this.ensureInitialized();

    if (!this._wallet) {
      return { fee: '0', feeRate: this._config.defaultFeeRate ?? 10 };
    }

    try {
      // Convert satoshis to ALPHA
      const amountAlpha = parseInt(amount, 10) / 100_000_000;

      const plan = await l1CreateTransactionPlan(
        this._wallet,
        to,
        amountAlpha
      );

      if (!plan.success) {
        return { fee: '0', feeRate: this._config.defaultFeeRate ?? 10 };
      }

      // Sum fees from all transactions
      const totalFee = plan.transactions.reduce((sum, tx) => sum + tx.fee, 0);

      return {
        fee: totalFee.toString(),
        feeRate: this._config.defaultFeeRate ?? 10,
      };
    } catch {
      return { fee: '10000', feeRate: this._config.defaultFeeRate ?? 10 };
    }
  }

  getAddresses(): string[] {
    return [...this._addresses];
  }

  addAddress(address: string): void {
    if (!this._addresses.includes(address)) {
      this._addresses.push(address);

      // Also add to wallet object
      if (this._wallet) {
        this._wallet.addresses.push({
          address,
          path: null,
          index: this._wallet.addresses.length,
        });
      }
    }
  }

  getVestingThreshold(): number {
    return VESTING_THRESHOLD;
  }

  isConnected(): boolean {
    return isWebSocketConnected();
  }

  private ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error('L1PaymentsModule not initialized');
    }
  }

  private _getWatchedAddresses(): string[] {
    const addresses = [...this._addresses];
    if (this._identity?.address && !addresses.includes(this._identity.address)) {
      addresses.unshift(this._identity.address);
    }
    return addresses;
  }

  private async _getAllUtxos(): Promise<UTXO[]> {
    const addresses = this._getWatchedAddresses();
    const allUtxos: UTXO[] = [];

    for (const addr of addresses) {
      const utxos = await getUtxo(addr);
      allUtxos.push(...utxos);
    }

    return allUtxos;
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
