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
  WakeStream,
  WakeChannelStatus,
} from '../../../transport/delivery-provider';
import { composeDeliveryKeys, computeDeliveryId } from '../../../transport/delivery-provider';
import { unwrapTokenBlobBytes } from '../../../token-engine/token-blob';
import {
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  decryptDeliveryBundle,
} from '../../../core/delivery-envelope';
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
  /**
   * The backend-true (tokenId, stateHash) derivation (`ITokenEngine.deliveryKeys`).
   * Optional at construction — compositions are engine-less; `PaymentsModule`
   * late-binds it via `bindDeliveryKeys` at init. The provider never derives
   * these locally (§8.2 / sdk-changes S7) and fails loudly if unbound.
   */
  deliveryKeys?: (blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const TAG = 'WalletApiMailbox';

export class WalletApiMailboxProvider implements DeliveryProvider {
  readonly custody: DeliveryCustody;

  private readonly client: WalletApiClient;
  private readonly stateStore: KeyValueStore;
  private deriveKeysFn: ((blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>) | null = null;

  private identity: { privateKey: string; chainPubkey: string; nametag?: string } | null = null;

  constructor(config: WalletApiMailboxProviderConfig) {
    this.client = config.client;
    this.custody = config.custody;
    this.stateStore = config.stateStore;
    this.deriveKeysFn = config.deliveryKeys ?? null;
  }

  /**
   * #583: the underlying authenticated client. Sphere's per-address wiring uses
   * the SAME client for an address's delivery provider AND its `walletApi`
   * session (intents/history/payment-requests), so one address holds ONE
   * identity-bound client across its whole module set — not three siblings that
   * would each sign in separately.
   */
  get walletApiClient(): WalletApiClient {
    return this.client;
  }

  /** @inheritDoc — wired by PaymentsModule at init (engine-owning seam). */
  bindDeliveryKeys(derive: (blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>): void {
    this.deriveKeysFn = derive;
  }

  private deriveKeys(blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> {
    if (this.deriveKeysFn === null) {
      throw new WalletApiError(
        'deliveryKeys derivation not bound — PaymentsModule binds ITokenEngine.deliveryKeys at init (S7)',
        'PROTOCOL'
      );
    }
    return this.deriveKeysFn(blobBytes);
  }

  /**
   * Bind the wallet identity (binds the client). The optional `nametag` is the
   * sender's own nametag — bundled into outgoing delivery envelopes so the
   * recipient can render the human identity (it is the wallet's own public
   * name, not a secret). Delivery memos are encrypted per-recipient (ECDH —
   * see {@link deriveDeliveryEncryptionKey}), so no self-scoped key is held.
   */
  setIdentity(identity: { privateKey: string; chainPubkey: string; nametag?: string }): void {
    this.identity = identity;
    this.client.setIdentity({ privateKey: identity.privateKey, chainPubkey: identity.chainPubkey });
  }

  /**
   * #583 per-address client isolation: mint an INDEPENDENT delivery provider
   * for a different HD address, backed by a FRESH {@link WalletApiClient} cloned
   * from the same composition config (same composition-time `custody`). Each
   * address's delivery provider then drives its OWN identity-bound client + wake
   * socket — an orphaned previous-address delivery pump re-auths as ITS OWN
   * owner (correct, harmless) instead of rejecting + marking-seen the NEW
   * owner's mailbox entries through a re-bound shared client (the silent
   * incoming-token loss / wrong-owner wake-routing class collapses). The cloned
   * client starts identity-less; `Sphere.switchToAddress` / `PaymentsModule.
   * initialize` bind identity + the engine's deliveryKeys before it pumps. The
   * shared `stateStore` is fine — the seen-set / cursor keys are namespaced per
   * (network, chainPubkey), so per-owner state stays separate.
   */
  createForAddress(): WalletApiMailboxProvider {
    return new WalletApiMailboxProvider({
      client: this.client.clone(),
      custody: this.custody,
      stateStore: this.stateStore,
      ...(this.deriveKeysFn !== null ? { deliveryKeys: this.deriveKeysFn } : {}),
    });
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
    if (!this.identity) {
      throw new WalletApiError('No identity set — call setIdentity() first', 'CONFIG');
    }
    const keys = composeDeliveryKeys(await this.deriveKeys(blob));

    // S6: bundle the sender's nametag + memo into ONE recipient-addressed
    // envelope. The key is the ECDH shared secret between the sender's private
    // key and the RECIPIENT's chain pubkey (symmetric — the recipient
    // re-derives it from its own key + this entry's senderPubkey), HKDF'd into
    // the SAME `enc1.` XChaCha20-Poly1305 envelope the self-scoped field
    // encryption uses (operator-blind, backend-valid — §8.3; no wire change).
    // Attached whenever there is a nametag OR a memo (so the nametag travels
    // even on a memo-less transfer); `undefined` ⇒ no `memo` field is sent.
    const deliveryKey = deriveDeliveryEncryptionKey(this.identity.privateKey, recipientPubkey);
    const envelope = encryptDeliveryBundle(deliveryKey, {
      // The per-call nametag (threaded by PaymentsModule) wins; setIdentity's
      // nametag is the standalone fallback.
      senderNametag: options.senderNametag ?? this.identity.nametag,
      memo: options.memo,
    });

    // §5.2/§8.2: the wallet-api wire carries the RAW token bytes — the
    // cross-port blob argument is the sphere envelope; unwrap at the boundary
    // (the real backend content-addresses and Token.fromCBOR's exactly these
    // bytes; the 39051 envelope never crosses the §16 API).
    const wire = unwrapTokenBlobBytes(blob);

    // Upload the finished blob (checksum-bound presigned PUT — §5.2).
    const sha = bytesToHex(sha256(wire));
    const urls = await this.client.getUploadUrls([{ sha256: sha, size: wire.length }]);
    const upload = urls.find((u) => u.sha256 === sha);
    if (!upload) {
      throw new WalletApiError(`upload-urls response missing sha256 ${sha}`, 'PROTOCOL');
    }
    await this.client.uploadBlob(upload.putUrl, wire); // 412 = already present = success (§5.2)

    // Deposit (idempotent by entry_id — §6). The nametag+memo envelope is
    // ECDH-encrypted to the recipient BEFORE it leaves the device (§8.3): the
    // operator never sees plaintext.
    let entryId: string;
    try {
      entryId = await this.client.depositMailbox({
        recipientPubkey,
        key: upload.key,
        transferId: options.transferId,
        stateHash: keys.stateHash,
        tokenId: keys.tokenId,
        ...(envelope !== undefined ? { memo: envelope } : {}),
      });
    } catch (err) {
      // §6 CONFLICT = the backend already holds a record of EXACTLY this
      // (tokenId, stateHash) with different bytes. Reachable honestly in one
      // way: a resume re-derives the byte-identical TRANSACTION (E.1), but
      // the aggregator RECOMPUTES inclusion proofs per request (st-sdk#126),
      // so once the tree has advanced the rebuilt token blob's proof bytes —
      // and its content-addressed key — differ from the originally-deposited
      // blob's. The state itself is identical and bound to this recipient by
      // its own predicate (§8.2), so the existing entry IS this delivery:
      // succeed idempotently with the content-derived id (the port contract —
      // deliver is idempotent per (token, state), S7). A foreign-spend
      // conflict can never reach here: the engine's E.2 match-verify raises
      // TransferConflictError before anything is delivered.
      if (err instanceof WalletApiError && err.status === 409) {
        return { deliveryId: keys.deliveryId };
      }
      throw err;
    }

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
        if (entry.status !== 'unclaimed') {
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

  /**
   * Decrypt an entry's recipient-addressed envelope into `{ memo, senderNametag }`.
   * Needs both the entry's `senderPubkey` (the ECDH peer) and an identity;
   * returns an empty bundle (and logs at debug) on any absence/failure so the
   * receive loop never wedges on an unreadable counterparty memo.
   */
  private decryptDeliveryEnvelope(entry: MailboxEntry): { memo?: string; senderNametag?: string } {
    if (entry.memo === undefined || !this.identity || entry.senderPubkey === undefined) {
      return {};
    }
    try {
      const key = deriveDeliveryEncryptionKey(this.identity.privateKey, entry.senderPubkey);
      return decryptDeliveryBundle(key, entry.memo);
    } catch {
      logger.debug(TAG, `delivery envelope for entry ${entry.entryId.slice(0, 12)}… not decryptable (not addressed here / tampered)`);
      return {};
    }
  }

  private toIncomingDelivery(entry: MailboxEntry): IncomingDelivery {
    const client = this.client;
    const deriveKeys = (bytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> => this.deriveKeys(bytes);

    // S6: decrypt the recipient-addressed envelope (nametag + memo). The key is
    // the ECDH shared secret between THIS wallet's private key and the entry's
    // senderPubkey (symmetric with the sender's derivation; self-sends use the
    // own pubkey). An envelope addressed to a DIFFERENT recipient, or any
    // tamper, fails authentication and is surfaced as absent — never as
    // ciphertext, and never thrown into the receive loop.
    const { memo, senderNametag } = this.decryptDeliveryEnvelope(entry);

    return {
      deliveryId: entry.entryId,
      transferId: entry.transferId,
      senderPubkey: entry.senderPubkey,
      ...(memo !== undefined ? { memo } : {}),
      ...(senderNametag !== undefined ? { senderNametag } : {}),
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
        const keys = composeDeliveryKeys(await deriveKeys(bytes));
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

  // The wallet-api wake socket multiplexes all three owner streams; forward
  // each so the consumer (PaymentsModule) can route mailbox/inventory/
  // payment_requests to their respective pulls. (Previously only `mailbox`
  // was surfaced — inventory and payment-request nudges were dropped, leaving
  // a second session with no realtime path for those streams.)
  //
  // The socket SELF-HEALS via the client's supervisor (§9): it reconnects with
  // backoff on any drop and a liveness watchdog catches a half-open socket.
  // Because wakes missed while the socket was dead are NOT replayed, every
  // (re)connect runs a full catch-up pull of ALL THREE streams — done by firing
  // `callback` once per stream, which the consumer already routes to each
  // stream's pull. This is what converges a window whose socket went dark.
  onWake(
    callback: (stream: WakeStream) => void,
    onStatus?: (status: WakeChannelStatus) => void
  ): () => void {
    const handle = this.client.superviseWakeSocket({
      onWake: (wake) => callback(wake.stream),
      onReconnect: () => this.catchUpAllStreams(callback),
      onStatus,
    });
    return () => handle.close();
  }

  /** §9: replay one synthetic nudge per stream so the consumer full-resyncs after a (re)connect. */
  private catchUpAllStreams(callback: (stream: WakeStream) => void): void {
    const streams: WakeStream[] = ['inventory', 'mailbox', 'payment_requests'];
    for (const stream of streams) callback(stream);
  }
}

export function createWalletApiMailboxProvider(
  config: WalletApiMailboxProviderConfig
): WalletApiMailboxProvider {
  return new WalletApiMailboxProvider(config);
}
