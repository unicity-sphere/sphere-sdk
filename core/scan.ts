/**
 * Address Scanning — Derive HD addresses and check L1 balances via Fulcrum.
 *
 * Used after importing BIP32/.dat wallets to discover which addresses have funds.
 */

import { logger } from './logger';
import type { AddressInfo } from './crypto';

// =============================================================================
// Types
// =============================================================================

/** Progress callback for address scanning */
export interface ScanAddressProgress {
  /** Number of addresses scanned so far */
  scanned: number;
  /** Total addresses to scan (maxAddresses * chains) */
  total: number;
  /** Current address being checked */
  currentAddress: string;
  /** Number of addresses found with balance */
  foundCount: number;
  /** Current gap count (consecutive empty addresses) */
  currentGap: number;
  /** Number of found addresses that have a nametag */
  nametagsFoundCount: number;
}

/** Single scanned address result */
export interface ScannedAddressResult {
  /** HD derivation index */
  index: number;
  /** L1 bech32 address (alpha1...) */
  address: string;
  /** Full BIP32 derivation path */
  path: string;
  /** L1 balance in ALPHA */
  balance: number;
  /** Whether this is a change address (chain 1) */
  isChange: boolean;
  /** Nametag associated with this address (resolved during scan) */
  nametag?: string;
}

/** Options for scanning addresses */
export interface ScanAddressesOptions {
  /** Maximum number of addresses to scan per chain (default: 50) */
  maxAddresses?: number;
  /** Stop after this many consecutive 0-balance addresses (default: 20) */
  gapLimit?: number;
  /** Also scan change addresses (chain 1) (default: true) */
  includeChange?: boolean;
  /** Progress callback */
  onProgress?: (progress: ScanAddressProgress) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Resolve nametag for a found address. Return nametag string or null. */
  resolveNametag?: (l1Address: string) => Promise<string | null>;
}

/** Result of scanning */
export interface ScanAddressesResult {
  /** All addresses found with non-zero balance */
  addresses: ScannedAddressResult[];
  /** Total balance across all found addresses (in ALPHA) */
  totalBalance: number;
  /** Number of addresses actually scanned */
  scannedCount: number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Scan blockchain addresses to discover used addresses with balances.
 * Derives addresses sequentially and checks L1 balance via Fulcrum.
 * Uses gap limit to stop after N consecutive empty addresses.
 *
 * @param deriveAddress - Function to derive an address at a given index
 * @param options - Scanning options
 * @returns Scan results with found addresses and total balance
 */
export async function scanAddressesImpl(
  deriveAddress: (index: number, isChange: boolean) => AddressInfo,
  options: ScanAddressesOptions = {},
): Promise<ScanAddressesResult> {
  const maxAddresses = options.maxAddresses ?? 50;
  const gapLimit = options.gapLimit ?? 20;
  const includeChange = options.includeChange ?? true;
  const { onProgress, signal, resolveNametag } = options;

  // Dynamic import to avoid hard dependency on L1 for non-L1 consumers
  const { connect, getBalance } = await import('../l1/network');
  await connect();

  const foundAddresses: ScannedAddressResult[] = [];
  let totalBalance = 0;
  let totalScanned = 0;
  let nametagsFoundCount = 0;

  const chains: boolean[] = includeChange ? [false, true] : [false];
  const totalToScan = maxAddresses * chains.length;

  for (const isChange of chains) {
    let consecutiveEmpty = 0;

    for (let index = 0; index < maxAddresses; index++) {
      if (signal?.aborted) break;

      const addrInfo = deriveAddress(index, isChange);
      totalScanned++;

      onProgress?.({
        scanned: totalScanned,
        total: totalToScan,
        currentAddress: addrInfo.address,
        foundCount: foundAddresses.length,
        currentGap: consecutiveEmpty,
        nametagsFoundCount,
      });

      try {
        const balance = await getBalance(addrInfo.address);

        if (balance > 0) {
          // Resolve nametag for addresses with balance
          let nametag: string | undefined;
          if (resolveNametag) {
            try {
              const tag = await resolveNametag(addrInfo.address);
              if (tag) {
                nametag = tag;
                nametagsFoundCount++;
              }
            } catch {
              // Nametag resolution failure is non-fatal
            }
          }

          foundAddresses.push({
            index,
            address: addrInfo.address,
            path: addrInfo.path,
            balance,
            isChange,
            nametag,
          });
          totalBalance += balance;
          consecutiveEmpty = 0;
        } else {
          consecutiveEmpty++;
        }
      } catch (err) {
        // Network error — count as empty to avoid hanging
        logger.warn('Sphere', `scanAddresses: Error checking ${addrInfo.address}:`, err);
        consecutiveEmpty++;
      }

      if (consecutiveEmpty >= gapLimit) {
        break;
      }

      // Yield every 5 addresses to keep UI responsive
      if (totalScanned % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (signal?.aborted) break;
  }

  return {
    addresses: foundAddresses,
    totalBalance,
    scannedCount: totalScanned,
  };
}
