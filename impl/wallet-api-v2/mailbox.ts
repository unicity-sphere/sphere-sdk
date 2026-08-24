// P3b: WalletApiDeliveryPort — DeliveryPort over the §16 mailbox (§5.6/§5.7).
// deliveryId is ALWAYS content-derived hex(SHA-256(tokenId ‖ stateHash)) — never
// a server row id or seq. The seen-set is S7 port-owned; an entry enters it
// ONLY after its ack succeeded.

import { sha256 } from '@noble/hashes/sha2.js';

import { SerialChain } from '../../modules/payments-v2/async';
import type {
  AckOutcome,
  AckRequest,
  DeliverOptions,
  DeliveryPort,
  DeliveryReceipt,
  IncomingDelivery,
} from '../../modules/payments-v2/ports';
import type { ScopedKV } from '../../modules/payments-v2/stores';
import { bytesToHex, hexToBytes } from '../../core/crypto';
import {
  decryptDeliveryBundle,
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  type DeliveryBundle,
} from '../../core/delivery-envelope';
import { isRetryableStatus, isWalletApiHttpError } from './http';
import type {
  MailboxDepositEntry,
  MailboxEntryWire,
  MailboxRejectReason,
  WalletApiV2Client,
} from './client';
import { uploadViaPresigned } from './storage';

export type DeliveryPortClient = Pick<
  WalletApiV2Client,
  'uploadUrls' | 'uploadBlob' | 'fetchBlob' | 'deposit' | 'depositBatch' | 'listMailbox' | 'claim' | 'reject'
>;

export type DeliveryCustody = 'inventory' | 'external';

export interface WakeSource {
  subscribeStream(stream: 'inventory' | 'mailbox' | 'payment_requests', handler: () => void): () => void;
}

export class DeliveryKeysUnboundError extends Error {
  readonly code = 'DELIVERY_KEYS_UNBOUND';
  constructor() {
    super('deliveryKeys derivation not bound — bindDeliveryKeys(engine.deliveryKeys) must run first (S7)');
    this.name = 'DeliveryKeysUnboundError';
  }
}

export class MailboxClaimFailedError extends Error {
  readonly code = 'MAILBOX_CLAIM_FAILED';
  constructor(deliveryId: string, readonly failureCode: string) {
    super(`mailbox claim failed for ${deliveryId}: ${failureCode}`);
    this.name = 'MailboxClaimFailedError';
  }
}

export class DeliveryProtocolError extends Error {
  readonly code = 'PROTOCOL';
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryProtocolError';
  }
}

export function computeDeliveryId(tokenIdHex: string, stateHashHex: string): string {
  const tokenId = hexToBytes(tokenIdHex);
  const stateHash = hexToBytes(stateHashHex);
  const joined = new Uint8Array(tokenId.length + stateHash.length);
  joined.set(tokenId, 0);
  joined.set(stateHash, tokenId.length);
  return bytesToHex(sha256(joined));
}

export const DELIVERY_SEEN_KEY = 'delivery:seen';

export interface DeliveryIdentity {
  privateKey: string;
  chainPubkey: string;
}

export interface WalletApiDeliveryPortConfig {
  client: DeliveryPortClient;
  kv: ScopedKV;
  identity: DeliveryIdentity;
  /** Composition-time custody (S7) — NEVER a per-call flag. */
  custody: DeliveryCustody;
  wake?: WakeSource;
  deliveryKeys?: (blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>;
}

interface PreparedDelivery {
  readonly bytes: Uint8Array;
  readonly tokenId: string;
  readonly stateHash: string;
  readonly deliveryId: string;
  readonly sha: string;
}

/**
 * Entries per claim/reject call. The server caps at 1000, but each entry costs
 * its own S3 read and transaction there, so a huge batch is a multi-second
 * request against an idle timeout with nothing learned about what committed.
 * 50 keeps almost all of the round-trip amortisation.
 */
const ACK_CHUNK = 50;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Retryable = a per-entry retry hits the same wall, so the caller must NOT fall back. */
class RetryableAckFailure extends Error {
  readonly retryable = true;
  constructor(cause: unknown) {
    super(`mailbox ack batch could not be attempted: ${String(cause)}`);
    this.name = 'RetryableAckFailure';
    this.cause = cause;
  }
}

function asRetryable(err: unknown): unknown {
  return isRetryableStatus(err) ? new RetryableAckFailure(err) : err;
}

export class WalletApiDeliveryPort implements DeliveryPort {
  readonly custody: DeliveryCustody;

  private readonly client: DeliveryPortClient;
  private readonly kv: ScopedKV;
  private readonly identity: DeliveryIdentity;
  private readonly wake: WakeSource | null;
  private deriveFn: ((blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>) | null;
  private readonly seenChain = new SerialChain();
  private lastIncomingEpoch: string | null = null;

  constructor(config: WalletApiDeliveryPortConfig) {
    this.client = config.client;
    this.kv = config.kv;
    this.identity = config.identity;
    this.custody = config.custody;
    this.wake = config.wake ?? null;
    this.deriveFn = config.deliveryKeys ?? null;
  }

  bindDeliveryKeys(derive: (blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>): void {
    this.deriveFn = derive;
  }

  private deriveKeys(blob: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
    if (this.deriveFn === null) throw new DeliveryKeysUnboundError();
    return this.deriveFn(blob);
  }

  // ── deliver ────────────────────────────────────────────────────────────────

  async deliver(recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt> {
    const receipts = await this.deliverBatch(recipientPubkey, [blob], options);
    const first = receipts[0];
    if (first === undefined) throw new DeliveryProtocolError('deliver produced no receipt');
    return first;
  }

  async deliverBatch(
    recipientPubkey: string,
    blobs: Uint8Array[],
    options: DeliverOptions
  ): Promise<DeliveryReceipt[]> {
    if (blobs.length === 0) return [];
    const prepared = await Promise.all(blobs.map(async (bytes) => this.prepare(bytes)));
    const envelope = this.buildEnvelope(recipientPubkey, options);
    const keyBySha = await uploadViaPresigned(
      this.client,
      prepared.map((p) => ({ sha256: p.sha, bytes: p.bytes }))
    );
    const entries = prepared.map((p): MailboxDepositEntry => {
      const key = keyBySha.get(p.sha);
      if (key === undefined) throw new DeliveryProtocolError(`upload returned no key for sha256 ${p.sha}`);
      return {
        recipientPubkey,
        key,
        transferId: options.transferId,
        tokenId: p.tokenId,
        stateHash: p.stateHash,
        ...(envelope !== undefined ? { memo: envelope } : {}),
      };
    });
    return this.depositAll(entries, prepared.map((p) => p.deliveryId));
  }

  private async prepare(bytes: Uint8Array): Promise<PreparedDelivery> {
    const keys = await this.deriveKeys(bytes);
    return {
      bytes,
      tokenId: keys.tokenId,
      stateHash: keys.stateHash,
      deliveryId: computeDeliveryId(keys.tokenId, keys.stateHash),
      sha: bytesToHex(sha256(bytes)),
    };
  }

  // sphere#487: the nametag is a per-call option and NOT port config — a
  // construction-time copy would silently go stale on registration, and only a
  // caller-supplied value is enforceable by the port contract suite (which any
  // swapped DeliveryPort must pass).
  private buildEnvelope(recipientPubkey: string, options: DeliverOptions): string | undefined {
    const key = deriveDeliveryEncryptionKey(this.identity.privateKey, recipientPubkey);
    return encryptDeliveryBundle(key, {
      senderNametag: options.senderNametag,
      memo: options.memo,
    });
  }

  private async depositAll(entries: MailboxDepositEntry[], deliveryIds: string[]): Promise<DeliveryReceipt[]> {
    if (entries.length > 1) {
      try {
        const results = await this.client.depositBatch(entries);
        if (results.length !== entries.length) {
          throw new DeliveryProtocolError(
            `mailbox batch deposit returned ${String(results.length)} entries for ${String(entries.length)}`
          );
        }
        return deliveryIds.map((deliveryId) => ({ deliveryId }));
      } catch (err) {
        if (!isWalletApiHttpError(err, 409)) throw err;
      }
    }
    const receipts: DeliveryReceipt[] = [];
    for (const [i, entry] of entries.entries()) {
      receipts.push(await this.depositOne(entry, deliveryIds[i] as string));
    }
    return receipts;
  }

  private async depositOne(entry: MailboxDepositEntry, deliveryId: string): Promise<DeliveryReceipt> {
    try {
      await this.client.deposit(entry);
    } catch (err) {
      if (!isWalletApiHttpError(err, 409)) throw err;
    }
    return { deliveryId };
  }

  // ── incoming ───────────────────────────────────────────────────────────────

  async *incoming(sinceCursor?: string): AsyncIterable<IncomingDelivery> {
    const seen = await this.readSeen();
    let page = await this.client.listMailbox(sinceCursor === undefined ? 0 : Number(sinceCursor));
    for (;;) {
      this.lastIncomingEpoch = String(page.syncEpoch);
      for (const entry of page.entries) {
        if (entry.status !== 'unclaimed') continue;
        if (seen.has(entry.entryId)) continue;
        yield this.toIncoming(entry);
      }
      if (!page.more) return;
      page = await this.client.listMailbox(page.cursor);
    }
  }

  /** §5.7: the page-honest epoch — the restore-detection source Receive keys on. */
  incomingEpoch(): string | null {
    return this.lastIncomingEpoch;
  }

  private toIncoming(entry: MailboxEntryWire): IncomingDelivery {
    const bundle = this.openEnvelope(entry);
    return {
      deliveryId: entry.entryId,
      ...(entry.transferId !== '' ? { transferId: entry.transferId } : {}),
      ...(entry.senderPubkey !== '' ? { senderPubkey: entry.senderPubkey } : {}),
      ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      ...(bundle.memo !== undefined ? { memo: bundle.memo } : {}),
      cursor: String(entry.seq),
      fetchBlob: () => this.fetchVerified(entry),
    };
  }

  private openEnvelope(entry: MailboxEntryWire): DeliveryBundle {
    if (entry.memo === undefined || entry.senderPubkey === '') return {};
    try {
      const key = deriveDeliveryEncryptionKey(this.identity.privateKey, entry.senderPubkey);
      return decryptDeliveryBundle(key, entry.memo);
    } catch {
      return {};
    }
  }

  private async fetchVerified(entry: MailboxEntryWire): Promise<Uint8Array> {
    if (entry.blobCollected === true || entry.getUrl === undefined) {
      throw new DeliveryProtocolError(`mailbox entry ${entry.entryId} has no fetchable blob (blobCollected)`);
    }
    const bytes = await this.client.fetchBlob(entry.getUrl);
    const keys = await this.deriveKeys(bytes);
    const derived = computeDeliveryId(keys.tokenId, keys.stateHash);
    if (derived !== entry.entryId) {
      throw new DeliveryProtocolError(
        `mailbox blob does not match its entry id (expected ${entry.entryId}, bytes derive ${derived})`
      );
    }
    return bytes;
  }

  // ── ack ────────────────────────────────────────────────────────────────────

  async ack(
    deliveryId: string,
    disposition: 'claimed' | 'rejected',
    reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other'
  ): Promise<void> {
    if (disposition === 'claimed') {
      const result = await this.client.claim([deliveryId], this.custody === 'inventory');
      const failed = result.failed.find((f) => f.entryId === deliveryId);
      if (failed !== undefined) throw new MailboxClaimFailedError(deliveryId, failed.code);
    } else {
      await this.client.reject([deliveryId], reason);
    }
    await this.addSeenAll([deliveryId]);
  }

  /**
   * §5.7/#757 batched settle. Claims go out grouped, rejects grouped by reason
   * (the endpoint takes one reason per call), and the seen-set is written ONCE
   * after every HTTP call has succeeded — never on a throw, so an aborted batch
   * re-lists rather than being silently forgotten.
   */
  async ackBatch(acks: readonly AckRequest[]): Promise<readonly AckOutcome[]> {
    const settled: string[] = [];
    const outcomes: AckOutcome[] = [];
    try {
      await this.settleClaims(acks, settled, outcomes);
      await this.settleRejects(acks, settled);
    } catch (err) {
      // Chunks that DID commit are acked server-side; the seen-set must record
      // them even though the batch as a whole failed, or a §5.4 restore that
      // rebuilds the rows re-yields deliveries this wallet already claimed.
      // The caller is still told nothing settled, which is what makes it safe.
      await this.addSeenAll(settled).catch(() => undefined);
      throw asRetryable(err);
    }
    await this.addSeenAll(settled);
    return [...outcomes, ...settled.map((deliveryId): AckOutcome => ({ deliveryId, status: 'settled' }))];
  }

  private async settleClaims(
    acks: readonly AckRequest[],
    settled: string[],
    outcomes: AckOutcome[]
  ): Promise<void> {
    const ids = acks.filter((a) => a.disposition === 'claimed').map((a) => a.deliveryId);
    for (const chunk of chunked(ids, ACK_CHUNK)) {
      const result = await this.client.claim(chunk, this.custody === 'inventory');
      settled.push(...result.claimed);
      // Idempotent re-delivery is SETTLED; treating it as unsettled stalls the
      // caller's cursor behind an entry that can never change (§6).
      settled.push(...result.alreadyClaimed.map((e) => e.entryId));
      for (const f of result.failed) {
        if (f.code === 'CONFLICT') outcomes.push({ deliveryId: f.entryId, status: 'conflict' });
        else throw new MailboxClaimFailedError(f.entryId, f.code);
      }
    }
  }

  private async settleRejects(acks: readonly AckRequest[], settled: string[]): Promise<void> {
    const byReason = new Map<string, string[]>();
    for (const a of acks) {
      if (a.disposition !== 'rejected') continue;
      const key = a.reason ?? '';
      const group = byReason.get(key) ?? [];
      group.push(a.deliveryId);
      byReason.set(key, group);
    }
    for (const [reason, group] of byReason) {
      for (const chunk of chunked(group, ACK_CHUNK)) {
        await this.client.reject(chunk, reason === '' ? undefined : (reason as MailboxRejectReason));
        // A 200 settles the whole requested group: reject runs in ONE server
        // transaction, and an id it skips was already claimed — terminal too.
        settled.push(...chunk);
      }
    }
  }

  onWake(cb: () => void): () => void {
    if (this.wake === null) return () => undefined;
    return this.wake.subscribeStream('mailbox', cb);
  }

  // ── seen-set (S7) ──────────────────────────────────────────────────────────

  private async readSeen(): Promise<Set<string>> {
    const raw = await this.kv.get<string[]>(DELIVERY_SEEN_KEY);
    return new Set(raw ?? []);
  }

  /** SerialChain settles-not-fulfills: a rejected write never bricks later acks. */
  private addSeenAll(deliveryIds: readonly string[]): Promise<void> {
    if (deliveryIds.length === 0) return Promise.resolve();
    return this.seenChain.enqueue(async () => {
      const seen = await this.readSeen();
      for (const id of deliveryIds) seen.add(id);
      await this.kv.set(DELIVERY_SEEN_KEY, [...seen]);
    });
  }
}
