// P3b: WalletApiDeliveryPort — DeliveryPort over the §16 mailbox (§5.6/§5.7).
// deliveryId is ALWAYS content-derived hex(SHA-256(tokenId ‖ stateHash)) — never
// a server row id or seq. The seen-set is S7 port-owned; an entry enters it
// ONLY after its ack succeeded.

import { sha256 } from '@noble/hashes/sha2.js';

import type {
  DeliverOptions,
  DeliveryPort,
  DeliveryReceipt,
  IncomingDelivery,
} from '../../modules/payments-v2/ports';
import type { ScopedKV } from '../../modules/payments-v2/stores';
import {
  decryptDeliveryBundle,
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  type DeliveryBundle,
} from '../../core/delivery-envelope';
import { isWalletApiHttpError } from './http';
import type { MailboxDepositEntry, MailboxEntryWire, WalletApiV2Client } from './client';
import { mapBounded, WALLET_API_V2_FANOUT_WIDTH } from './storage';

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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
  nametag?: string;
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

export class WalletApiDeliveryPort implements DeliveryPort {
  readonly custody: DeliveryCustody;

  private readonly client: DeliveryPortClient;
  private readonly kv: ScopedKV;
  private readonly identity: DeliveryIdentity;
  private readonly wake: WakeSource | null;
  private deriveFn: ((blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>) | null;
  private seenChain: Promise<void> = Promise.resolve();

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
    const keyBySha = await this.upload(prepared);
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

  private buildEnvelope(recipientPubkey: string, options: DeliverOptions): string | undefined {
    const key = deriveDeliveryEncryptionKey(this.identity.privateKey, recipientPubkey);
    return encryptDeliveryBundle(key, {
      senderNametag: options.senderNametag ?? this.identity.nametag,
      memo: options.memo,
    });
  }

  private async upload(prepared: readonly PreparedDelivery[]): Promise<Map<string, string>> {
    const urls = await this.client.uploadUrls(prepared.map((p) => ({ sha256: p.sha, size: p.bytes.length })));
    const urlBySha = new Map(urls.map((u) => [u.sha256, u]));
    const uploads = prepared.map((p) => {
      const url = urlBySha.get(p.sha);
      if (url === undefined) throw new DeliveryProtocolError(`upload-urls response missing sha256 ${p.sha}`);
      return { p, url };
    });
    await mapBounded(uploads, WALLET_API_V2_FANOUT_WIDTH, ({ p, url }) => this.client.uploadBlob(url.putUrl, p.bytes));
    return new Map(uploads.map(({ url }) => [url.sha256, url.key]));
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
      for (const entry of page.entries) {
        if (entry.status !== 'unclaimed') continue;
        if (seen.has(entry.entryId)) continue;
        yield this.toIncoming(entry);
      }
      if (!page.more) return;
      page = await this.client.listMailbox(page.cursor);
    }
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
    await this.addSeen(deliveryId);
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

  private addSeen(deliveryId: string): Promise<void> {
    this.seenChain = this.seenChain.then(async () => {
      const seen = await this.readSeen();
      seen.add(deliveryId);
      await this.kv.set(DELIVERY_SEEN_KEY, [...seen]);
    });
    return this.seenChain;
  }
}
