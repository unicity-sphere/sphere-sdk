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
import { getPublicKey, hexToBytes } from '../../core/crypto';
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
import { sealHistoryRecord, openHistoryRecord } from './history-codec';
import { deleteCanon } from '../../vault-aead/canon';
import { signMessage } from '../../core/crypto';
import { SphereError } from '../../core/errors';
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
import { normalizeVaultNetwork } from './normalize-network';
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
  /**
   * The CANONICAL vault network literal (`normalizeVaultNetwork(config.network)`).
   * ALL vault-boundary derivations — AEAD vault key, wireKey, vault-entry AAD,
   * history seal, the signed root + the server epoch canon — use THIS, so a
   * wallet configured with the `'testnet'` alias and one configured with
   * `'testnet2'` share vault keys (DESIGN §7.1). Storage SCOPING stays on the
   * literal `config.network` (migration-v2 trap) — see the tracker's storageNetwork.
   */
  private readonly vaultNetwork: string;
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

  /** dedupKeys already POSTed to `/v1/history` (the pushed-set, Task 7.4). */
  private readonly pushedHistory = new Set<string>();
  /** The history-seq watermark for `GET /v1/history?since=` (Task 7.4). */
  private historyCursor = 0;
  /** Decrypted history records recovered on load, by dedupKey (contract history ops). */
  private readonly localHistory = new Map<string, HistoryRecord>();

  constructor(config: RemoteTokenStorageConfig) {
    this.config = config;
    this.vaultNetwork = normalizeVaultNetwork(config.network);
    this.delta = new LoadDeltaTracker({
      // Sign the root + verify the epoch under the CANONICAL vault literal …
      network: this.vaultNetwork,
      // … but scope the local baseline STORAGE key by the LITERAL network.
      storageNetwork: config.network,
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
    // FUND-SAFETY (remote-provider-multiaddress-key-desync): the AEAD vault key,
    // wireKeys and the auth signature are all derived from the CONSTRUCTION-TIME
    // `config.privateKey`, while `ownerId` comes from `identity`. If `identity`
    // belongs to a DIFFERENT address (an HD address switch), the crypto would
    // desync from the owner — blobs sealed under the wrong key, auth 401. Multi-
    // address requires a per-address provider instance keyed to THAT address's
    // private key (see `createForAddress()` in the contract). FAIL LOUD on a
    // mismatch so a cross-identity write can NEVER reach the server.
    this.assertIdentityMatchesKey(identity);
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
    this.pushedHistory.clear();
    this.localHistory.clear();
    this.historyCursor = 0;
    this.auth = new VaultApiClient({
      network: this.vaultNetwork,
      chainPubkey: identity.chainPubkey,
      privateKey: this.config.privateKey,
      deviceId: this.config.deviceId ?? 'sphere-vault',
      authClient: this.config.authClient,
    });
    this.delta.setIdentity(identity.chainPubkey);
    this.delta.setWalletPriv(this.config.privateKey);
  }

  /**
   * Guard against a multi-address key desync (remote-provider-multiaddress-key-desync):
   * `config.privateKey` is fixed at construction and drives ALL vault-boundary
   * crypto (AEAD key, wireKey, auth signature), so the identity's pubkey MUST be
   * the public key of THAT private key. A mismatch means a different HD address is
   * being pointed at this provider — which would seal blobs under the wrong key
   * and 401 the auth. Throw a clear error so the desync can never reach the wire;
   * the caller must spawn a per-address provider keyed to that address instead.
   */
  private assertIdentityMatchesKey(identity: FullIdentity): void {
    const expected = getPublicKey(this.config.privateKey);
    if (identity.chainPubkey !== expected) {
      throw new SphereError(
        'RemoteTokenStorageProvider.setIdentity: identity pubkey does not match the ' +
          "provider's configured private key — multi-address requires a per-address " +
          'provider instance (createForAddress) keyed to that address.',
        'INVALID_IDENTITY',
      );
    }
  }

  /** Abort the flush path if the identity epoch advanced (Task 7.3). */
  private assertEpoch(epoch: number): void {
    if (epoch !== this.identityEpoch) throw new IdentityFencedError();
  }

  /**
   * Authenticate, then run the FIRST load ourselves so the flush gate opens even
   * when `PaymentsModule.load()` short-circuits before reaching this provider
   * (Task 7.1).
   *
   * FUND-SAFETY (remote-provider-init-auth-throw-bricks-wallet): this is a BACKUP
   * provider and the wallet loads providers together — a throw here would reject
   * the WHOLE wallet load and brick the wallet because the vault is unreachable.
   * So `initialize()` NEVER throws on auth / network / first-load failure: it
   * logs (via `storage:error`), leaves the flush gate SHUT (`initialLoadDone`
   * stays false → `sync()` degrades, never wipes the server with empty local
   * data) and RETURNS the contract's non-fatal `false` so the wallet still loads
   * from local storage. A vault outage degrades to "remote backup inactive".
   */
  async initialize(): Promise<boolean> {
    this.status = 'connecting';
    try {
      await this.requireAuth().authenticate();
    } catch (error) {
      this.status = 'error';
      this.emit('storage:error', { reason: 'auth' }, this.errMsg(error, 'vault auth failed'));
      return false; // degrade — do NOT brick the wallet
    }
    this.status = 'connected';
    const first = await this.load(); // load() never throws (it try/catches internally)
    if (!first.success) {
      this.status = 'error';
      this.emit('storage:error', { reason: 'initial-load' }, first.error);
      return false; // first load failed → gate stays SHUT, wallet still loads locally
    }
    return true;
  }

  /** Extract a human message from an unknown thrown value (degraded-path logging). */
  private errMsg(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
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
    //
    // FUND-SAFETY (remote-provider-silent-backup-failure-reports-success): while
    // the gate is shut the backup did NOT happen, so we must NOT report a silent
    // success — that would tell the wallet its tokens are durably backed up when
    // nothing was persisted. We SIGNAL the degraded state: return success:false
    // with a reason AND emit a degraded `sync:error` event (frozen union, a
    // data.reason — never a new union member). Empty-import protection is intact:
    // we still perform NO PATCH before a successful first load.
    if (!this.initialLoadDone) {
      return this.degraded(localData);
    }
    // Capture the identity epoch BEFORE queueing; the flush aborts if it advances
    // across any await (Task 7.3). Serialized so flushes never interleave.
    const epoch = this.identityEpoch;
    return this.queue.enqueue(() => this.runSync(localData, epoch));
  }

  /**
   * The gate-shut degraded result (finding
   * remote-provider-silent-backup-failure-reports-success): emit a `sync:error`
   * degraded signal with a `data.reason` and return success:false. NO PATCH is
   * performed (empty-import protection). Distinct from a genuine successful no-op
   * flush (gate OPEN, nothing to push), which stays success:true.
   */
  private degraded(localData: TData): SyncResult<TData> {
    const reason = 'awaiting-initial-load';
    this.emit('sync:error', { reason }, 'vault backup inactive: awaiting a successful initial load');
    return { success: false, merged: localData, added: 0, removed: 0, conflicts: 0, error: reason };
  }

  private async runSync(localData: TData, epoch: number): Promise<SyncResult<TData>> {
    this.emit('sync:started');
    try {
      this.assertEpoch(epoch);
      const ops = this.planFlush(localData);
      const reserved = await this.planReservedAddress();
      this.assertEpoch(epoch); // re-check after the (async) reserved-address derive
      await this.pushHistory(localData, epoch); // single-channel history (Task 7.4)
      if (ops.length === 0 && !reserved) return this.cleanResult(localData, 0, 0, 0);
      return await this.flush(localData, ops, reserved, epoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sync failed';
      this.emit('sync:error', undefined, message);
      return { success: false, added: 0, removed: 0, conflicts: 0, error: message };
    }
  }

  /**
   * Single-channel history (Task 7.4): diff the `_history` dedupKeys vs the pushed
   * set and POST only NEW records (each AEAD-sealed). `appendHistory` is idempotent
   * server-side, so a duplicate dedupKey is accepted (not an error) — only a real
   * failure rejects, and a real error rethrows up the flush path.
   */
  private async pushHistory(localData: TData, epoch: number): Promise<void> {
    const history = localData._history ?? [];
    const fresh = history.filter((r) => !this.pushedHistory.has(r.dedupKey));
    if (fresh.length === 0) return;
    const records = fresh.map((r) => ({ dedupKey: r.dedupKey, payload: this.sealHistory(r) }));
    const res = await this.client().appendHistory(records);
    this.assertEpoch(epoch); // fence after the history POST await
    for (const r of fresh) {
      const wasRejected = res.rejected.some((x) => x.dedupKey === r.dedupKey);
      if (wasRejected) continue; // keep out of the pushed set → retried next flush
      this.pushedHistory.add(r.dedupKey);
      this.localHistory.set(r.dedupKey, r);
    }
  }

  private sealHistory(record: HistoryRecord): { nonce: string; ct: string } {
    return sealHistoryRecord(record, this.ownerId(), this.config.privateKey, this.vaultNetwork);
  }

  /**
   * The reserved meta-address op (Task 7.2, finding #17). Sealed once, from the
   * REAL engine identity (`deriveDirectAddress(hexToBytes(chainPubkey))`), so a
   * fresh import restores `_meta.address` without re-deriving from tokens — the
   * XP-invariant address survives a wipe. Returns `null` once it is on the server.
   */
  private async planReservedAddress(): Promise<PatchOp | null> {
    const wk = reservedAddressKey(this.config.privateKey, this.vaultNetwork);
    const cur = this.known.get(wk);
    if (cur && !cur.deleted) return null; // already on the server
    const chainPubkey = this.ownerId();
    const directAddress = await deriveDirectAddress(hexToBytes(chainPubkey));
    const payload = sealReservedAddress(
      { directAddress, chainPubkey, formatVersion: RESERVED_ADDRESS_FORMAT_VERSION },
      this.config.privateKey,
      this.vaultNetwork,
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
      reserved: new Set([reservedAddressKey(this.config.privateKey, this.vaultNetwork)]),
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
      network: this.vaultNetwork,
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
      // Task 8.2 / #14: a server-key-VERIFIED strict epoch bump is a SANCTIONED
      // reset, not an alarm — drop local state and re-baseline at the new epoch.
      if (gate.reset) return this.handleSanctionedReset();
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
    const recovered = await this.loadHistory(); // single-channel history (Task 7.4)
    return this.materialize(pages, recovered);
  }

  /**
   * Sanctioned-reset path (Task 8.2 / finding #14). A server-key-verified strict
   * epoch bump was recognised, so the operator legitimately reset the network (a
   * testnet wipe). DROP all local vault state and re-paginate the fresh seq space
   * from `since=0`, then re-baseline the signed root at the NEW epoch/cursor — NO
   * rollback alarm. This is only ever reached AFTER `ingestPage` verified the bump
   * against `NETWORKS[net].vaultServerKey`, so it cannot mask a hostile rollback.
   */
  private async handleSanctionedReset(): Promise<LoadResult<TData>> {
    this.dropLocalVaultState();
    this.delta.beginReset(); // empty accumulator, no stale-root gate for the re-pass
    const { entries, cursor, epoch, epochSig } = await this.repaginateFromReset();
    this.delta.foldReset(entries); // re-baseline root reflects the actual reset state
    this.serverCursor = cursor;
    await this.delta.commitBaseline(cursor, epoch, epochSig); // persist the NEW epoch
    const recovered = await this.loadHistory();
    return this.materialize(entries, recovered);
  }

  /** Re-pull the post-reset state from `since=0` UNGATED (the reset is sanctioned). */
  private async repaginateFromReset(): Promise<{ entries: StateEntry[]; cursor: number; epoch: number; epochSig: string }> {
    const client = this.client();
    const entries: StateEntry[] = [];
    let since = 0;
    let cursor = 0;
    let epoch = 0;
    let epochSig = '';
    for (;;) {
      const page = await client.getState(since);
      entries.push(...page.entries);
      cursor = page.cursor;
      epoch = page.syncEpoch;
      epochSig = page.epochSig;
      if (!page.more || page.cursor <= since) break;
      since = page.cursor;
    }
    return { entries, cursor, epoch, epochSig };
  }

  /**
   * Drop all per-owner local vault state for a sanctioned reset: the internal
   * last-known server view, content hashes, the pagination watermark, the restored
   * address and the history watermark. The signed baseline is re-persisted fresh by
   * `commitBaseline`. Storage scope (the literal-network baseline KEY) is unchanged.
   */
  private dropLocalVaultState(): void {
    this.known.clear();
    this.contentHash.clear();
    this.serverCursor = 0;
    this.restoredAddress = null;
    this.localHistory.clear();
    this.pushedHistory.clear();
    this.historyCursor = 0;
  }

  /**
   * Pull the single-channel history log (Task 7.4). There is no `more` flag on the
   * wire (`GET /v1/history?since=<seq>`): the client loops `since=maxSeq` until a
   * page comes back SHORT — fewer records than the server's full page size, which
   * we infer as the largest page seen. Each payload is decrypted to a
   * `HistoryRecord`, merged into the local map, and marked pushed so a later flush
   * never re-POSTs it. Returns the records recovered THIS load.
   */
  private async loadHistory(): Promise<HistoryRecord[]> {
    const client = this.client();
    const recovered: HistoryRecord[] = [];
    let pageSize = 0; // inferred full-page size (the largest page observed)
    for (;;) {
      const page = await client.historySince(this.historyCursor);
      for (const row of page.records) recovered.push(this.absorbHistoryRow(row));
      pageSize = Math.max(pageSize, page.records.length);
      // A short page (fewer than a full page, or empty) ends the loop.
      if (page.records.length === 0 || page.records.length < pageSize) break;
    }
    return recovered;
  }

  /** Decrypt + cache one history row, marking it pushed and advancing the cursor. */
  private absorbHistoryRow(row: { dedupKey: string; payload: { nonce: string; ct: string }; seq: number }): HistoryRecord {
    const record = openHistoryRecord(row.dedupKey, row.payload, this.ownerId(), this.config.privateKey, this.vaultNetwork);
    this.localHistory.set(record.dedupKey, record);
    this.pushedHistory.add(record.dedupKey);
    this.historyCursor = Math.max(this.historyCursor, row.seq);
    return record;
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
  private materialize(entries: StateEntry[], history: HistoryRecord[]): LoadResult<TData> {
    const reserved = this.restoreReservedAddress(entries); // may throw → LOAD_FAILED
    for (const e of entries) {
      this.known.set(e.key, { version: e.version, deleted: e.deleted });
    }
    const isEmpty =
      !reserved && this.restoredAddress === null && this.knownCount() === 0 && history.length === 0;
    const data: TxfStorageDataBase & { isEmpty?: boolean } = {
      _meta: { version: 1, address: this.restoredAddress ?? '', formatVersion: '2.0', updatedAt: Date.now() },
    };
    // Attach recovered history for the existing import hook (importHistoryEntries).
    if (history.length > 0) data._history = history;
    if (isEmpty) data.isEmpty = true;
    this.initialLoadDone = true; // the flush gate opens on a successful load (Task 7.1)
    this.emit('storage:loaded', { entries: entries.length, history: history.length });
    return { success: true, data: data as TData, source: 'remote', timestamp: Date.now() };
  }

  /**
   * Find + decode the reserved meta-address entry from the page rows, caching the
   * restored DIRECT:// address. Throws on a decrypt/verify failure (LOAD_FAILED);
   * a missing reserved entry is fine (EMPTY / not-yet-flushed). Returns true when a
   * reserved row was present on this page.
   */
  private restoreReservedAddress(entries: StateEntry[]): boolean {
    const wk = reservedAddressKey(this.config.privateKey, this.vaultNetwork);
    const row = entries.find((e) => e.key === wk && !e.deleted);
    if (!row) return false;
    const meta = openReservedAddress(row.payload, this.ownerId(), this.config.privateKey, this.vaultNetwork);
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

  // === history (Task 7.4 — single channel) ==================================

  /**
   * Append one history entry: seal + POST it to `/v1/history` (idempotent), then
   * cache it locally and mark it pushed. A duplicate dedupKey is a no-op (idempotent
   * server-side); a real append error rethrows.
   */
  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    if (this.pushedHistory.has(entry.dedupKey)) {
      this.localHistory.set(entry.dedupKey, entry);
      return;
    }
    const res = await this.client().appendHistory([{ dedupKey: entry.dedupKey, payload: this.sealHistory(entry) }]);
    if (res.rejected.some((r) => r.dedupKey === entry.dedupKey)) {
      const reason = res.rejected.find((r) => r.dedupKey === entry.dedupKey)!.reason;
      throw new Error(`vault history append rejected: ${reason}`);
    }
    this.pushedHistory.add(entry.dedupKey);
    this.localHistory.set(entry.dedupKey, entry);
  }

  /** All locally-known history records, newest first (recovered on load). */
  async getHistoryEntries(): Promise<HistoryRecord[]> {
    return [...this.localHistory.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    return this.localHistory.has(dedupKey);
  }

  /** Local-only clear (the server log is append-only and never truncated by a client). */
  async clearHistory(): Promise<void> {
    this.localHistory.clear();
  }

  /** Bulk-import history (skip existing dedupKeys); push each new record. Returns new count. */
  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    let imported = 0;
    for (const entry of entries) {
      if (this.localHistory.has(entry.dedupKey)) continue;
      await this.addHistoryEntry(entry);
      imported += 1;
    }
    return imported;
  }

  // === account delete (Task 7.5) ============================================

  /**
   * Fresh-signature-gated account deletion (§7.4). Fetch a fresh single-use
   * delete-nonce, sign the REAL `delete:v1` template — `unicity:vault:delete:v1\n`
   * + `network\nownerId\nnonce` — with the wallet key, and send `DELETE /v1/account`.
   * A missing/stale signature is rejected CLIENT-side (we never send an empty sig),
   * so the spend key signs only a fresh, server-issued nonce. Returns the server's
   * `ok` (a bad/stale signature → `false`, mapping to the server's 401).
   */
  async deleteAccount(): Promise<boolean> {
    const client = this.client();
    const { nonce } = await client.deleteNonce();
    const ownerId = this.ownerId();
    const signature = signMessage(this.config.privateKey, deleteCanon(this.vaultNetwork, ownerId, nonce));
    // Client-side freshness guard: never send a missing/empty signature.
    if (!nonce || !signature) throw new Error('vault account delete: missing fresh nonce/signature');
    const res = await client.deleteAccount(nonce, signature);
    return res.ok;
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

  /**
   * The provider's live JWT source (Task 8.3 wiring). The REAL `HttpVaultClient`
   * reads the Bearer JWT + drives the serialized refresh through this same
   * `VaultApiClient`, so the data client and the provider share ONE auth session.
   * `setIdentity()` must have run first. Resolved lazily by the http-client factory
   * (the factory closure is supplied at construction, before `setIdentity`).
   */
  authTokenSource(): VaultApiClient {
    return this.requireAuth();
  }

  private ownerId(): string {
    return this.requireIdentity().chainPubkey;
  }

  private client(): VaultHttpClient {
    return this.config.httpClientFactory(this.ownerId());
  }

  private wireKeyFor(plainKey: string): string {
    return wireKey(this.config.privateKey, this.vaultNetwork, plainKey);
  }

  private vaultKey(): Uint8Array {
    return deriveVaultKey(this.config.privateKey, this.vaultNetwork);
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
