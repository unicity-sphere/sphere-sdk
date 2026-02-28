/**
 * IPFS HTTP Client
 * Fetch-based HTTP API client for IPFS gateway operations.
 * Works in both browser and Node.js (native fetch available since Node 18+).
 */

import { logger } from '../../../core/logger';
import type {
  IpnsGatewayResult,
  IpnsProgressiveResult,
  IpnsPublishResult,
  GatewayHealthResult,
} from './ipfs-types';
import type { TxfStorageDataBase } from '../../../storage';
import {
  IpfsError,
  classifyFetchError,
  classifyHttpStatus,
} from './ipfs-error-types';
import { IpfsCache } from './ipfs-cache';
import { parseRoutingApiResponse } from './ipns-record-manager';

// =============================================================================
// Default Timeouts
// =============================================================================

const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 10000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 30000;
const DEFAULT_GATEWAY_PATH_TIMEOUT_MS = 3000;
const DEFAULT_ROUTING_API_TIMEOUT_MS = 2000;

// =============================================================================
// HTTP Client
// =============================================================================

export interface IpfsHttpClientConfig {
  gateways: string[];
  fetchTimeoutMs?: number;
  resolveTimeoutMs?: number;
  publishTimeoutMs?: number;
  connectivityTimeoutMs?: number;
  debug?: boolean;
}

export class IpfsHttpClient {
  private readonly gateways: string[];
  private readonly fetchTimeoutMs: number;
  private readonly resolveTimeoutMs: number;
  private readonly publishTimeoutMs: number;
  private readonly connectivityTimeoutMs: number;
  private readonly debug: boolean;
  private readonly cache: IpfsCache;

  constructor(config: IpfsHttpClientConfig, cache: IpfsCache) {
    this.gateways = config.gateways;
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.resolveTimeoutMs = config.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
    this.publishTimeoutMs = config.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.connectivityTimeoutMs = config.connectivityTimeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS;
    this.debug = config.debug ?? false;
    this.cache = cache;
  }

  // ---------------------------------------------------------------------------
  // Public Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get configured gateway URLs.
   */
  getGateways(): string[] {
    return [...this.gateways];
  }

  // ---------------------------------------------------------------------------
  // Gateway Health
  // ---------------------------------------------------------------------------

  /**
   * Test connectivity to a single gateway.
   */
  async testConnectivity(gateway: string): Promise<GatewayHealthResult> {
    const start = Date.now();
    try {
      const response = await this.fetchWithTimeout(
        `${gateway}/api/v0/version`,
        this.connectivityTimeoutMs,
        { method: 'POST' },
      );

      if (!response.ok) {
        return { gateway, healthy: false, error: `HTTP ${response.status}` };
      }

      return {
        gateway,
        healthy: true,
        responseTimeMs: Date.now() - start,
      };
    } catch (error) {
      return {
        gateway,
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find healthy gateways from the configured list.
   */
  async findHealthyGateways(): Promise<string[]> {
    const results = await Promise.allSettled(
      this.gateways.map((gw) => this.testConnectivity(gw)),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<GatewayHealthResult> =>
        r.status === 'fulfilled' && r.value.healthy)
      .map((r) => r.value.gateway);
  }

  /**
   * Get gateways that are not in circuit breaker cooldown.
   */
  getAvailableGateways(): string[] {
    return this.gateways.filter((gw) => !this.cache.isGatewayInCooldown(gw));
  }

  // ---------------------------------------------------------------------------
  // Content Upload
  // ---------------------------------------------------------------------------

  /**
   * Upload JSON content to IPFS.
   * Tries all gateways in parallel, returns first success.
   */
  async upload(data: unknown, gateways?: string[]): Promise<{ cid: string }> {
    const targets = gateways ?? this.getAvailableGateways();
    if (targets.length === 0) {
      throw new IpfsError('No gateways available for upload', 'NETWORK_ERROR');
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(data));

    const promises = targets.map(async (gateway) => {
      try {
        const formData = new FormData();
        formData.append('file', new Blob([jsonBytes], { type: 'application/json' }), 'data.json');

        const response = await this.fetchWithTimeout(
          `${gateway}/api/v0/add?pin=true&cid-version=1`,
          this.publishTimeoutMs,
          { method: 'POST', body: formData },
        );

        if (!response.ok) {
          throw new IpfsError(
            `Upload failed: HTTP ${response.status}`,
            classifyHttpStatus(response.status),
            gateway,
          );
        }

        const result = await response.json();
        this.cache.recordGatewaySuccess(gateway);
        this.log(`Uploaded to ${gateway}: CID=${result.Hash}`);
        return { cid: result.Hash as string, gateway };
      } catch (error) {
        if (error instanceof IpfsError && error.shouldTriggerCircuitBreaker) {
          this.cache.recordGatewayFailure(gateway);
        }
        throw error;
      }
    });

    try {
      const result = await Promise.any(promises);
      return { cid: result.cid };
    } catch (error) {
      if (error instanceof AggregateError) {
        throw new IpfsError(
          `Upload failed on all gateways: ${error.errors.map(e => e.message).join('; ')}`,
          'NETWORK_ERROR',
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Content Fetch
  // ---------------------------------------------------------------------------

  /**
   * Fetch content by CID from IPFS gateways.
   * Checks content cache first. Races all gateways for fastest response.
   */
  async fetchContent<T extends TxfStorageDataBase>(
    cid: string,
    gateways?: string[],
  ): Promise<T> {
    // Check content cache (infinite TTL for immutable content)
    const cached = this.cache.getContent(cid);
    if (cached) {
      this.log(`Content cache hit for CID=${cid}`);
      return cached as T;
    }

    const targets = gateways ?? this.getAvailableGateways();
    if (targets.length === 0) {
      throw new IpfsError('No gateways available for fetch', 'NETWORK_ERROR');
    }

    const promises = targets.map(async (gateway) => {
      try {
        const response = await this.fetchWithTimeout(
          `${gateway}/ipfs/${cid}`,
          this.fetchTimeoutMs,
          { headers: { Accept: 'application/octet-stream' } },
        );

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new IpfsError(
            `Fetch failed: HTTP ${response.status}`,
            classifyHttpStatus(response.status, body),
            gateway,
          );
        }

        const data = await response.json() as T;
        this.cache.recordGatewaySuccess(gateway);
        this.cache.setContent(cid, data);
        this.log(`Fetched from ${gateway}: CID=${cid}`);
        return data;
      } catch (error) {
        if (error instanceof IpfsError && error.shouldTriggerCircuitBreaker) {
          this.cache.recordGatewayFailure(gateway);
        }
        throw error;
      }
    });

    try {
      return await Promise.any(promises);
    } catch (error) {
      if (error instanceof AggregateError) {
        throw new IpfsError(
          `Fetch failed on all gateways for CID=${cid}`,
          'NETWORK_ERROR',
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // IPNS Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve IPNS via Routing API (returns record with sequence number).
   * POST /api/v0/routing/get?arg=/ipns/{name}
   */
  async resolveIpnsViaRoutingApi(
    gateway: string,
    ipnsName: string,
    timeoutMs: number = DEFAULT_ROUTING_API_TIMEOUT_MS,
  ): Promise<IpnsGatewayResult | null> {
    try {
      const response = await this.fetchWithTimeout(
        `${gateway}/api/v0/routing/get?arg=/ipns/${ipnsName}`,
        timeoutMs,
        { method: 'POST' },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const category = classifyHttpStatus(response.status, body);
        if (category === 'NOT_FOUND') return null;
        throw new IpfsError(`Routing API: HTTP ${response.status}`, category, gateway);
      }

      const text = await response.text();
      const parsed = await parseRoutingApiResponse(text);

      if (!parsed) return null;

      this.cache.recordGatewaySuccess(gateway);
      return {
        cid: parsed.cid,
        sequence: parsed.sequence,
        gateway,
        recordData: parsed.recordData,
      };
    } catch (error) {
      if (error instanceof IpfsError) throw error;
      const category = classifyFetchError(error);
      if (category !== 'NOT_FOUND') {
        this.cache.recordGatewayFailure(gateway);
      }
      return null;
    }
  }

  /**
   * Resolve IPNS via gateway path (simpler, no sequence number).
   * GET /ipns/{name}?format=dag-json
   */
  async resolveIpnsViaGatewayPath(
    gateway: string,
    ipnsName: string,
    timeoutMs: number = DEFAULT_GATEWAY_PATH_TIMEOUT_MS,
  ): Promise<{ cid: string; content?: unknown } | null> {
    try {
      const response = await this.fetchWithTimeout(
        `${gateway}/ipns/${ipnsName}`,
        timeoutMs,
        { headers: { Accept: 'application/json' } },
      );

      if (!response.ok) return null;

      const content = await response.json();
      const cidHeader = response.headers.get('X-Ipfs-Path');
      if (cidHeader) {
        const match = cidHeader.match(/\/ipfs\/([a-zA-Z0-9]+)/);
        if (match) {
          this.cache.recordGatewaySuccess(gateway);
          return { cid: match[1], content };
        }
      }

      return { cid: '', content };
    } catch {
      return null;
    }
  }

  /**
   * Progressive IPNS resolution across all gateways.
   * Queries all gateways in parallel, returns highest sequence number.
   */
  async resolveIpns(
    ipnsName: string,
    gateways?: string[],
  ): Promise<IpnsProgressiveResult> {
    const targets = gateways ?? this.getAvailableGateways();
    if (targets.length === 0) {
      return { best: null, allResults: [], respondedCount: 0, totalGateways: 0 };
    }

    const results: IpnsGatewayResult[] = [];
    let respondedCount = 0;

    const promises = targets.map(async (gateway) => {
      const result = await this.resolveIpnsViaRoutingApi(
        gateway,
        ipnsName,
        this.resolveTimeoutMs,
      );
      if (result) results.push(result);
      respondedCount++;
      return result;
    });

    // Wait for all to complete (with overall timeout)
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) =>
        setTimeout(resolve, this.resolveTimeoutMs + 1000)),
    ]);

    // Find best result (highest sequence)
    let best: IpnsGatewayResult | null = null;
    for (const result of results) {
      if (!best || result.sequence > best.sequence) {
        best = result;
      }
    }

    if (best) {
      this.cache.setIpnsRecord(ipnsName, best);
    }

    return {
      best,
      allResults: results,
      respondedCount,
      totalGateways: targets.length,
    };
  }

  // ---------------------------------------------------------------------------
  // IPNS Publishing
  // ---------------------------------------------------------------------------

  /**
   * Publish IPNS record to a single gateway via routing API.
   */
  async publishIpnsViaRoutingApi(
    gateway: string,
    ipnsName: string,
    marshalledRecord: Uint8Array,
    timeoutMs: number = DEFAULT_PUBLISH_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([new Uint8Array(marshalledRecord)]),
        'record',
      );

      const response = await this.fetchWithTimeout(
        `${gateway}/api/v0/routing/put?arg=/ipns/${ipnsName}&allow-offline=true`,
        timeoutMs,
        { method: 'POST', body: formData },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new IpfsError(
          `IPNS publish: HTTP ${response.status}: ${errorText.slice(0, 100)}`,
          classifyHttpStatus(response.status, errorText),
          gateway,
        );
      }

      this.cache.recordGatewaySuccess(gateway);
      this.log(`IPNS published to ${gateway}: ${ipnsName}`);
      return true;
    } catch (error) {
      if (error instanceof IpfsError && error.shouldTriggerCircuitBreaker) {
        this.cache.recordGatewayFailure(gateway);
      }
      this.log(`IPNS publish to ${gateway} failed: ${error}`);
      return false;
    }
  }

  /**
   * Publish IPNS record to all gateways in parallel.
   */
  async publishIpns(
    ipnsName: string,
    marshalledRecord: Uint8Array,
    gateways?: string[],
  ): Promise<IpnsPublishResult> {
    const targets = gateways ?? this.getAvailableGateways();
    if (targets.length === 0) {
      return { success: false, error: 'No gateways available' };
    }

    const results = await Promise.allSettled(
      targets.map((gw) =>
        this.publishIpnsViaRoutingApi(gw, ipnsName, marshalledRecord, this.publishTimeoutMs)),
    );

    const successfulGateways: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        successfulGateways.push(targets[index]);
      }
    });

    return {
      success: successfulGateways.length > 0,
      ipnsName,
      successfulGateways,
      error: successfulGateways.length === 0 ? 'All gateways failed' : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // IPNS Verification
  // ---------------------------------------------------------------------------

  /**
   * Verify IPNS record persistence after publishing.
   * Retries resolution to confirm the record was accepted.
   */
  async verifyIpnsRecord(
    ipnsName: string,
    expectedSeq: bigint,
    expectedCid: string,
    retries: number = 3,
    delayMs: number = 1000,
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const { best } = await this.resolveIpns(ipnsName);
      if (best && best.sequence >= expectedSeq && best.cid === expectedCid) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
    options?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private log(message: string): void {
    logger.debug('IPFS-HTTP', message);
  }
}
