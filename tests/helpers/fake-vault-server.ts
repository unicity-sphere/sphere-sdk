/**
 * fake-vault-server — an in-memory, faithful re-implementation of the token-api
 * AUTH + VAULT + EPOCH wire (Part A: `routes/auth.ts`, `routes/vault.ts`,
 * `services/auth.service.ts`, `services/vault.service.ts`, `services/epoch.service.ts`,
 * `storage/mongo/repos/vault-tokens.repo.ts`). The REAL token-api is only
 * exercised in Phase 8.3; this fake lets the provider's logic run identically
 * against a swappable in-process server (mirrors `fake-courier-server.ts`).
 *
 * Faithful to Part A:
 *  - AUTH: single-use challenge whose literal is
 *    `'unicity:vault:auth:v1\n' + JSON.stringify({network,pubkey,nonce,issuedAt,expiresAt})`
 *    (Dates serialize to ISO strings); `/verify` recovers the signer from the
 *    challenge and checks it equals `pubkey`; rotating refresh where reusing a
 *    now-stale token REVOKES the session (`refreshToken = '<ownerId>.<hex>'`).
 *  - VAULT CAS: per-`(ownerId,key)` CAS — `baseVersion 0` creates (v1) or
 *    resurrects a deleted row (v+1); `baseVersion N>0` requires the live version
 *    to equal N AND not be deleted. Rejections land in `rejected[]` with the
 *    lowercase wire reason; 507 ONLY when the whole batch was blocked by a
 *    storage watermark. `conflicts` is ALWAYS `[]`; the internal `status` is
 *    stripped from the body. PATCH `cursor` = per-owner commit counter.
 *  - STATE: `/state?since=` returns rows with `seq > since`, page-limited, with
 *    `more`; `cursor` = the last entry's `seq` on the page (or `since` if empty).
 *    `epochSig` = the server signature over `epochCanon(net, syncEpoch)`,
 *    verifiable under `NETWORKS[net].vaultServerKey`.
 *
 * Swap seam: the provider talks to {@link VaultAuthHttpClient} (raw auth) and
 * {@link VaultHttpClient} (authenticated data). `authClient()` returns the auth
 * seam; `clientFor(ownerId)` returns a data seam scoped to a caller. Phase 8.3
 * swaps in a real HTTP client (fetch + JWT) implementing the same interfaces —
 * no provider changes.
 */

import { randomUUID } from 'node:crypto';
import { recoverPubkeyFromSignature, verifySignedMessage, signMessage } from '../../core/crypto';
import { epochCanon, deleteCanon } from '../../vault-aead/canon';
import { vaultAuthChallenge } from '../../vault/auth';
import type { VaultEntryPayload } from '../../vault-aead/entry';
import type {
  AccountDeleteResponse,
  AuthTokens,
  ChallengeResponse,
  DeleteNonceResponse,
  HistoryAppendRecord,
  HistoryAppendResponse,
  HistoryRejection,
  HistorySinceResponse,
  HistoryStateRecord,
  PatchOp,
  PatchRejection,
  PatchResponse,
  RejectionReason,
  StateEntry,
  StateResponse,
  VaultAuthHttpClient,
  VaultHttpClient,
  VerifyRequest,
} from '../../storage/remote/types';

/** Shared deployment-fixture server signing key — its pubkey = `NETWORKS.testnet2.vaultServerKey`. */
export const SERVER_SIGN_PRIV = 'a'.repeat(64);

const CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_PAGE_LIMIT = 1000;
const DELETE_NONCE_TTL_MS = 5 * 60_000;

let counter = 0;
const uniq = (p: string): string => `${p}-${++counter}-${Math.random().toString(36).slice(2)}`;

interface NonceRow {
  pubkey: string;
  challenge: string;
  expiresAt: number;
}

interface SessionRow {
  sessionId: string;
  ownerId: string;
  deviceId: string;
  /** Current live refresh token. */
  refreshToken: string;
  /** The immediately-prior refresh token (reuse-detection). */
  priorToken: string | null;
  revoked: boolean;
}

/** Live vault entry (mirrors `VaultTokenDoc`). */
interface EntryRow {
  ownerId: string;
  key: string;
  version: number;
  payload: VaultEntryPayload;
  deleted: boolean;
  seq: number;
}

/** Stored history row (mirrors `HistoryRec`). */
interface HistoryRow {
  ownerId: string;
  dedupKey: string;
  seq: number;
  payload: VaultEntryPayload;
  createdAt: Date;
}

/** Account-delete nonce (mirrors `DeleteNonceDoc`) — single-use, owner-bound. */
interface DeleteNonceRow {
  ownerId: string;
  nonce: string;
  expiresAt: number;
}

export interface FakeVaultServerOptions {
  network?: string;
  pageLimit?: number;
}

/**
 * The in-memory vault server. Hold ONE instance per test; obtain the auth seam
 * via {@link FakeVaultServer.authClient} and a caller-scoped data seam via
 * {@link FakeVaultServer.clientFor}.
 */
export class FakeVaultServer {
  readonly network: string;
  private readonly pageLimit: number;

  private readonly nonces = new Map<string, NonceRow>();
  private readonly sessions: SessionRow[] = [];
  private readonly entries: EntryRow[] = [];
  private readonly historyRows: HistoryRow[] = [];
  private readonly deleteNonces = new Map<string, DeleteNonceRow>();
  /** Owners whose account has been deleted (purge armed). */
  private readonly deleted = new Set<string>();
  /** Per-owner monotonic seq allocator (the `/state` pagination watermark). */
  private readonly seqCounter = new Map<string, number>();
  /** Per-owner history-seq allocator (the `/history` pagination watermark). */
  private readonly historySeqCounter = new Map<string, number>();
  /** Per-owner commit counter (the PATCH-response `cursor`). */
  private readonly cursorCounter = new Map<string, number>();

  /** Current signed storage epoch (DESIGN §5.4) — injectable bump for 8.2/4.2. */
  private epoch = 1;
  /** When true, `insufficient_storage` blocks ALL ops (whole-batch 507 path). */
  private storageFull = false;
  /** Per-key byte cap for the `entry_too_large` path; undefined = unbounded. */
  private maxEntryBytes: number | undefined;
  /** Per-owner history record cap (`history_full`); undefined = unbounded. */
  private maxOwnerHistory: number | undefined;

  /** Per-endpoint call log — tests assert request bodies and call counts. */
  readonly calls: {
    challenge: string[];
    verify: VerifyRequest[];
    refresh: string[];
    logout: string[];
    patch: PatchOp[][];
    state: number[];
    historyAppend: HistoryAppendRecord[][];
    historySince: number[];
    deleteNonce: string[];
    deleteAccount: Array<{ nonce: string; signature: string }>;
  } = {
    challenge: [], verify: [], refresh: [], logout: [], patch: [], state: [],
    historyAppend: [], historySince: [], deleteNonce: [], deleteAccount: [],
  };

  constructor(opts: FakeVaultServerOptions | string = {}) {
    const o = typeof opts === 'string' ? { network: opts } : opts;
    this.network = o.network ?? 'testnet2';
    this.pageLimit = o.pageLimit ?? DEFAULT_PAGE_LIMIT;
  }

  /** The raw auth seam (challenge / verify / refresh / logout). */
  authClient(): VaultAuthHttpClient {
    return {
      challenge: (pubkey) => Promise.resolve(this.challenge(pubkey)),
      verify: (req) => Promise.resolve(this.verify(req)),
      refresh: (token) => Promise.resolve(this.refresh(token)),
      logout: (sessionId) => Promise.resolve(this.logout(sessionId)),
    };
  }

  /** A {@link VaultHttpClient} bound to the authenticated caller (`ownerId`). */
  clientFor(ownerId: string): VaultHttpClient {
    return {
      patchEntries: (ops) => Promise.resolve(this.patchEntries(ownerId, ops)),
      getState: (since) => Promise.resolve(this.getState(ownerId, since)),
      appendHistory: (records) => Promise.resolve(this.appendHistory(ownerId, records)),
      historySince: (since) => Promise.resolve(this.historySince(ownerId, since)),
      deleteNonce: () => Promise.resolve(this.deleteNonce(ownerId)),
      deleteAccount: (nonce, signature) => Promise.resolve(this.deleteAccount(ownerId, nonce, signature)),
    };
  }

  // === AUTH ==================================================================

  private challenge(pubkey: string): ChallengeResponse {
    this.calls.challenge.push(pubkey);
    const nonce = uniq('nonce');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    // EXACT server template — built via the single-source contract (vault/auth.ts).
    const challenge = vaultAuthChallenge({ network: this.network, pubkey, nonce, issuedAt, expiresAt });
    this.nonces.set(nonce, { pubkey, challenge, expiresAt: expiresAt.getTime() });
    return { nonce, challenge, expiresAt: expiresAt.toISOString() };
  }

  private verify(req: VerifyRequest): AuthTokens | null {
    this.calls.verify.push(req);
    const row = this.nonces.get(req.nonce);
    if (!row) return null; // single-use / unknown nonce
    this.nonces.delete(req.nonce); // consume once
    if (Date.now() > row.expiresAt) return null;
    let owner: string;
    try {
      owner = recoverPubkeyFromSignature(row.challenge, req.signature);
    } catch {
      return null;
    }
    if (owner !== row.pubkey) return null;
    if (!verifySignedMessage(row.challenge, req.signature, owner)) return null;
    return this.openSession(owner, req.deviceId);
  }

  private openSession(ownerId: string, deviceId: string): AuthTokens {
    const refreshToken = `${ownerId}.${uniq('r')}`;
    this.sessions.push({ sessionId: uniq('sess'), ownerId, deviceId, refreshToken, priorToken: null, revoked: false });
    return { jwt: this.mintJwt(ownerId, deviceId), refreshToken };
  }

  private refresh(token: string): AuthTokens | null {
    this.calls.refresh.push(token);
    const live = this.sessions.find((s) => !s.revoked && s.refreshToken === token);
    if (live) return this.rotate(live);
    // Reusing a now-stale (prior) token REVOKES the session (DESIGN §4.3).
    const stale = this.sessions.find((s) => s.priorToken === token);
    if (stale) stale.revoked = true;
    return null;
  }

  private rotate(s: SessionRow): AuthTokens {
    s.priorToken = s.refreshToken;
    s.refreshToken = `${s.ownerId}.${uniq('r')}`;
    return { jwt: this.mintJwt(s.ownerId, s.deviceId), refreshToken: s.refreshToken };
  }

  private logout(sessionId: string): void {
    this.calls.logout.push(sessionId);
    const s = this.sessions.find((x) => x.sessionId === sessionId);
    if (s) s.revoked = true;
  }

  /** A faux JWT — the fake never parses it; the data seam is bound by `clientFor`. */
  private mintJwt(sub: string, deviceId: string): string {
    return `jwt.${sub}.${deviceId}.${uniq('j')}`;
  }

  // === VAULT (PATCH /v1/entries) ============================================

  private patchEntries(ownerId: string, ops: PatchOp[]): PatchResponse {
    this.calls.patch.push(ops);
    const applied: string[] = [];
    const rejected: PatchRejection[] = [];
    for (const op of ops) {
      this.applyOne(ownerId, op, applied, rejected);
    }
    const cursor = this.bumpCursor(ownerId);
    // The route strips `status`; we replicate only the body the SDK observes.
    // (`status === 507` ⟺ whole batch blocked — the provider tolerates either.)
    return { cursor, applied, rejected, conflicts: [] };
  }

  private applyOne(ownerId: string, op: PatchOp, applied: string[], rejected: PatchRejection[]): void {
    const reason = this.checkEntry(op);
    if (reason) {
      rejected.push({ key: op.key, reason });
      return;
    }
    if (!this.upsertCas(ownerId, op)) {
      rejected.push({ key: op.key, reason: 'conflict' });
      return;
    }
    applied.push(op.key);
  }

  /** Quota gate: oversize → `entry_too_large`; storage watermark → `insufficient_storage`. */
  private checkEntry(op: PatchOp): RejectionReason | null {
    if (this.maxEntryBytes !== undefined && this.payloadBytes(op.payload) > this.maxEntryBytes) {
      return 'entry_too_large';
    }
    if (this.storageFull) return 'insufficient_storage';
    return null;
  }

  private payloadBytes(payload?: VaultEntryPayload): number {
    if (!payload) return 0;
    return payload.nonce.length + payload.ct.length;
  }

  /**
   * CAS, mirroring `vault-tokens.repo.ts::applyCas`:
   *  - baseVersion 0 → create when absent (v1) OR resurrect a deleted row (v+1);
   *    a live non-deleted row → conflict.
   *  - baseVersion N>0 → require the live version to equal N AND not be deleted.
   */
  private upsertCas(ownerId: string, op: PatchOp): boolean {
    const cur = this.entries.find((e) => e.ownerId === ownerId && e.key === op.key);
    if (op.baseVersion === 0) return this.createOrResurrect(ownerId, op, cur);
    if (!cur || cur.deleted || cur.version !== op.baseVersion) return false;
    this.writeNext(cur, op);
    return true;
  }

  private createOrResurrect(ownerId: string, op: PatchOp, cur: EntryRow | undefined): boolean {
    if (!cur) {
      this.entries.push({
        ownerId,
        key: op.key,
        version: 1,
        payload: op.payload!,
        deleted: op.deleted ?? false,
        seq: this.nextSeq(ownerId),
      });
      return true;
    }
    if (!cur.deleted) return false; // a live row cannot be re-created at baseVersion 0
    this.writeNext(cur, op);
    return true;
  }

  /** Apply the next version to a row; a delete op RETAINS the last ciphertext. */
  private writeNext(row: EntryRow, op: PatchOp): void {
    row.version += 1;
    row.deleted = op.deleted ?? false;
    if (op.payload) row.payload = op.payload;
    row.seq = this.nextSeq(row.ownerId);
  }

  // === STATE (GET /v1/state) ================================================

  private getState(ownerId: string, since: number): StateResponse {
    this.calls.state.push(since);
    const rows = this.entries
      .filter((e) => e.ownerId === ownerId && e.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const more = rows.length > this.pageLimit;
    const page = more ? rows.slice(0, this.pageLimit) : rows;
    return {
      cursor: page.length ? page[page.length - 1].seq : since,
      syncEpoch: this.epoch,
      epochSig: this.signEpoch(this.epoch),
      formatVersion: 'entries-v1',
      more,
      entries: page.map(toStateEntry),
    };
  }

  private signEpoch(epoch: number): string {
    return signMessage(SERVER_SIGN_PRIV, epochCanon(this.network, epoch));
  }

  // === HISTORY (POST/GET /v1/history) =======================================

  /**
   * Idempotent append (mirrors `history.service.ts`): a duplicate `dedupKey` is
   * NOT inserted but still counted `accepted`; oversize → `record_too_large`; the
   * per-owner count cap → `history_full`. Always 200 (status stripped).
   */
  private appendHistory(ownerId: string, records: HistoryAppendRecord[]): HistoryAppendResponse {
    this.calls.historyAppend.push(records);
    const rejected: HistoryRejection[] = [];
    let accepted = 0;
    let count = this.historyRows.filter((r) => r.ownerId === ownerId).length;
    for (const rec of records) {
      if (this.payloadBytes(rec.payload) > (this.maxEntryBytes ?? Infinity)) {
        rejected.push({ dedupKey: rec.dedupKey, reason: 'record_too_large' });
        continue;
      }
      if (count >= (this.maxOwnerHistory ?? Infinity)) {
        rejected.push({ dedupKey: rec.dedupKey, reason: 'history_full' });
        continue;
      }
      if (this.appendHistoryRow(ownerId, rec)) count += 1;
      accepted += 1;
    }
    return { accepted, rejected };
  }

  /** Append a history row; returns true when a NEW row was inserted (idempotent). */
  private appendHistoryRow(ownerId: string, rec: HistoryAppendRecord): boolean {
    const exists = this.historyRows.some((r) => r.ownerId === ownerId && r.dedupKey === rec.dedupKey);
    if (exists) return false;
    this.historyRows.push({
      ownerId, dedupKey: rec.dedupKey, payload: rec.payload,
      seq: this.nextHistorySeq(ownerId), createdAt: new Date(),
    });
    return true;
  }

  /** `GET /v1/history?since=<seq>` — rows with `seq > since`, page-limited by seq. */
  private historySince(ownerId: string, since: number): HistorySinceResponse {
    this.calls.historySince.push(since);
    const rows = this.historyRows
      .filter((r) => r.ownerId === ownerId && r.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, this.pageLimit);
    return { records: rows.map(toHistoryRecord) };
  }

  // === ACCOUNT (delete-nonce + DELETE /v1/account) ==========================

  /** Issue a fresh single-use, owner-bound delete nonce (5-min TTL). */
  private deleteNonce(ownerId: string): DeleteNonceResponse {
    this.calls.deleteNonce.push(ownerId);
    const nonce = randomUUID();
    this.deleteNonces.set(nonce, { ownerId, nonce, expiresAt: Date.now() + DELETE_NONCE_TTL_MS });
    return { nonce };
  }

  /**
   * Confirm deletion (mirrors `account.service.ts`): consume the nonce (single-use,
   * owner-bound), verify the fresh signature over the REAL `delete:v1` template,
   * and on success arm the purge. A bad/absent/stale signature → `{ok:false}` (401).
   */
  private deleteAccount(ownerId: string, nonce: string, signature: string): AccountDeleteResponse {
    this.calls.deleteAccount.push({ nonce, signature });
    const row = this.deleteNonces.get(nonce);
    this.deleteNonces.delete(nonce); // single-use
    if (!row || row.ownerId !== ownerId || Date.now() > row.expiresAt) return { ok: false };
    const msg = deleteCanon(this.network, ownerId, nonce);
    if (!this.verifyDelete(msg, signature, ownerId)) return { ok: false };
    this.deleted.add(ownerId);
    return { ok: true };
  }

  private verifyDelete(msg: string, signature: string, ownerId: string): boolean {
    try {
      return verifySignedMessage(msg, signature, ownerId);
    } catch {
      return false;
    }
  }

  // === seq / cursor allocators ==============================================

  private nextSeq(ownerId: string): number {
    const next = (this.seqCounter.get(ownerId) ?? 0) + 1;
    this.seqCounter.set(ownerId, next);
    return next;
  }

  private bumpCursor(ownerId: string): number {
    const next = (this.cursorCounter.get(ownerId) ?? 0) + 1;
    this.cursorCounter.set(ownerId, next);
    return next;
  }

  private nextHistorySeq(ownerId: string): number {
    const next = (this.historySeqCounter.get(ownerId) ?? 0) + 1;
    this.historySeqCounter.set(ownerId, next);
    return next;
  }

  // === test affordances =====================================================

  /** Bump the signed storage epoch (sanctioned reset — DESIGN §8.2). */
  bumpEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  /**
   * SANCTIONED-RESET injector (Task 8.2): wipe an owner's vault entries, reset its
   * seq + cursor allocators to 0, and BUMP the signed epoch (so `/state` now
   * returns `{cursor:0, entries:[]}` with a strictly-increased, validly-signed
   * `epochSig`). This is the only thing that distinguishes a real testnet reset
   * from a hostile rollback — the client must DROP local state + re-baseline, NOT
   * alarm. Returns the new epoch.
   */
  resetOwner(ownerId: string): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].ownerId === ownerId) this.entries.splice(i, 1);
    }
    this.seqCounter.set(ownerId, 0);
    this.cursorCounter.set(ownerId, 0);
    return this.bumpEpoch();
  }

  /** Force the whole-batch storage watermark (507 path). */
  setStorageFull(full: boolean): void {
    this.storageFull = full;
  }

  /** Set the per-entry byte cap (oversize → `entry_too_large`). */
  setMaxEntryBytes(max: number | undefined): void {
    this.maxEntryBytes = max;
  }

  /** Set the per-owner history record cap (`history_full`). */
  setMaxOwnerHistory(max: number | undefined): void {
    this.maxOwnerHistory = max;
  }

  /** Number of stored history rows for an owner (assertions). */
  historyCount(ownerId: string): number {
    return this.historyRows.filter((r) => r.ownerId === ownerId).length;
  }

  /** True once an owner's account has been deleted (assertions). */
  isDeleted(ownerId: string): boolean {
    return this.deleted.has(ownerId);
  }

  /** Number of live entries for an owner (assertions). */
  entryCount(ownerId: string): number {
    return this.entries.filter((e) => e.ownerId === ownerId).length;
  }

  /** Read a stored entry row (assertions). */
  getEntry(ownerId: string, key: string): EntryRow | undefined {
    return this.entries.find((e) => e.ownerId === ownerId && e.key === key);
  }

  /**
   * HOSTILE-ROLLBACK injector (Task 4.2): mutate a stored entry's ciphertext at a
   * FRESH monotonic seq WITHOUT bumping the signed epoch. This surfaces a `/state`
   * delta whose recomputed root diverges from the signed baseline — a rollback the
   * client must catch (no sanctioned epoch ⇒ alarm).
   */
  mutateEntry(ownerId: string, key: string, payload: VaultEntryPayload): void {
    const row = this.entries.find((e) => e.ownerId === ownerId && e.key === key);
    if (!row) throw new Error(`mutateEntry: no entry ${key}`);
    row.payload = payload;
    row.version += 1;
    row.seq = this.nextSeq(ownerId);
  }

  /** A session id for an owner (logout tests). */
  sessionIdFor(ownerId: string): string | undefined {
    return this.sessions.find((s) => s.ownerId === ownerId && !s.revoked)?.sessionId;
  }
}

const toStateEntry = (e: EntryRow): StateEntry => ({
  key: e.key,
  version: e.version,
  payload: e.payload,
  deleted: e.deleted,
  seq: e.seq,
});

const toHistoryRecord = (r: HistoryRow): HistoryStateRecord => ({
  dedupKey: r.dedupKey,
  seq: r.seq,
  payload: r.payload,
  createdAt: r.createdAt.toISOString(),
});
