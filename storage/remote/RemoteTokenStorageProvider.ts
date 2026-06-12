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
import { hexToBytes } from '../../core/crypto';
import { sealVaultEntry } from '../../vault-aead/entry';
import { deriveVaultKey } from '../../vault-aead/derive';
import { wireKey } from './wire-key';
import { VaultApiClient } from './VaultApiClient';
import { extractTokens, planOps } from './diff';
import type { KnownEntry, PlannedOp } from './diff';
import {
  reservedAddressKey,
  sealReservedAddress,
  openReservedAddress,
  RESERVED_ADDRESS_FORMAT_VERSION,
} from './reserved-address';
import { deriveDirectAddress } from '../../token-engine/identity';
import type {
  PatchOp,
  PatchResponse,
  StateEntry,
  VaultAuthHttpClient,
  VaultHttpClient,
} from './types';
import { LoadDeltaTracker } from './load-delta';
import type { LocalBaselineStore } from './load-delta';
import type { EntryState } from './merkle';
import { AsyncSerialQueue } from '../../impl/shared/ipfs/write-behind-buffer';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Thrown by the flush path when the identity epoch advanced across an await. */
class IdentityFencedError extends Error {
  constructor() {
    super('vault flush aborted: identity changed mid-flush (epoch fenced)');
    this.name = 'IdentityFencedError';
  }
}

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

  /**
   * The flush gate (Task 7.1). `sync()` is a NO-OP until the FIRST successful
   * `load()` opens it. `PaymentsModule.load()` stops at the first successful
   * provider, so this provider may never get a caller `load()` — `initialize()`
   * runs the first load itself. Empty-import protection: a transient load failure
   * leaves this `false`, so an empty local snapshot can never wipe the server.
   */
  private initialLoadDone = false;

  /** The DIRECT:// address restored from the reserved meta-address entry (Task 7.2). */
  private restoredAddress: string | null = null;

  /**
   * Serialize flush / sync / shutdown so two flushes never interleave their CAS
   * writes (Task 7.3). The same queue gates load too, so a load mid-flush waits.
   */
  private readonly queue = new AsyncSerialQueue();
  /**
   * Identity-epoch counter (Task 7.3). `setIdentity` bumps it; the flush path
   * re-checks it after EVERY await and aborts on a mismatch, so a write keyed to
   * the old identity can never reach the server after a switch.
   */
  private identityEpoch = 0;

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
    // Bump the identity epoch FIRST so any in-flight flush awaiting an I/O round
    // trip aborts the moment it next re-checks (Task 7.3) — no cross-identity write.
    this.identityEpoch += 1;
    this.identity = identity;
    // Switching identity resets the per-identity server view: the flush gate must
    // re-open on the new owner's first load, and the old `known`/cursor are stale.
    this.known.clear();
    this.contentHash.clear();
    this.serverCursor = 0;
    this.restoredAddress = null;
    this.initialLoadDone = false;
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

  /** Abort the flush path if the identity epoch advanced (Task 7.3). */
  private assertEpoch(epoch: number): void {
    if (epoch !== this.identityEpoch) throw new IdentityFencedError();
  }

  /**
   * Authenticate, then run the FIRST load ourselves so the flush gate opens even
   * when `PaymentsModule.load()` short-circuits before reaching this provider
   * (Task 7.1). A transient first-load failure is swallowed (the gate stays SHUT,
   * `sync()` no-ops) so an empty local import can never overwrite the server.
   */
  async initialize(): Promise<boolean> {
    this.status = 'connecting';
    await this.requireAuth().authenticate();
    this.status = 'connected';
    const first = await this.load();
    if (!first.success) {
      this.emit('storage:error', { reason: 'initial-load' }, first.error);
    }
    return true;
  }

  /** True once the first successful load opened the flush gate (Task 7.1). */
  isInitialLoadDone(): boolean {
    return this.initialLoadDone;
  }

  async shutdown(): Promise<void> {
    // Route through the queue so an in-flight flush drains first (Task 7.3).
    await this.queue.enqueue(() => {
      this.status = 'disconnected';
      return Promise.resolve();
    });
  }

  /** `save` routes through `sync` (the vault has no local-only persistence). */
  async save(data: TData): Promise<SaveResult> {
    const res = await this.sync(data);
    return { success: res.success, error: res.error, timestamp: Date.now() };
  }

  // === sync (Task 6.2 / 6.3) ================================================

  async sync(localData: TData): Promise<SyncResult<TData>> {
    // Flush gate (Task 7.1): no PATCH before a successful first load, so a
    // transient load failure can never wipe the server with empty local data.
    if (!this.initialLoadDone) {
      return { success: true, merged: localData, added: 0, removed: 0, conflicts: 0 };
    }
    // Capture the identity epoch BEFORE queueing; the flush aborts if it advances
    // across any await (Task 7.3). Serialized so flushes never interleave.
    const epoch = this.identityEpoch;
    return this.queue.enqueue(() => this.runSync(localData, epoch));
  }

  private async runSync(localData: TData, epoch: number): Promise<SyncResult<TData>> {
    this.emit('sync:started');
    try {
      this.assertEpoch(epoch);
      const ops = this.planFlush(localData);
      const reserved = await this.planReservedAddress();
      this.assertEpoch(epoch); // re-check after the (async) reserved-address derive
      if (ops.length === 0 && !reserved) return this.cleanResult(localData, 0, 0, 0);
      return await this.flush(localData, ops, reserved, epoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sync failed';
      this.emit('sync:error', undefined, message);
      return { success: false, added: 0, removed: 0, conflicts: 0, error: message };
    }
  }

  /**
   * The reserved meta-address op (Task 7.2, finding #17). Sealed once, from the
   * REAL engine identity (`deriveDirectAddress(hexToBytes(chainPubkey))`), so a
   * fresh import restores `_meta.address` without re-deriving from tokens — the
   * XP-invariant address survives a wipe. Returns `null` once it is on the server.
   */
  private async planReservedAddress(): Promise<PatchOp | null> {
    const wk = reservedAddressKey(this.config.privateKey, this.config.network);
    const cur = this.known.get(wk);
    if (cur && !cur.deleted) return null; // already on the server
    const chainPubkey = this.ownerId();
    const directAddress = await deriveDirectAddress(hexToBytes(chainPubkey));
    const payload = sealReservedAddress(
      { directAddress, chainPubkey, formatVersion: RESERVED_ADDRESS_FORMAT_VERSION },
      this.config.privateKey,
      this.config.network,
    );
    return { key: wk, baseVersion: 0, payload };
  }

  /** Diff the TXF snapshot vs internal last-known state into a list of CAS ops. */
  private planFlush(localData: TData): PlannedOp[] {
    return planOps({
      tokens: extractTokens(localData),
      known: this.known,
      wireKeyOf: (plainKey) => this.wireKeyFor(plainKey),
      changed: (wk, value) => this.hasChanged(wk, value),
      reserved: new Set([reservedAddressKey(this.config.privateKey, this.config.network)]),
    });
  }

  private hasChanged(wk: string, value: unknown): boolean {
    return this.contentHash.get(wk) !== this.hashValue(value);
  }

  /** PATCH the planned ops (token ops + the optional reserved-address op). */
  private async flush(
    localData: TData,
    ops: PlannedOp[],
    reserved: PatchOp | null,
    epoch: number,
  ): Promise<SyncResult<TData>> {
    const wireOps = ops.map((op) => this.toWireOp(op));
    if (reserved) wireOps.push(reserved);
    // Bind the client to the flush-start owner BEFORE the await so the patch can
    // never re-target a switched identity.
    const client = this.client();
    const res = await client.patchEntries(wireOps);
    // Identity fence (Task 7.3): if the identity switched across the patch await,
    // abort WITHOUT committing local state under the wrong identity.
    this.assertEpoch(epoch);
    if (reserved && res.applied.includes(reserved.key)) {
      this.known.set(reserved.key, { version: 1, deleted: false });
    }
    const result = this.applyPatchResult(localData, ops, res);
    // Re-sign the local baseline so the wallet's OWN writes advance the signed
    // root — the next load must not see them as an unauthored delta (Task 7.1).
    await this.delta.rebaseline(this.serverCursor, this.knownAsEntryState());
    this.assertEpoch(epoch); // re-check after the baseline persist await
    return result;
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
    await this.delta.beginLoad(this.knownAsEntryState());
    let since = this.serverCursor;
    const pages: StateEntry[] = [];
    let lastEpochSig = '';
    let lastEpoch = 0;
    for (;;) {
      const page = await client.getState(since);
      const gate = await this.delta.ingestPage({
        since,
        entries: page.entries,
        cursor: page.cursor,
        epoch: page.syncEpoch,
        epochSig: page.epochSig,
      });
      if (!gate.ok) return this.rollback(gate.reason);
      pages.push(...page.entries);
      lastEpochSig = page.epochSig;
      lastEpoch = page.syncEpoch;
      // Guard against a non-advancing cursor when `more` is set (would loop forever).
      if (page.more && page.cursor <= since) return this.rollback('cursor did not advance');
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

  /**
   * Build the TXF snapshot from the accumulated `/state` rows, adopting their
   * versions and running the 3-state machine (Task 7.2):
   *  - LOAD_FAILED: a corrupt reserved-address entry throws → caller returns
   *    `success:false`, the gate stays SHUT (initialLoadDone untouched).
   *  - POPULATED: the reserved entry decodes → `_meta.address` is restored (#17).
   *  - EMPTY: no reserved entry has ever been seen → an `isEmpty` sentinel rides
   *    INSIDE `data` so it can never short-circuit local data (#22).
   */
  private materialize(entries: StateEntry[]): LoadResult<TData> {
    const reserved = this.restoreReservedAddress(entries); // may throw → LOAD_FAILED
    for (const e of entries) {
      this.known.set(e.key, { version: e.version, deleted: e.deleted });
    }
    const isEmpty = !reserved && this.restoredAddress === null && this.knownCount() === 0;
    const data: TxfStorageDataBase & { isEmpty?: boolean } = {
      _meta: { version: 1, address: this.restoredAddress ?? '', formatVersion: '2.0', updatedAt: Date.now() },
    };
    if (isEmpty) data.isEmpty = true;
    this.initialLoadDone = true; // the flush gate opens on a successful load (Task 7.1)
    this.emit('storage:loaded', { entries: entries.length });
    return { success: true, data: data as TData, source: 'remote', timestamp: Date.now() };
  }

  /**
   * Find + decode the reserved meta-address entry from the page rows, caching the
   * restored DIRECT:// address. Throws on a decrypt/verify failure (LOAD_FAILED);
   * a missing reserved entry is fine (EMPTY / not-yet-flushed). Returns true when a
   * reserved row was present on this page.
   */
  private restoreReservedAddress(entries: StateEntry[]): boolean {
    const wk = reservedAddressKey(this.config.privateKey, this.config.network);
    const row = entries.find((e) => e.key === wk && !e.deleted);
    if (!row) return false;
    const meta = openReservedAddress(row.payload, this.ownerId(), this.config.privateKey, this.config.network);
    this.restoredAddress = meta.directAddress;
    return true;
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

  /** Live (non-tombstoned) entry count in the internal last-known state (tests/diagnostics). */
  knownCount(): number {
    let n = 0;
    for (const e of this.known.values()) if (!e.deleted) n += 1;
    return n;
  }

  /** Snapshot the internal last-known state as a merkle `EntryState` map. */
  private knownAsEntryState(): Map<string, EntryState> {
    const out = new Map<string, EntryState>();
    for (const [wk, e] of this.known) out.set(wk, { version: e.version, deleted: e.deleted });
    return out;
  }
}
