/**
 * RemoteTokenStorageProvider — the Token-Vault v2 remote box (DESIGN §5).
 *
 * Implements the FROZEN `TokenStorageProvider` contract verbatim. ALL CAS /
 * cursor / signed-root / rejected state is internal (finding #29); the rollback
 * alarm rides `storage:error` with `data.reason === 'rollback'`, never a new
 * `StorageEventType` member.
 *
 * Phase 6 lands the data path:
 *  - `sync(localData)` (Task 6.2/6.3) diffs the TXF snapshot vs the internal
 *    last-known server state, PATCHes CAS ops keyed by the opaque wireKey, and
 *    maps `{applied, rejected, cursor}` → `SyncResult` (conflicts derived from
 *    `rejected[].reason === 'conflict'`); rejected ops stay OUT of the clean
 *    snapshot and are retried next flush.
 *  - `load()` (Task 6.4/4.2) paginates `/state`, asserts cursor monotonicity, and
 *    runs the signed-root anti-rollback gate.
 *
 * The provider-initiated first-load gate, reserved-address restore, identity
 * fencing, history channel and account-delete are Phase 7 — the seams here
 * (auth client, data-client factory, local baseline store, event emitter) are
 * shaped so Phase 7 slots in without reshaping this file.
 */

import type { FullIdentity } from '../../types';
import type {
  HistoryRecord,
  LoadResult,
  SaveResult,
  StorageEvent,
  StorageEventCallback,
  StorageEventType,
  SyncResult,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage-provider';
import { sealVaultEntry } from '../../vault-aead/entry';
import { deriveVaultKey } from '../../vault-aead/derive';
import { wireKey } from './wire-key';
import { VaultApiClient } from './VaultApiClient';
import { extractTokens, planOps } from './diff';
import type { KnownEntry, PlannedOp } from './diff';
import type {
  PatchOp,
  PatchResponse,
  StateEntry,
  VaultAuthHttpClient,
  VaultHttpClient,
} from './types';
import { LoadDeltaTracker } from './load-delta';
import type { LocalBaselineStore } from './load-delta';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface RemoteTokenStorageConfig {
  /** Canonical network name (storage scope, AEAD/wireKey scope). */
  network: string;
  /** Vault base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Wallet spend key — derives wireKeys + the AEAD vault key, signs auth + root. */
  privateKey: string;
  /** Raw auth wire seam (fake server in tests; fetch+JWT in Phase 8.3). */
  authClient: VaultAuthHttpClient;
  /** Authenticated data wire seam, scoped to the caller (`ownerId = chainPubkey`). */
  httpClientFactory: (ownerId: string) => VaultHttpClient;
  /** Stable device id stamped into the auth session. */
  deviceId?: string;
  /**
   * Local KV for the signed-root baseline `{cursor,root,sig}` (anti-rollback,
   * Task 4.2). Injected in tests as a simple in-memory store; Phase 7 wires the
   * real local `StorageProvider`.
   */
  localBaseline?: LocalBaselineStore;
  /** The compressed server signing key for this network (`NETWORKS[net].vaultServerKey`). */
  vaultServerKey?: string;
}

export class RemoteTokenStorageProvider<TData extends TxfStorageDataBase = TxfStorageDataBase>
  implements TokenStorageProvider<TData>
{
  readonly id = 'remote-token-storage';
  readonly name = 'Remote Token Storage (Vault v2)';
  readonly type = 'cloud' as const;

  private readonly config: RemoteTokenStorageConfig;
  private identity: FullIdentity | null = null;
  private auth: VaultApiClient | null = null;
  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

  /** Internal last-known server view: plainKey → {version, deleted}. */
  private known = new Map<string, KnownEntry>();
  /** Content hash of the last-flushed value per plainKey (suppresses no-op updates). */
  private contentHash = new Map<string, string>();
  /** The highest `/state` seq the provider has consumed (pagination watermark). */
  private serverCursor = 0;

  private readonly listeners = new Set<StorageEventCallback>();
  private readonly delta: LoadDeltaTracker;

  constructor(config: RemoteTokenStorageConfig) {
    this.config = config;
    this.delta = new LoadDeltaTracker({
      network: config.network,
      vaultServerKey: config.vaultServerKey,
      baseline: config.localBaseline,
    });
  }

  // --- BaseProvider ---------------------------------------------------------

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return this.status;
  }

  // --- TokenStorageProvider -------------------------------------------------

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    this.auth = new VaultApiClient({
      network: this.config.network,
      chainPubkey: identity.chainPubkey,
      privateKey: this.config.privateKey,
      deviceId: this.config.deviceId ?? 'sphere-vault',
      authClient: this.config.authClient,
    });
    this.delta.setIdentity(identity.chainPubkey);
    this.delta.setWalletPriv(this.config.privateKey);
  }

  /** Phase 6 initialize: authenticate so the data client carries a JWT. */
  async initialize(): Promise<boolean> {
    this.status = 'connecting';
    await this.requireAuth().authenticate();
    this.status = 'connected';
    return true;
  }

  async shutdown(): Promise<void> {
    this.status = 'disconnected';
  }

  /** `save` routes through `sync` (the vault has no local-only persistence). */
  async save(data: TData): Promise<SaveResult> {
    const res = await this.sync(data);
    return { success: res.success, error: res.error, timestamp: Date.now() };
  }

  // === sync (Task 6.2 / 6.3) ================================================

  async sync(localData: TData): Promise<SyncResult<TData>> {
    this.emit('sync:started');
    try {
      const ops = this.planFlush(localData);
      if (ops.length === 0) return this.cleanResult(localData, 0, 0, 0);
      return await this.flush(localData, ops);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sync failed';
      this.emit('sync:error', undefined, message);
      return { success: false, added: 0, removed: 0, conflicts: 0, error: message };
    }
  }

  /** Diff the TXF snapshot vs internal last-known state into a list of CAS ops. */
  private planFlush(localData: TData): PlannedOp[] {
    return planOps({
      tokens: extractTokens(localData),
      known: this.known,
      wireKeyOf: (plainKey) => this.wireKeyFor(plainKey),
      changed: (wk, value) => this.hasChanged(wk, value),
    });
  }

  private hasChanged(wk: string, value: unknown): boolean {
    return this.contentHash.get(wk) !== this.hashValue(value);
  }

  /** PATCH the planned ops, map the response onto `SyncResult`. */
  private async flush(localData: TData, ops: PlannedOp[]): Promise<SyncResult<TData>> {
    const wireOps = ops.map((op) => this.toWireOp(op));
    const res = await this.client().patchEntries(wireOps);
    return this.applyPatchResult(localData, ops, res);
  }

  /** Seal one planned op into its on-wire `{key: wireKey, baseVersion, payload?, deleted?}`. */
  private toWireOp(op: PlannedOp): PatchOp {
    if (op.isDelete) return { key: op.wireKey, baseVersion: op.baseVersion, deleted: true };
    return {
      key: op.wireKey,
      baseVersion: op.baseVersion,
      payload: this.sealValue(op.wireKey, op.baseVersion + 1, op.value),
    };
  }

  /** Seal a token value AAD-bound to the version it will have AFTER apply. */
  private sealValue(key: string, version: number, value: unknown): { nonce: string; ct: string } {
    return sealVaultEntry({
      network: this.config.network,
      ownerId: this.ownerId(),
      key,
      version,
      plaintext: enc(JSON.stringify(value ?? null)),
      key32: this.vaultKey(),
    });
  }

  /**
   * Fold the server response into the clean snapshot: only APPLIED ops update the
   * internal last-known state + content hash. Rejected ops are dropped from the
   * clean snapshot (retried next flush). `conflicts` is derived from the wire
   * reason `'conflict'`; oversize/insufficient rejections are NOT conflicts.
   */
  private applyPatchResult(localData: TData, ops: PlannedOp[], res: PatchResponse): SyncResult<TData> {
    const appliedKeys = new Set(res.applied);
    let added = 0;
    let removed = 0;
    for (const op of ops) {
      if (!appliedKeys.has(op.wireKey)) continue;
      if (op.isDelete) {
        removed += 1;
        this.recordDelete(op.wireKey);
      } else {
        if (this.isCreate(op.wireKey)) added += 1;
        this.recordApply(op);
      }
    }
    const conflicts = res.rejected.filter((r) => r.reason === 'conflict').length;
    if (res.rejected.length > 0) this.emit('sync:conflict', { rejected: res.rejected });
    return this.cleanResult(localData, added, removed, conflicts);
  }

  /** A create (counts toward `added`) is a wireKey absent or currently tombstoned. */
  private isCreate(wk: string): boolean {
    const prev = this.known.get(wk);
    return !prev || prev.deleted;
  }

  /** Record an applied create/update in the internal last-known state. */
  private recordApply(op: PlannedOp): void {
    const prev = this.known.get(op.wireKey);
    const version = prev ? prev.version + 1 : 1;
    this.known.set(op.wireKey, { version, deleted: false });
    this.contentHash.set(op.wireKey, this.hashValue(op.value));
  }

  private recordDelete(wk: string): void {
    const prev = this.known.get(wk);
    this.known.set(wk, { version: (prev?.version ?? 0) + 1, deleted: true });
    this.contentHash.delete(wk);
  }

  private cleanResult(localData: TData, added: number, removed: number, conflicts: number): SyncResult<TData> {
    this.emit('sync:completed', { added, removed, conflicts });
    return { success: true, merged: localData, added, removed, conflicts };
  }

  // === load (Task 6.4 / 4.2) ================================================

  async load(_identifier?: string): Promise<LoadResult<TData>> {
    this.emit('storage:loading');
    try {
      return await this.loadPaginated();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'load failed';
      this.emit('storage:error', { reason: 'load' }, message);
      return { success: false, error: message, source: 'remote', timestamp: Date.now() };
    }
  }

  /**
   * Paginate `/state?since=` until `!more`, asserting cursor monotonicity and
   * running the signed-root anti-rollback gate per page. A cursor regression or
   * root mismatch WITHOUT a server-verified epoch bump returns `success:false`
   * and emits `storage:error{reason:'rollback'}` (frozen union, never a new
   * member). On a clean load the new signed baseline is persisted.
   */
  private async loadPaginated(): Promise<LoadResult<TData>> {
    const client = this.client();
    let since = this.serverCursor;
    const pages: StateEntry[] = [];
    let lastEpochSig = '';
    let lastEpoch = 0;
    for (;;) {
      const page = await client.getState(since);
      const gate = await this.delta.ingestPage({ since, entries: page.entries, cursor: page.cursor, epoch: page.syncEpoch, epochSig: page.epochSig });
      if (!gate.ok) return this.rollback(gate.reason);
      pages.push(...page.entries);
      lastEpochSig = page.epochSig;
      lastEpoch = page.syncEpoch;
      since = page.cursor;
      if (!page.more) break;
    }
    this.serverCursor = since;
    await this.delta.commitBaseline(since, lastEpoch, lastEpochSig);
    return this.materialize(pages);
  }

  private rollback(reason: string): LoadResult<TData> {
    this.emit('storage:error', { reason: 'rollback', detail: reason });
    return { success: false, error: `vault rollback: ${reason}`, source: 'remote', timestamp: Date.now() };
  }

  /** Build the TXF snapshot from the accumulated `/state` rows + adopt their versions. */
  private materialize(entries: StateEntry[]): LoadResult<TData> {
    const data: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: this.identity?.directAddress ?? this.identity?.l1Address ?? '',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
    };
    for (const e of entries) {
      this.known.set(e.key, { version: e.version, deleted: e.deleted });
    }
    this.emit('storage:loaded', { entries: entries.length });
    return { success: true, data: data as TData, source: 'remote', timestamp: Date.now() };
  }

  // === events ===============================================================

  onEvent(callback: StorageEventCallback): () => void {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  private emit(type: StorageEventType, data?: unknown, error?: string): void {
    const event: StorageEvent = { type, timestamp: Date.now(), data, error };
    for (const cb of this.listeners) cb(event);
  }

  // === history (Phase 7) ====================================================

  async addHistoryEntry(_entry: HistoryRecord): Promise<void> {
    throw new Error('history sync lands in Phase 7');
  }

  async getHistoryEntries(): Promise<HistoryRecord[]> {
    return [];
  }

  async hasHistoryEntry(_dedupKey: string): Promise<boolean> {
    return false;
  }

  async clearHistory(): Promise<void> {
    // Phase 7
  }

  async importHistoryEntries(_entries: HistoryRecord[]): Promise<number> {
    return 0;
  }

  // === internals ============================================================

  private requireIdentity(): FullIdentity {
    if (!this.identity) throw new Error('RemoteTokenStorageProvider: setIdentity() must be called first');
    return this.identity;
  }

  private requireAuth(): VaultApiClient {
    this.requireIdentity();
    if (!this.auth) throw new Error('RemoteTokenStorageProvider: setIdentity() must be called first');
    return this.auth;
  }

  private ownerId(): string {
    return this.requireIdentity().chainPubkey;
  }

  private client(): VaultHttpClient {
    return this.config.httpClientFactory(this.ownerId());
  }

  private wireKeyFor(plainKey: string): string {
    return wireKey(this.config.privateKey, this.config.network, plainKey);
  }

  private vaultKey(): Uint8Array {
    return deriveVaultKey(this.config.privateKey, this.config.network);
  }

  /** Stable content hash for no-op-update suppression (order-independent JSON). */
  private hashValue(value: unknown): string {
    return JSON.stringify(value ?? null);
  }
}
