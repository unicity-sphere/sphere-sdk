/**
 * Receive + delivery: `receive()`, the `handleV2Transfer` receiver, the
 * PENDING_V2_DELIVERIES journal, the hoisted send delivery pass and the bounded
 * replay + poison budget. The token map and `save()` stay in PaymentsModule.
 */

import type { IncomingTransfer, Token } from '../../../types';
import type { ITokenEngine, SphereToken, TokenBlob } from '../../../token-engine';
import { decodeTokenBlob, encodeTokenBlob, TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import type { DeliverOptions, DeliveryProvider } from '../../../transport/delivery-provider';
import { WalletApiError } from '../../../wallet-api';
import { MAX_SEND_OPERATION_CONCURRENCY } from '../SendOperations';
import type { PaymentsModuleDependencies, TransactionHistoryEntry } from '../PaymentsModule';
import { extractStateHashFromSdkData } from '../PaymentsModule';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { logger } from '../../../core/logger';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { sleep } from '../../../core/utils';

/**
 * Bounded replay budget for journaled finished-but-undelivered v2 blobs (#517
 * item 1). Each load()'s replay pass makes at most {@link DELIVERY_REPLAY_RETRIES}
 * + 1 attempts per entry with exponential backoff; the cumulative failed-attempt
 * count is journaled across loads. Once it reaches
 * {@link MAX_DELIVERY_REPLAY_ATTEMPTS} (inclusive) the entry is surfaced as poison
 * (`delivery:undeliverable`) and left journaled but no longer auto-retried —
 * the deposit is idempotent, so a later app version may still land it.
 */
const DELIVERY_REPLAY_RETRIES = 2;
const MAX_DELIVERY_REPLAY_ATTEMPTS = 6;
/** §3.1 (#621): how long a recipient-quota (429) delivery is deferred before the next replay attempt. */
const DELIVERY_DEFERRAL_MS = 60 * 60 * 1000; // 1h
const DELIVERY_REPLAY_BASE_DELAY_MS = 1_000;
const DELIVERY_REPLAY_MAX_DELAY_MS = 8_000;

/**
 * A FINISHED v2 token blob awaiting transport delivery. Journaled the moment
 * the transfer/split output is certified on-chain (the source is already
 * spent) and removed after successful delivery, so a transport failure or a
 * crash never loses the recipient's token. Replayed by load().
 */
export interface PendingV2Delivery {
  transferId: string;
  recipientPubkey: string;
  /** Hex of the finished token blob (the V2_TRANSFER payload). */
  tokenBlob: string;
  memo?: string;
  createdAt: number;
  /**
   * Cumulative failed replay attempts across load()s. Surfaced as poison and
   * marked `undeliverable` once it reaches {@link MAX_DELIVERY_REPLAY_ATTEMPTS}
   * so journaled blobs never sit undelivered invisibly (#517).
   */
  attempts?: number;
  /** Set once the entry is surfaced as poison; it stays journaled but is no longer auto-retried. */
  undeliverable?: boolean;
  /**
   * (transferId, opIndex) pairing (§8.1) — the op's position in the intent's persisted order.
   * Lets resume RE-DELIVER this already-certified blob instead of re-running the engine op
   * (which would raise TransferConflictError on the spent source). Absent on legacy entries.
   */
  opIndex?: number;
  /**
   * §3.1 (#621): a recipient-side 429 (full mailbox / never-claimer) is NOT poison — it self-heals
   * when the recipient drains. Such entries are deferred (kept journaled, never auto-poisoned) and
   * retried no sooner than this epoch-ms; the count does not consume the case-A poison budget.
   */
  deferredUntil?: number;
  /** Why the entry is deferred (observability) — e.g. 'recipient-quota'. */
  deferredReason?: string;
}

// =============================================================================
// Receive Options & Result
// =============================================================================

/**
 * @deprecated v2 transfers arrive as finished tokens — there is no finalization
 * phase. The options are accepted for backwards compatibility and ignored.
 */
export interface ReceiveOptions {
  /** @deprecated Ignored — v2 tokens are stored confirmed on receipt. */
  finalize?: boolean;
  /** @deprecated Ignored. */
  timeout?: number;
  /** @deprecated Ignored. */
  pollInterval?: number;
}

export interface ReceiveResult {
  /** Newly received incoming transfers. */
  transfers: IncomingTransfer[];
}

/**
 * The exact PaymentsModule members this feature reaches back for. Deliberately
 * narrow: the token map is exposed as a READ-ONLY view and every write to it
 * goes through the module's own `storeEngineToken`, so the delivery path never
 * becomes a second writer of the module's core state.
 */
export interface DeliveryHost {
  /** Live dependency handle (identity / storage / emitEvent / tokenEngine); null before initialize(). */
  readonly deps: PaymentsModuleDependencies | null;
  /** The composed delivery port — the single seam assets ride in and out on. */
  readonly delivery: DeliveryProvider | null;
  /** load() gate — an incoming transfer must observe the loaded token map before deduping. */
  readonly loaded: boolean;
  readonly loadedPromise: Promise<void> | null;
  /** Throws unless the module has dependencies. */
  ensureInitialized(): void;
  /** Throws unless a delivery provider is composed. */
  ensureDelivery(): void;
  /** The sender's own canonical nametag, carried on the delivery envelope (S6). */
  currentNametagName(): string | undefined;
  /** READ-ONLY view of the module's token map (dedup + the receive() diff). */
  getHeldTokens(): ReadonlyMap<string, Token>;
  /** Uncoalesced pull of the delivery port's incoming feed (receive() must observe NOW). */
  pumpIncomingDeliveriesFresh(): Promise<number>;
  /** Persist a verified engine token into the module's token map. */
  storeEngineToken(
    engine: ITokenEngine,
    token: SphereToken,
    opts?: { criticalSave?: boolean },
  ): Promise<{ uiToken: Token; added: boolean }>;
  /** Append a history record (the RECEIVED receipt). */
  addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void>;
}

export class Delivery {
  /**
   * Base delay (ms) for the journaled-delivery replay backoff (#517 item 1).
   * A field, not a const, so tests can drive the bounded retry loop without
   * waiting real time — never mutated in production.
   */
  private replayBackoffBaseMs = DELIVERY_REPLAY_BASE_DELAY_MS;
  /** Deferral window for recipient-quota (429) deliveries (#621). Overridable in tests. */
  private deliveryDeferralMs = DELIVERY_DEFERRAL_MS;
  /**
   * #517: serializes {@link replayPendingV2Deliveries}. `load()` kicks replay
   * off fire-and-forget and `receive()` calls `load()`, so two passes can
   * overlap — duplicating delivery attempts and clobbering each other's
   * `attempts` increments (both read the same stale value, both write N+1,
   * delaying poison surfacing). Only one pass runs per module instance at a time.
   */
  private replayInFlight = false;
  /**
   * #517: serializes every read-modify-write of the PENDING_V2_DELIVERIES journal.
   * save/remove/update each load → mutate → store the WHOLE blob, so a replay
   * (fire-and-forget from load()) overlapping a send()'s journal write could
   * clobber a newly-saved undelivered entry and lose it — defeating the crash-
   * safety guarantee. A promise-chain mutex makes each whole RMW atomic.
   */
  private journalMutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: DeliveryHost) {}

  // ===========================================================================
  // Public API - Receive
  // ===========================================================================

  /**
   * Fetch and process pending incoming transfers from the transport layer.
   *
   * Performs a one-shot query to fetch all pending events, processes them
   * through the existing pipeline, and resolves after all stored events
   * are handled. Useful for batch/CLI apps that need explicit receive.
   *
   * v2 transfers arrive as FINISHED tokens, so there is no finalization phase —
   * a received token is stored confirmed immediately.
   *
   * @param _options - Deprecated; the v1 finalization options are ignored.
   * @param callback - Optional callback invoked for each newly received transfer
   * @returns ReceiveResult with the newly received transfers
   */
  async receive(
    _options?: ReceiveOptions,
    callback?: (transfer: IncomingTransfer) => void,
  ): Promise<ReceiveResult> {
    this.host.ensureInitialized();

    this.host.ensureDelivery();

    // S3: the one-shot fetch IS a pump of the delivery port's incoming feed.
    const tokensBefore = new Set(this.host.getHeldTokens().keys());
    await this.host.pumpIncomingDeliveriesFresh();
    const received: IncomingTransfer[] = [];
    for (const [tokenId, token] of this.host.getHeldTokens()) {
      if (tokensBefore.has(tokenId)) continue;
      const transfer: IncomingTransfer = {
        id: tokenId,
        senderPubkey: '',
        tokens: [token],
        receivedAt: Date.now(),
      };
      received.push(transfer);
      if (callback) callback(transfer);
    }
    return { transfers: received };
  }

  /**
   * v2 engine transfer (sender-driven): the sender handed us a FINISHED token.
   * Decode the blob, dedup by the genesis-stable token id, store it as a
   * confirmed token, and emit/record the receipt. No commitment / inclusion-proof
   * / finalization round-trip (contrast the v1 sourceToken+transferTx path).
   *
   * Transport-agnostic (sdk-changes S3): fed by the relay push subscription
   * AND by the delivery port's incoming pump — the returned verdict lets the
   * pump map outcomes onto `ack('claimed' | 'rejected')`.
   */
  async handleV2Transfer(
    payload: V2TransferPayload,
    senderPubkey: string
  ): Promise<'stored' | 'duplicate' | 'storage-rejected' | 'invalid' | 'not-owned' | 'no-engine'> {
    this.host.ensureInitialized();
    if (!this.host.loaded && this.host.loadedPromise) {
      await this.host.loadedPromise;
    }

    const engine = this.host.deps!.tokenEngine;
    if (!engine) {
      logger.error('Payments', 'V2 transfer received but no token engine is configured — payload dropped. Supply the v2 oracle config (trust base + gateway URL).');
      return 'no-engine';
    }

    let token: SphereToken;
    try {
      // Tolerant read: peers/journals carry the sphere envelope, while the
      // wallet-api mailbox serves RAW wire bytes (§5.2/§8.2). Either way the
      // engine's decode re-derives the authoritative blob from the token
      // itself, so the placeholder fields of a raw wrap are never trusted.
      const bytes = hexToBytes(payload.tokenBlob);
      let blob: TokenBlob;
      try {
        blob = decodeTokenBlob(bytes);
      } catch {
        blob = { v: TOKEN_BLOB_VERSION, network: 0, tokenId: '', token: bytes };
      }
      token = await engine.decodeToken(blob);
    } catch (err) {
      logger.error('Payments', 'V2 transfer: failed to decode token blob:', err);
      return 'invalid';
    }

    // Security: the sender hands us a FINISHED token — verify it cryptographically
    // and confirm its final state is actually locked to this wallet before it
    // enters the balance. Both checks are local (trust base + predicate bytes).
    const verdict = await engine.verify(token);
    if (!verdict.ok) {
      logger.warn('Payments', `V2 transfer rejected: verification failed (${verdict.reason ?? 'unknown'})`);
      return 'invalid';
    }
    if (!engine.isOwnedBy(token, engine.getIdentity().chainPubkey)) {
      logger.warn('Payments', 'V2 transfer rejected: token not addressed to this wallet');
      return 'not-owned';
    }

    // Dedup by (tokenId, stateHash) — NOT genesis-id alone. A re-delivered IDENTICAL state
    // is ignored, but a NEW state of a token we already hold (a self-send or A→B→A round-trip
    // direct leg returning at a new state) MUST still be received and recorded, or the wallet
    // keeps the funds but drops the RECEIVED history. v2 tokens are keyed by `v2_<genesisId>`,
    // so the currently-held state (if any) is an O(1) lookup.
    const genesisId = engine.tokenId(token);
    const id = `v2_${genesisId}`;
    const incomingStateHash = extractStateHashFromSdkData(bytesToHex(encodeTokenBlob(engine.encodeToken(token))));
    const held = this.host.getHeldTokens().get(id);
    if (held) {
      const heldStateHash = extractStateHashFromSdkData(held.sdkData);
      if (incomingStateHash !== '' && incomingStateHash === heldStateHash) {
        logger.debug('Payments', `V2 transfer ${id.slice(0, 16)}... (same state) already present, skipping`);
        return 'duplicate';
      }
      // A DIFFERENT state of a token we ALREADY hold. Accepting it means addToken will
      // REPLACE the held state (CASE 2). That is correct for a legitimate re-acquire (the
      // incoming state is the live unspent tip), but a delayed/replayed OLDER, already-spent
      // state would otherwise swap the spendable state for a phantom spent one — and
      // mergeLazyInventory won't repair it (it skips genesis ids already in memory). verify()
      // is cryptographic only; isSpent() is the on-chain unspent check. So gate the replacement:
      // reject the incoming state if it is already consumed on-chain (Codex P1 on #687).
      if (await engine.isSpent(token)) {
        logger.warn(
          'Payments',
          `V2 transfer ${id.slice(0, 16)}... is an already-spent state of a held token — rejecting stale/replayed delivery`
        );
        return 'duplicate';
      }
    }

    const { uiToken, added } = await this.host.storeEngineToken(engine, token);
    if (!added) {
      // Storage rejected it: a tombstoned re-delivery of a since-spent state, or
      // a duplicate race. Emitting transfer:incoming / writing RECEIVED history
      // here would announce a phantom payment for value the wallet does not hold.
      logger.warn('Payments', `V2 transfer ${id.slice(0, 16)}... rejected by storage (tombstoned/duplicate) — no event emitted`);
      return 'storage-rejected';
    }
    // The sender's nametag rides the recipient-addressed delivery envelope (S6).
    const senderNametag = payload.senderNametag;

    this.host.deps!.emitEvent('transfer:incoming', {
      id,
      senderPubkey,
      senderNametag,
      tokens: [uiToken],
      memo: payload.memo,
      receivedAt: Date.now(),
    });

    await this.host.addToHistory({
      type: 'RECEIVED',
      amount: uiToken.amount,
      coinId: uiToken.coinId,
      symbol: uiToken.symbol,
      timestamp: Date.now(),
      senderPubkey,
      ...(senderNametag !== undefined ? { senderNametag } : {}),
      memo: payload.memo,
      tokenId: id,
      // Per-state receipt key (Codex #687 P2): a genesis token re-acquired at multiple
      // states (self-send / round-trip) records each leg instead of upserting one key.
      ...(incomingStateHash !== '' ? { stateHash: incomingStateHash } : {}),
    });
    return 'stored';
  }

  // ===========================================================================
  // Pending v2 deliveries (finished-but-undelivered token blobs)
  // ===========================================================================

  async loadPendingV2Deliveries(): Promise<PendingV2Delivery[]> {
    const data = await this.host.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
    return data ? (JSON.parse(data) as PendingV2Delivery[]) : [];
  }

  /** #517: run a journal read-modify-write atomically against all other journal mutations. */
  private withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.journalMutation.then(fn, fn);
    this.journalMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async savePendingV2Delivery(entry: PendingV2Delivery): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      if (!all.some((e) => e.tokenBlob === entry.tokenBlob)) {
        all.push(entry);
        await this.host.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
      }
    });
  }

  private async removePendingV2Delivery(tokenBlob: string): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      const filtered = all.filter((e) => e.tokenBlob !== tokenBlob);
      if (filtered.length !== all.length) {
        await this.host.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(filtered));
      }
    });
  }

  /**
   * The hoisted send delivery pass (#699): hand a send's journaled committed
   * blobs to ONE recipient — a single deliverBatch call when the port offers
   * it and there is more than one blob, else per-blob deliver at the
   * certification fan-out width. Returns true iff every blob was delivered
   * (deferred blobs stay journaled). Never throws (§3.1).
   */
  async deliverCommittedBlobs(
    blobs: readonly string[],
    recipientPubkey: string,
    transferId: string,
    memo?: string,
  ): Promise<boolean> {
    if (blobs.length === 0) return true;
    // Carry the sender's own CANONICAL nametag so the recipient renders
    // "@name" instead of "Someone" — bundled with the memo in ONE
    // recipient-addressed envelope (S6). One send = one options set.
    const nm = this.host.currentNametagName();
    const options: DeliverOptions = {
      transferId,
      memo,
      ...(nm !== undefined ? { senderNametag: nm } : {}),
    };
    // A single blob stays on the plain deliver path — byte-identical wire to
    // the pre-batch era, and no batch probe for the dominant case.
    if (this.host.delivery?.deliverBatch && blobs.length > 1) {
      return this.tryDeliverBatch(blobs, recipientPubkey, options);
    }
    return this.deliverPerBlob(blobs, recipientPubkey, options);
  }

  /**
   * Batch sibling of {@link tryDeliver}: success clears every journal entry;
   * ANY failure keeps them ALL journaled (the deposit is idempotent by
   * content-derived entry_id, so a replay absorbs entries that already
   * landed). Never throws.
   */
  private async tryDeliverBatch(
    blobs: readonly string[],
    recipientPubkey: string,
    options: DeliverOptions,
  ): Promise<boolean> {
    try {
      await this.host.delivery!.deliverBatch!(recipientPubkey, blobs.map(hexToBytes), options);
    } catch (err) {
      logger.warn('Payments', 'Batch delivery deferred (all blobs kept journaled); sender not failed (§3.1):', err);
      return false;
    }
    for (const tokenBlob of blobs) {
      try {
        await this.removePendingV2Delivery(tokenBlob);
      } catch (err) {
        logger.warn('Payments', 'Delivered, but journal cleanup failed (replay will re-remove):', err);
      }
    }
    return true;
  }

  /**
   * Per-blob fallback (a batch-less port, or a single blob), chunked at
   * MAX_SEND_OPERATION_CONCURRENCY so the pass keeps the certification
   * fan-out era's delivery width. Never throws.
   */
  private async deliverPerBlob(
    blobs: readonly string[],
    recipientPubkey: string,
    options: DeliverOptions,
  ): Promise<boolean> {
    const results: boolean[] = [];
    for (let start = 0; start < blobs.length; start += MAX_SEND_OPERATION_CONCURRENCY) {
      const chunk = blobs.slice(start, start + MAX_SEND_OPERATION_CONCURRENCY);
      results.push(
        ...(await Promise.all(
          chunk.map((tokenBlob) =>
            this.tryDeliver(() => this.host.delivery!.deliver(recipientPubkey, hexToBytes(tokenBlob), options), tokenBlob),
          ),
        )),
      );
    }
    return results.every(Boolean);
  }

  /**
   * Covenant §3.1 (#621): once the source is certified on-chain, a delivery failure must NEVER
   * fail the sender. Recipient-side conditions (a full mailbox / 429 from a never-claiming recipient)
   * and transient delivery-infra failures (5xx/network) both leave the finished blob JOURNALED for
   * (re-)delivery — the send resolves as delivery-pending and the sender moves on. The blob is already
   * journaled (savePendingV2Delivery ran before this); on success we clear the journal, on any failure
   * we keep it. Returns true if delivered, false if deferred. Never throws.
   */
  private async tryDeliver(deliver: () => Promise<unknown>, tokenBlob: string): Promise<boolean> {
    try {
      await deliver();
    } catch (err) {
      logger.warn('Payments', 'Delivery deferred (kept journaled); sender not failed (§3.1):', err);
      return false;
    }
    // Delivered. Clearing the journal is best-effort — a failure here is harmless (the idempotent
    // replay re-removes it) and must NOT flip the result to delivery-pending (#622 review).
    try {
      await this.removePendingV2Delivery(tokenBlob);
    } catch (err) {
      logger.warn('Payments', 'Delivered, but journal cleanup failed (replay will re-remove):', err);
    }
    return true;
  }

  /**
   * Replay journaled finished-but-undelivered v2 blobs (kicked from load())
   * through the delivery port (sdk-changes S3). Idempotent end to end: the
   * mailbox deposit is idempotent by the content-derived entry_id — it succeeds
   * even after the recipient claimed (§6) — and the relay path's recipient
   * dedups by the genesis-stable token id.
   *
   * #517 item 1: instead of a silent unbounded fire-and-forget, each entry is
   * retried with bounded exponential backoff, its cumulative failed-attempt
   * count is journaled across loads, and an entry that exhausts
   * {@link MAX_DELIVERY_REPLAY_ATTEMPTS} is SURFACED as poison
   * (`delivery:undeliverable`) and left journaled but no longer auto-retried —
   * so a journaled blob never sits undelivered invisibly.
   */
  async replayPendingV2Deliveries(): Promise<void> {
    // #517: drop an overlapping pass — a replay started while one is in flight
    // would read the same journal snapshot, re-deliver the same entries, and
    // race the per-entry `attempts` read/modify/write. Dropped entries stay
    // journaled and replay on the next load(), so nothing is lost.
    // No rail composed: return WITHOUT touching the journal. Counting this as a
    // delivery attempt would burn the poison budget on a configuration state and
    // strand already-certified funds — the entries stay put until a provider exists.
    if (!this.host.delivery) return;
    if (this.replayInFlight) return;
    this.replayInFlight = true;
    try {
      // #621: skip poison and recipient-quota entries still inside their deferral window.
      const now = Date.now();
      const entries = (await this.loadPendingV2Deliveries()).filter(
        (e) => !e.undeliverable && (e.deferredUntil === undefined || e.deferredUntil <= now),
      );
      if (entries.length === 0) return;
      logger.warn('Payments', `${entries.length} undelivered v2 transfer(s) journaled from a previous session — replaying`);
      for (const e of entries) {
        await this.replayOneDelivery(e);
      }
    } finally {
      this.replayInFlight = false;
    }
  }

  /** Replay a single journaled entry: backoff retries → success/removal, or → bounded poison. */
  private async replayOneDelivery(entry: PendingV2Delivery): Promise<void> {
    const tag = entry.transferId.slice(0, 8);
    try {
      await this.attemptDeliveryWithBackoff(entry);
      await this.removePendingV2Delivery(entry.tokenBlob);
      logger.debug('Payments', `Replayed undelivered v2 transfer ${tag}...`);
    } catch (err) {
      // §3.1 (#621): a recipient-side 429 (full mailbox / never-claimer) is NOT poison — it
      // self-heals when the recipient drains. Defer it (kept journaled, never consumes the case-A
      // poison budget, retried after the deferral window), distinct from a genuine delivery failure.
      if (err instanceof WalletApiError && err.status === 429) {
        await this.deferDelivery(entry, err.message);
        return;
      }
      const attempts = (entry.attempts ?? 0) + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_DELIVERY_REPLAY_ATTEMPTS) {
        await this.markDeliveryPoison(entry, attempts, message);
        return;
      }
      await this.bumpDeliveryAttempts(entry.tokenBlob, attempts);
      logger.warn('Payments', `Replay of undelivered v2 transfer ${tag}... failed (attempt ${attempts}/${MAX_DELIVERY_REPLAY_ATTEMPTS}, kept for next load):`, err);
    }
  }

  /**
   * §3.1 (#621): defer a recipient-quota (429) delivery — keep it journaled, never poison it (it
   * self-heals when the recipient claims), and retry no sooner than the deferral window. Surfaced
   * distinctly (delivery:deferred) so a UI can show "recipient's mailbox is full — will retry".
   */
  private async deferDelivery(entry: PendingV2Delivery, error: string): Promise<void> {
    const deferredUntil = Date.now() + this.deliveryDeferralMs;
    await this.updatePendingV2Delivery(entry.tokenBlob, (e) => {
      e.deferredUntil = deferredUntil;
      e.deferredReason = 'recipient-quota';
    });
    logger.warn('Payments', `Undelivered v2 transfer ${entry.transferId.slice(0, 8)}... deferred — recipient mailbox full (429); kept journaled, retried after the deferral window (§3.1):`, error);
    this.host.deps!.emitEvent('delivery:deferred', {
      transferId: entry.transferId,
      recipientPubkey: entry.recipientPubkey,
      reason: 'recipient-quota',
      deferredUntil,
    });
  }

  /** One delivery with in-pass exponential backoff; throws the last error if all attempts fail. */
  private async attemptDeliveryWithBackoff(entry: PendingV2Delivery): Promise<void> {
    const nm = this.host.currentNametagName();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= DELIVERY_REPLAY_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(this.replayBackoffBaseMs * 2 ** (attempt - 1), DELIVERY_REPLAY_MAX_DELAY_MS);
        if (delay > 0) await sleep(delay);
      }
      try {
        await this.host.delivery!.deliver(entry.recipientPubkey, hexToBytes(entry.tokenBlob), {
          transferId: entry.transferId,
          memo: entry.memo,
          ...(nm !== undefined ? { senderNametag: nm } : {}),
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Mark a journal entry poison (keep it, stop retrying) and surface it (#517 item 1). */
  private async markDeliveryPoison(entry: PendingV2Delivery, attempts: number, error: string): Promise<void> {
    await this.updatePendingV2Delivery(entry.tokenBlob, (e) => { e.attempts = attempts; e.undeliverable = true; });
    logger.error('Payments', `Undelivered v2 transfer ${entry.transferId.slice(0, 8)}... is POISON after ${attempts} attempts — surfaced, kept journaled, no longer auto-retried:`, error);
    this.host.deps!.emitEvent('delivery:undeliverable', {
      transferId: entry.transferId,
      recipientPubkey: entry.recipientPubkey,
      attempts,
      error,
    });
  }

  private async bumpDeliveryAttempts(tokenBlob: string, attempts: number): Promise<void> {
    await this.updatePendingV2Delivery(tokenBlob, (e) => { e.attempts = attempts; });
  }

  /** Mutate one journaled entry in place (keyed by tokenBlob) and persist. No-op if gone. */
  private async updatePendingV2Delivery(tokenBlob: string, mutate: (e: PendingV2Delivery) => void): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      const target = all.find((e) => e.tokenBlob === tokenBlob);
      if (!target) return;
      mutate(target);
      await this.host.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
    });
  }
}
