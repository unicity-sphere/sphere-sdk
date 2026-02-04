/**
 * Browser IPFS Storage Provider
 * Implements TokenStorageProvider using IPFS/IPNS for decentralized storage
 *
 * Uses a hybrid approach:
 * - HTTP API to backend gateways for fast publishing/resolution
 * - Helia for browser-based DHT operations as backup
 */

import type { ProviderStatus, FullIdentity } from '../../../types';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  TxfTombstone,
  SaveResult,
  LoadResult,
  SyncResult,
  StorageEvent,
  StorageEventCallback,
} from '../../../storage';
import {
  DEFAULT_IPFS_GATEWAYS,
  DEFAULT_IPFS_BOOTSTRAP_PEERS,
} from '../../../constants';

// Helia and IPFS types (runtime imports are dynamic)
import type { Helia } from 'helia';
import type { JSON as HeliaJSON } from '@helia/json';
import type { PrivateKey } from '@libp2p/interface';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Dynamic import cache
let heliaModule: typeof import('helia') | null = null;
let heliaJsonModule: typeof import('@helia/json') | null = null;
let libp2pBootstrapModule: typeof import('@libp2p/bootstrap') | null = null;
let libp2pCryptoModule: typeof import('@libp2p/crypto/keys') | null = null;
let libp2pPeerIdModule: typeof import('@libp2p/peer-id') | null = null;
let multiformatsCidModule: typeof import('multiformats/cid') | null = null;

async function loadHeliaModules() {
  if (!heliaModule) {
    [
      heliaModule,
      heliaJsonModule,
      libp2pBootstrapModule,
      libp2pCryptoModule,
      libp2pPeerIdModule,
      multiformatsCidModule,
    ] = await Promise.all([
      import('helia'),
      import('@helia/json'),
      import('@libp2p/bootstrap'),
      import('@libp2p/crypto/keys'),
      import('@libp2p/peer-id'),
      import('multiformats/cid'),
    ]);
  }
  return {
    createHelia: heliaModule!.createHelia,
    json: heliaJsonModule!.json,
    bootstrap: libp2pBootstrapModule!.bootstrap,
    generateKeyPairFromSeed: libp2pCryptoModule!.generateKeyPairFromSeed,
    peerIdFromPrivateKey: libp2pPeerIdModule!.peerIdFromPrivateKey,
    CID: multiformatsCidModule!.CID,
  };
}

/** HKDF info for IPNS key derivation */
const HKDF_INFO = new TextEncoder().encode('ipfs-storage-key');

// =============================================================================
// Configuration
// =============================================================================

export interface IpfsStorageProviderConfig {
  /** IPFS gateway URLs for HTTP API */
  gateways?: string[];
  /** Bootstrap peers for DHT */
  bootstrapPeers?: string[];
  /** Enable IPNS for mutable addressing */
  enableIpns?: boolean;
  /** IPNS publish timeout (ms) */
  ipnsTimeout?: number;
  /** Content fetch timeout (ms) */
  fetchTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export class IpfsStorageProvider<TData extends TxfStorageDataBase = TxfStorageDataBase>
  implements TokenStorageProvider<TData>
{
  readonly id = 'ipfs';
  readonly name = 'IPFS Storage';
  readonly type = 'p2p' as const;
  readonly description = 'Decentralized storage via IPFS/IPNS';

  private config: Required<IpfsStorageProviderConfig>;
  private identity: FullIdentity | null = null;
  private status: ProviderStatus = 'disconnected';
  private ipnsName: string | null = null;
  private lastCid: string | null = null;
  private eventCallbacks: Set<StorageEventCallback> = new Set();

  // Helia instance for browser-based IPFS
  private helia: Helia | null = null;
  private heliaJson: HeliaJSON | null = null;
  private ipnsKeyPair: PrivateKey | null = null;

  /** Get the last published CID */
  getLastCid(): string | null {
    return this.lastCid;
  }

  // Local cache for faster loads
  private localCache: TData | null = null;
  private cacheTimestamp = 0;

  constructor(config?: IpfsStorageProviderConfig) {
    this.config = {
      gateways: config?.gateways ?? [...DEFAULT_IPFS_GATEWAYS],
      bootstrapPeers: config?.bootstrapPeers ?? [...DEFAULT_IPFS_BOOTSTRAP_PEERS],
      enableIpns: config?.enableIpns ?? true,
      ipnsTimeout: config?.ipnsTimeout ?? 30000,
      fetchTimeout: config?.fetchTimeout ?? 15000,
      debug: config?.debug ?? false,
    };
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    try {
      // Test gateway connectivity first (fast path)
      await this.testGatewayConnectivity();

      // Initialize Helia for browser-based DHT
      await this.initializeHelia();

      this.status = 'connected';
      this.log('Connected to IPFS gateways and Helia initialized');
    } catch (error) {
      this.status = 'error';
      throw new Error(`IPFS connection failed: ${error}`);
    }
  }

  /**
   * Initialize Helia browser IPFS node
   */
  private async initializeHelia(): Promise<void> {
    if (this.helia) return;

    try {
      this.log('Initializing Helia with bootstrap peers...');

      const { createHelia, json, bootstrap } = await loadHeliaModules();

      this.helia = await createHelia({
        libp2p: {
          peerDiscovery: [
            bootstrap({ list: this.config.bootstrapPeers }),
          ],
          connectionManager: {
            maxConnections: 10,
          },
        },
      });

      this.heliaJson = json(this.helia);

      const peerId = this.helia.libp2p.peerId.toString();
      this.log('Helia initialized, browser peer ID:', peerId.slice(0, 20) + '...');

      // Log connections after a short delay
      setTimeout(() => {
        const connections = this.helia?.libp2p.getConnections() || [];
        this.log(`Active Helia connections: ${connections.length}`);
      }, 3000);
    } catch (error) {
      this.log('Helia initialization failed (will use HTTP only):', error);
      // Non-fatal - HTTP gateways still work
    }
  }

  async disconnect(): Promise<void> {
    // Stop Helia
    if (this.helia) {
      try {
        await this.helia.stop();
      } catch (error) {
        this.log('Error stopping Helia:', error);
      }
      this.helia = null;
      this.heliaJson = null;
    }

    this.status = 'disconnected';
    this.localCache = null;
    this.ipnsKeyPair = null;
    this.log('Disconnected from IPFS');
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // TokenStorageProvider Implementation
  // ===========================================================================

  async setIdentity(identity: FullIdentity): Promise<void> {
    this.identity = identity;

    // Derive IPNS key pair from wallet private key using HKDF
    try {
      const { generateKeyPairFromSeed, peerIdFromPrivateKey } = await loadHeliaModules();
      const walletSecret = this.hexToBytes(identity.privateKey);
      const derivedKey = hkdf(sha256, walletSecret, undefined, HKDF_INFO, 32);

      // Generate libp2p Ed25519 key pair for IPNS
      this.ipnsKeyPair = await generateKeyPairFromSeed('Ed25519', derivedKey);
      const peerId = peerIdFromPrivateKey(this.ipnsKeyPair);
      this.ipnsName = peerId.toString();

      this.log('Identity set, IPNS name:', this.ipnsName);
    } catch {
      // Fallback to provided IPNS name or simple derivation
      this.ipnsName = identity.ipnsName ?? this.deriveIpnsNameSimple(identity.privateKey);
      this.log('Identity set with fallback IPNS name:', this.ipnsName);
    }
  }

  async initialize(): Promise<boolean> {
    if (!this.identity) {
      throw new Error('Identity must be set before initialization');
    }

    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
  }

  async save(data: TData): Promise<SaveResult> {
    this.ensureReady();
    this.emitEvent({ type: 'storage:saving', timestamp: Date.now() });

    try {
      // Update metadata
      const dataToSave: TData = {
        ...data,
        _meta: {
          ...data._meta,
          updatedAt: Date.now(),
          ipnsName: this.ipnsName ?? undefined,
        },
      };

      // Publish to IPFS (parallel to all gateways)
      const cid = await this.publishToGateways(dataToSave);

      // Update IPNS if enabled
      if (this.config.enableIpns && this.ipnsName) {
        await this.publishIpns(cid);
      }

      // Update local cache
      this.localCache = dataToSave;
      this.cacheTimestamp = Date.now();
      this.lastCid = cid;

      this.emitEvent({ type: 'storage:saved', timestamp: Date.now(), data: { cid } });

      return {
        success: true,
        cid,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: 'storage:error', timestamp: Date.now(), error: errorMsg });

      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
      };
    }
  }

  async load(identifier?: string): Promise<LoadResult<TData>> {
    this.ensureReady();
    this.emitEvent({ type: 'storage:loading', timestamp: Date.now() });

    try {
      // Try local cache first (if recent)
      const cacheAge = Date.now() - this.cacheTimestamp;
      if (this.localCache && cacheAge < 60000) {
        this.log('Returning cached data');
        return {
          success: true,
          data: this.localCache,
          source: 'cache',
          timestamp: Date.now(),
        };
      }

      // Resolve IPNS or use direct CID
      let cid: string | null = identifier ?? null;

      if (!cid && this.config.enableIpns && this.ipnsName) {
        cid = await this.resolveIpns(this.ipnsName);
      }

      if (!cid) {
        // No remote data found
        return {
          success: true,
          data: undefined,
          source: 'remote',
          timestamp: Date.now(),
        };
      }

      // Fetch content
      const data = await this.fetchFromGateways<TData>(cid);

      // Update cache
      this.localCache = data;
      this.cacheTimestamp = Date.now();
      this.lastCid = cid;

      this.emitEvent({ type: 'storage:loaded', timestamp: Date.now() });

      return {
        success: true,
        data,
        source: 'remote',
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: 'storage:error', timestamp: Date.now(), error: errorMsg });

      // Fallback to cache on error
      if (this.localCache) {
        return {
          success: true,
          data: this.localCache,
          source: 'cache',
          timestamp: Date.now(),
        };
      }

      return {
        success: false,
        error: errorMsg,
        source: 'remote',
        timestamp: Date.now(),
      };
    }
  }

  async sync(localData: TData): Promise<SyncResult<TData>> {
    this.ensureReady();
    this.emitEvent({ type: 'sync:started', timestamp: Date.now() });

    try {
      // Load remote data
      const remoteResult = await this.load();
      const remoteData = remoteResult.data;

      if (!remoteData) {
        // No remote data, just save local
        await this.save(localData);
        this.emitEvent({ type: 'sync:completed', timestamp: Date.now() });
        return {
          success: true,
          merged: localData,
          added: 0,
          removed: 0,
          conflicts: 0,
        };
      }

      // Merge data
      const mergeResult = this.mergeData(localData, remoteData);

      // Save merged result
      await this.save(mergeResult.merged);

      this.emitEvent({ type: 'sync:completed', timestamp: Date.now() });

      return {
        success: true,
        merged: mergeResult.merged,
        added: mergeResult.added,
        removed: mergeResult.removed,
        conflicts: mergeResult.conflicts,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: 'sync:error', timestamp: Date.now(), error: errorMsg });

      return {
        success: false,
        added: 0,
        removed: 0,
        conflicts: 0,
        error: errorMsg,
      };
    }
  }

  async exists(): Promise<boolean> {
    if (!this.ipnsName) return false;

    try {
      const cid = await this.resolveIpns(this.ipnsName);
      return cid !== null;
    } catch {
      return false;
    }
  }

  async clear(): Promise<boolean> {
    // IPFS is immutable, we can only publish empty data
    const emptyData = {
      _meta: {
        version: 0,
        address: this.identity?.l1Address ?? '',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
      _tombstones: [],
    } as unknown as TData;

    const result = await this.save(emptyData);
    return result.success;
  }

  onEvent(callback: StorageEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: IPFS Operations
  // ===========================================================================

  private async testGatewayConnectivity(): Promise<void> {
    const gateway = this.config.gateways[0];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${gateway}/api/v0/version`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Gateway not responding');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async publishToGateways(data: TData): Promise<string> {
    const content = JSON.stringify(data);
    const blob = new Blob([content], { type: 'application/json' });

    // Strategy: Try both HTTP and Helia in parallel, return first success
    const promises: Promise<string>[] = [];

    // HTTP gateway publishing (fast path)
    for (const gateway of this.config.gateways) {
      promises.push(this.publishToGateway(gateway, blob));
    }

    // Helia DHT publishing (backup path)
    if (this.heliaJson) {
      promises.push(this.publishToHelia(data));
    }

    try {
      const cid = await Promise.any(promises);
      this.log('Published to IPFS, CID:', cid);
      return cid;
    } catch {
      throw new Error('All publish attempts failed');
    }
  }

  /**
   * Publish data via Helia (browser DHT)
   */
  private async publishToHelia(data: TData): Promise<string> {
    if (!this.heliaJson) {
      throw new Error('Helia not initialized');
    }

    const cid = await this.heliaJson.add(data);
    this.log('Published via Helia, CID:', cid.toString());
    return cid.toString();
  }

  private async publishToGateway(gateway: string, blob: Blob): Promise<string> {
    const formData = new FormData();
    formData.append('file', blob);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.fetchTimeout);

    try {
      const response = await fetch(`${gateway}/api/v0/add?pin=true`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Gateway ${gateway} returned ${response.status}`);
      }

      const result = await response.json();
      return result.Hash;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async publishIpns(cid: string): Promise<void> {
    if (!this.identity) return;

    // Publish to all gateways in parallel
    const promises = this.config.gateways.map((gateway) =>
      this.publishIpnsToGateway(gateway, cid).catch(() => null)
    );

    await Promise.allSettled(promises);
    this.log('Published IPNS:', this.ipnsName, '->', cid);
  }

  private async publishIpnsToGateway(gateway: string, cid: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.ipnsTimeout);

    try {
      const response = await fetch(
        `${gateway}/api/v0/name/publish?arg=${cid}&key=${this.ipnsName}`,
        {
          method: 'POST',
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`IPNS publish failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveIpns(name: string): Promise<string | null> {
    // Try each gateway
    for (const gateway of this.config.gateways) {
      try {
        return await this.resolveIpnsFromGateway(gateway, name);
      } catch {
        continue;
      }
    }
    return null;
  }

  private async resolveIpnsFromGateway(gateway: string, name: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.fetchTimeout);

    try {
      const response = await fetch(`${gateway}/api/v0/name/resolve?arg=${name}`, {
        method: 'POST',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`IPNS resolve failed: ${response.status}`);
      }

      const result = await response.json();
      // Path is like "/ipfs/Qm..."
      return result.Path.replace('/ipfs/', '');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchFromGateways<T>(cid: string): Promise<T> {
    // Strategy: Try both HTTP and Helia in parallel
    const promises: Promise<T>[] = [];

    // HTTP gateway fetching (fast path)
    for (const gateway of this.config.gateways) {
      promises.push(this.fetchFromGateway<T>(gateway, cid));
    }

    // Helia DHT fetching (backup path)
    if (this.heliaJson) {
      promises.push(this.fetchFromHelia<T>(cid));
    }

    return Promise.any(promises);
  }

  /**
   * Fetch content via Helia (browser DHT)
   */
  private async fetchFromHelia<T>(cidString: string): Promise<T> {
    if (!this.heliaJson) {
      throw new Error('Helia not initialized');
    }

    const { CID } = await loadHeliaModules();
    const cid = CID.parse(cidString);
    const data = await this.heliaJson.get(cid);
    this.log('Fetched via Helia, CID:', cidString);
    return data as T;
  }

  private async fetchFromGateway<T>(gateway: string, cid: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.fetchTimeout);

    try {
      const response = await fetch(`${gateway}/ipfs/${cid}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ===========================================================================
  // Private: Merge Logic
  // ===========================================================================

  private mergeData(
    local: TData,
    remote: TData
  ): { merged: TData; added: number; removed: number; conflicts: number } {
    const localVersion = local._meta?.version ?? 0;
    const remoteVersion = remote._meta?.version ?? 0;

    // Simple strategy: newer version wins for meta
    const baseMeta = remoteVersion > localVersion ? remote._meta : local._meta;

    // Merge tombstones (union)
    const tombstones = new Map<string, TxfTombstone>();
    for (const t of local._tombstones ?? []) {
      tombstones.set(t.tokenId, t);
    }
    for (const t of remote._tombstones ?? []) {
      const existing = tombstones.get(t.tokenId);
      if (!existing || t.timestamp > existing.timestamp) {
        tombstones.set(t.tokenId, t);
      }
    }

    // Merge token entries (newer wins, respect tombstones)
    const merged = {
      _meta: {
        ...baseMeta,
        version: Math.max(localVersion, remoteVersion) + 1,
        updatedAt: Date.now(),
      },
      _tombstones: Array.from(tombstones.values()),
    } as unknown as TData;

    let added = 0;
    let conflicts = 0;

    // Process all token entries from both sources
    const processedKeys = new Set<string>();

    for (const key of Object.keys(local)) {
      if (!key.startsWith('_') || key === '_meta' || key === '_tombstones') continue;
      processedKeys.add(key);

      const tokenId = key.slice(1); // Remove leading _
      if (tombstones.has(tokenId)) continue; // Deleted

      const localToken = local[key as keyof TData];
      const remoteToken = remote[key as keyof TData];

      if (remoteToken) {
        // Both have it - conflict resolution
        conflicts++;
        // Use local (could be smarter based on timestamps)
        (merged as Record<string, unknown>)[key] = localToken;
      } else {
        (merged as Record<string, unknown>)[key] = localToken;
      }
    }

    for (const key of Object.keys(remote)) {
      if (!key.startsWith('_') || key === '_meta' || key === '_tombstones') continue;
      if (processedKeys.has(key)) continue;

      const tokenId = key.slice(1);
      if (tombstones.has(tokenId)) continue;

      (merged as Record<string, unknown>)[key] = remote[key as keyof TData];
      added++;
    }

    return { merged, added, removed: 0, conflicts };
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureReady(): void {
    if (this.status !== 'connected') {
      throw new Error('IpfsStorageProvider not connected');
    }
    if (!this.identity) {
      throw new Error('Identity not set');
    }
  }

  /**
   * Simple IPNS name derivation (fallback when libp2p is unavailable)
   */
  private deriveIpnsNameSimple(privateKey: string): string {
    // Fallback: use truncated hash of private key
    return `12D3KooW${privateKey.slice(0, 40)}`;
  }

  /**
   * Convert hex string to Uint8Array
   */
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  private emitEvent(event: StorageEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('[IpfsStorageProvider] Event callback error:', error);
      }
    }
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[IpfsStorageProvider]', ...args);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createIpfsStorageProvider<TData extends TxfStorageDataBase = TxfStorageDataBase>(
  config?: IpfsStorageProviderConfig
): IpfsStorageProvider<TData> {
  return new IpfsStorageProvider<TData>(config);
}
