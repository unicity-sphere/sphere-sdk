/**
 * IPFS Multi-Tier Cache
 * Caches IPNS records, content by CID, and tracks gateway failures
 */

import type { IpnsGatewayResult } from './ipfs-types';
import type { TxfStorageDataBase } from '../../../storage';

// =============================================================================
// Cache Entry Type
// =============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// =============================================================================
// Default Config
// =============================================================================

const DEFAULT_IPNS_TTL_MS = 60_000;           // 60s for IPNS records
const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;   // 60s circuit breaker cooldown
const DEFAULT_FAILURE_THRESHOLD = 3;          // 3 consecutive failures
const DEFAULT_KNOWN_FRESH_WINDOW_MS = 30_000; // 30s after publish

// =============================================================================
// Cache Implementation
// =============================================================================

export interface IpfsCacheConfig {
  ipnsTtlMs?: number;
  failureCooldownMs?: number;
  failureThreshold?: number;
  knownFreshWindowMs?: number;
}

export class IpfsCache {
  private readonly ipnsRecords = new Map<string, CacheEntry<IpnsGatewayResult>>();
  private readonly content = new Map<string, CacheEntry<TxfStorageDataBase>>();
  private readonly gatewayFailures = new Map<string, { count: number; lastFailure: number }>();
  private readonly knownFreshTimestamps = new Map<string, number>();

  private readonly ipnsTtlMs: number;
  private readonly failureCooldownMs: number;
  private readonly failureThreshold: number;
  private readonly knownFreshWindowMs: number;

  constructor(config?: IpfsCacheConfig) {
    this.ipnsTtlMs = config?.ipnsTtlMs ?? DEFAULT_IPNS_TTL_MS;
    this.failureCooldownMs = config?.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.knownFreshWindowMs = config?.knownFreshWindowMs ?? DEFAULT_KNOWN_FRESH_WINDOW_MS;
  }

  // ---------------------------------------------------------------------------
  // IPNS Record Cache (60s TTL)
  // ---------------------------------------------------------------------------

  getIpnsRecord(ipnsName: string): IpnsGatewayResult | null {
    const entry = this.ipnsRecords.get(ipnsName);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ipnsTtlMs) {
      this.ipnsRecords.delete(ipnsName);
      return null;
    }

    return entry.data;
  }

  /**
   * Get cached IPNS record ignoring TTL (for known-fresh optimization).
   */
  getIpnsRecordIgnoreTtl(ipnsName: string): IpnsGatewayResult | null {
    const entry = this.ipnsRecords.get(ipnsName);
    return entry?.data ?? null;
  }

  setIpnsRecord(ipnsName: string, result: IpnsGatewayResult): void {
    this.ipnsRecords.set(ipnsName, {
      data: result,
      timestamp: Date.now(),
    });
  }

  invalidateIpns(ipnsName: string): void {
    this.ipnsRecords.delete(ipnsName);
  }

  // ---------------------------------------------------------------------------
  // Content Cache (infinite TTL - content is immutable by CID)
  // ---------------------------------------------------------------------------

  getContent(cid: string): TxfStorageDataBase | null {
    const entry = this.content.get(cid);
    return entry?.data ?? null;
  }

  setContent(cid: string, data: TxfStorageDataBase): void {
    this.content.set(cid, {
      data,
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Gateway Failure Tracking (Circuit Breaker)
  // ---------------------------------------------------------------------------

  /**
   * Record a gateway failure. After threshold consecutive failures,
   * the gateway enters cooldown and is considered unhealthy.
   */
  recordGatewayFailure(gateway: string): void {
    const existing = this.gatewayFailures.get(gateway);
    this.gatewayFailures.set(gateway, {
      count: (existing?.count ?? 0) + 1,
      lastFailure: Date.now(),
    });
  }

  /** Reset failure count for a gateway (on successful request) */
  recordGatewaySuccess(gateway: string): void {
    this.gatewayFailures.delete(gateway);
  }

  /**
   * Check if a gateway is currently in circuit breaker cooldown.
   * A gateway is considered unhealthy if it has had >= threshold
   * consecutive failures and the cooldown period hasn't elapsed.
   */
  isGatewayInCooldown(gateway: string): boolean {
    const failure = this.gatewayFailures.get(gateway);
    if (!failure) return false;

    if (failure.count < this.failureThreshold) return false;

    const elapsed = Date.now() - failure.lastFailure;
    if (elapsed >= this.failureCooldownMs) {
      // Cooldown expired, reset
      this.gatewayFailures.delete(gateway);
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Known-Fresh Flag (FAST mode optimization)
  // ---------------------------------------------------------------------------

  /**
   * Mark IPNS cache as "known-fresh" (after local publish or push notification).
   * Within the fresh window, we can skip network resolution.
   */
  markIpnsFresh(ipnsName: string): void {
    this.knownFreshTimestamps.set(ipnsName, Date.now());
  }

  /**
   * Check if the cache is known-fresh (within the fresh window).
   */
  isIpnsKnownFresh(ipnsName: string): boolean {
    const timestamp = this.knownFreshTimestamps.get(ipnsName);
    if (!timestamp) return false;

    if (Date.now() - timestamp > this.knownFreshWindowMs) {
      this.knownFreshTimestamps.delete(ipnsName);
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Cache Management
  // ---------------------------------------------------------------------------

  clear(): void {
    this.ipnsRecords.clear();
    this.content.clear();
    this.gatewayFailures.clear();
    this.knownFreshTimestamps.clear();
  }
}
