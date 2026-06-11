/**
 * WalletApiMailboxProvider — the reference `DeliveryProvider` implementation
 * over the wallet-api mailbox (sdk-changes S3/S7; ARCHITECTURE §6/§16).
 *
 * Platform-neutral over the injected {@link WalletApiClient}. Key behaviors:
 *
 * - **deliver** = sha256 + upload via upload-urls (a `412` from the
 *   content-addressed store means the blob is already present = success,
 *   §5.2) → `POST /v1/mailbox` (idempotent by content-derived `entry_id`,
 *   §6). The memo is encrypted client-side with the S6 field key before it
 *   leaves the device; the deposit's `entryId` is verified to equal the
 *   locally computed content-derived id — a backend substituting row ids is a
 *   protocol violation (covenant §3.1-4).
 * - **incoming** = `GET /v1/mailbox?since=` paging (`more` loops), yielding
 *   claimable entries (pending; claimed/rejected entries are recorded as seen
 *   and skipped — they were resolved here or on another of the owner's
 *   devices). `fetchBlob` uses the entry's `getUrl` and re-derives
 *   (tokenId, stateHash, deliveryId) from the actual bytes — the recipient
 *   never trusts the backend (§8.2). `blobCollected` entries throw a typed
 *   error.
 * - **ack** → claim with the provider's **composition-time custody**
 *   (`'inventory'` → `intoInventory: true` handoff; `'external'` →
 *   `intoInventory: false`, ZERO inventory writes — §6 delivery-only claim),
 *   or reject (terminal for discovery only — §6).
 * - **Persistent seen-set**: every acked delivery's content-derived id — the
 *   canonical hash of its `(tokenId, stateHash)` pair — is persisted via the
 *   injected {@link KeyValueStore}; a replayed delivery (server replay, cursor
 *   reset, restore) is never yielded again (S7 port contract).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import type {
  DeliverOptions,
  DeliveryCustody,
  DeliveryDisposition,
  DeliveryProvider,
  DeliveryReceipt,
  IncomingDelivery,
} from '../../../transport/delivery-provider';
import { computeDeliveryId, deliveryKeysFromBlob } from '../../../transport/delivery-provider';
import { deriveFieldEncryptionKey, decryptField, encryptField } from '../../../core/field-encryption';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import type { KeyValueStore, MailboxEntry } from '../../../wallet-api';
import { logger } from '../../../core/logger';

export interface WalletApiMailboxProviderConfig {
  /** The authenticated wallet-api client (S1). DI — never a singleton. */
  client: WalletApiClient;
  /**
   * Composition-time custody (S7 — NEVER a per-call flag): `'inventory'` for
   * the full wallet-api preset (acks hand tokens into the server inventory),
   * `'external'` for the own-storage preset (acks perform zero inventory
   * writes; the app's storage keeps custody).
   */
  custody: DeliveryCustody;
  /** Persists the per-identity seen-set + mailbox cursor. */
  stateStore: KeyValueStore;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const TAG = 'WalletApiMailbox';

export class WalletApiMailboxProvider implements DeliveryProvider {
  readonly custody: DeliveryCustody;

  private readonly client: WalletApiClient;
  private readonly stateStore: KeyValueStore;

  private identity: { privateKey: string; chainPubkey: string } | null = null;
  private fieldKey: Uint8Array | null = null;

  constructor(config: WalletApiMailboxProviderConfig) {
    this.client = config.client;
    this.custody = config.custody;
    this.stateStore = config.stateStore;
  }

  /** Bind the wallet identity (derives the S6 field key; binds the client). */
  setIdentity(identity: { privateKey: string; chainPubkey: string }): void {
    this.identity = identity;
    this.fieldKey = deriveFieldEncryptionKey(identity.privateKey);
    this.client.setIdentity(identity);
  }

  // ── persisted state (per network + identity) ────────────────────────────────

  private stateKey(kind: string): string {
    if (!this.identity) {
      throw new WalletApiError('No identity set — call setIdentity() first', 'CONFIG');
    }
    return `wallet-api-mailbox:${kind}:${this.client.network}:${this.identity.chainPubkey}`;
  }

  /**
   * The persistent seen-set (S7): content-derived delivery ids — i.e. the
   * canonical `SHA-256(tokenId ‖ stateHash)` encoding of the (tokenId,
   * stateHash) pairs this wallet has already resolved.
   */
  private async readSeen(): Promise<Set<string>> {
    const raw = await this.stateStore.get(this.stateKey('seen'));
    if (!raw) return new Set();
    try {
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private async addSeen(deliveryIds: string[]): Promise<void> {
    if (deliveryIds.length === 0) return;
    const seen = await this.readSeen();
    for (const id of deliveryIds) seen.add(id);
    await this.stateStore.set(this.stateKey('seen'), JSON.stringify([...seen]));
  }

  private async readCursorState(): Promise<{ cursor: bigint; syncEpoch: bigint } | null> {
    const raw = await this.stateStore.get(this.stateKey('cursor'));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { cursor?: string; syncEpoch?: string };
      if (typeof parsed.cursor !== 'string' || typeof parsed.syncEpoch !== 'string') return null;
      return { cursor: BigInt(parsed.cursor), syncEpoch: BigInt(parsed.syncEpoch) };
    } catch {
      return null;
    }
  }

  private async persistCursorState(cursor: bigint, syncEpoch: bigint): Promise<void> {
    await this.stateStore.set(
      this.stateKey('cursor'),
      JSON.stringify({ cursor: cursor.toString(), syncEpoch: syncEpoch.toString() })
    );
  }

  // ── deliver (S3: upload → deposit) ──────────────────────────────────────────

  /**
   * Idempotent per (token, state): the upload is content-addressed (412 =
   * already present = success — §5.2) and the deposit is idempotent by the
   * content-derived entry_id — it succeeds even after the recipient claimed
   * (§6), which is what makes the sender's journal replay safe.
   */
  async deliver(recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt> {
    if (!this.fieldKey) {
      throw new WalletApiError('No identity set — call setIdentity() first', 'CONFIG');
    }
    const keys = deliveryKeysFromBlob(blob);

    // Upload the finished blob (checksum-bound presigned PUT — §5.2).
    const sha = bytesToHex(sha256(blob));
    const urls = await this.client.getUploadUrls([{ sha256: sha, size: blob.length }]);
    const upload = urls.find((u) => u.sha256 === sha);
    if (!upload) {
      throw new WalletApiError(`upload-urls response missing sha256 ${sha}`, 'PROTOCOL');
    }
    await this.client.uploadBlob(upload.putUrl, blob); // 412 = already present = success (§5.2)

    // Deposit (idempotent by entry_id — §6). The memo is S6-encrypted BEFORE
    // it leaves the device (§8.3): the operator never sees plaintext.
    const entryId = await this.client.depositMailbox({
      recipientPubkey,
      key: upload.key,
      transferId: options.transferId,
      stateHash: keys.stateHash,
      tokenId: keys.tokenId,
      ...(options.memo !== undefined ? { memo: encryptField(this.fieldKey, options.memo) } : {}),
    });

    // covenant §3.1-4: the id is CONTENT-DERIVED — computed client-side; a
    // backend returning anything else (e.g. a row id) is a protocol violation.
    if (entryId !== keys.deliveryId) {
      throw new WalletApiError(
        `mailbox deposit returned a non-content-derived entryId (got ${entryId}, expected ${keys.deliveryId})`,
        'PROTOCOL'
      );
    }
    return { deliveryId: keys.deliveryId };
  }

  // ── incoming (S3: mailbox pull) ─────────────────────────────────────────────

  /**
   * Pull entries since the given cursor (or the persisted one), loop while
   * `more`, and yield claimable deliveries not yet in the seen-set. The
   * persisted cursor advances to the server's read pointer (§6) — entries at
   * or below it are all resolved; the seen-set (not the cursor) is the replay
   * guard, so a cursor reset is safe.
   */
  async *incoming(sinceCursor?: string): AsyncIterable<IncomingDelivery> {
    const persisted = await this.readCursorState();
    let since: bigint;
    if (sinceCursor !== undefined) {
      since = BigInt(sinceCursor);
    } else {
      since = persisted?.cursor ?? 0n;
    }

    const seen = await this.readSeen();
    let page = await this.client.listMailbox(since);
    // §5.4: a syncEpoch change (server restore) invalidates cursor continuity —
    // discard the persisted cursor and re-pull from the start; the seen-set
    // absorbs the replays.
    if (persisted !== null && page.syncEpoch !== persisted.syncEpoch && sinceCursor === undefined) {
      page = await this.client.listMailbox(0n);
    }

    for (;;) {
      for (const entry of page.entries) {
        if (seen.has(entry.entryId)) continue; // persistent replay guard (S7)
        if (entry.status !== 'pending') {
          // Resolved here earlier or on another of the owner's devices —
          // record and skip (claimed/rejected filtering for the consumer).
          seen.add(entry.entryId);
          await this.addSeen([entry.entryId]);
          continue;
        }
        yield this.toIncomingDelivery(entry);
      }
      await this.persistCursorState(page.readPointer, page.syncEpoch);
      if (!page.more) break;
      const lastSeq = page.entries.length > 0 ? page.entries[page.entries.length - 1].seq : since;
      page = await this.client.listMailbox(lastSeq);
    }
  }

  private toIncomingDelivery(entry: MailboxEntry): IncomingDelivery {
    const client = this.client;
    const fieldKey = this.fieldKey;

    // S6: decrypt the memo envelope. NOTE: the S6 key is wallet-scoped (HKDF
    // from the wallet key), so only memos written by THIS wallet's key
    // decrypt (self-sends / multi-device). A counterparty's memo fails
    // authentication and is surfaced as absent rather than as ciphertext.
    let memo: string | undefined;
    if (entry.memo !== undefined && fieldKey) {
      try {
        memo = decryptField(fieldKey, entry.memo);
      } catch {
        logger.debug(TAG, `memo for entry ${entry.entryId.slice(0, 12)}… not decryptable with this wallet's key`);
      }
    }

    return {
      deliveryId: entry.entryId,
      transferId: entry.transferId,
      senderPubkey: entry.senderPubkey,
      ...(memo !== undefined ? { memo } : {}),
      cursor: entry.seq.toString(),
      async fetchBlob(): Promise<Uint8Array> {
        if (entry.blobCollected || !entry.getUrl) {
          // §6: only RESOLVED entries lose their blob after retention; a
          // pending entry's blob is always retained — treat this as a server
          // contract violation rather than silently skipping value.
          throw new WalletApiError(
            `mailbox entry ${entry.entryId} has no fetchable blob (blobCollected)`,
            'PROTOCOL'
          );
        }
        const bytes = await client.fetchBlob(entry.getUrl);
        // §8.2: the recipient never trusts the backend — re-derive the
        // content-derived id from the ACTUAL bytes and match it.
        const keys = deliveryKeysFromBlob(bytes);
        if (keys.deliveryId !== entry.entryId) {
          throw new WalletApiError(
            `mailbox blob does not match its entry id (expected ${entry.entryId}, bytes derive ${keys.deliveryId})`,
            'PROTOCOL'
          );
        }
        return bytes;
      },
    };
  }

  // ── ack (claim / reject) ────────────────────────────────────────────────────

  async ack(deliveryId: string, disposition: DeliveryDisposition): Promise<void> {
    if (disposition === 'claimed') {
      // Custody is the provider's COMPOSITION-TIME property (S7): the
      // own-storage preset bakes 'external' in, so every claim here sends
      // intoInventory:false — zero inventory writes (§6 delivery-only claim) —
      // even when ack is called with no thought given to options.
      const intoInventory = this.custody === 'inventory';
      const result = await this.client.claimMailbox([deliveryId], intoInventory);
      const failed = result.failed.find((f) => f.entryId === deliveryId);
      if (failed) {
        // §16: the defensive lineage bucket — unreachable in normal flows.
        throw new WalletApiError(
          `mailbox claim failed for ${deliveryId}: ${failed.code}`,
          'CONFLICT'
        );
      }
      // claimed / alreadyClaimed (idempotent — possibly via another device).
    } else {
      // §6: terminal for discovery only — the entry stays claimable and its
      // blob retained (retryable after e.g. a trustbase fix).
      await this.client.rejectMailbox([deliveryId]);
    }
    await this.addSeen([deliveryId]); // the persistent (tokenId, stateHash) seen-set (S7)
  }

  // ── wake (optional hook — §9: a nudge, never a correctness dependency) ──────

  onWake(callback: () => void): () => void {
    let closed = false;
    let close: (() => void) | null = null;
    void this.client
      .connectWakeSocket((wake) => {
        if (wake.stream === 'mailbox') callback();
      })
      .then((handle) => {
        if (closed) handle.close();
        else close = () => handle.close();
      })
      .catch((err) => {
        // Wakes are best-effort; polling remains the correctness path (§9).
        logger.debug(TAG, 'wake socket unavailable (polling continues):', err);
      });
    return () => {
      closed = true;
      close?.();
    };
  }
}

export function createWalletApiMailboxProvider(
  config: WalletApiMailboxProviderConfig
): WalletApiMailboxProvider {
  return new WalletApiMailboxProvider(config);
}
