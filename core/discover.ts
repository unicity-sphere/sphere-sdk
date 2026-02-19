/**
 * HD Address Discovery — discover previously used addresses via transport binding events.
 *
 * Derives transport pubkeys for HD indices and batch-queries the relay.
 * Complements L1 scan (scan.ts) by finding L3-only addresses.
 */

import type { PeerInfo } from '../transport/transport-provider';

// =============================================================================
// Types
// =============================================================================

/** Progress callback for address discovery */
export interface DiscoverAddressProgress {
  /** Current batch being queried */
  currentBatch: number;
  /** Total batches planned */
  totalBatches: number;
  /** Number of addresses discovered so far */
  discoveredCount: number;
  /** Current gap count (consecutive empty indices) */
  currentGap: number;
  /** Phase: 'transport' or 'l1' */
  phase: 'transport' | 'l1';
}

/** Single discovered address result */
export interface DiscoveredAddress {
  /** HD derivation index */
  index: number;
  /** L1 bech32 address (alpha1...) */
  l1Address: string;
  /** L3 DIRECT address */
  directAddress: string;
  /** 33-byte compressed chain pubkey */
  chainPubkey: string;
  /** Nametag (from binding event) */
  nametag?: string;
  /** L1 balance in ALPHA (0 if only discovered via transport) */
  l1Balance: number;
  /** Discovery source */
  source: 'transport' | 'l1' | 'both';
}

/** Options for address discovery */
export interface DiscoverAddressesOptions {
  /** Max HD indices to probe (default: 50) */
  maxAddresses?: number;
  /** Stop after N consecutive empty indices (default: 20) */
  gapLimit?: number;
  /** Batch size for transport queries (default: 20) */
  batchSize?: number;
  /** Also run L1 balance scan (default: true) */
  includeL1Scan?: boolean;
  /** Progress callback */
  onProgress?: (progress: DiscoverAddressProgress) => void;
  /** Abort signal */
  signal?: AbortSignal;
  /** Auto-track discovered addresses (default: true) */
  autoTrack?: boolean;
}

/** Result of address discovery */
export interface DiscoverAddressesResult {
  /** All discovered addresses */
  addresses: DiscoveredAddress[];
  /** Total indices scanned */
  scannedCount: number;
  /** Whether scan was aborted */
  aborted: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/** Info derived for a single HD index */
interface DerivedAddressInfo {
  transportPubkey: string;
  chainPubkey: string;
  l1Address: string;
  directAddress: string;
}

/**
 * Discover used HD addresses via transport binding events.
 *
 * Derives transport pubkeys in batches, queries the relay, and uses
 * gap limit to determine when to stop.
 *
 * @param deriveTransportPubkey - function(index) → address info with transportPubkey
 * @param batchResolve - function(transportPubkeys[]) → PeerInfo[]
 * @param options - Discovery options
 */
export async function discoverAddressesImpl(
  deriveTransportPubkey: (index: number) => DerivedAddressInfo,
  batchResolve: (transportPubkeys: string[]) => Promise<PeerInfo[]>,
  options: DiscoverAddressesOptions = {},
): Promise<DiscoverAddressesResult> {
  const maxAddresses = options.maxAddresses ?? 50;
  const gapLimit = options.gapLimit ?? 20;
  const batchSize = options.batchSize ?? 20;
  const { onProgress, signal } = options;

  const discovered = new Map<number, DiscoveredAddress>();
  let consecutiveEmpty = 0;
  let scanned = 0;
  const totalBatches = Math.ceil(maxAddresses / batchSize);

  for (let batchStart = 0; batchStart < maxAddresses; batchStart += batchSize) {
    if (signal?.aborted) break;
    if (consecutiveEmpty >= gapLimit) break;

    const batchEnd = Math.min(batchStart + batchSize, maxAddresses);
    const batchIndices: number[] = [];
    const pubkeyToIndex = new Map<string, number>();
    const pubkeyToInfo = new Map<string, DerivedAddressInfo>();

    for (let i = batchStart; i < batchEnd; i++) {
      const info = deriveTransportPubkey(i);
      batchIndices.push(i);
      pubkeyToIndex.set(info.transportPubkey, i);
      pubkeyToInfo.set(info.transportPubkey, info);
    }

    const batchPubkeys = Array.from(pubkeyToIndex.keys());

    onProgress?.({
      currentBatch: Math.floor(batchStart / batchSize) + 1,
      totalBatches,
      discoveredCount: discovered.size,
      currentGap: consecutiveEmpty,
      phase: 'transport',
    });

    // Batch query relay
    const peerInfos = await batchResolve(batchPubkeys);

    // Map results back to indices
    const foundInBatch = new Set<number>();
    for (const peer of peerInfos) {
      const index = pubkeyToIndex.get(peer.transportPubkey);
      if (index !== undefined) {
        foundInBatch.add(index);
        const derived = pubkeyToInfo.get(peer.transportPubkey)!;
        discovered.set(index, {
          index,
          l1Address: peer.l1Address || derived.l1Address,
          directAddress: peer.directAddress || derived.directAddress,
          chainPubkey: peer.chainPubkey || derived.chainPubkey,
          nametag: peer.nametag,
          l1Balance: 0,
          source: 'transport',
        });
      }
    }

    // Update gap counter per-index
    for (const idx of batchIndices) {
      scanned++;
      if (foundInBatch.has(idx)) {
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
        if (consecutiveEmpty >= gapLimit) break;
      }
    }
  }

  return {
    addresses: Array.from(discovered.values()).sort((a, b) => a.index - b.index),
    scannedCount: scanned,
    aborted: signal?.aborted ?? false,
  };
}
