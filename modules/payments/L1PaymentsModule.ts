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
import { SphereError } from '../../core/errors';
import type { TransportProvider } from '../../transport';
import { DEFAULT_ELECTRUM_URL } from '../../constants';
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
  /** Transport provider for nametag resolution (optional) */
  transport?: TransportProvider;
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
  private _disabled = false;
  private _config: L1PaymentsModuleConfig;
  private _identity?: FullIdentity;
  private _addresses: string[] = [];
  private _wallet?: Wallet;
  private _transport?: TransportProvider;

  constructor(config?: L1PaymentsModuleConfig) {
    this._config = {
      electrumUrl: config?.electrumUrl ?? DEFAULT_ELECTRUM_URL,
      network: config?.network ?? 'mainnet',
      defaultFeeRate: config?.defaultFeeRate ?? 10,
      enableVesting: config?.enableVesting ?? true,
    };
  }

  async initialize(deps: L1PaymentsModuleDependencies): Promise<void> {
    this._identity = deps.identity;
    this._addresses = deps.addresses ?? [];
    this._transport = deps.transport;

    // Build wallet object for L1 SDK functions
    this._wallet = {
      masterPrivateKey: deps.identity.privateKey,
      chainCode: deps.chainCode,
      addresses: [
        {
          address: deps.identity.l1Address,
          publicKey: deps.identity.chainPubkey,
          privateKey: deps.identity.privateKey,
          path: 'm/0',
          index: 0,
        },
      ],
    };

    // Add additional addresses
    for (const addr of this._addresses) {
      if (addr !== deps.identity.l1Address) {
        this._wallet.addresses.push({
          address: addr,
          path: null,
          index: this._wallet.addresses.length,
        });
      }
    }

    // NOTE: We do NOT connect to Fulcrum here. Connection is deferred to
    // first use (ensureConnected) so that import + scan flows are not
    // disrupted by an early L1 WebSocket connection on the global singleton.

    this._initialized = true;
  }

  /**
   * Ensure the Fulcrum WebSocket is connected. Called lazily before any
   * operation that needs the network. If the singleton is already connected
   * (e.g. by the address scanner), this is a no-op.
   */
  private async ensureConnected(): Promise<void> {
    if (this._disabled) {
      throw new SphereError('L1 provider is disabled', 'NOT_INITIALIZED');
    }
    if (!isWebSocketConnected() && this._config.electrumUrl) {
      await l1Connect(this._config.electrumUrl);
    }
  }

  destroy(): void {
    if (isWebSocketConnected()) {
      l1Disconnect();
    }
    this._initialized = false;
    this._identity = undefined;
    this._addresses = [];
    this._wallet = undefined;
  }

  /**
   * Disable this module — disconnect WebSocket and block operations until re-enabled.
   */
  disable(): void {
    this._disabled = true;
    if (isWebSocketConnected()) {
      l1Disconnect();
    }
  }

  /**
   * Re-enable this module. Connection will be established lazily on next operation.
   */
  enable(): void {
    this._disabled = false;
  }

  get disabled(): boolean {
    return this._disabled;
  }

  /**
   * Check if a string looks like an L1 address (alpha1... or alphat1...)
   */
  private isL1Address(value: string): boolean {
    return value.startsWith('alpha1') || value.startsWith('alphat1');
  }

  /**
   * Resolve recipient to L1 address
   * Supports: L1 address (alpha1...), nametag (with or without @)
   */
  async resolveL1Address(recipient: string): Promise<string> {
    // Explicit nametag with @
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      return this.resolveNametagToL1Address(nametag);
    }

    // If it looks like an L1 address, return as-is
    if (this.isL1Address(recipient)) {
      return recipient;
    }

    // Smart detection: try as nametag
    try {
      const l1Address = await this.resolveNametagToL1Address(recipient);
      return l1Address;
    } catch {
      throw new SphereError(
        `Recipient "${recipient}" is not a valid nametag or L1 address. ` +
        `Use @nametag for explicit nametag or a valid alpha1... address.`,
        'INVALID_RECIPIENT'
      );
    }
  }

  /**
   * Resolve nametag to L1 address using transport provider
   */
  private async resolveNametagToL1Address(nametag: string): Promise<string> {
    if (!this._transport?.resolve) {
      throw new SphereError('Transport provider does not support resolution', 'TRANSPORT_ERROR');
    }

    const info = await this._transport.resolve(nametag);
    if (!info) {
      throw new SphereError(`Unicity ID not found: ${nametag}`, 'INVALID_RECIPIENT');
    }

    if (!info.l1Address) {
      throw new SphereError(
        `Nametag @${nametag} does not have L1 address information. ` +
        `The owner needs to update their nametag registration.`,
        'INVALID_RECIPIENT'
      );
    }

    return info.l1Address;
  }

  async send(request: L1SendRequest): Promise<L1SendResult> {
    this.ensureInitialized();
    await this.ensureConnected();

    if (!this._wallet || !this._identity) {
      return { success: false, error: 'No wallet available' };
    }

    try {
      // Resolve recipient to L1 address (supports nametag)
      const recipientAddress = await this.resolveL1Address(request.to);

      // Convert amount from satoshis to ALPHA
      const amountAlpha = parseInt(request.amount, 10) / 100_000_000;

      // Send using the L1 SDK
      const results = await l1SendAlpha(
        this._wallet,
        recipientAddress,
        amountAlpha,
        this._identity.l1Address
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
    await this.ensureConnected();

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
    await this.ensureConnected();

    const result: L1Utxo[] = [];
    const currentHeight = await getCurrentBlockHeight();
    const allUtxos = await this._getAllUtxos();

    // Classify if vesting is enabled
    const classifiedVested: Set<string> = new Set();
    const classifiedCoinbaseHeights: Map<string, number | null> = new Map();

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
    await this.ensureConnected();
    this.ensureInitialized();

    const addresses = this._getWatchedAddresses();
    const transactions: L1Transaction[] = [];
    const seenTxids = new Set<string>();
    const currentHeight = await getCurrentBlockHeight();

    // Cache for fetched transactions (avoids re-fetching the same tx)
    const txCache = new Map<string, TransactionDetail | null>();
    const fetchTx = async (txid: string): Promise<TransactionDetail | null> => {
      if (txCache.has(txid)) return txCache.get(txid)!;
      const detail = (await l1GetTransaction(txid)) as TransactionDetail | null;
      txCache.set(txid, detail);
      return detail;
    };

    const addressSet = new Set(addresses.map((a) => a.toLowerCase()));

    for (const address of addresses) {
      const history = await getTransactionHistory(address);

      for (const item of history) {
        if (seenTxids.has(item.tx_hash)) continue;
        seenTxids.add(item.tx_hash);

        const tx = await fetchTx(item.tx_hash);
        if (!tx) continue;

        // Resolve input addresses by looking up previous transactions
        let isSend = false;
        for (const vin of (tx.vin ?? [])) {
          if (!vin.txid) continue;
          const prevTx = await fetchTx(vin.txid);
          if (prevTx?.vout?.[vin.vout]) {
            const prevOut = prevTx.vout[vin.vout];
            const prevAddrs = [
              ...(prevOut.scriptPubKey?.addresses ?? []),
              ...(prevOut.scriptPubKey?.address ? [prevOut.scriptPubKey.address] : []),
            ];
            if (prevAddrs.some((a) => addressSet.has(a.toLowerCase()))) {
              isSend = true;
              break;
            }
          }
        }

        // Calculate amounts: sum outputs to us vs outputs to others
        let amountToUs = 0;
        let amountToOthers = 0;
        let txAddress = address;
        let externalAddress = '';
        if (tx.vout) {
          for (const vout of tx.vout) {
            const voutAddresses = [
              ...(vout.scriptPubKey?.addresses ?? []),
              ...(vout.scriptPubKey?.address ? [vout.scriptPubKey.address] : []),
            ];
            const isOurs = voutAddresses.some((a) => addressSet.has(a.toLowerCase()));
            const valueSats = Math.floor((vout.value ?? 0) * 100_000_000);
            if (isOurs) {
              amountToUs += valueSats;
              if (!txAddress) txAddress = voutAddresses[0];
            } else {
              amountToOthers += valueSats;
              if (!externalAddress && voutAddresses.length > 0) {
                externalAddress = voutAddresses[0];
              }
            }
          }
        }

        // For sends: amount is what went to external addresses; address is the recipient
        // For receives: amount is what came to us; address is our address
        const amount = isSend ? amountToOthers.toString() : amountToUs.toString();
        const displayAddress = isSend ? (externalAddress || txAddress) : txAddress;

        transactions.push({
          txid: item.tx_hash,
          type: isSend ? 'send' : 'receive',
          amount,
          address: displayAddress,
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
    await this.ensureConnected();

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
    await this.ensureConnected();

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
      throw new SphereError('L1PaymentsModule not initialized', 'NOT_INITIALIZED');
    }
  }

  private _getWatchedAddresses(): string[] {
    const addresses = [...this._addresses];
    if (this._identity?.l1Address && !addresses.includes(this._identity.l1Address)) {
      addresses.unshift(this._identity.l1Address);
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
