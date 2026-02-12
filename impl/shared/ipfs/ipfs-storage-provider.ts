/**
 * IPFS Storage Provider
 * Main TokenStorageProvider implementation using IPFS/IPNS.
 * Shared cross-platform module (browser + Node.js via native fetch).
 *
 * Uses a write-behind buffer for non-blocking save() operations.
 * Writes are accepted immediately and flushed to IPFS asynchronously.
 */

import type { ProviderStatus, FullIdentity } from '../../../types';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  SaveResult,
  LoadResult,
  SyncResult,
  StorageEventCallback,
  StorageEvent,
} from '../../../storage';
import type {
  IpfsStorageConfig,
  IpfsStatePersistence,
} from './ipfs-types';
import type { WebSocketFactory } from '../../../transport/websocket';
import { getIpfsGatewayUrls } from '../../../constants';
import { IpfsCache } from './ipfs-cache';
import { IpfsHttpClient } from './ipfs-http-client';
import { IpnsSubscriptionClient } from './ipns-subscription-client';
import { deriveIpnsIdentity } from './ipns-key-derivation';
import { createSignedRecord } from './ipns-record-manager';
import { mergeTxfData } from './txf-merge';
import { InMemoryIpfsStatePersistence } from './ipfs-state-persistence';
import { AsyncSerialQueue, WriteBuffer } from './write-behind-buffer';

// =============================================================================
// Implementation
// =============================================================================

export class IpfsStorageProvider<TData extends TxfStorageDataBase = TxfStorageDataBase>
  implements TokenStorageProvider<TData>
{
  readonly id = 'ipfs';
  readonly name = 'IPFS Storage';
  readonly type = 'p2p' as const;

  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;
  private ipnsKeyPair: unknown = null;
  private ipnsName: string | null = null;
  private ipnsSequenceNumber: bigint = 0n;
  private lastCid: string | null = null;
  private lastKnownRemoteSequence: bigint = 0n;
  private dataVersion = 0;

  /**
   * The CID currently stored on the sidecar for this IPNS name.
   * Used as `_meta.lastCid` in the next save to satisfy chain validation.
   * - null for bootstrap (first-ever save)
   * - set after every successful save() or load()
   */
  private remoteCid: string | null = null;

  private readonly cache: IpfsCache;
  private readonly httpClient: IpfsHttpClient;
  private readonly statePersistence: IpfsStatePersistence;
  private readonly eventCallbacks: Set<StorageEventCallback> = new Set();
  private readonly debug: boolean;
  private readonly ipnsLifetimeMs: number;

  /** WebSocket factory for push subscriptions */
  private readonly createWebSocket: WebSocketFactory | undefined;
  /** Override WS URL */
  private readonly wsUrl: string | undefined;
  /** Fallback poll interval (default: 90000) */
  private readonly fallbackPollIntervalMs: number;
  /** IPNS subscription client for push notifications */
  private subscriptionClient: IpnsSubscriptionClient | null = null;
  /** Unsubscribe function from subscription client */
  private subscriptionUnsubscribe: (() => void) | null = null;

  /** In-memory buffer for individual token save/delete calls */
  private tokenBuffer: Map<string, unknown> = new Map();
  private deletedTokenIds: Set<string> = new Set();

  /** Write-behind buffer: serializes flush / sync / shutdown */
  private readonly flushQueue = new AsyncSerialQueue();
  /** Pending mutations not yet flushed to IPFS */
  private pendingBuffer = new WriteBuffer();
  /** Debounce timer for background flush */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce interval in ms */
  private readonly flushDebounceMs: number;
  /** Set to true during shutdown to prevent new flushes */
  private isShuttingDown = false;

  constructor(
    config?: IpfsStorageConfig,
    statePersistence?: IpfsStatePersistence,
  ) {
    const gateways = config?.gateways ?? getIpfsGatewayUrls();
    this.debug = config?.debug ?? false;
    this.ipnsLifetimeMs = config?.ipnsLifetimeMs ?? (99 * 365 * 24 * 60 * 60 * 1000);
    this.flushDebounceMs = config?.flushDebounceMs ?? 2000;

    this.cache = new IpfsCache({
      ipnsTtlMs: config?.ipnsCacheTtlMs,
      failureCooldownMs: config?.circuitBreakerCooldownMs,
      failureThreshold: config?.circuitBreakerThreshold,
      knownFreshWindowMs: config?.knownFreshWindowMs,
    });

    this.httpClient = new IpfsHttpClient({
      gateways,
      fetchTimeoutMs: config?.fetchTimeoutMs,
      resolveTimeoutMs: config?.resolveTimeoutMs,
      publishTimeoutMs: config?.publishTimeoutMs,
      connectivityTimeoutMs: config?.connectivityTimeoutMs,
      debug: this.debug,
    }, this.cache);

    this.statePersistence = statePersistence ?? new InMemoryIpfsStatePersistence();
    this.createWebSocket = config?.createWebSocket;
    this.wsUrl = config?.wsUrl;
    this.fallbackPollIntervalMs = config?.fallbackPollIntervalMs ?? 90000;
  }

  // ---------------------------------------------------------------------------
  // BaseProvider interface
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ---------------------------------------------------------------------------
  // Identity & Initialization
  // ---------------------------------------------------------------------------

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
  }

  async initialize(): Promise<boolean> {
    if (!this.identity) {
      this.log('Cannot initialize: no identity set');
      return false;
    }

    this.status = 'connecting';
    this.emitEvent({ type: 'storage:loading', timestamp: Date.now() });

    try {
      // Derive IPNS key pair and name from wallet private key
      const { keyPair, ipnsName } = await deriveIpnsIdentity(this.identity.privateKey);
      this.ipnsKeyPair = keyPair;
      this.ipnsName = ipnsName;
      this.log(`IPNS name derived: ${ipnsName}`);

      // Load persisted state
      const persisted = await this.statePersistence.load(ipnsName);
      if (persisted) {
        this.ipnsSequenceNumber = BigInt(persisted.sequenceNumber);
        this.lastCid = persisted.lastCid;
        this.remoteCid = persisted.lastCid; // chain link for next save
        this.dataVersion = persisted.version;
        this.log(`Loaded persisted state: seq=${this.ipnsSequenceNumber}, cid=${this.lastCid}`);
      }

      // Set up IPNS push subscription if WebSocket factory is available
      if (this.createWebSocket) {
        try {
          const wsUrlFinal = this.wsUrl ?? this.deriveWsUrl();
          if (wsUrlFinal) {
            this.subscriptionClient = new IpnsSubscriptionClient({
              wsUrl: wsUrlFinal,
              createWebSocket: this.createWebSocket,
              debug: this.debug,
            });

            // Subscribe to own IPNS name
            this.subscriptionUnsubscribe = this.subscriptionClient.subscribe(
              ipnsName,
              (update) => {
                this.log(`Push update: seq=${update.sequence}, cid=${update.cid}`);
                this.emitEvent({
                  type: 'storage:remote-updated',
                  timestamp: Date.now(),
                  data: { name: update.name, sequence: update.sequence, cid: update.cid },
                });
              },
            );

            // Set fallback poll for when WS is disconnected
            this.subscriptionClient.setFallbackPoll(
              () => this.pollForRemoteChanges(),
              this.fallbackPollIntervalMs,
            );

            // Connect (non-blocking)
            this.subscriptionClient.connect();
          }
        } catch (wsError) {
          this.log(`Failed to set up IPNS subscription: ${wsError}`);
          // Non-fatal — provider works without push notifications
        }
      }

      // Test gateway connectivity (non-blocking, don't fail on it)
      this.httpClient.findHealthyGateways().then((healthy) => {
        if (healthy.length > 0) {
          this.log(`${healthy.length} healthy gateway(s) found`);
        } else {
          this.log('Warning: no healthy gateways found');
        }
      }).catch(() => {
        // Non-fatal
      });

      this.isShuttingDown = false;
      this.status = 'connected';
      this.emitEvent({ type: 'storage:loaded', timestamp: Date.now() });
      return true;
    } catch (error) {
      this.status = 'error';
      this.emitEvent({
        type: 'storage:error',
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Cancel any pending debounced flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush — drain any pending writes
    await this.flushQueue.enqueue(async () => {
      if (!this.pendingBuffer.isEmpty) {
        try {
          await this.executeFlush();
        } catch {
          this.log('Final flush on shutdown failed (data may be lost)');
        }
      }
    });

    // Disconnect subscription client
    if (this.subscriptionUnsubscribe) {
      this.subscriptionUnsubscribe();
      this.subscriptionUnsubscribe = null;
    }
    if (this.subscriptionClient) {
      this.subscriptionClient.disconnect();
      this.subscriptionClient = null;
    }

    this.cache.clear();
    this.status = 'disconnected';
  }

  // ---------------------------------------------------------------------------
  // Save (non-blocking — buffers data for async flush)
  // ---------------------------------------------------------------------------

  async save(data: TData): Promise<SaveResult> {
    if (!this.ipnsKeyPair || !this.ipnsName) {
      return { success: false, error: 'Not initialized', timestamp: Date.now() };
    }

    // Buffer the data for async flush
    this.pendingBuffer.txfData = data;
    this.scheduleFlush();

    // Return immediately — flush happens in background
    return { success: true, timestamp: Date.now() };
  }

  // ---------------------------------------------------------------------------
  // Internal: Blocking save (used by sync and executeFlush)
  // ---------------------------------------------------------------------------

  /**
   * Perform the actual upload + IPNS publish synchronously.
   * Called by executeFlush() and sync() — never by public save().
   */
  private async _doSave(data: TData): Promise<SaveResult> {
    if (!this.ipnsKeyPair || !this.ipnsName) {
      return { success: false, error: 'Not initialized', timestamp: Date.now() };
    }

    this.emitEvent({ type: 'storage:saving', timestamp: Date.now() });

    try {
      // Update meta with chain-validation fields required by sidecar:
      // - lastCid: must equal the CID currently stored on sidecar (null for bootstrap)
      // - version: must be exactly current_version + 1 (for normal updates)
      this.dataVersion++;
      const metaUpdate: Record<string, unknown> = {
        ...data._meta,
        version: this.dataVersion,
        ipnsName: this.ipnsName,
        updatedAt: Date.now(),
      };
      if (this.remoteCid) {
        // Normal update: chain to previous CID
        metaUpdate.lastCid = this.remoteCid;
      }
      // Bootstrap (remoteCid is null): do NOT include lastCid field at all
      const updatedData = { ...data, _meta: metaUpdate } as unknown as Record<string, unknown>;

      // Inject buffered tokens into TXF data
      for (const [tokenId, tokenData] of this.tokenBuffer) {
        if (!this.deletedTokenIds.has(tokenId)) {
          updatedData[tokenId] = tokenData;
        }
      }
      // Remove deleted tokens from the payload
      for (const tokenId of this.deletedTokenIds) {
        delete updatedData[tokenId];
      }

      // Upload to IPFS
      const { cid } = await this.httpClient.upload(updatedData);
      this.log(`Content uploaded: CID=${cid}`);

      // Compute new sequence: max(local, remote) + 1
      const baseSeq = this.ipnsSequenceNumber > this.lastKnownRemoteSequence
        ? this.ipnsSequenceNumber
        : this.lastKnownRemoteSequence;
      const newSeq = baseSeq + 1n;

      // Create signed IPNS record
      const marshalledRecord = await createSignedRecord(
        this.ipnsKeyPair,
        cid,
        newSeq,
        this.ipnsLifetimeMs,
      );

      // Publish to all gateways
      const publishResult = await this.httpClient.publishIpns(
        this.ipnsName,
        marshalledRecord,
      );

      if (!publishResult.success) {
        // Rollback version (sequence was not yet updated)
        this.dataVersion--;
        this.log(`IPNS publish failed: ${publishResult.error}`);
        return {
          success: false,
          error: publishResult.error ?? 'IPNS publish failed',
          timestamp: Date.now(),
        };
      }

      // Update local state
      this.ipnsSequenceNumber = newSeq;
      this.lastCid = cid;
      this.remoteCid = cid; // next save chains to this CID

      // Update cache
      this.cache.setIpnsRecord(this.ipnsName, {
        cid,
        sequence: newSeq,
        gateway: 'local',
      });
      this.cache.setContent(cid, updatedData as unknown as TxfStorageDataBase);
      this.cache.markIpnsFresh(this.ipnsName);

      // Persist state
      await this.statePersistence.save(this.ipnsName, {
        sequenceNumber: newSeq.toString(),
        lastCid: cid,
        version: this.dataVersion,
      });

      // Clear deleted set — deletions have been persisted
      this.deletedTokenIds.clear();

      this.emitEvent({
        type: 'storage:saved',
        timestamp: Date.now(),
        data: { cid, sequence: newSeq.toString() },
      });

      this.log(`Saved: CID=${cid}, seq=${newSeq}`);
      return { success: true, cid, timestamp: Date.now() };
    } catch (error) {
      // Rollback version on any error
      this.dataVersion--;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'storage:error',
        timestamp: Date.now(),
        error: errorMessage,
      });
      return { success: false, error: errorMessage, timestamp: Date.now() };
    }
  }

  // ---------------------------------------------------------------------------
  // Write-behind buffer: scheduling and flushing
  // ---------------------------------------------------------------------------

  /**
   * Schedule a debounced background flush.
   * Resets the timer on each call so rapid mutations coalesce.
   */
  private scheduleFlush(): void {
    if (this.isShuttingDown) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushQueue.enqueue(() => this.executeFlush()).catch((err) => {
        this.log(`Background flush failed: ${err}`);
      });
    }, this.flushDebounceMs);
  }

  /**
   * Execute a flush of the pending buffer to IPFS.
   * Runs inside AsyncSerialQueue for concurrency safety.
   */
  private async executeFlush(): Promise<void> {
    if (this.pendingBuffer.isEmpty) return;

    // 1. Swap: take pending → active, create new empty pending
    const active = this.pendingBuffer;
    this.pendingBuffer = new WriteBuffer();

    try {
      // 2. Build the data to save
      //    Use buffered TXF data if available, otherwise build minimal payload
      const baseData = (active.txfData ?? {
        _meta: { version: 0, address: this.identity?.directAddress ?? '', formatVersion: '2.0', updatedAt: 0 },
      }) as TData;

      // 3. Perform the actual blocking save
      const result = await this._doSave(baseData);

      if (!result.success) {
        throw new Error(result.error ?? 'Save failed');
      }

      this.log(`Flushed successfully: CID=${result.cid}`);
    } catch (error) {
      // 4. Rollback: merge active back into pending
      this.pendingBuffer.mergeFrom(active);

      const msg = error instanceof Error ? error.message : String(error);
      this.log(`Flush failed (will retry): ${msg}`);

      // Schedule retry
      this.scheduleFlush();

      throw error; // re-throw so callers (e.g. shutdown) know it failed
    }
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  async load(identifier?: string): Promise<LoadResult<TData>> {
    if (!this.ipnsName && !identifier) {
      return { success: false, error: 'Not initialized', source: 'local', timestamp: Date.now() };
    }

    this.emitEvent({ type: 'storage:loading', timestamp: Date.now() });

    try {
      // If a specific CID is given, fetch directly
      if (identifier) {
        const data = await this.httpClient.fetchContent<TData>(identifier);
        return { success: true, data, source: 'remote', timestamp: Date.now() };
      }

      const ipnsName = this.ipnsName!;

      // Check known-fresh cache
      if (this.cache.isIpnsKnownFresh(ipnsName)) {
        const cached = this.cache.getIpnsRecordIgnoreTtl(ipnsName);
        if (cached) {
          const content = this.cache.getContent(cached.cid);
          if (content) {
            this.log('Using known-fresh cached data');
            return { success: true, data: content as TData, source: 'cache', timestamp: Date.now() };
          }
        }
      }

      // Check IPNS cache (60s TTL)
      const cachedRecord = this.cache.getIpnsRecord(ipnsName);
      if (cachedRecord) {
        const content = this.cache.getContent(cachedRecord.cid);
        if (content) {
          this.log('IPNS cache hit');
          return { success: true, data: content as TData, source: 'cache', timestamp: Date.now() };
        }
        // Have CID but not content — fetch content
        try {
          const data = await this.httpClient.fetchContent<TData>(cachedRecord.cid);
          return { success: true, data, source: 'remote', timestamp: Date.now() };
        } catch {
          // Fall through to full resolution
        }
      }

      // Resolve IPNS from network
      const { best } = await this.httpClient.resolveIpns(ipnsName);

      if (!best) {
        // Not found — could be a new wallet
        this.log('IPNS record not found (new wallet?)');
        return { success: false, error: 'IPNS record not found', source: 'remote', timestamp: Date.now() };
      }

      // Track remote sequence and CID for chain validation
      if (best.sequence > this.lastKnownRemoteSequence) {
        this.lastKnownRemoteSequence = best.sequence;
      }
      this.remoteCid = best.cid;

      // Fetch content
      const data = await this.httpClient.fetchContent<TData>(best.cid);

      // Track remote version for correct version chaining
      const remoteVersion = (data as TxfStorageDataBase)?._meta?.version;
      if (typeof remoteVersion === 'number' && remoteVersion > this.dataVersion) {
        this.dataVersion = remoteVersion;
      }

      // Populate token buffer from loaded data
      this.populateTokenBuffer(data as TxfStorageDataBase);

      this.emitEvent({
        type: 'storage:loaded',
        timestamp: Date.now(),
        data: { cid: best.cid, sequence: best.sequence.toString() },
      });

      return { success: true, data, source: 'remote', timestamp: Date.now() };
    } catch (error) {
      // On network error, try to return cached data
      if (this.ipnsName) {
        const cached = this.cache.getIpnsRecordIgnoreTtl(this.ipnsName);
        if (cached) {
          const content = this.cache.getContent(cached.cid);
          if (content) {
            this.log('Network error, returning stale cache');
            return { success: true, data: content as TData, source: 'cache', timestamp: Date.now() };
          }
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'storage:error',
        timestamp: Date.now(),
        error: errorMessage,
      });
      return { success: false, error: errorMessage, source: 'remote', timestamp: Date.now() };
    }
  }

  // ---------------------------------------------------------------------------
  // Sync (enters serial queue to avoid concurrent IPNS conflicts)
  // ---------------------------------------------------------------------------

  async sync(localData: TData): Promise<SyncResult<TData>> {
    return this.flushQueue.enqueue(async () => {
      // Cancel any pending debounced flush (we'll save as part of sync)
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      this.emitEvent({ type: 'sync:started', timestamp: Date.now() });

      try {
        // Drain pending buffer — its data will be included via the sync save
        this.pendingBuffer.clear();

        // Load remote data
        const remoteResult = await this.load();

        if (!remoteResult.success || !remoteResult.data) {
          // No remote data — save local as initial
          this.log('No remote data found, uploading local data');
          const saveResult = await this._doSave(localData);
          this.emitEvent({ type: 'sync:completed', timestamp: Date.now() });
          return {
            success: saveResult.success,
            merged: this.enrichWithTokenBuffer(localData),
            added: 0,
            removed: 0,
            conflicts: 0,
            error: saveResult.error,
          };
        }

        const remoteData = remoteResult.data;

        // Check if merge is needed
        const localVersion = localData._meta?.version ?? 0;
        const remoteVersion = remoteData._meta?.version ?? 0;

        if (localVersion === remoteVersion && this.lastCid) {
          // Same version — no merge needed
          this.log('Data is in sync (same version)');
          this.emitEvent({ type: 'sync:completed', timestamp: Date.now() });
          return {
            success: true,
            merged: this.enrichWithTokenBuffer(localData),
            added: 0,
            removed: 0,
            conflicts: 0,
          };
        }

        // Merge
        this.log(`Merging: local v${localVersion} <-> remote v${remoteVersion}`);
        const { merged, added, removed, conflicts } = mergeTxfData(localData, remoteData);

        if (conflicts > 0) {
          this.emitEvent({
            type: 'sync:conflict',
            timestamp: Date.now(),
            data: { conflicts },
          });
        }

        // Save merged result
        const saveResult = await this._doSave(merged);

        this.emitEvent({
          type: 'sync:completed',
          timestamp: Date.now(),
          data: { added, removed, conflicts },
        });

        return {
          success: saveResult.success,
          merged: this.enrichWithTokenBuffer(merged),
          added,
          removed,
          conflicts,
          error: saveResult.error,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emitEvent({
          type: 'sync:error',
          timestamp: Date.now(),
          error: errorMessage,
        });
        return {
          success: false,
          added: 0,
          removed: 0,
          conflicts: 0,
          error: errorMessage,
        };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Enrich TXF data with individually-buffered tokens before returning to caller.
   * PaymentsModule.createStorageData() passes empty tokens (they're stored via
   * saveToken()), but loadFromStorageData() needs them in the merged result.
   */
  private enrichWithTokenBuffer(data: TData): TData {
    if (this.tokenBuffer.size === 0) return data;

    const enriched = { ...data } as Record<string, unknown>;
    for (const [tokenId, tokenData] of this.tokenBuffer) {
      if (!this.deletedTokenIds.has(tokenId)) {
        enriched[tokenId] = tokenData;
      }
    }
    return enriched as TData;
  }

  // ---------------------------------------------------------------------------
  // Optional Methods
  // ---------------------------------------------------------------------------

  async exists(): Promise<boolean> {
    if (!this.ipnsName) return false;

    // Check cache first
    const cached = this.cache.getIpnsRecord(this.ipnsName);
    if (cached) return true;

    // Resolve from network
    const { best } = await this.httpClient.resolveIpns(this.ipnsName);
    return best !== null;
  }

  async clear(): Promise<boolean> {
    if (!this.ipnsKeyPair || !this.ipnsName) return false;

    // Clear pending buffer
    this.pendingBuffer.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const emptyData = {
      _meta: {
        version: 0,
        address: this.identity?.directAddress ?? '',
        ipnsName: this.ipnsName,
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
    } as TData;

    const result = await this._doSave(emptyData);
    if (result.success) {
      this.cache.clear();
      this.tokenBuffer.clear();
      this.deletedTokenIds.clear();
      await this.statePersistence.clear(this.ipnsName);
    }
    return result.success;
  }

  onEvent(callback: StorageEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  async saveToken(tokenId: string, tokenData: unknown): Promise<void> {
    this.pendingBuffer.tokenMutations.set(tokenId, { op: 'save', data: tokenData });
    this.tokenBuffer.set(tokenId, tokenData);
    this.deletedTokenIds.delete(tokenId);
    this.scheduleFlush();
  }

  async getToken(tokenId: string): Promise<unknown | null> {
    if (this.deletedTokenIds.has(tokenId)) return null;
    return this.tokenBuffer.get(tokenId) ?? null;
  }

  async listTokenIds(): Promise<string[]> {
    return Array.from(this.tokenBuffer.keys()).filter(
      (id) => !this.deletedTokenIds.has(id),
    );
  }

  async deleteToken(tokenId: string): Promise<void> {
    this.pendingBuffer.tokenMutations.set(tokenId, { op: 'delete' });
    this.tokenBuffer.delete(tokenId);
    this.deletedTokenIds.add(tokenId);
    this.scheduleFlush();
  }

  // ---------------------------------------------------------------------------
  // Public Accessors
  // ---------------------------------------------------------------------------

  getIpnsName(): string | null {
    return this.ipnsName;
  }

  getLastCid(): string | null {
    return this.lastCid;
  }

  getSequenceNumber(): bigint {
    return this.ipnsSequenceNumber;
  }

  getDataVersion(): number {
    return this.dataVersion;
  }

  getRemoteCid(): string | null {
    return this.remoteCid;
  }

  // ---------------------------------------------------------------------------
  // Testing helper: wait for pending flush to complete
  // ---------------------------------------------------------------------------

  /**
   * Wait for the pending flush timer to fire and the flush operation to
   * complete. Useful in tests to await background writes.
   * Returns immediately if no flush is pending.
   */
  async waitForFlush(): Promise<void> {
    if (this.flushTimer) {
      // Force the timer to fire now
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.flushQueue.enqueue(() => this.executeFlush()).catch(() => {});
    } else if (!this.pendingBuffer.isEmpty) {
      // No timer but pending data — flush now
      await this.flushQueue.enqueue(() => this.executeFlush()).catch(() => {});
    } else {
      // Ensure any in-flight flush completes
      await this.flushQueue.enqueue(async () => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Push Subscription Helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive WebSocket URL from the first configured gateway.
   * Converts https://host → wss://host/ws/ipns
   */
  private deriveWsUrl(): string | null {
    const gateways = this.httpClient.getGateways();
    if (gateways.length === 0) return null;

    const gateway = gateways[0];
    const wsProtocol = gateway.startsWith('https://') ? 'wss://' : 'ws://';
    const host = gateway.replace(/^https?:\/\//, '');
    return `${wsProtocol}${host}/ws/ipns`;
  }

  /**
   * Poll for remote IPNS changes (fallback when WS is unavailable).
   * Compares remote sequence number with last known and emits event if changed.
   */
  private async pollForRemoteChanges(): Promise<void> {
    if (!this.ipnsName) return;

    try {
      const { best } = await this.httpClient.resolveIpns(this.ipnsName);
      if (best && best.sequence > this.lastKnownRemoteSequence) {
        this.log(`Poll detected remote change: seq=${best.sequence} (was ${this.lastKnownRemoteSequence})`);
        this.lastKnownRemoteSequence = best.sequence;
        this.emitEvent({
          type: 'storage:remote-updated',
          timestamp: Date.now(),
          data: { name: this.ipnsName, sequence: Number(best.sequence), cid: best.cid },
        });
      }
    } catch {
      // Non-fatal — poll will retry on next interval
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private emitEvent(event: StorageEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch {
        // Don't let event handler errors break the provider
      }
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.log(`[IPFS-Storage] ${message}`);
    }
  }

  private readonly META_KEYS = new Set([
    '_meta', '_tombstones', '_outbox', '_sent', '_invalid',
    '_nametag', '_mintOutbox', '_invalidatedNametags', '_integrity',
  ]);

  private populateTokenBuffer(data: TxfStorageDataBase): void {
    this.tokenBuffer.clear();
    this.deletedTokenIds.clear();
    for (const key of Object.keys(data)) {
      if (!this.META_KEYS.has(key)) {
        this.tokenBuffer.set(key, (data as unknown as Record<string, unknown>)[key]);
      }
    }
  }
}
