/**
 * Adversarial in-memory wallet-api fake — typed methods, no HTTP.
 * Fidelity source: ../wallet-api/src (mailbox/inventory/intents/history/payments
 * services + repositories, restore/rebuild.ts, ws/events.ts). Where the
 * PAYMENTS-V2-DESIGN doc and the server disagree, the server semantics win.
 */
import { createHash, randomUUID } from 'node:crypto';

// ── errors (statusCode mirrors ../wallet-api/src/lib/errors.ts) ──────────────

export class FakeApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}
export class ValidationFailedError extends FakeApiError {
  constructor(message: string) {
    super(422, 'VALIDATION_FAILED', message);
  }
}
export class ConflictError extends FakeApiError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}
export class ForbiddenError extends FakeApiError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}
export class NotFoundError extends FakeApiError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}
export class QuotaExceededError extends FakeApiError {
  readonly limitName: string;
  constructor(message: string, limitName: string) {
    super(429, 'QUOTA_EXCEEDED', message);
    this.limitName = limitName;
  }
}

// ── wire/domain types ─────────────────────────────────────────────────────────

export interface AssetAmount {
  readonly coinId: string;
  readonly amount: string;
}

export interface FakeCaller {
  readonly chainPubkey: string;
  readonly network: string;
}

export type RemovalClass = 'evidenced' | 'unevidenced' | 'external';

export interface FakeBlobMeta {
  readonly tokenId: string;
  readonly stateHash: string;
  readonly consumedStates: readonly string[];
  readonly ownerPubkey: string;
  readonly assets: readonly AssetAmount[];
  readonly splitEvidence?: { readonly burntTokenId: string; readonly preBurnState: string };
}

export interface InventoryWireItem {
  readonly tokenId: string;
  readonly status: 'active' | 'removed';
  readonly seq: number;
  readonly stateHash: string;
  readonly assets?: readonly AssetAmount[];
}

export interface InventoryWirePage {
  readonly cursor: number;
  readonly syncEpoch: number;
  readonly more: boolean;
  readonly items: readonly InventoryWireItem[];
}

export interface ApplyInput {
  readonly transferId: string;
  readonly spent: readonly string[];
  readonly added: readonly { readonly tokenId: string; readonly key: string }[];
  readonly externalDelivery?: boolean;
}

export interface DepositInput {
  readonly recipientPubkey: string;
  readonly key: string;
  readonly transferId: string;
  readonly memo?: string;
  readonly stateHash: string;
  readonly tokenId: string;
}

export type MailboxStatus = 'unclaimed' | 'claimed' | 'rejected';

export interface MailboxWireEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly status: MailboxStatus;
  readonly transferId: string | null;
  readonly tokenId: string;
  readonly assets: readonly AssetAmount[];
  readonly senderPubkey: string | null;
  readonly memo?: string;
  readonly createdAt: string;
  readonly key: string;
}

export interface MailboxListResult {
  readonly readPointer: number;
  readonly cursor: number;
  readonly syncEpoch: number;
  readonly more: boolean;
  readonly entries: readonly MailboxWireEntry[];
}

export interface ClaimResult {
  readonly claimed: string[];
  readonly alreadyClaimed: { entryId: string; intoInventory: boolean }[];
  readonly failed: { entryId: string; code: string }[];
}

export type RejectReason = 'invalid' | 'not-owned' | 'storage-rejected' | 'other';

export interface IntentView {
  readonly transferId: string;
  readonly payload: string;
  readonly status: 'open' | 'aborted';
  readonly createdAt: string;
}

export interface ProgressView {
  readonly opIndex: number;
  readonly payload: string;
  readonly createdAt: string;
}

export type HistoryType = 'SENT' | 'RECEIVED' | 'MINT';

export interface HistoryRecordInput {
  readonly dedupKey: string;
  readonly id: string;
  readonly type: HistoryType;
  readonly assets: readonly AssetAmount[];
  readonly ts: string;
  readonly transferId?: string;
  readonly tokenId?: string;
  readonly counterpartyPubkey?: string;
  readonly counterpartyNametag?: string;
  readonly memo?: string;
}

export interface HistoryListResult {
  readonly records: readonly HistoryRecordInput[];
  readonly more: boolean;
  readonly cursor: string | null;
  readonly syncEpoch: number;
}

export type PaymentRequestStatus = 'open' | 'paid' | 'declined' | 'expired';

export interface PaymentRequestWire {
  readonly id: string;
  readonly seq: number;
  readonly fromPubkey: string;
  readonly toPubkey: string;
  readonly assets: readonly AssetAmount[];
  readonly memo?: string;
  readonly status: PaymentRequestStatus;
  readonly transferId: string | null;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RequestListResult {
  readonly requests: readonly PaymentRequestWire[];
  readonly more: boolean;
  readonly cursor: number | string | null;
  readonly syncEpoch: number;
}

export interface WakeEvent {
  readonly stream: 'inventory' | 'mailbox' | 'payment_requests';
  readonly syncEpoch: number;
}

export interface SeedSignatureCheck {
  readonly chainPubkey: string;
  readonly message: string;
  readonly signature: string;
}

export interface FakeWalletApiConfig {
  readonly pageLimit?: number;
  readonly maxRecipientEntries?: number;
  readonly maxSenderRecipientEntries?: number;
  readonly maxPayerOpenRequests?: number;
  readonly network?: string;
  readonly decodeBlob?: (bytes: Uint8Array) => FakeBlobMeta;
  readonly verifySeedSignature?: (check: SeedSignatureCheck) => boolean;
}

// ── pure helpers (exported for tests and later phases) ───────────────────────

export function sha256Hex(...parts: Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** entry_id = SHA-256(token_id bytes ‖ state_hash bytes) — mailbox/service.ts entryIdFor. */
export function entryIdFor(tokenIdHex: string, stateHashHex: string): string {
  return sha256Hex(hexBytes(tokenIdHex), hexBytes(stateHashHex));
}

export function encodeFakeBlob(meta: FakeBlobMeta): Uint8Array {
  return utf8(JSON.stringify(meta));
}

export function decodeFakeBlob(bytes: Uint8Array): FakeBlobMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ValidationFailedError('blob is not a decodable fake token blob');
  }
  const meta = parsed as FakeBlobMeta;
  if (
    typeof meta.tokenId !== 'string' ||
    typeof meta.stateHash !== 'string' ||
    !Array.isArray(meta.consumedStates) ||
    typeof meta.ownerPubkey !== 'string' ||
    !Array.isArray(meta.assets)
  ) {
    throw new ValidationFailedError('blob is not a decodable fake token blob');
  }
  return meta;
}

/** intents/service.ts progressMessage — bound to the exact stored payload bytes. */
export function progressMessageFor(transferId: string, opIndex: number, payload: string): string {
  return `wallet-api.progress.v1:${transferId}:${String(opIndex)}:${sha256Hex(utf8(payload))}`;
}

export function completeMessageFor(transferId: string): string {
  return `wallet-api.complete.v1:${transferId}`;
}

/** The default fake signature scheme; inject verifySeedSignature for real crypto. */
export function fakeSeedSignature(chainPubkey: string, message: string): string {
  return `sig:${chainPubkey}:${message}`;
}

export const ownerIdOf = (caller: FakeCaller): string => `${caller.network}:${caller.chainPubkey}`;
const pubkeyOf = (ownerId: string): string => ownerId.slice(ownerId.indexOf(':') + 1);

const MAX_OP_INDEX = 255;
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

// ── internal rows ─────────────────────────────────────────────────────────────

interface Account {
  cursor: number;
  nextMailboxSeq: number;
  nextPrSeq: number;
}

interface InvRow {
  readonly tokenId: string;
  status: 'active' | 'removed';
  stateHash: string;
  seq: number;
  key: string;
  removalClass: RemovalClass | null;
  assets: readonly AssetAmount[];
}

interface MailboxRow {
  readonly entryId: string;
  readonly recipientOwnerId: string;
  readonly seq: number;
  status: MailboxStatus;
  claimedIntoInventory: boolean | null;
  readonly transferId: string | null;
  readonly tokenId: string;
  readonly stateHash: string;
  readonly key: string;
  readonly assets: readonly AssetAmount[];
  readonly senderPubkey: string | null;
  readonly memo: string | null;
  readonly createdAt: string;
  rejectReason: string | null;
  rejectDetail: string | null;
}

interface IntentRow {
  readonly transferId: string;
  payload: string;
  status: 'open' | 'completed' | 'aborted';
  readonly requiresSeedClose: boolean;
  readonly createdAt: string;
  readonly progress: Map<number, { payload: string; createdAt: string }>;
}

interface PrRow {
  readonly id: string;
  seq: number;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
  readonly assets: readonly AssetAmount[];
  readonly memo: string | null;
  status: PaymentRequestStatus;
  transferId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

interface LineageRowView {
  readonly ownerId: string;
  readonly status: 'active' | 'removed';
  readonly stateHash: string;
  readonly removalClass: RemovalClass | null;
}

type LineageDecision =
  | { ok: true; action: 'insert' | 'update'; handoffOwnerIds: readonly string[] }
  | { ok: false; reason: string };

/**
 * validation/lineage.ts decideLineage, ported: cross-owner precedence first;
 * strict extension over the own row (any status); equal-state reactivation only
 * for the own UNEVIDENCED tombstone; everything else conflicts.
 */
function decideLineage(
  ownerId: string,
  incoming: { finalState: string; consumedStates: ReadonlySet<string> },
  rows: readonly LineageRowView[]
): LineageDecision {
  const others = rows.filter((row) => row.ownerId !== ownerId);
  for (const other of others) {
    if (!incoming.consumedStates.has(other.stateHash)) {
      return { ok: false, reason: 'another owner holds an equal or newer state for this token' };
    }
  }
  const handoffOwnerIds = others.filter((row) => row.status === 'active').map((row) => row.ownerId);
  const own = rows.find((row) => row.ownerId === ownerId);
  if (own === undefined) return { ok: true, action: 'insert', handoffOwnerIds };
  if (incoming.consumedStates.has(own.stateHash)) return { ok: true, action: 'update', handoffOwnerIds };
  if (own.stateHash === incoming.finalState && own.status === 'removed' && own.removalClass === 'unevidenced') {
    return { ok: true, action: 'update', handoffOwnerIds };
  }
  return { ok: false, reason: 'stale or equal-state re-add refused' };
}

// ── the fake ──────────────────────────────────────────────────────────────────

export class FakeWalletApi {
  private readonly pageLimit: number;
  private readonly maxRecipientEntries: number;
  private readonly maxSenderRecipientEntries: number;
  private readonly maxPayerOpenRequests: number;
  private readonly network: string;
  private readonly decodeBlob: (bytes: Uint8Array) => FakeBlobMeta;
  private readonly verifySeed: (check: SeedSignatureCheck) => boolean;

  private epoch = 1;
  private tick = 0;
  private lossyWakes = false;

  private readonly accounts = new Map<string, Account>();
  private readonly inventory = new Map<string, Map<string, InvRow>>();
  private readonly applied = new Map<string, Map<string, number>>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly intents = new Map<string, Map<string, IntentRow>>();
  private readonly mailbox = new Map<string, MailboxRow>();
  private readonly readPointers = new Map<string, number>();
  private readonly history = new Map<string, Map<string, HistoryRecordInput>>();
  private readonly requests = new Map<string, PrRow>();
  private readonly wakeListeners = new Map<string, Set<(event: WakeEvent) => void>>();

  constructor(config: FakeWalletApiConfig = {}) {
    this.pageLimit = config.pageLimit ?? 100;
    this.maxRecipientEntries = config.maxRecipientEntries ?? 0;
    this.maxSenderRecipientEntries = config.maxSenderRecipientEntries ?? 0;
    this.maxPayerOpenRequests = config.maxPayerOpenRequests ?? 100;
    this.network = config.network ?? 'testnet2';
    this.decodeBlob = config.decodeBlob ?? decodeFakeBlob;
    this.verifySeed =
      config.verifySeedSignature ??
      ((check): boolean => check.signature === fakeSeedSignature(check.chainPubkey, check.message));
  }

  get syncEpoch(): number {
    return this.epoch;
  }

  // ── shared internals ────────────────────────────────────────────────────────

  private nowIso(): string {
    this.tick += 1;
    return new Date(BASE_MS + this.tick * 1000).toISOString();
  }

  private account(ownerId: string): Account {
    let account = this.accounts.get(ownerId);
    if (account === undefined) {
      account = { cursor: 0, nextMailboxSeq: 0, nextPrSeq: 0 };
      this.accounts.set(ownerId, account);
    }
    return account;
  }

  private ownRows(ownerId: string): Map<string, InvRow> {
    let rows = this.inventory.get(ownerId);
    if (rows === undefined) {
      rows = new Map();
      this.inventory.set(ownerId, rows);
    }
    return rows;
  }

  private tokenRows(tokenId: string): { ownerId: string; row: InvRow }[] {
    const out: { ownerId: string; row: InvRow }[] = [];
    for (const [ownerId, rows] of this.inventory) {
      const row = rows.get(tokenId);
      if (row !== undefined) out.push({ ownerId, row });
    }
    return out;
  }

  private lineageViews(tokenId: string): LineageRowView[] {
    return this.tokenRows(tokenId).map(({ ownerId, row }) => ({
      ownerId,
      status: row.status,
      stateHash: row.stateHash,
      removalClass: row.removalClass,
    }));
  }

  private wake(ownerId: string, stream: WakeEvent['stream']): void {
    if (this.lossyWakes) return;
    const listeners = this.wakeListeners.get(ownerId);
    if (listeners === undefined) return;
    for (const listener of listeners) listener({ stream, syncEpoch: this.epoch });
  }

  private tombstone(ownerId: string, tokenId: string, removalClass: RemovalClass): void {
    const row = this.ownRows(ownerId).get(tokenId);
    if (row === undefined) return;
    const account = this.account(ownerId);
    account.cursor += 1;
    row.status = 'removed';
    row.removalClass = removalClass;
    row.seq = account.cursor;
    row.assets = [];
  }

  private writeRow(ownerId: string, meta: { tokenId: string; stateHash: string; key: string; assets: readonly AssetAmount[] }): void {
    const account = this.account(ownerId);
    account.cursor += 1;
    const rows = this.ownRows(ownerId);
    const existing = rows.get(meta.tokenId);
    if (existing === undefined) {
      rows.set(meta.tokenId, {
        tokenId: meta.tokenId,
        status: 'active',
        stateHash: meta.stateHash,
        seq: account.cursor,
        key: meta.key,
        removalClass: null,
        assets: meta.assets,
      });
      return;
    }
    existing.status = 'active';
    existing.stateHash = meta.stateHash;
    existing.seq = account.cursor;
    existing.key = meta.key;
    existing.removalClass = null;
    existing.assets = meta.assets;
  }

  private validateBlob(params: { key: string; claimedTokenId: string; ownerPubkey: string }): FakeBlobMeta {
    const bytes = this.blobs.get(params.key);
    if (bytes === undefined) throw new ValidationFailedError(`blob unavailable: ${params.key}`);
    const meta = this.decodeBlob(bytes);
    if (meta.tokenId !== params.claimedTokenId) {
      throw new ValidationFailedError('decoded token id does not match the claimed tokenId');
    }
    if (meta.ownerPubkey !== params.ownerPubkey) {
      throw new ValidationFailedError('final state predicate is not owned by the expected pubkey');
    }
    return meta;
  }

  // ── blobs ───────────────────────────────────────────────────────────────────

  async putBlob(sha256: string, bytes: Uint8Array): Promise<{ key: string }> {
    if (sha256Hex(bytes) !== sha256) {
      throw new ValidationFailedError('uploaded bytes do not match the pinned sha256 checksum');
    }
    if (!this.blobs.has(sha256)) this.blobs.set(sha256, Uint8Array.from(bytes));
    return { key: sha256 };
  }

  async getBlob(key: string): Promise<Uint8Array | undefined> {
    const bytes = this.blobs.get(key);
    return bytes === undefined ? undefined : Uint8Array.from(bytes);
  }

  // ── inventory ───────────────────────────────────────────────────────────────

  async listInventory(caller: FakeCaller, since?: number): Promise<InventoryWirePage> {
    const ownerId = ownerIdOf(caller);
    const account = this.account(ownerId);
    const all = [...this.ownRows(ownerId).values()].sort((a, b) => a.seq - b.seq);
    const filtered =
      since === undefined ? all.filter((row) => row.status === 'active') : all.filter((row) => row.seq > since);
    const more = filtered.length > this.pageLimit;
    const page = filtered.slice(0, this.pageLimit);
    const items = page.map((row): InventoryWireItem => ({
      tokenId: row.tokenId,
      status: row.status,
      seq: row.seq,
      stateHash: row.stateHash,
      ...(row.status === 'active' && row.assets.length > 0 ? { assets: row.assets } : {}),
    }));
    const last = items[items.length - 1];
    return { cursor: more && last !== undefined ? last.seq : account.cursor, syncEpoch: this.epoch, more, items };
  }

  async balances(caller: FakeCaller): Promise<{ coinId: string; total: string; tokenCount: number }[]> {
    const totals = new Map<string, { total: bigint; tokenCount: number }>();
    for (const row of this.ownRows(ownerIdOf(caller)).values()) {
      if (row.status !== 'active') continue;
      for (const asset of row.assets) {
        const entry = totals.get(asset.coinId) ?? { total: 0n, tokenCount: 0 };
        entry.total += BigInt(asset.amount);
        entry.tokenCount += 1;
        totals.set(asset.coinId, entry);
      }
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([coinId, entry]) => ({ coinId, total: entry.total.toString(), tokenCount: entry.tokenCount }));
  }

  async apply(caller: FakeCaller, input: ApplyInput): Promise<{ cursor: number; syncEpoch: number }> {
    const ownerId = ownerIdOf(caller);
    assertDisjointTokenSets(input);
    const validated = input.added.map((added) => ({
      key: added.key,
      meta: this.validateBlob({ key: added.key, claimedTokenId: added.tokenId, ownerPubkey: caller.chainPubkey }),
    }));
    const evidence = this.loadDepositEvidence(ownerId, input);
    const replayed = this.applied.get(ownerId)?.get(input.transferId);
    if (replayed !== undefined) return { cursor: replayed, syncEpoch: this.epoch };
    const outcome = this.applyTx(ownerId, input, validated, evidence);
    for (const changed of outcome.changedOwnerIds) this.wake(changed, 'inventory');
    return { cursor: outcome.cursor, syncEpoch: this.epoch };
  }

  private loadDepositEvidence(
    ownerId: string,
    input: ApplyInput
  ): { consumed: Map<string, Set<string>>; finals: Map<string, Set<string>> } {
    const consumed = new Map<string, Set<string>>();
    const finals = new Map<string, Set<string>>();
    if (input.spent.length === 0) return { consumed, finals };
    const spentSet = new Set(input.spent);
    for (const entry of this.mailbox.values()) {
      if (entry.transferId !== input.transferId || !spentSet.has(entry.tokenId)) continue;
      if (entry.recipientOwnerId === ownerId) addTo(finals, entry.tokenId, entry.stateHash);
      const bytes = this.blobs.get(entry.key);
      if (bytes === undefined) continue;
      let meta: FakeBlobMeta;
      try {
        meta = this.decodeBlob(bytes);
      } catch {
        continue;
      }
      for (const state of meta.consumedStates) addTo(consumed, entry.tokenId, state);
    }
    return { consumed, finals };
  }

  private applyTx(
    ownerId: string,
    input: ApplyInput,
    validated: readonly { key: string; meta: FakeBlobMeta }[],
    evidence: { consumed: Map<string, Set<string>>; finals: Map<string, Set<string>> }
  ): { cursor: number; changedOwnerIds: readonly string[] } {
    const adds = validated.map((blob) => this.planAdd(ownerId, blob));
    const spends = input.spent.map((tokenId) => this.planSpend(ownerId, tokenId, input, validated, evidence));
    const changed = new Set<string>();
    for (const add of adds) {
      if (add.kind === 'noop') continue;
      for (const handoffOwnerId of add.handoffOwnerIds) {
        this.tombstone(handoffOwnerId, add.meta.tokenId, 'evidenced');
        changed.add(handoffOwnerId);
      }
      this.writeRow(ownerId, { tokenId: add.meta.tokenId, stateHash: add.meta.stateHash, key: add.key, assets: add.meta.assets });
      changed.add(ownerId);
    }
    for (const spend of spends) {
      if (spend.kind === 'noop') continue;
      this.tombstone(ownerId, spend.tokenId, spend.removalClass);
      changed.add(ownerId);
    }
    const evidencedSpend = spends.some((spend) => spend.kind === 'flip' && spend.removalClass === 'evidenced');
    this.completeIntentUnchecked(ownerId, input.transferId, evidencedSpend);
    const cursor = this.account(ownerId).cursor;
    let appliedForOwner = this.applied.get(ownerId);
    if (appliedForOwner === undefined) {
      appliedForOwner = new Map();
      this.applied.set(ownerId, appliedForOwner);
    }
    appliedForOwner.set(input.transferId, cursor);
    return { cursor, changedOwnerIds: [...changed] };
  }

  private planAdd(
    ownerId: string,
    blob: { key: string; meta: FakeBlobMeta }
  ): { kind: 'noop' } | { kind: 'write'; key: string; meta: FakeBlobMeta; handoffOwnerIds: readonly string[] } {
    const own = this.ownRows(ownerId).get(blob.meta.tokenId);
    if (own !== undefined && own.status === 'active' && own.stateHash === blob.meta.stateHash) return { kind: 'noop' };
    const decision = decideLineage(
      ownerId,
      { finalState: blob.meta.stateHash, consumedStates: new Set(blob.meta.consumedStates) },
      this.lineageViews(blob.meta.tokenId)
    );
    if (!decision.ok) {
      throw new ConflictError(`lineage conflict for token ${blob.meta.tokenId}: ${decision.reason}`);
    }
    return { kind: 'write', key: blob.key, meta: blob.meta, handoffOwnerIds: decision.handoffOwnerIds };
  }

  private planSpend(
    ownerId: string,
    tokenId: string,
    input: ApplyInput,
    validated: readonly { key: string; meta: FakeBlobMeta }[],
    evidence: { consumed: Map<string, Set<string>>; finals: Map<string, Set<string>> }
  ): { kind: 'noop'; tokenId: string } | { kind: 'flip'; tokenId: string; removalClass: RemovalClass } {
    const own = this.ownRows(ownerId).get(tokenId);
    if (own === undefined) throw new ValidationFailedError(`spent token ${tokenId} has no inventory row for this owner`);
    if (own.status === 'removed') return { kind: 'noop', tokenId };
    if (evidence.finals.get(tokenId)?.has(own.stateHash) === true) return { kind: 'noop', tokenId };
    if (evidence.consumed.get(tokenId)?.has(own.stateHash) === true) {
      return { kind: 'flip', tokenId, removalClass: 'evidenced' };
    }
    const corroborated = validated.some(
      (blob) =>
        blob.meta.splitEvidence !== undefined &&
        blob.meta.splitEvidence.burntTokenId === tokenId &&
        blob.meta.splitEvidence.preBurnState === own.stateHash
    );
    if (corroborated) return { kind: 'flip', tokenId, removalClass: 'evidenced' };
    return { kind: 'flip', tokenId, removalClass: input.externalDelivery === true ? 'external' : 'unevidenced' };
  }

  // ── intents ─────────────────────────────────────────────────────────────────

  async putIntent(
    caller: FakeCaller,
    params: { transferId: string; payload: string; requiresSeedClose?: boolean }
  ): Promise<void> {
    const ownerId = ownerIdOf(caller);
    let ownerIntents = this.intents.get(ownerId);
    if (ownerIntents === undefined) {
      ownerIntents = new Map();
      this.intents.set(ownerId, ownerIntents);
    }
    const existing = ownerIntents.get(params.transferId);
    if (existing === undefined) {
      ownerIntents.set(params.transferId, {
        transferId: params.transferId,
        payload: params.payload,
        status: 'open',
        requiresSeedClose: params.requiresSeedClose ?? false,
        createdAt: this.nowIso(),
        progress: new Map(),
      });
      return;
    }
    if (existing.status !== 'aborted') return;
    if (existing.payload !== params.payload) {
      throw new ConflictError('an aborted intent re-opens only with its original payload');
    }
    existing.status = 'open';
  }

  async listIntents(caller: FakeCaller, status: 'open' | 'aborted'): Promise<readonly IntentView[]> {
    const ownerIntents = this.intents.get(ownerIdOf(caller));
    if (ownerIntents === undefined) return [];
    return [...ownerIntents.values()]
      .filter((intent) => intent.status === status)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.transferId < b.transferId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((intent) => ({
        transferId: intent.transferId,
        payload: intent.payload,
        status: intent.status as 'open' | 'aborted',
        createdAt: intent.createdAt,
      }));
  }

  async abortIntent(caller: FakeCaller, transferId: string): Promise<void> {
    const intent = this.intents.get(ownerIdOf(caller))?.get(transferId);
    if (intent === undefined) throw new NotFoundError('unknown intent');
    if (intent.status === 'open') intent.status = 'aborted';
  }

  async completeIntent(caller: FakeCaller, params: { transferId: string; signature?: string }): Promise<void> {
    let seedVerified = false;
    if (params.signature !== undefined) {
      const check: SeedSignatureCheck = {
        chainPubkey: caller.chainPubkey,
        message: completeMessageFor(params.transferId),
        signature: params.signature,
      };
      if (!this.verifySeed(check)) throw new ForbiddenError('complete signature verification failed');
      seedVerified = true;
    }
    const intent = this.intents.get(ownerIdOf(caller))?.get(params.transferId);
    if (intent === undefined) throw new NotFoundError('unknown intent');
    if (intent.status === 'completed') return;
    if (intent.requiresSeedClose && !seedVerified) {
      throw new ForbiddenError('completing a requires_seed_close intent needs the wallet chain key; the close was refused');
    }
    intent.status = 'completed';
  }

  private completeIntentUnchecked(ownerId: string, transferId: string, evidencedSpend: boolean): void {
    const intent = this.intents.get(ownerId)?.get(transferId);
    if (intent === undefined || intent.status === 'completed') return;
    if (intent.requiresSeedClose && !evidencedSpend) return;
    intent.status = 'completed';
  }

  async appendProgress(
    caller: FakeCaller,
    params: { transferId: string; opIndex: number; payload: string; signature: string }
  ): Promise<{ created: boolean; record: ProgressView }> {
    if (!Number.isInteger(params.opIndex) || params.opIndex < 0 || params.opIndex > MAX_OP_INDEX) {
      throw new ValidationFailedError(`opIndex must be an integer in 0..${String(MAX_OP_INDEX)}`);
    }
    const check: SeedSignatureCheck = {
      chainPubkey: caller.chainPubkey,
      message: progressMessageFor(params.transferId, params.opIndex, params.payload),
      signature: params.signature,
    };
    if (!this.verifySeed(check)) throw new ForbiddenError('progress append signature verification failed');
    const intent = this.intents.get(ownerIdOf(caller))?.get(params.transferId);
    if (intent === undefined) throw new NotFoundError('unknown intent');
    if (intent.status !== 'open') throw new ConflictError('intent progress is writable only while the intent is open');
    if (!intent.requiresSeedClose) {
      throw new ConflictError('intent progress requires the intent to be created with requiresSeedClose=true');
    }
    const existing = intent.progress.get(params.opIndex);
    if (existing !== undefined) {
      return { created: false, record: { opIndex: params.opIndex, payload: existing.payload, createdAt: existing.createdAt } };
    }
    const record = { payload: params.payload, createdAt: this.nowIso() };
    intent.progress.set(params.opIndex, record);
    return { created: true, record: { opIndex: params.opIndex, payload: record.payload, createdAt: record.createdAt } };
  }

  async listProgress(caller: FakeCaller, transferId: string): Promise<readonly ProgressView[]> {
    const intent = this.intents.get(ownerIdOf(caller))?.get(transferId);
    if (intent === undefined) throw new NotFoundError('unknown intent');
    return [...intent.progress.entries()]
      .sort(([a], [b]) => a - b)
      .map(([opIndex, record]) => ({ opIndex, payload: record.payload, createdAt: record.createdAt }));
  }

  /** Test-inspection only — intents in status 'completed' are not listable on the wire. */
  inspectIntent(
    caller: FakeCaller,
    transferId: string
  ): { status: 'open' | 'completed' | 'aborted'; requiresSeedClose: boolean; payload: string } | undefined {
    const intent = this.intents.get(ownerIdOf(caller))?.get(transferId);
    if (intent === undefined) return undefined;
    return { status: intent.status, requiresSeedClose: intent.requiresSeedClose, payload: intent.payload };
  }

  /** Test-inspection only — removalClass is not on the list wire (server exposes it via 409 behavior). */
  inspectInventoryRow(
    caller: FakeCaller,
    tokenId: string
  ): { status: 'active' | 'removed'; stateHash: string; seq: number; removalClass: RemovalClass | null } | undefined {
    const row = this.ownRows(ownerIdOf(caller)).get(tokenId);
    if (row === undefined) return undefined;
    return { status: row.status, stateHash: row.stateHash, seq: row.seq, removalClass: row.removalClass };
  }

  // ── mailbox ─────────────────────────────────────────────────────────────────

  async deposit(caller: FakeCaller, input: DepositInput): Promise<{ entryId: string }> {
    const { entries } = await this.depositBatch(caller, [input]);
    const first = entries[0];
    if (first === undefined) throw new ValidationFailedError('deposit produced no entry');
    return { entryId: first.entryId };
  }

  async depositBatch(
    caller: FakeCaller,
    inputs: readonly DepositInput[]
  ): Promise<{ entries: readonly { entryId: string; seq: number }[] }> {
    if (inputs.length === 0) throw new ValidationFailedError('batch deposit requires at least one entry');
    if (new Set(inputs.map((input) => input.recipientPubkey)).size > 1) {
      throw new ValidationFailedError('batch deposit entries must name one recipient');
    }
    const items = inputs.map((input) => this.validateDeposit(input));
    if (new Set(items.map((item) => item.entryId)).size !== items.length) {
      throw new ValidationFailedError('batch deposit entries must be distinct (tokenId, stateHash) pairs');
    }
    const firstInput = inputs[0];
    if (firstInput === undefined) throw new ValidationFailedError('batch deposit requires at least one entry');
    const recipientOwnerId = `${caller.network}:${firstInput.recipientPubkey}`;
    const resolved = items.map((item) => {
      const existing = this.mailbox.get(item.entryId);
      if (existing !== undefined && (existing.recipientOwnerId !== recipientOwnerId || existing.key !== item.input.key)) {
        throw new ConflictError('an entry with this entry_id exists with a different recipient or key');
      }
      return { item, existing };
    });
    for (const { item, existing } of resolved) {
      if (existing !== undefined) continue;
      const decision = decideLineage(
        recipientOwnerId,
        { finalState: item.meta.stateHash, consumedStates: new Set(item.meta.consumedStates) },
        this.lineageViews(item.meta.tokenId)
      );
      if (!decision.ok) throw new ConflictError(`lineage conflict for token ${item.meta.tokenId}: ${decision.reason}`);
    }
    const freshCount = resolved.filter((entry) => entry.existing === undefined).length;
    this.assertInboxCaps(recipientOwnerId, caller.chainPubkey, freshCount);
    const account = this.account(recipientOwnerId);
    const entries: { entryId: string; seq: number }[] = [];
    for (const { item, existing } of resolved) {
      if (existing !== undefined) {
        entries.push({ entryId: item.entryId, seq: existing.seq });
        continue;
      }
      account.nextMailboxSeq += 1;
      this.mailbox.set(item.entryId, {
        entryId: item.entryId,
        recipientOwnerId,
        seq: account.nextMailboxSeq,
        status: 'unclaimed',
        claimedIntoInventory: null,
        transferId: item.input.transferId,
        tokenId: item.meta.tokenId,
        stateHash: item.meta.stateHash,
        key: item.input.key,
        assets: item.meta.assets,
        senderPubkey: caller.chainPubkey,
        memo: item.input.memo ?? null,
        createdAt: this.nowIso(),
        rejectReason: null,
        rejectDetail: null,
      });
      entries.push({ entryId: item.entryId, seq: account.nextMailboxSeq });
    }
    if (freshCount > 0) this.wake(recipientOwnerId, 'mailbox');
    return { entries };
  }

  private validateDeposit(input: DepositInput): { input: DepositInput; entryId: string; meta: FakeBlobMeta } {
    const meta = this.validateBlob({ key: input.key, claimedTokenId: input.tokenId, ownerPubkey: input.recipientPubkey });
    if (meta.stateHash !== input.stateHash) {
      throw new ValidationFailedError('decoded final state does not match the claimed stateHash');
    }
    return { input, entryId: entryIdFor(meta.tokenId, meta.stateHash), meta };
  }

  private assertInboxCaps(recipientOwnerId: string, senderPubkey: string, freshCount: number): void {
    if (freshCount === 0 || (this.maxRecipientEntries <= 0 && this.maxSenderRecipientEntries <= 0)) return;
    let total = 0;
    let fromSender = 0;
    for (const entry of this.mailbox.values()) {
      if (entry.recipientOwnerId !== recipientOwnerId || entry.status === 'claimed') continue;
      total += 1;
      if (entry.senderPubkey === senderPubkey) fromSender += 1;
    }
    if (this.maxSenderRecipientEntries > 0 && fromSender + freshCount > this.maxSenderRecipientEntries) {
      throw new QuotaExceededError(
        `per-(sender, recipient) unclaimed+rejected entries exceed ${String(this.maxSenderRecipientEntries)}`,
        'max_sender_recipient_entries'
      );
    }
    if (this.maxRecipientEntries > 0 && total + freshCount > this.maxRecipientEntries) {
      throw new QuotaExceededError(
        `per-recipient unclaimed+rejected entries exceed ${String(this.maxRecipientEntries)}`,
        'max_recipient_entries'
      );
    }
  }

  async listMailbox(caller: FakeCaller, since = 0): Promise<MailboxListResult> {
    const ownerId = ownerIdOf(caller);
    const account = this.account(ownerId);
    const all = [...this.mailbox.values()]
      .filter((entry) => entry.recipientOwnerId === ownerId && entry.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const more = all.length > this.pageLimit;
    const page = all.slice(0, this.pageLimit);
    const last = page[page.length - 1];
    return {
      readPointer: this.readPointers.get(ownerId) ?? 0,
      cursor: more && last !== undefined ? last.seq : account.nextMailboxSeq,
      syncEpoch: this.epoch,
      more,
      entries: page.map((entry) => ({
        entryId: entry.entryId,
        seq: entry.seq,
        status: entry.status,
        transferId: entry.transferId,
        tokenId: entry.tokenId,
        assets: entry.assets,
        senderPubkey: entry.senderPubkey,
        ...(entry.memo === null ? {} : { memo: entry.memo }),
        createdAt: entry.createdAt,
        key: entry.key,
      })),
    };
  }

  async claim(caller: FakeCaller, input: { entryIds: readonly string[]; intoInventory: boolean }): Promise<ClaimResult> {
    const out: ClaimResult = { claimed: [], alreadyClaimed: [], failed: [] };
    for (const entryId of [...new Set(input.entryIds)].sort()) {
      this.claimOne(caller, entryId, input.intoInventory, out);
    }
    return out;
  }

  private claimOne(caller: FakeCaller, entryId: string, intoInventory: boolean, out: ClaimResult): void {
    const entry = this.requireAddressee(entryId, caller);
    if (entry.status === 'claimed') {
      const stored = entry.claimedIntoInventory ?? false;
      if (!intoInventory || stored) {
        out.alreadyClaimed.push({ entryId, intoInventory: stored });
        return;
      }
      const written = this.materialize(entry);
      if (!written.ok) {
        out.failed.push({ entryId, code: written.code });
        return;
      }
      entry.claimedIntoInventory = true;
      out.alreadyClaimed.push({ entryId, intoInventory: true });
      for (const changed of written.changedOwnerIds) this.wake(changed, 'inventory');
      return;
    }
    let changedOwnerIds: readonly string[] = [];
    if (intoInventory) {
      const written = this.materialize(entry);
      if (!written.ok) {
        out.failed.push({ entryId, code: written.code });
        return;
      }
      changedOwnerIds = written.changedOwnerIds;
    }
    entry.status = 'claimed';
    entry.claimedIntoInventory = intoInventory;
    this.recomputeReadPointer(entry.recipientOwnerId);
    out.claimed.push(entryId);
    for (const changed of changedOwnerIds) this.wake(changed, 'inventory');
  }

  private requireAddressee(entryId: string, caller: FakeCaller): MailboxRow {
    const entry = this.mailbox.get(entryId);
    if (entry === undefined) throw new NotFoundError('unknown mailbox entry');
    if (entry.recipientOwnerId !== ownerIdOf(caller)) {
      throw new ForbiddenError('only the addressee may claim or reject a mailbox entry');
    }
    return entry;
  }

  private materialize(entry: MailboxRow): { ok: true; changedOwnerIds: readonly string[] } | { ok: false; code: string } {
    const bytes = this.blobs.get(entry.key);
    if (bytes === undefined) throw new ValidationFailedError(`mailbox blob unavailable: ${entry.key}`);
    const meta = this.decodeBlob(bytes);
    const own = this.ownRows(entry.recipientOwnerId).get(entry.tokenId);
    if (own !== undefined && own.status === 'active' && own.stateHash === entry.stateHash) {
      return { ok: true, changedOwnerIds: [] };
    }
    const decision = decideLineage(
      entry.recipientOwnerId,
      { finalState: entry.stateHash, consumedStates: new Set(meta.consumedStates) },
      this.lineageViews(entry.tokenId)
    );
    if (!decision.ok) return { ok: false, code: 'CONFLICT' };
    for (const handoffOwnerId of decision.handoffOwnerIds) this.tombstone(handoffOwnerId, entry.tokenId, 'evidenced');
    this.writeRow(entry.recipientOwnerId, {
      tokenId: entry.tokenId,
      stateHash: entry.stateHash,
      key: entry.key,
      assets: entry.assets,
    });
    return { ok: true, changedOwnerIds: [entry.recipientOwnerId, ...decision.handoffOwnerIds] };
  }

  async reject(
    caller: FakeCaller,
    input: { entryIds: readonly string[]; reason?: RejectReason; detail?: string }
  ): Promise<{ rejected: string[] }> {
    const reason = input.reason ?? null;
    const detail = reason === null ? null : (input.detail ?? null);
    const ids = [...new Set(input.entryIds)].sort();
    const entries = ids.map((entryId) => this.requireAddressee(entryId, caller));
    const rejected: string[] = [];
    let newlyRejected = false;
    for (const [index, entry] of entries.entries()) {
      const entryId = ids[index] as string;
      if (entry.status === 'claimed') continue;
      if (entry.status === 'unclaimed') {
        entry.status = 'rejected';
        entry.rejectReason = reason;
        entry.rejectDetail = detail;
        newlyRejected = true;
      }
      rejected.push(entryId);
    }
    if (newlyRejected) this.recomputeReadPointer(ownerIdOf(caller));
    return { rejected };
  }

  private recomputeReadPointer(recipientOwnerId: string): void {
    const lastSeq = this.readPointers.get(recipientOwnerId) ?? 0;
    const entries = [...this.mailbox.values()].filter((entry) => entry.recipientOwnerId === recipientOwnerId);
    const unclaimedAbove = entries
      .filter((entry) => entry.status === 'unclaimed' && entry.seq > lastSeq)
      .map((entry) => entry.seq);
    const pointer =
      unclaimedAbove.length > 0
        ? Math.min(...unclaimedAbove) - 1
        : entries.length > 0
          ? Math.max(lastSeq, ...entries.map((entry) => entry.seq))
          : lastSeq;
    this.readPointers.set(recipientOwnerId, pointer);
  }

  // ── history ─────────────────────────────────────────────────────────────────

  async appendHistory(
    caller: FakeCaller,
    records: readonly HistoryRecordInput[]
  ): Promise<{ inserted: number; deduped: number }> {
    const ownerId = ownerIdOf(caller);
    let ownerHistory = this.history.get(ownerId);
    if (ownerHistory === undefined) {
      ownerHistory = new Map();
      this.history.set(ownerId, ownerHistory);
    }
    let inserted = 0;
    for (const record of records) {
      if (ownerHistory.has(record.dedupKey)) continue;
      ownerHistory.set(record.dedupKey, { ...record, ts: new Date(record.ts).toISOString() });
      inserted += 1;
    }
    return { inserted, deduped: records.length - inserted };
  }

  async listHistory(caller: FakeCaller, query: { before?: string; limit?: number } = {}): Promise<HistoryListResult> {
    const limit = Math.min(query.limit ?? 100, 500);
    const before = query.before === undefined ? null : decodeKeyset(query.before);
    const all = [...(this.history.get(ownerIdOf(caller))?.values() ?? [])].sort(byTsDescIdAsc);
    const filtered =
      before === null
        ? all
        : all.filter((record) => {
            const ts = Date.parse(record.ts);
            const beforeTs = Date.parse(before.ts);
            return ts < beforeTs || (ts === beforeTs && record.id > before.id);
          });
    const more = filtered.length > limit;
    const records = filtered.slice(0, limit);
    const last = records[records.length - 1];
    return {
      records,
      more,
      cursor: more && last !== undefined ? encodeKeyset({ ts: last.ts, id: last.id }) : null,
      syncEpoch: this.epoch,
    };
  }

  // ── payment requests ────────────────────────────────────────────────────────

  async createRequest(
    caller: FakeCaller,
    input: { toPubkey: string; assets: readonly AssetAmount[]; memo?: string; expiresAt?: string }
  ): Promise<PaymentRequestWire> {
    const toOwnerId = `${caller.network}:${input.toPubkey}`;
    const openCount = [...this.requests.values()].filter(
      (request) => request.toOwnerId === toOwnerId && request.status === 'open'
    ).length;
    if (openCount >= this.maxPayerOpenRequests) {
      throw new QuotaExceededError(
        `open payment requests per payer exceed ${String(this.maxPayerOpenRequests)}`,
        'max_payer_open_requests'
      );
    }
    const account = this.account(toOwnerId);
    account.nextPrSeq += 1;
    const row: PrRow = {
      id: randomUUID(),
      seq: account.nextPrSeq,
      fromOwnerId: ownerIdOf(caller),
      toOwnerId,
      assets: input.assets,
      memo: input.memo ?? null,
      status: 'open',
      transferId: null,
      createdAt: this.nowIso(),
      expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt).toISOString(),
    };
    this.requests.set(row.id, row);
    this.wake(toOwnerId, 'payment_requests');
    return toRequestWire(row);
  }

  async listRequests(
    caller: FakeCaller,
    input: { role: 'incoming' | 'outgoing'; status?: PaymentRequestStatus; since?: number; before?: string }
  ): Promise<RequestListResult> {
    const ownerId = ownerIdOf(caller);
    if (input.role === 'incoming') {
      if (input.before !== undefined) throw new ValidationFailedError('incoming is a ?since= stream — before is rejected');
      const since = input.since ?? 0;
      const all = [...this.requests.values()]
        .filter(
          (request) =>
            request.toOwnerId === ownerId && request.seq > since && (input.status === undefined || request.status === input.status)
        )
        .sort((a, b) => a.seq - b.seq);
      const more = all.length > this.pageLimit;
      const page = all.slice(0, this.pageLimit);
      const last = page[page.length - 1];
      return {
        requests: page.map(toRequestWire),
        more,
        cursor: more && last !== undefined ? last.seq : this.account(ownerId).nextPrSeq,
        syncEpoch: this.epoch,
      };
    }
    if (input.since !== undefined) throw new ValidationFailedError('outgoing is a ?before= backfill view — since is rejected');
    const before = input.before === undefined ? null : decodeKeyset(input.before);
    const all = [...this.requests.values()]
      .filter((request) => request.fromOwnerId === ownerId && (input.status === undefined || request.status === input.status))
      .sort((a, b) => byTsDescIdAsc({ ts: a.createdAt, id: a.id }, { ts: b.createdAt, id: b.id }));
    const filtered =
      before === null
        ? all
        : all.filter((request) => {
            const ts = Date.parse(request.createdAt);
            const beforeTs = Date.parse(before.ts);
            return ts < beforeTs || (ts === beforeTs && request.id > before.id);
          });
    const more = filtered.length > this.pageLimit;
    const page = filtered.slice(0, this.pageLimit);
    const last = page[page.length - 1];
    return {
      requests: page.map(toRequestWire),
      more,
      cursor: more && last !== undefined ? encodeKeyset({ ts: last.createdAt, id: last.id }) : null,
      syncEpoch: this.epoch,
    };
  }

  async respondRequest(
    caller: FakeCaller,
    id: string,
    input: { action: 'paid' | 'declined'; transferId?: string }
  ): Promise<PaymentRequestWire> {
    if (input.action === 'paid' && input.transferId === undefined) {
      throw new ValidationFailedError('paid links the fulfilling transfer — transferId is required');
    }
    if (input.action === 'declined' && input.transferId !== undefined) {
      throw new ValidationFailedError('declined carries no transfer — transferId is rejected');
    }
    const request = this.requests.get(id);
    if (request === undefined) throw new NotFoundError('unknown payment request');
    if (request.toOwnerId !== ownerIdOf(caller)) {
      throw new ForbiddenError('only the addressee (the payer) may respond to a payment request');
    }
    if (request.status !== 'open') {
      throw new ConflictError(`only an open request may be responded to (status: ${request.status})`);
    }
    const account = this.account(request.toOwnerId);
    account.nextPrSeq += 1;
    request.seq = account.nextPrSeq;
    request.status = input.action;
    request.transferId = input.action === 'paid' ? (input.transferId ?? null) : null;
    for (const owner of new Set([request.toOwnerId, request.fromOwnerId])) this.wake(owner, 'payment_requests');
    return toRequestWire(request);
  }

  /** workers/pr-expiry.ts run(), test-invokable: flips overdue open requests, re-stamps seq. */
  async runExpirySweep(cutoff?: string | Date): Promise<number> {
    const cutoffMs = cutoff === undefined ? BASE_MS + this.tick * 1000 : new Date(cutoff).getTime();
    let flipped = 0;
    for (const request of this.requests.values()) {
      if (request.status !== 'open' || request.expiresAt === null) continue;
      if (Date.parse(request.expiresAt) > cutoffMs) continue;
      const account = this.account(request.toOwnerId);
      account.nextPrSeq += 1;
      request.seq = account.nextPrSeq;
      request.status = 'expired';
      for (const owner of new Set([request.toOwnerId, request.fromOwnerId])) this.wake(owner, 'payment_requests');
      flipped += 1;
    }
    return flipped;
  }

  // ── sync epoch + wakes ──────────────────────────────────────────────────────

  /**
   * restore/rebuild.ts: DB restore simulation. Epoch bumps FIRST; every DB
   * table is lost (intents included — the §6 non-guarantee); blobs survive in
   * S3; inventory + one mailbox entry re-derive from each token's tip blob,
   * with fresh (reset) per-owner counters.
   */
  bumpEpoch(): number {
    this.epoch += 1;
    this.accounts.clear();
    this.inventory.clear();
    this.applied.clear();
    this.intents.clear();
    this.mailbox.clear();
    this.readPointers.clear();
    this.history.clear();
    this.requests.clear();
    this.rebuildFromBlobs();
    return this.epoch;
  }

  private rebuildFromBlobs(): void {
    const byToken = new Map<string, { key: string; meta: FakeBlobMeta }[]>();
    for (const [key, bytes] of this.blobs) {
      let meta: FakeBlobMeta;
      try {
        meta = this.decodeBlob(bytes);
      } catch {
        continue;
      }
      const list = byToken.get(meta.tokenId) ?? [];
      list.push({ key, meta });
      byToken.set(meta.tokenId, list);
    }
    for (const blobsOfToken of byToken.values()) {
      const tip = pickTip(blobsOfToken);
      const ownerId = `${this.network}:${tip.meta.ownerPubkey}`;
      this.writeRow(ownerId, {
        tokenId: tip.meta.tokenId,
        stateHash: tip.meta.stateHash,
        key: tip.key,
        assets: tip.meta.assets,
      });
      const account = this.account(ownerId);
      account.nextMailboxSeq += 1;
      const entryId = entryIdFor(tip.meta.tokenId, tip.meta.stateHash);
      this.mailbox.set(entryId, {
        entryId,
        recipientOwnerId: ownerId,
        seq: account.nextMailboxSeq,
        status: 'unclaimed',
        claimedIntoInventory: null,
        transferId: null,
        tokenId: tip.meta.tokenId,
        stateHash: tip.meta.stateHash,
        key: tip.key,
        assets: tip.meta.assets,
        senderPubkey: null,
        memo: null,
        createdAt: this.nowIso(),
        rejectReason: null,
        rejectDetail: null,
      });
    }
  }

  onWake(ownerId: string, cb: (event: WakeEvent) => void): () => void {
    let listeners = this.wakeListeners.get(ownerId);
    if (listeners === undefined) {
      listeners = new Set();
      this.wakeListeners.set(ownerId, listeners);
    }
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  setLossyWakes(lossy: boolean): void {
    this.lossyWakes = lossy;
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

function assertDisjointTokenSets(input: ApplyInput): void {
  const spent = new Set(input.spent);
  if (spent.size !== input.spent.length) throw new ValidationFailedError('duplicate tokenId in spent');
  const added = new Set(input.added.map((a) => a.tokenId));
  if (added.size !== input.added.length) throw new ValidationFailedError('duplicate tokenId in added');
  for (const tokenId of added) {
    if (spent.has(tokenId)) throw new ValidationFailedError(`tokenId in both spent and added: ${tokenId}`);
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** restore/rebuild.ts pickTip: the blob no other blob consumes; ties → longest chain. */
function pickTip<T extends { meta: FakeBlobMeta }>(blobs: readonly T[]): T {
  const unconsumed = blobs.filter(
    (blob) => !blobs.some((other) => other !== blob && other.meta.consumedStates.includes(blob.meta.stateHash))
  );
  const candidates = unconsumed.length > 0 ? unconsumed : blobs;
  const sorted = [...candidates].sort((a, b) => b.meta.consumedStates.length - a.meta.consumedStates.length);
  const tip = sorted[0];
  if (tip === undefined) throw new Error('pickTip requires at least one blob');
  return tip;
}

function byTsDescIdAsc(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  const tsA = Date.parse(a.ts);
  const tsB = Date.parse(b.ts);
  if (tsA !== tsB) return tsB - tsA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function encodeKeyset(keyset: { ts: string; id: string }): string {
  return Buffer.from(JSON.stringify(keyset), 'utf8').toString('base64url');
}

function decodeKeyset(token: string): { ts: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { ts: string; id: string };
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') throw new Error('bad keyset');
    return parsed;
  } catch {
    throw new ValidationFailedError('malformed keyset cursor');
  }
}

function toRequestWire(row: PrRow): PaymentRequestWire {
  return {
    id: row.id,
    seq: row.seq,
    fromPubkey: pubkeyOf(row.fromOwnerId),
    toPubkey: pubkeyOf(row.toOwnerId),
    assets: row.assets,
    ...(row.memo === null ? {} : { memo: row.memo }),
    status: row.status,
    transferId: row.transferId,
    createdAt: row.createdAt,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
  };
}
