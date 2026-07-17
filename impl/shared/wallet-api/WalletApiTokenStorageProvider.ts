/**
 * WalletApiTokenStorageProvider — the lazy, thin-wallet storage provider over
 * the wallet-api backend (sdk-changes S2; ARCHITECTURE §5/§16).
 *
 * Platform-neutral (browser + Node) over the injected {@link WalletApiClient}.
 * The wallet renders balances from the server's value-indexed inventory view;
 * blobs are fetched on demand only to spend (signed GET URLs). Key behaviors:
 *
 * - **Tombstone-aware delta sync** (§5.1): `?since=` deltas include
 *   `status:'removed'` rows — the only way a stale device learns about
 *   spends/handoffs; the provider applies them (drops the entries from its
 *   active view) and loops while `more`.
 * - **Paginated full pull** is finished with an immediate
 *   `?since=<page-1 cursor>` closing delta, whose tombstones repair any flips
 *   that happened between pages (§5.1).
 * - **`syncEpoch` change** (server restore — §5.4): discard all persisted
 *   cursors, full pull, then re-PUT locally-known open intents (E.3, via the
 *   client) before anything resumes.
 * - **Write-behind with empty-import protection** (§5.1 client guards): a
 *   removal is pushed only after a successful inventory load and only for a
 *   confirmed on-chain spend (a `_tombstones` entry) — a fresh device or a
 *   failed load can never appear to "empty" the wallet, and a merely-absent
 *   token is never removed.
 * - **`recoverRemoved()`** (§5.3 recovery): tombstones the client cannot match
 *   to a known spend are re-fetched via blob-urls (which work for own
 *   tombstoned rows), re-verified locally, and re-added (reactivation). A
 *   server `409` is an evidenced tombstone — "actually spent" — and is kept.
 * - **Blob upload** via upload-urls with client-side sha256; a `412` from the
 *   content-addressed store means the blob already exists = success (§5.2).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { randomUUID } from '../../../core/uuid';
import type {
  ApplyDeltaAdded,
  ApplyDeltaOptions,
  InventoryItem,
  InventoryView,
  LoadResult,
  RecoverRemovedResult,
  SaveResult,
  SyncResult,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TokenBlob } from '../../../token-engine/types';
import {
  TOKEN_BLOB_VERSION,
  decodeTokenBlob,
  unwrapTokenBlobBytes,
} from '../../../token-engine/token-blob';
import type { FullIdentity, ProviderStatus } from '../../../types';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import type { KeyValueStore } from '../../../wallet-api';

export interface WalletApiTokenStorageConfig {
  /** The authenticated wallet-api client (S1). DI — never a singleton. */
  client: WalletApiClient;
  /** Persists the inventory cursor, syncEpoch and own-spend set per identity. */
  stateStore: KeyValueStore;
  /**
   * Optional local token verification used by `recoverRemoved()` before
   * re-adding a tombstoned blob (S2: "re-verifies locally"). Wire the engine's
   * `verify` here at composition; the default accepts any blob that decodes
   * and matches its tokenId.
   */
  verifyToken?: (blob: TokenBlob) => Promise<boolean>;
  /**
   * Optional ON-CHAIN spent check used by `recoverRemoved()` before reactivating a
   * tombstoned blob. A wiped/second device has an EMPTY knownSpends set — the exact
   * cohort recoverRemoved serves — so the local (tokenId, state) skip cannot protect it;
   * this asks the aggregator whether the blob's current state is already consumed, so a
   * genuinely-spent token is never resurrected (a re-spend would be blocked on-chain
   * anyway, but we must not surface phantom balance). Wire the engine's `isSpent` here at
   * composition; when unset, recoverRemoved relies on knownSpends + the server's evidenced
   * -tombstone 409 alone (its prior behavior).
   */
  isSpent?: (blob: TokenBlob) => Promise<boolean>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function newTransferId(): string {
  return randomUUID();
}

/** A stored v2 token entry (the UI token record with a hex CBOR blob). */
function isV2BlobEntry(entry: unknown): entry is { sdkData: string } {
  if (typeof entry !== 'object' || entry === null || 'genesis' in entry) return false;
  const sdkData = (entry as { sdkData?: unknown }).sdkData;
  return (
    typeof sdkData === 'string' &&
    sdkData.length >= 2 &&
    sdkData.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(sdkData)
  );
}

export class WalletApiTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'wallet-api-token-storage';
  readonly name = 'Wallet API Token Storage';
  readonly type = 'cloud' as const;
  /** Custody lives in the wallet-api backend — composing this provider without
   * the wallet-api client is illegal (fail-closed, S7/#515). */
  readonly requiresWalletApi = true;

  private readonly client: WalletApiClient;
  private readonly stateStore: KeyValueStore;
  private readonly verifyToken?: (blob: TokenBlob) => Promise<boolean>;
  private readonly isSpentOnChain?: (blob: TokenBlob) => Promise<boolean>;

  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  /** Local mirror of the inventory view — active rows and tombstones. */
  private readonly view = new Map<string, InventoryItem>();
  /**
   * Empty-import protection (§5.1): no removal is ever pushed before this
   * flips on the first successful inventory load. Doubles as the per-session
   * first-sync flag (#521): while false, `syncInventory` full-pulls even with
   * a warm persisted cursor — the view Map is process-lifetime, so a reloaded
   * instance (tab refresh) must rebuild it before deltas can resume.
   */
  private hadSuccessfulLoad = false;

  constructor(config: WalletApiTokenStorageConfig) {
    this.client = config.client;
    this.stateStore = config.stateStore;
    this.verifyToken = config.verifyToken;
    this.isSpentOnChain = config.isSpent;
  }

  // ── provider lifecycle ──────────────────────────────────────────────────────

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    this.client.setIdentity({ privateKey: identity.privateKey, chainPubkey: identity.chainPubkey });
    this.view.clear();
    this.hadSuccessfulLoad = false;
  }

  /**
   * #583 per-address client isolation: mint an INDEPENDENT provider for a
   * different HD address. Each address's storage provider drives its OWN
   * identity-bound client — an orphaned previous-address poll pump can never
   * serve inventory from a client re-authed to a different owner (the
   * address-switch bleed class collapses).
   *
   * `sharedClient` (Sphere threads it): the address's ALREADY-built client — the
   * one backing its delivery provider + walletApi session. Reusing it makes ALL
   * of an address's wallet-api artifacts share ONE client and ONE refresh-token
   * rotation lineage. Two sibling clients of the SAME owner+deviceId over the
   * shared stateStore would otherwise rotate the SAME refresh token and trip the
   * server's rotation-reuse revocation (§4). A bare clone is the fallback when
   * no shared client is threaded. The client starts identity-less here;
   * `setIdentity` binds it before it serves inventory. The shared `stateStore`
   * is fine — keys are namespaced per (network, chainPubkey), so per-owner
   * cursors / known-spend sets stay separate.
   */
  createForAddress(sharedClient?: unknown): WalletApiTokenStorageProvider {
    // The generic TokenStorageProvider contract types the context as `unknown`;
    // for this provider it is the address's WalletApiClient (or absent → clone).
    const client = sharedClient instanceof WalletApiClient ? sharedClient : this.client.clone();
    return new WalletApiTokenStorageProvider({
      client,
      stateStore: this.stateStore,
      verifyToken: this.verifyToken,
      isSpent: this.isSpentOnChain,
    });
  }

  async initialize(): Promise<boolean> {
    this.status = 'connected';
    return true;
  }

  async shutdown(): Promise<void> {
    this.status = 'disconnected';
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ── persisted sync state (per network + identity) ───────────────────────────

  private stateKey(kind: string): string {
    if (!this.identity) {
      throw new WalletApiError('No identity set — call setIdentity() first', 'CONFIG');
    }
    return `wallet-api-storage:${kind}:${this.client.network}:${this.identity.chainPubkey}`;
  }

  private async readCursor(): Promise<bigint | null> {
    const raw = await this.stateStore.get(this.stateKey('cursor'));
    return raw !== null && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
  }

  private async readSyncEpoch(): Promise<bigint | null> {
    const raw = await this.stateStore.get(this.stateKey('syncEpoch'));
    return raw !== null && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
  }

  private async persistSyncState(cursor: bigint, syncEpoch: bigint): Promise<void> {
    await this.stateStore.set(this.stateKey('cursor'), cursor.toString());
    await this.stateStore.set(this.stateKey('syncEpoch'), syncEpoch.toString());
  }

  /**
   * States this provider itself spent, so `recoverRemoved()`/`pushRemovals()` can tell
   * "a state we spent" from "a state a claim reactivated". Entries are composite
   * `${tokenId}:${protocolStateHash}` keys (the PROTOCOL imprint — same space as the
   * server row `state_hash`). Legacy builds wrote a BARE `${tokenId}`; those are tolerated
   * on read as state-agnostic records (see {@link mayHaveSpent}).
   */
  private async readKnownSpends(): Promise<Set<string>> {
    const raw = await this.stateStore.get(this.stateKey('knownSpends'));
    if (!raw) return new Set();
    try {
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private async addKnownSpends(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const known = await this.readKnownSpends();
    for (const k of keys) known.add(k);
    await this.stateStore.set(this.stateKey('knownSpends'), JSON.stringify([...known]));
  }

  private knownSpendKey(tokenId: string, stateHash: string): string {
    return `${tokenId}:${stateHash}`;
  }

  /**
   * PROVEN spend: we authoritatively recorded spending this token AT EXACTLY this
   * protocol state. Authorizes an evidence-free removal ({@link pushRemovals}) — STRICT,
   * so a legacy bare (state-agnostic) entry never authorizes destroying a row that a
   * claim may have reactivated at a different state. An absent/empty state is never a
   * proof.
   */
  private provenSpentAtState(known: Set<string>, tokenId: string, stateHash: string | undefined): boolean {
    return stateHash !== undefined && stateHash !== '' && known.has(this.knownSpendKey(tokenId, stateHash));
  }

  /**
   * CONSERVATIVE: did we record spending this token — this exact state, OR (a legacy
   * bare entry) any state? Used to SKIP recovery ({@link recoverRemoved}); errs toward
   * NOT resurrecting a token we may have transferred away.
   */
  private mayHaveSpent(known: Set<string>, tokenId: string, stateHash: string | undefined): boolean {
    if (known.has(tokenId)) return true; // legacy bare entry — state-agnostic
    return this.provenSpentAtState(known, tokenId, stateHash);
  }

  /**
   * #679 durable suspected-spent overlay — DURABLE LOCAL demotions, never on
   * the server. A source proven spent on-chain (`TransferConflictError`) is
   * demoted client-side, but the server row is still `active` (no evidenced
   * tombstone), so `save()` carries nothing and a reload would re-serve the
   * phantom as spendable `confirmed` balance (SPHERE-4). We keep the tokenId in
   * this per-device set and re-stamp it onto every returned view — full
   * snapshot and delta page alike (see {@link applySuspectedSpentOverlay}); the
   * set is pruned once the token leaves the active view (a real tombstone/spend
   * or handoff) on either path, so it stays bounded and never shadows a
   * legitimately re-added token.
   */
  private async readSuspectedSpent(): Promise<Set<string>> {
    const raw = await this.stateStore.get(this.stateKey('suspectedSpent'));
    if (!raw) return new Set();
    try {
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private async writeSuspectedSpent(ids: Set<string>): Promise<void> {
    if (ids.size === 0) {
      await this.stateStore.remove(this.stateKey('suspectedSpent'));
      return;
    }
    await this.stateStore.set(this.stateKey('suspectedSpent'), JSON.stringify([...ids]));
  }

  /**
   * #679: serialize overlay read-modify-write. Both {@link markSuspectedSpent}
   * and {@link reconcileSuspectedSpent} read the persisted overlay, mutate it,
   * and write it back; without this a concurrent demotion (overlapping `send()`
   * calls) could read a stale set and clobber another's write, dropping a
   * `suspectedSpent` id so the phantom balance reappears after reload. A simple
   * promise-chain mutex — each op runs after the previous settles, and a failing
   * op never wedges the chain.
   */
  private overlayLock: Promise<unknown> = Promise.resolve();
  private withOverlayLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.overlayLock.then(fn, fn);
    this.overlayLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * #679: durably record a client-side demotion. Called by the consumer
   * (`PaymentsModule.demoteSuspectedSpent`) when a `TransferConflictError`
   * proves a source already spent on-chain. LOCAL only — the server view still
   * shows the row active, so this is the only place the flag can survive a
   * reload. Re-applied to every returned view (full snapshot and delta) by
   * {@link applySuspectedSpentOverlay}.
   */
  async markSuspectedSpent(tokenId: string): Promise<void> {
    await this.withOverlayLock(async () => {
      const overlay = await this.readSuspectedSpent();
      if (overlay.has(tokenId)) return;
      overlay.add(tokenId);
      await this.writeSuspectedSpent(overlay);
    });
  }

  /**
   * Prune the durable suspected-spent overlay to the tokens still ACTIVE in the
   * given view and return the surviving set. Any overlay id that is no longer
   * active — legitimately tombstoned/spent, handed off, or vanished — is
   * dropped, so the overlay cannot grow unbounded or shadow a re-added token
   * (#679 lifecycle). Persists only when the set actually changed.
   */
  private async reconcileSuspectedSpent(active: InventoryItem[]): Promise<Set<string>> {
    return this.withOverlayLock(async () => {
      const overlay = await this.readSuspectedSpent();
      if (overlay.size === 0) return overlay;
      const activeIds = new Set(active.map((i) => i.tokenId));
      let changed = false;
      for (const id of overlay) {
        if (!activeIds.has(id)) {
          overlay.delete(id);
          changed = true;
        }
      }
      if (changed) await this.writeSuspectedSpent(overlay);
      return overlay;
    });
  }

  // ── inventory sync (§5.1) ───────────────────────────────────────────────────

  private applyItems(items: InventoryItem[]): void {
    for (const item of items) {
      // Tombstones drop the entry from the active view but stay recorded —
      // recoverRemoved() needs them (§5.3 recovery).
      this.view.set(item.tokenId, item);
    }
  }

  /** Full pull + the §5.1 closing delta; replaces the whole local view. */
  private async fullPull(): Promise<void> {
    this.view.clear();
    let page = await this.client.listInventory(undefined);
    const firstPageCursor = page.cursor;
    this.applyItems(page.items);
    while (page.more) {
      page = await this.client.listInventory(page.cursor);
      this.applyItems(page.items);
    }
    // Closing delta from the page-1 cursor: its tombstones repair any flips
    // that happened between pages (§5.1 — a paginated full pull spans snapshots).
    let delta = await this.client.listInventory(firstPageCursor);
    this.applyItems(delta.items);
    while (delta.more) {
      delta = await this.client.listInventory(delta.cursor);
      this.applyItems(delta.items);
    }
    await this.persistSyncState(delta.cursor, delta.syncEpoch);
  }

  /**
   * Delta loop from the persisted cursor. Returns `true` when the server's
   * `syncEpoch` no longer matches the persisted one — the cursors are invalid
   * (server restore, §5.4) and the caller must resync from scratch.
   */
  private async deltaLoop(since: bigint): Promise<boolean> {
    const knownEpoch = await this.readSyncEpoch();
    let page = await this.client.listInventory(since);
    if (knownEpoch !== null && page.syncEpoch !== knownEpoch) return true;
    this.applyItems(page.items);
    while (page.more) {
      page = await this.client.listInventory(page.cursor);
      if (knownEpoch !== null && page.syncEpoch !== knownEpoch) return true;
      this.applyItems(page.items);
    }
    await this.persistSyncState(page.cursor, page.syncEpoch);
    return false;
  }

  /** §5.4: discard cursors → full pull → re-PUT locally-known open intents. */
  private async handleSyncEpochChange(): Promise<void> {
    await this.stateStore.remove(this.stateKey('cursor'));
    await this.stateStore.remove(this.stateKey('syncEpoch'));
    await this.fullPull();
    await this.client.resyncOpenIntents();
  }

  /** Converge the local view with the server (delta when possible). */
  private async syncInventory(): Promise<void> {
    const cursor = await this.readCursor();
    // #521: the cursor is durable but the view Map is not — a delta from a
    // warm cursor into an empty view renders an empty wallet after a reload.
    // The FIRST sync of each instance/identity session (the flag setIdentity
    // resets) is therefore always a full pull; deltas resume afterwards.
    if (cursor === null || !this.hadSuccessfulLoad) {
      await this.fullPull();
    } else if (await this.deltaLoop(cursor)) {
      await this.handleSyncEpochChange();
    }
    this.hadSuccessfulLoad = true;
  }

  // ── lazy inventory port (S2) ────────────────────────────────────────────────

  /**
   * Without `since`: converge with the server, then return the full active
   * view (`more:false`) — a fresh device renders balances with zero blob
   * downloads. With `since`: a true server delta page (tombstones included),
   * also applied to the local view.
   */
  async listInventory(since?: bigint): Promise<InventoryView> {
    if (since === undefined) {
      await this.syncInventory();
      return this.snapshotView();
    }
    const knownEpoch = await this.readSyncEpoch();
    const page = await this.client.listInventory(since);
    if (knownEpoch !== null && page.syncEpoch !== knownEpoch) {
      // The caller's cursor predates a server restore — resync and hand back
      // the converged snapshot instead of a meaningless delta (§5.4).
      await this.handleSyncEpochChange();
      this.hadSuccessfulLoad = true;
      return this.snapshotView();
    }
    this.applyItems(page.items);
    if (!page.more) {
      const stored = await this.readCursor();
      if (stored === null || page.cursor > stored) {
        await this.persistSyncState(page.cursor, page.syncEpoch);
      }
    }
    // #679: the suspected-spent overlay is authoritative on the delta path too,
    // not only in snapshotView — stamp any demoted active row this page carries
    // (so a delta consumer never sees a demoted source as spendable) and prune
    // ids this page tombstoned (so a stale overlay entry can't shadow a later
    // re-add). Both paths converge on the SAME stamp/prune helper.
    const items = await this.applySuspectedSpentOverlay(page.items);
    return { ...page, items };
  }

  private async snapshotView(): Promise<InventoryView> {
    const active = [...this.view.values()].filter((i) => i.status === 'active');
    const items = await this.applySuspectedSpentOverlay(active);
    const cursor = (await this.readCursor()) ?? 0n;
    const syncEpoch = (await this.readSyncEpoch()) ?? 0n;
    return { cursor, syncEpoch, more: false, items };
  }

  /**
   * #679: the SINGLE place the durable suspected-spent overlay is applied to
   * inventory rows on their way to a consumer — used by BOTH return paths, the
   * full snapshot ({@link snapshotView}) and the S2 delta page
   * ({@link listInventory} with a cursor), so the two can never drift:
   *  - a returned ACTIVE row whose tokenId is in the overlay is stamped
   *    `suspectedSpent`, so a client-side demotion survives a reload AND a delta
   *    consumer is never served a demoted source as spendable (the phantom
   *    balance / re-spend guard, SPHERE-4);
   *  - the overlay is pruned to the tokens still active in the WHOLE local view
   *    — a tombstone arriving on EITHER path has already flipped its `this.view`
   *    row to `removed`, so its id is dropped here, keeping the overlay bounded
   *    and unable to shadow a later legitimately re-added token of the same id.
   * Pruning is reconciled against the whole `this.view`, NOT just `rows`: a
   * delta page is PARTIAL, so reconciling to only its rows would wrongly drop
   * still-active overlay ids that simply did not change in this page.
   */
  private async applySuspectedSpentOverlay(rows: InventoryItem[]): Promise<InventoryItem[]> {
    const active = [...this.view.values()].filter((i) => i.status === 'active');
    const overlay = await this.reconcileSuspectedSpent(active);
    if (overlay.size === 0) return rows;
    return rows.map((i) =>
      i.status === 'active' && overlay.has(i.tokenId) ? { ...i, suspectedSpent: true } : i
    );
  }

  /** Fetch + decode one blob on demand via a short-lived signed GET (§5.1). */
  async getToken(tokenId: string): Promise<TokenBlob> {
    const urls = await this.client.getBlobUrls([tokenId]);
    const entry = urls.find((u) => u.tokenId === tokenId);
    if (!entry) {
      throw new WalletApiError(`No blob URL for token ${tokenId} (not owned here)`, 'NOT_FOUND');
    }
    const bytes = await this.client.fetchBlob(entry.getUrl);
    const blob = this.wrapWireBlob(tokenId, bytes);
    if (blob.tokenId !== tokenId) {
      throw new WalletApiError(
        `Blob tokenId mismatch: requested ${tokenId}, blob carries ${blob.tokenId}`,
        'PROTOCOL'
      );
    }
    return blob;
  }

  /**
   * The §16 wire serves RAW token bytes (§5.2/§8.2 — the sphere 39051
   * envelope never crosses the API): re-wrap them for the engine-facing
   * {@link TokenBlob} surface. Envelope bytes (older rows, fake-world seeds)
   * still decode — their embedded tokenId is then checked by the caller. The
   * `network` of a raw wrap is not recoverable without the engine; consumers
   * derive it from the decoded token (`engine.decodeToken` re-wraps), so it
   * is never read from this value.
   */
  private wrapWireBlob(tokenId: string, bytes: Uint8Array): TokenBlob {
    try {
      return decodeTokenBlob(bytes);
    } catch {
      return { v: TOKEN_BLOB_VERSION, network: 0, tokenId, token: bytes };
    }
  }

  /**
   * Record a spend (§5.3) — idempotent by `transferId` server-side. MUST be
   * called after the mailbox deposit of the same `transferId` (the backend
   * evidence-checks removals against it). Refreshes the local view from the
   * resulting delta.
   */
  async applyDelta(
    transferId: string,
    spent: string[],
    added: ApplyDeltaAdded[],
    opts?: ApplyDeltaOptions
  ): Promise<void> {
    await this.client.applyInventoryDelta({
      transferId,
      spent,
      added,
      ...(opts?.externalDelivery !== undefined ? { externalDelivery: opts.externalDelivery } : {}),
    });
    // Record knownSpends keyed by (tokenId, PROTOCOL spent state) from the caller's
    // AUTHORITATIVE spentStates — never from this.view (a concurrent claim can have
    // advanced the view's state before this call). A legacy caller with no spentStates
    // falls back to a bare tokenId record (state-agnostic).
    const spentState = new Map((opts?.spentStates ?? []).map((s) => [s.tokenId, s.stateHash]));
    await this.addKnownSpends(
      spent.map((id) => {
        const s = spentState.get(id);
        return s !== undefined && s !== '' ? this.knownSpendKey(id, s) : id;
      })
    );
    await this.syncInventory();
  }

  // ── recovery (§5.3, sdk-changes S2) ─────────────────────────────────────────

  /**
   * Re-add tombstoned tokens this client cannot match to a known spend (a
   * wiped view — stolen JWT or a buggy client). Blobs are retained server-side
   * and blob-urls works for own tombstoned rows; each candidate is re-fetched,
   * locally verified, and re-added (reactivation). A `409` is the server's
   * verdict that the tombstone is an evidenced spend — kept as spent.
   */
  async recoverRemoved(): Promise<RecoverRemovedResult> {
    await this.syncInventory();
    const knownSpends = await this.readKnownSpends();
    const result: RecoverRemovedResult = { recovered: [], spent: [], skipped: [] };

    // State-scoped skip: reactivate a tombstone UNLESS we recorded spending this token
    // (this exact protocol state, or a legacy state-agnostic entry). This lets a bogus
    // (claim-reactivated) removal be undone while never reviving a state we truly spent.
    const candidates = [...this.view.values()].filter(
      (i) => i.status === 'removed' && !this.mayHaveSpent(knownSpends, i.tokenId, i.stateHash)
    );
    for (const item of candidates) {
      const blobBytes = await this.fetchRemovedBlob(item.tokenId);
      if (blobBytes === null || !(await this.locallyValid(item.tokenId, blobBytes))) {
        result.skipped.push(item.tokenId);
        continue;
      }
      // I4 gate: a wiped/second device has an EMPTY knownSpends, so the skip above can't
      // protect it — ask the aggregator whether this blob's state is already consumed and
      // NEVER resurrect a genuinely-spent token (belt-and-suspenders to the server 409).
      if (this.isSpentOnChain && (await this.isSpentBlob(item.tokenId, blobBytes))) {
        result.spent.push(item.tokenId);
        if (item.stateHash) await this.addKnownSpends([this.knownSpendKey(item.tokenId, item.stateHash)]);
        continue;
      }
      // Content-addressed key of the exact bytes we verified (§5.2).
      const key = `${this.client.network}/t/${bytesToHex(sha256(blobBytes))}`;
      try {
        await this.client.applyInventoryDelta({
          transferId: newTransferId(),
          spent: [],
          added: [{ tokenId: item.tokenId, key }],
        });
        result.recovered.push(item.tokenId);
      } catch (err) {
        if (err instanceof WalletApiError && err.code === 'CONFLICT') {
          // Evidenced tombstone (or the token moved on) — actually spent (§5.3). Record
          // the exact state the server 409'd so recovery stays scoped to that state.
          result.spent.push(item.tokenId);
          await this.addKnownSpends([
            item.stateHash ? this.knownSpendKey(item.tokenId, item.stateHash) : item.tokenId,
          ]);
        } else {
          throw err;
        }
      }
    }

    await this.syncInventory();
    return result;
  }

  private async fetchRemovedBlob(tokenId: string): Promise<Uint8Array | null> {
    const urls = await this.client.getBlobUrls([tokenId]);
    const entry = urls.find((u) => u.tokenId === tokenId);
    if (!entry) return null;
    try {
      return await this.client.fetchBlob(entry.getUrl);
    } catch {
      return null;
    }
  }

  private async locallyValid(tokenId: string, bytes: Uint8Array): Promise<boolean> {
    const blob = this.wrapWireBlob(tokenId, bytes);
    if (blob.tokenId !== tokenId) return false;
    if (this.verifyToken) return this.verifyToken(blob);
    return true;
  }

  /** True when the aggregator reports this blob's current state already consumed. */
  private async isSpentBlob(tokenId: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.isSpentOnChain) return false;
    return this.isSpentOnChain(this.wrapWireBlob(tokenId, bytes));
  }

  // ── whole-blob surface (thin: the hot path is the lazy port above) ──────────

  /**
   * Thin view: converges with the server and reports tombstones, but carries
   * NO token entries — blobs are fetched on demand via `getToken()`
   * (sdk-changes S2: `load()` no longer eagerly pulls every blob).
   */
  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    try {
      await this.syncInventory();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'inventory sync failed',
        source: 'remote',
        timestamp: Date.now(),
      };
    }
    const data: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: this.identity?.chainPubkey ?? '',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
      _tombstones: [...this.view.values()]
        .filter((i) => i.status === 'removed')
        .map((i) => ({ tokenId: i.tokenId, stateHash: '', timestamp: Date.now() })),
    };
    return { success: true, data, source: 'remote', timestamp: Date.now() };
  }

  /**
   * Write-behind push of a whole-blob snapshot:
   * - unknown tokens are uploaded (content-addressed, 412 = already present)
   *   and added via one idempotent apply;
   * - removals are pushed ONLY for confirmed spends (`_tombstones` entries)
   *   and ONLY after a successful inventory load (empty-import protection,
   *   §5.1) — a merely-absent token is never removed.
   * A failed sync fails the save: pushing against an unknown server view
   * could only do harm.
   */
  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    try {
      await this.syncInventory();
      const tombstoneIds = new Set((data._tombstones ?? []).map((t) => t.tokenId));
      await this.pushAdditions(data, tombstoneIds);
      await this.pushRemovals(tombstoneIds);
      await this.syncInventory();
      return { success: true, timestamp: Date.now() };
    } catch (error) {
      // A §5.3 lineage CONFLICT means the server already holds an equal/newer
      // or evidenced-tombstoned state for a token we tried to push — the local
      // snapshot is stale, NOT a failed save (recoverRemoved() treats the same
      // CONFLICT as benign). Converge the view to server truth and report
      // success: the mirror is already up to date, just not via our push.
      // Surfacing this as a failure produced a red "storage degraded" toast and
      // a Sentry error for a routine concurrency outcome, and left the stale
      // view to re-conflict next cycle. Only genuine errors (network / protocol
      // / auth) are a real degraded save.
      if (error instanceof WalletApiError && error.code === 'CONFLICT') {
        try {
          await this.syncInventory();
        } catch {
          // Convergence is best-effort; the next save/sync cycle reconciles.
        }
        return { success: true, timestamp: Date.now() };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'wallet-api save failed',
        timestamp: Date.now(),
      };
    }
  }

  private async pushAdditions(data: TxfStorageDataBase, excluded: Set<string>): Promise<void> {
    const toAdd: { tokenId: string; bytes: Uint8Array }[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!/^_[0-9a-f]{4,}$/i.test(key) || !isV2BlobEntry(value)) continue;
      const tokenId = key.slice(1);
      // Skip tokens the server already knows: an equal-state re-push of an
      // active row is a lineage 409 (§5.3), and tombstoned tokens re-enter
      // via recoverRemoved(), never via write-behind.
      if (excluded.has(tokenId) || this.view.has(tokenId)) continue;
      // §5.2/§8.2: the wire carries the RAW token bytes — the stored sdkData
      // is the sphere envelope; unwrap it at the wallet-api boundary.
      toAdd.push({ tokenId, bytes: unwrapTokenBlobBytes(hexToBytes(value.sdkData)) });
    }
    if (toAdd.length === 0) return;

    const urls = await this.client.getUploadUrls(
      toAdd.map((t) => ({ sha256: bytesToHex(sha256(t.bytes)), size: t.bytes.length }))
    );
    const added: ApplyDeltaAdded[] = [];
    for (const token of toAdd) {
      const sha = bytesToHex(sha256(token.bytes));
      const url = urls.find((u) => u.sha256 === sha);
      if (!url) {
        throw new WalletApiError(`upload-urls response missing sha256 ${sha}`, 'PROTOCOL');
      }
      await this.client.uploadBlob(url.putUrl, token.bytes); // 412 = already present = success (§5.2)
      added.push({ tokenId: token.tokenId, key: url.key });
    }
    await this.client.applyInventoryDelta({ transferId: newTransferId(), spent: [], added });
  }

  private async pushRemovals(tombstoneIds: Set<string>): Promise<void> {
    // Empty-import protection (§5.1): never push a removal before the first
    // successful inventory load; a spent token is removed only against a
    // confirmed on-chain spend (a tombstone), never mere absence.
    if (!this.hadSuccessfulLoad || tombstoneIds.size === 0) return;
    const known = await this.readKnownSpends();
    // FAIL-CLOSED + state-scoped. Push an evidence-free removal (fresh transferId, no
    // deposit) ONLY for a row the server still shows ACTIVE at EXACTLY the protocol state
    // we authoritatively spent (provenSpentAtState). A row active at a DIFFERENT state was
    // reactivated by a claim (self-send / A→B→A round-trip) and is legitimately ours —
    // destroying it there is the fund-loss bug. A row whose stateHash the server does not
    // expose (pre-Unit-A backend) is skipped, never removed on tokenId alone (degrade to
    // prune-primary: the PaymentsModule stale-tombstone prune is the go-forward fix).
    const spent: string[] = [];
    for (const id of tombstoneIds) {
      const row = this.view.get(id);
      if (row?.status !== 'active') continue;
      if (this.provenSpentAtState(known, id, row.stateHash)) spent.push(id);
    }
    if (spent.length === 0) return;
    await this.client.applyInventoryDelta({ transferId: newTransferId(), spent, added: [] });
    await this.addKnownSpends(spent.map((id) => this.knownSpendKey(id, this.view.get(id)!.stateHash!)));
  }

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    const result = await this.save(localData);
    return {
      success: result.success,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
      error: result.error,
    };
  }
}

export function createWalletApiTokenStorageProvider(
  config: WalletApiTokenStorageConfig
): WalletApiTokenStorageProvider {
  return new WalletApiTokenStorageProvider(config);
}
