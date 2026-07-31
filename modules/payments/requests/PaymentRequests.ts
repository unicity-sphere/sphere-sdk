/**
 * Payment Requests (sdk-changes S4 — §10/§16): the incoming/outgoing surfaces,
 * the wallet-api pump + refresh, and the #441 settling journal. The token map,
 * `save()` and send stay in PaymentsModule, reached via {@link PaymentRequestsHost}.
 */

import type {
  PaymentRequest,
  IncomingPaymentRequest,
  OutgoingPaymentRequest,
  PaymentRequestResult,
  PaymentRequestStatus,
  PaymentRequestHandler,
  PaymentRequestResponse,
  PaymentRequestResponseHandler,
  TransferRequest,
  TransferResult,
} from '../../../types';
import type {
  PaymentsModuleDependencies,
  PaymentsWalletApiPort,
  WalletApiPaymentRequest,
} from '../PaymentsModule';
import type { PumpHealth } from '../pump-health';
import { logger } from '../../../core/logger';
import { SphereError, PartialSendConflictError, isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { WalletApiError } from '../../../wallet-api';
import { TokenRegistry } from '../../../registry';
import {
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  decryptDeliveryBundle,
} from '../../../core/delivery-envelope';

/**
 * #441: a wallet-api `respondPaymentRequest` rejection meaning the request is
 * NOT open (already resolved / expired) — a 409 CONFLICT. Safe to swallow when
 * replaying a deferred 'paid' (idempotent); any OTHER error must be retried.
 */
function isNonOpenConflict(err: unknown): boolean {
  return err instanceof WalletApiError && (err.code === 'CONFLICT' || err.status === 409);
}

/**
 * Cap on the number of gap-free `?since=` pages pulled when rebuilding the
 * incoming payment-request view from the server on reload (the wallet-api
 * composition — the #556 reload fix). At the §16 page limit this bounds a
 * single hydration past any realistic payer's request history while staying
 * finite if the server ever mis-reports `more`. Mirrors
 * `MAX_HISTORY_HYDRATION_PAGES`.
 */
const MAX_PR_HYDRATION_PAGES = 100;

/**
 * The S4 capability slice once detected (see
 * {@link PaymentRequests.paymentRequestsApi}) — the optional members above,
 * required.
 */
type PaymentRequestsApi = Pick<PaymentsWalletApiPort, 'network'> &
  Required<
    Pick<PaymentsWalletApiPort, 'createPaymentRequest' | 'listPaymentRequests' | 'respondPaymentRequest'>
  >;

/**
 * The exact PaymentsModule members this feature reaches back for. Deliberately
 * narrow: no token map, no `save()`, no storage-data shaping — the feature
 * never becomes a second writer of the module's core state.
 */
export interface PaymentRequestsHost {
  /** Live dependency handle (identity / storage / transport / emitEvent / walletApi); null before initialize(). */
  readonly deps: PaymentsModuleDependencies | null;
  /** Quiet-then-escalate logging for the background wallet-api pumps (#630). */
  readonly pumpHealth: PumpHealth;
  /** Poll interval for the payment-request stream (shared with the delivery/inventory pumps, §9). */
  readonly pollIntervalMs: number;
  readonly loadedPromise: Promise<void> | null;
  /** Throws unless the module has dependencies. */
  ensureInitialized(): void;
  /** Current address's canonical display nametag (bare, no '@') for outgoing memos. */
  currentNametagName(): string | undefined;
  /** The money path — `payPaymentRequest` funds a request through it. */
  send(request: TransferRequest): Promise<TransferResult>;
}

export class PaymentRequests {
  // Payment Requests State (Incoming)
  private paymentRequests: IncomingPaymentRequest[] = [];
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();

  // Payment Requests State (Outgoing)
  private outgoingPaymentRequests: Map<string, OutgoingPaymentRequest> = new Map();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private pendingResponseResolvers: Map<string, {
    resolve: (response: PaymentRequestResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  // wallet-api payment requests (sdk-changes S4 — §10/§16)
  private prPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesces concurrent payment-request pump runs. */
  private prPumpInFlight: Promise<void> | null = null;
  /**
   * Set after the once-per-session full incoming hydration (#556): the surfaced
   * incoming list is in-memory only, so on a fresh engine the CURRENT state of
   * ALL incoming requests — open AND resolved (paid/declined/expired) — must be
   * rebuilt from a `role=incoming&since=0` pull, not just the still-open ones.
   * A status-filtered bootstrap (the pre-#556 `status=open` scan) dropped
   * requests resolved in a PRIOR session, so the payer reopened and the
   * 'Paid Successfully' request was gone (twin of #521/#549).
   */
  private prBootstrapped = false;

  /**
   * #441 deferred-paid journal (durable, per network+identity): links a payment
   * request to the in-flight transfer of a possibly-committed pay so the request
   * is held NON-payable ('settling') until that transfer completes (→ 'paid',
   * server told) or aborts (→ payable, journal cleared). Keyed by request wire id
   * (== requestId for wallet-api-surfaced requests). The in-memory Map is the
   * synchronous source of truth used by the reload re-apply seam; it is
   * single-flight loaded and every read-modify-write is serialized through a tail
   * promise (the #679/#680 lesson: an unserialized RMW drops entries under
   * concurrency = a re-payable request = the double-pay this fix prevents).
   */
  private settlingJournal: Map<string, { transferId: string; createdAt: number; committed?: boolean }> | null = null;
  private settlingJournalLoad: Promise<void> | null = null;
  private settlingJournalWrite: Promise<void> = Promise.resolve();
  /** #441: guard overlapping resume reconciles (resumeOpenIntents has 2 fire-and-forget call sites). */
  private reconcileInFlight = false;

  /**
   * Per-request single-flight for {@link payPaymentRequest}. The request stays 'pending' across
   * the await on send(), so a concurrent double-tap / second session would otherwise enter send()
   * a second time and DOUBLE-PAY (each send picks a different token; the reservation ledger is
   * coin-scoped, not request-scoped). Concurrent calls for the same requestId coalesce onto the
   * first in-flight pay; the entry is cleared when it settles, so a later retry is unaffected.
   */
  private readonly payInFlight = new Map<string, Promise<TransferResult>>();

  constructor(private readonly host: PaymentRequestsHost) {}

  // ===========================================================================
  // Lifecycle (driven by PaymentsModule.initialize / destroy)
  // ===========================================================================

  /**
   * Re-arm for a (possibly new) identity. Called from PaymentsModule.initialize
   * AFTER `deps` is swapped in, so {@link paymentRequestsApi} sees the new port.
   */
  initialize(): void {
    // Payment requests ride wallet-api (sdk-changes S4). The incoming
    // `?since=<seq>` stream is polled — gap-free per §9, and the poll is the
    // correctness path.
    this.prBootstrapped = false;
    // #441: reset the deferred-paid journal so it reloads under the new identity's
    // storage key (the key bakes in chainPubkey). New mutations start a fresh
    // write chain; any still-queued old-identity mutation is dropped by the
    // per-mutation key guard in mutateSettlingJournal (it can't pollute the new
    // identity's journal).
    this.settlingJournal = null;
    this.settlingJournalLoad = null;
    this.settlingJournalWrite = Promise.resolve();
    if (this.paymentRequestsApi()) {
      this.prPollTimer = setInterval(() => {
        this.host.pumpHealth.run('payment-requests', () => this.pumpPaymentRequests());
      }, this.host.pollIntervalMs);
    }
  }

  /** Reject every {@link waitForPaymentResponse} waiter (address switch / destroy). */
  cancelPendingResponseResolvers(reason: string): void {
    for (const [, resolver] of this.pendingResponseResolvers) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error(reason));
    }
    this.pendingResponseResolvers.clear();
  }

  /** Cleanup: stop the poll, drop the handler sets, reject pending waiters. */
  destroy(): void {
    this.teardownPaymentRequestPump();
    this.paymentRequestHandlers.clear();
    this.paymentRequestResponseHandlers.clear();

    // Clear pending response resolvers
    this.cancelPendingResponseResolvers('Module destroyed');
  }

  // ===========================================================================
  // Public API - Payment Requests
  // ===========================================================================

  /**
   * Send a payment request to someone
   * @param recipientPubkeyOrNametag - Recipient's pubkey or @nametag
   * @param request - Payment request details
   * @returns Result with event ID
   */
  async sendPaymentRequest(
    recipientPubkeyOrNametag: string,
    request: Omit<PaymentRequest, 'id' | 'createdAt'>
  ): Promise<PaymentRequestResult> {
    this.host.ensureInitialized();

    const prApi = this.paymentRequestsApi();
    if (!prApi) {
      return { success: false, error: 'Payment requests require the wallet-api payment-request capability' };
    }
    return this.sendWalletApiPaymentRequest(prApi, recipientPubkeyOrNametag, request);
  }

  /**
   * S4: create the request via wallet-api (§16). The payer is addressed by
   * CHAIN pubkey (the canonical identity); the memo is S6-encrypted client-
   * side BEFORE it leaves the device (§8.3) — the operator stores ciphertext.
   * Mirrors the transport path's no-throw contract: failures (including the
   * §5.5 per-payer cap → 429) come back as `{ success: false, error }`.
   */
  private async sendWalletApiPaymentRequest(
    api: PaymentRequestsApi,
    recipientPubkeyOrNametag: string,
    request: Omit<PaymentRequest, 'id' | 'createdAt'>
  ): Promise<PaymentRequestResult> {
    try {
      const peerInfo = await this.host.deps!.transport.resolve?.(recipientPubkeyOrNametag) ?? null;
      const toPubkey =
        peerInfo?.chainPubkey ??
        (/^0[23][0-9a-f]{64}$/i.test(recipientPubkeyOrNametag)
          ? recipientPubkeyOrNametag.toLowerCase()
          : null);
      if (!toPubkey) {
        return {
          success: false,
          error: `Recipient ${recipientPubkeyOrNametag} has no published identity (chain pubkey) — cannot receive payment requests.`,
        };
      }

      // S6: the requester's nametag + message ride ONE recipient-addressed
      // envelope keyed off ECDH(requesterPriv, PAYER chain pubkey) — symmetric,
      // so the payer re-derives it from its own key + this request's fromPubkey
      // (the PR twin of #546/#547). The self-scoped field key was wrong here:
      // a memo encrypted with the requester's key could never be opened by the
      // payer. Same `enc1.` XChaCha20-Poly1305 wire (operator-blind, backend-
      // valid — no wire/backend change); attached whenever there is a nametag
      // OR a message, so the payer renders "@requester" even with no message.
      const memoEnvelope = encryptDeliveryBundle(
        deriveDeliveryEncryptionKey(this.host.deps!.identity.privateKey, toPubkey),
        { senderNametag: this.host.currentNametagName(), memo: request.message }
      );

      const wire = await api.createPaymentRequest({
        toPubkey,
        // Amounts are decimal strings end-to-end (§11) — BigInt round-trips them exactly.
        assets: [{ coinId: request.coinId, amount: BigInt(request.amount) }],
        ...(memoEnvelope !== undefined ? { memo: memoEnvelope } : {}),
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      });

      // Track the outgoing request under the SERVER id — the `?before=`
      // backfill refresh (refreshOutgoingPaymentRequests) matches on it.
      const outgoingRequest: OutgoingPaymentRequest = {
        id: wire.id,
        eventId: wire.id, // no relay event on this path — the server id stands in
        recipientPubkey: toPubkey,
        recipientNametag: recipientPubkeyOrNametag.startsWith('@')
          ? recipientPubkeyOrNametag.slice(1)
          : undefined,
        amount: request.amount,
        coinId: request.coinId,
        message: request.message,
        createdAt: wire.createdAt,
        status: 'pending',
      };
      this.outgoingPaymentRequests.set(wire.id, outgoingRequest);

      logger.debug('Payments', `Payment request created via wallet-api: ${wire.id}`);

      return {
        success: true,
        requestId: wire.id,
        eventId: wire.id,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Payments', `Failed to create wallet-api payment request: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Subscribe to incoming payment requests
   * @param handler - Handler function for incoming requests
   * @returns Unsubscribe function
   */
  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    return () => this.paymentRequestHandlers.delete(handler);
  }

  /**
   * Get all payment requests
   * @param filter - Optional status filter
   */
  getPaymentRequests(filter?: { status?: PaymentRequestStatus }): IncomingPaymentRequest[] {
    if (filter?.status) {
      return this.paymentRequests.filter((r) => r.status === filter.status);
    }
    return [...this.paymentRequests];
  }

  /**
   * Get the count of payment requests with status `'pending'`.
   *
   * @returns Number of pending incoming payment requests.
   */
  getPendingPaymentRequestsCount(): number {
    return this.paymentRequests.filter((r) => r.status === 'pending').length;
  }

  /**
   * Reject a payment request and notify the requester.
   *
   * On the wallet-api path (S4) the respond IS the state change — it is
   * confirmed server-side (`action: 'declined'`, §16) before the local status
   * flips, and a server rejection (403/409) propagates to the caller. The
   * transport path is best-effort and never throws.
   *
   * @param requestId - ID of the incoming payment request to reject.
   */
  async rejectPaymentRequest(requestId: string): Promise<void> {
    await this.sendPaymentRequestResponse(requestId, 'rejected');
    this.updatePaymentRequestStatus(requestId, 'rejected');
  }

  /**
   * Remove resolved incoming payment requests from memory.
   *
   * Keeps requests with status `'pending'` OR `'settling'` (#441). A `'settling'`
   * request is UNRESOLVED — its linked transfer is still in-flight — so evicting
   * it would drop the in-memory hold that keeps it non-payable until the journal
   * re-surfaces it. Only terminal statuses (`'paid'`/`'rejected'`/`'expired'`)
   * are removed.
   */
  clearProcessedPaymentRequests(): void {
    // #441: a 'settling' request is UNRESOLVED (its linked transfer is still
    // in-flight) — it must NOT be evicted, or the reload re-apply loses its
    // in-memory hold before the journal re-surfaces it.
    this.paymentRequests = this.paymentRequests.filter(
      (r) => r.status === 'pending' || r.status === 'settling'
    );
  }

  /**
   * Remove a specific incoming payment request by ID.
   *
   * @param requestId - ID of the payment request to remove.
   */
  removePaymentRequest(requestId: string): void {
    this.paymentRequests = this.paymentRequests.filter((r) => r.id !== requestId);
  }

  /**
   * Pay a payment request: send the amount, then report 'paid' to the requester.
   */
  async payPaymentRequest(requestId: string, memo?: string): Promise<TransferResult> {
    // Single-flight: a concurrent second call for the same request coalesces onto the first pay
    // instead of issuing a second send (double-pay). Cleared in the inner's finally so a later
    // sequential retry still proceeds.
    // NOTE: a coalesced caller receives the FIRST caller's result, so if concurrent callers pass
    // different `memo` values only the first is used — memo is per-request, not per-call, under
    // concurrency (a distinct memo needs a distinct request, or a sequential call).
    const inFlight = this.payInFlight.get(requestId);
    if (inFlight) return inFlight;
    const pay = this.payPaymentRequestInner(requestId, memo);
    this.payInFlight.set(requestId, pay);
    try {
      return await pay;
    } finally {
      this.payInFlight.delete(requestId);
    }
  }

  private async payPaymentRequestInner(requestId: string, memo?: string): Promise<TransferResult> {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (!request) {
      throw new SphereError(`Payment request not found: ${requestId}`, 'VALIDATION_ERROR');
    }

    if (request.status !== 'pending') {
      throw new SphereError(`Payment request is not pending: ${request.status}`, 'VALIDATION_ERROR');
    }

    try {
      // Send the payment
      const result = await this.host.send({
        coinId: request.coinId,
        amount: request.amount,
        recipient: request.senderPubkey,
        memo: memo || request.message,
      });

      // Mark as paid and send response with transfer ID. The transfer already
      // succeeded — a failed status link (e.g. an expiry race on the
      // wallet-api respond, §16) is logged, never reported as a failed payment.
      this.updatePaymentRequestStatus(requestId, 'paid');
      try {
        await this.sendPaymentRequestResponse(requestId, 'paid', result.id);
      } catch (error) {
        logger.warn('Payments', `Payment sent but the paid response failed for ${requestId}:`, error);
      }

      return result;
    } catch (error) {
      // #441/#442: reverting to 'pending' makes the request RE-PAYABLE (the guard
      // above admits a re-pay when the status is 'pending'). That is correct ONLY
      // for a clean pre-commit failure where NOTHING left the wallet.
      if (isPossiblyCommittedSendOutcome(error)) {
        // Money has (or may have) left the wallet on-chain. Do NOT tell the server
        // 'paid' yet — resumeOpenIntents may still ABORT this transfer. Durably
        // journal request→transfer and hold the request NON-payable ('settling')
        // until the linked transfer actually completes (resolves 'paid') or aborts
        // (returns to payable). Reverting to 'pending' here — or telling the server
        // 'paid' now — would double-pay after a RELOAD.
        const linkedTransferId =
          error instanceof SphereError && error.transferId ? error.transferId : undefined;
        // Deferral requires the wallet-api resume + respond mechanism. Without a
        // wallet-api PR port (a Nostr-only composition — where a possibly-committed
        // outcome does not actually arise, and requests are in-memory push-only, so
        // there is no reload re-surface to double-pay), keep the prior durable
        // 'paid' behavior instead of holding an unresolvable 'settling'.
        if (linkedTransferId && this.paymentRequestsApi()) {
          // A PartialSendConflictError means ≥1 leg ALREADY certified + delivered
          // and the anchor intent was soft-aborted — so resume will report it
          // aborted, but value DID leave the wallet. Journal it as `committed` so
          // the reconcile resolves it 'paid' and NEVER reverts to payable (a
          // re-pay would double-pay the delivered leg). Every other keep-open code
          // is a non-committed link that resume may complete or genuinely abort.
          const committed = error instanceof PartialSendConflictError;
          // Order is load-bearing: journal PERSISTS before the in-memory status
          // flip, so a crash in between leaves the durable link (reload re-applies
          // settling) — never a lost link (which would re-surface payable).
          await this.journalSettling(requestId, linkedTransferId, committed);
          this.updatePaymentRequestStatus(requestId, 'settling');
        } else {
          // Either a Nostr-only composition (no wallet-api PR port — no deferral
          // mechanism, no reload re-surface) or — defensively — a possibly-committed
          // code with NO stamped transferId (should be impossible after the sendOnce
          // stamps). Either way FAIL CLOSED to the pre-fix behavior (durably
          // non-payable) rather than re-surface payable or hold an unresolvable
          // 'settling'.
          if (!linkedTransferId) {
            logger.error(
              'Payments',
              `Possibly-committed send for ${requestId} carried no transferId — marking paid (fail-closed)`,
            );
          }
          this.updatePaymentRequestStatus(requestId, 'paid');
        }
      } else {
        // Clean pre-commit failure — nothing left the wallet; re-payable.
        await this.clearSettling(requestId); // defensive: drop any stale link
        this.updatePaymentRequestStatus(requestId, 'pending');
      }
      throw error;
    }
  }

  private updatePaymentRequestStatus(requestId: string, status: PaymentRequestStatus): void {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (request) {
      request.status = status;

      // Emit event
      const eventType = `payment_request:${status}` as const;
      if (eventType === 'payment_request:rejected' ||
          eventType === 'payment_request:paid' ||
          eventType === 'payment_request:expired' ||
          eventType === 'payment_request:settling') {
        this.host.deps?.emitEvent(eventType, request);
      }
    }
  }

  // ===========================================================================
  // Public API - Outgoing Payment Requests
  // ===========================================================================

  /**
   * Get outgoing payment requests
   * @param filter - Optional status filter
   */
  getOutgoingPaymentRequests(filter?: { status?: PaymentRequestStatus }): OutgoingPaymentRequest[] {
    const requests = Array.from(this.outgoingPaymentRequests.values());
    if (filter?.status) {
      return requests.filter((r) => r.status === filter.status);
    }
    return requests;
  }

  /**
   * Subscribe to payment request responses (for outgoing requests)
   * @param handler - Handler function for incoming responses
   * @returns Unsubscribe function
   */
  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  /**
   * Wait for a response to a payment request
   * @param requestId - The outgoing request ID to wait for
   * @param timeoutMs - Timeout in milliseconds (default: 60000)
   * @returns Promise that resolves with the response or rejects on timeout
   */
  waitForPaymentResponse(requestId: string, timeoutMs: number = 60000): Promise<PaymentRequestResponse> {
    const outgoing = this.outgoingPaymentRequests.get(requestId);
    if (!outgoing) {
      return Promise.reject(new Error(`Outgoing payment request not found: ${requestId}`));
    }

    // If already has a response, return it
    if (outgoing.response) {
      return Promise.resolve(outgoing.response);
    }

    // Create a promise that resolves when response arrives or times out
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponseResolvers.delete(requestId);
        // Update status to expired
        const request = this.outgoingPaymentRequests.get(requestId);
        if (request && request.status === 'pending') {
          request.status = 'expired';
        }
        reject(new Error(`Payment request response timeout: ${requestId}`));
      }, timeoutMs);

      this.pendingResponseResolvers.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * Cancel an active {@link waitForPaymentResponse} call.
   *
   * The pending promise is rejected with a `'Cancelled'` error.
   *
   * @param requestId - The outgoing request ID whose wait should be cancelled.
   */
  cancelWaitForPaymentResponse(requestId: string): void {
    const resolver = this.pendingResponseResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Cancelled'));
      this.pendingResponseResolvers.delete(requestId);
    }
  }

  /**
   * Remove an outgoing payment request and cancel any pending wait.
   *
   * @param requestId - ID of the outgoing request to remove.
   */
  removeOutgoingPaymentRequest(requestId: string): void {
    this.outgoingPaymentRequests.delete(requestId);
    this.cancelWaitForPaymentResponse(requestId);
  }

  /**
   * Remove all outgoing payment requests that are `'paid'`, `'rejected'`, or `'expired'`.
   */
  clearCompletedOutgoingPaymentRequests(): void {
    for (const [id, request] of this.outgoingPaymentRequests) {
      if (request.status === 'paid' || request.status === 'rejected' || request.status === 'expired') {
        this.outgoingPaymentRequests.delete(id);
      }
    }
  }

  /**
   * Fold a payment-request response into the outgoing surface and notify —
   * shared by the transport subscription and the wallet-api outgoing refresh
   * (S4): update the matched outgoing request, resolve any
   * {@link waitForPaymentResponse} waiter, emit the event, run the handlers.
   */
  private dispatchPaymentRequestResponse(response: PaymentRequestResponse): void {
    // Find the outgoing request by matching requestId
    let outgoingRequest: OutgoingPaymentRequest | undefined;
    let outgoingRequestId: string | undefined;

    for (const [id, request] of this.outgoingPaymentRequests) {
      // Match by eventId or requestId from the response
      if (request.eventId === response.requestId ||
          request.id === response.requestId) {
        outgoingRequest = request;
        outgoingRequestId = id;
        break;
      }
    }

    // Update outgoing request if found
    if (outgoingRequest && outgoingRequestId) {
      outgoingRequest.status = response.responseType === 'paid' ? 'paid' : 'rejected';
      outgoingRequest.response = response;

      // Resolve pending promise if any
      const resolver = this.pendingResponseResolvers.get(outgoingRequestId);
      if (resolver) {
        clearTimeout(resolver.timeout);
        resolver.resolve(response);
        this.pendingResponseResolvers.delete(outgoingRequestId);
      }
    }

    // Emit event
    this.host.deps?.emitEvent('payment_request:response', response);

    // Notify handlers
    for (const handler of this.paymentRequestResponseHandlers) {
      try {
        handler(response);
      } catch (error) {
        logger.debug('Payments', 'Payment request response handler error:', error);
      }
    }

    logger.debug('Payments', `Received payment request response: ${response.id} type: ${response.responseType}`);
  }

  /**
   * Send a response to a payment request (used internally by accept/reject/pay methods)
   */
  private async sendPaymentRequestResponse(
    requestId: string,
    responseType: 'rejected' | 'paid',
    transferId?: string
  ): Promise<void> {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (!request) return;

    const prApi = this.paymentRequestsApi();
    if (!prApi) return;

    // Server rejections (403 non-addressee, 409 non-open) propagate.
    if (responseType === 'paid') {
      if (transferId === undefined) {
        throw new SphereError('A paid response requires the fulfilling transferId (§16)', 'VALIDATION_ERROR');
      }
      await prApi.respondPaymentRequest(request.requestId, { action: 'paid', transferId });
    } else {
      await prApi.respondPaymentRequest(request.requestId, { action: 'declined' });
    }
    logger.debug('Payments', `Responded to payment request: ${responseType} for ${requestId}`);
  }

  // ===========================================================================
  // wallet-api payment requests: incoming pump + outgoing refresh (S4 — §10/§16)
  // ===========================================================================

  /** The S4 capability slice — null unless the composed wallet-api port carries it. */
  paymentRequestsApi(): PaymentRequestsApi | null {
    const api = this.host.deps?.walletApi;
    if (
      !api ||
      typeof api.createPaymentRequest !== 'function' ||
      typeof api.listPaymentRequests !== 'function' ||
      typeof api.respondPaymentRequest !== 'function'
    ) {
      return null;
    }
    return api as PaymentRequestsApi;
  }

  teardownPaymentRequestPump(): void {
    if (this.prPollTimer !== null) {
      clearInterval(this.prPollTimer);
      this.prPollTimer = null;
    }
  }

  // ── persisted cursor (per network + identity — mirrors the mailbox cursor) ──

  private prCursorKey(): string {
    const network = this.paymentRequestsApi()?.network ?? 'default';
    return `wallet-api-pr:cursor:${network}:${this.host.deps!.identity.chainPubkey}`;
  }

  private async readPrCursorState(): Promise<{ cursor: bigint; syncEpoch: bigint } | null> {
    const raw = await this.host.deps!.storage.get(this.prCursorKey());
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { cursor?: string; syncEpoch?: string };
      if (typeof parsed.cursor !== 'string' || typeof parsed.syncEpoch !== 'string') return null;
      return { cursor: BigInt(parsed.cursor), syncEpoch: BigInt(parsed.syncEpoch) };
    } catch {
      return null;
    }
  }

  private async persistPrCursorState(cursor: bigint, syncEpoch: bigint): Promise<void> {
    await this.host.deps!.storage.set(
      this.prCursorKey(),
      JSON.stringify({ cursor: cursor.toString(), syncEpoch: syncEpoch.toString() })
    );
  }

  // ── #441 deferred-paid journal (per network + identity — mirrors prCursor) ──

  private prSettlingKey(): string {
    const network = this.paymentRequestsApi()?.network ?? 'default';
    return `wallet-api-pr:settling:${network}:${this.host.deps!.identity.chainPubkey}`;
  }

  /**
   * Single-flight load: concurrent callers (the pump's reload re-apply, resume's
   * reconcile, a live pay catch) share ONE storage.get + ONE Map instance so a
   * lazy read never overwrites another context's in-memory mutation.
   */
  private ensureSettlingJournalLoaded(): Promise<void> {
    return (this.settlingJournalLoad ??= (async () => {
      const keyAtLoad = this.prSettlingKey();
      const raw = await this.host.deps!.storage.get(keyAtLoad);
      // Identity switched during the load await (initialize() reset the journal
      // for a new key): do NOT clobber the NEW identity's settlingJournal with
      // this stale load. The fresh identity's ensureSettlingJournalLoaded (its
      // memo was reset to null) loads the correct journal.
      if (this.prSettlingKey() !== keyAtLoad) return;
      try {
        this.settlingJournal = new Map(
          raw ? Object.entries(JSON.parse(raw) as Record<string, { transferId: string; createdAt: number; committed?: boolean }>) : []
        );
      } catch (err) {
        // A corrupt blob (partial write / manual clear / older format) must NOT
        // wedge the whole resume + payment-request pump. Fail open to an empty
        // journal (a settling request may re-surface payable — a rare, bounded
        // risk) rather than throw and break ALL resume for the session.
        logger.error('Payments', 'Settling journal unreadable — treating as empty:', err);
        this.settlingJournal = new Map();
      }
    })());
  }

  /**
   * Serialize every read-modify-write through a tail-promise chain so two
   * concurrent mutations can't lose an entry (the #679/#680 mutex lesson — a
   * dropped entry is a re-payable request is a double-pay). `fn` returns true
   * when the Map changed and must be persisted.
   */
  private mutateSettlingJournal(
    fn: (m: Map<string, { transferId: string; createdAt: number; committed?: boolean }>) => boolean
  ): Promise<void> {
    // Capture the identity's storage key at ENQUEUE time. If the identity
    // switches before this queued mutation runs, prSettlingKey() will have
    // changed — skip, so a stale old-identity mutation cannot reload + rewrite
    // the NEW identity's journal (resetting the chain pointer alone does not
    // cancel an already-queued .then).
    const keyAtEnqueue = this.prSettlingKey();
    this.settlingJournalWrite = this.settlingJournalWrite.catch(() => {}).then(async () => {
      if (this.prSettlingKey() !== keyAtEnqueue) return; // identity changed — drop the stale mutation
      await this.ensureSettlingJournalLoaded();
      // Re-check after the load await: if the identity switched WHILE loading, the
      // load skipped its assignment (guard above) — bail so we never mutate under
      // the wrong identity, and so `settlingJournal!` is provably non-null here.
      if (this.prSettlingKey() !== keyAtEnqueue) return;
      if (fn(this.settlingJournal!)) {
        await this.host.deps!.storage.set(keyAtEnqueue, JSON.stringify(Object.fromEntries(this.settlingJournal!)));
      }
    });
    return this.settlingJournalWrite;
  }

  /**
   * #441: link a request to its in-flight transfer. `committed` marks a
   * DEFINITE spend whose anchor intent is soft-aborted and will NOT resume-
   * complete — a `PartialSendConflictError` (≥1 leg already delivered). The
   * reconcile must resolve such a link 'paid' and NEVER revert it to payable
   * (re-paying the full amount would double-pay the delivered leg). A
   * non-`committed` link is a keep-open outcome that resume may still complete
   * OR abort (e.g. CERTIFICATION_UNCONFIRMED losing to a foreign tx delivers
   * nothing) — those DO revert to payable on abort.
   */
  private journalSettling(requestId: string, transferId: string, committed = false): Promise<void> {
    return this.mutateSettlingJournal((m) => {
      m.set(requestId, { transferId, createdAt: Date.now(), ...(committed ? { committed: true } : {}) });
      return true;
    });
  }

  private clearSettling(requestId: string): Promise<void> {
    return this.mutateSettlingJournal((m) => m.delete(requestId));
  }

  // ── the pump ─────────────────────────────────────────────────────────────────

  /**
   * Pull the wallet-api payment-request streams now (S4): drains the payer's
   * incoming `?since=<seq>` stream (gap-free — §9/§16) into the existing
   * handler/event surface and refreshes outgoing requests still awaiting a
   * response. The poll interval and `load()` call this automatically; it is
   * public for explicit fetch-now flows (mirrors {@link receive}). A no-op in
   * compositions without the wallet-api payment-request capability — there
   * the Nostr subscription is push-based.
   */
  async syncPaymentRequests(): Promise<void> {
    await this.pumpPaymentRequests();
  }

  /** Coalesces concurrent pump runs (poll + wake + load can overlap). */
  async pumpPaymentRequests(): Promise<void> {
    const api = this.paymentRequestsApi();
    if (!api) return;
    if (this.prPumpInFlight) return this.prPumpInFlight;
    this.prPumpInFlight = this.doPumpPaymentRequests(api).finally(() => {
      this.prPumpInFlight = null;
    });
    return this.prPumpInFlight;
  }

  private async doPumpPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    // #724: await the CURRENT load, not just the first.
    await this.host.loadedPromise;
    await this.pumpIncomingPaymentRequests(api);
    await this.refreshOutgoingPaymentRequests(api);
  }

  /**
   * Drain the payer's gap-free `?since=<seq>` stream (§9/§16), mirroring the
   * mailbox-cursor pattern: the persisted `{cursor, syncEpoch}` is the resume
   * point; a `syncEpoch` change (server restore — §5.4) voids cursor
   * continuity, so the tail re-pulls from 0 and the id-dedup in
   * {@link surfaceIncomingPaymentRequest} absorbs the replays.
   *
   * Because the surfaced list is in-memory only, each session FIRST runs one
   * full incoming hydration from `since=0` with NO status filter (#556 —
   * mirrors {@link hydrateHistoryFromServer}): a fresh engine rebuilds the
   * CURRENT state of ALL incoming requests — open AND resolved — so a request
   * paid/declined/expired in a PRIOR session is still present (with its
   * resolved status) instead of vanishing once the cursor advanced past it.
   * Hydration NEVER fires the new-incoming handlers/events for resolved
   * requests — only `open` ones notify (the status-aware
   * {@link surfaceIncomingPaymentRequest}) — so reopening can't spam stale
   * 'new request' notifications. After hydration the `since`-cursor delta poll
   * picks up live updates from the resume point.
   */
  private async pumpIncomingPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    // #441: the deferred-paid journal must be present in memory BEFORE the first
    // hydration surfaces any wire — surfaceIncomingPaymentRequest reads it
    // synchronously to hold a settling request non-payable instead of re-surfacing
    // it as payable. Single-flight, so ordering vs. resumeOpenIntents is irrelevant.
    await this.ensureSettlingJournalLoaded();

    const persisted = await this.readPrCursorState();

    if (!this.prBootstrapped) {
      let scan = await api.listPaymentRequests({ role: 'incoming', since: 0n });
      for (let pageCount = 0; pageCount < MAX_PR_HYDRATION_PAGES; pageCount++) {
        for (const wire of scan.requests) this.surfaceIncomingPaymentRequest(wire);
        if (!scan.more) break;
        scan = await api.listPaymentRequests({ role: 'incoming', since: scan.cursor });
      }
      // Marked only after the hydration SUCCEEDS — a transient failure here must
      // not skip recovery for the rest of the session (the next poll retries;
      // the id-dedup makes a re-hydration safe).
      this.prBootstrapped = true;
    }

    let page = await api.listPaymentRequests({ role: 'incoming', since: persisted?.cursor ?? 0n });
    if (persisted !== null && page.syncEpoch !== persisted.syncEpoch) {
      page = await api.listPaymentRequests({ role: 'incoming', since: 0n });
    }
    for (;;) {
      for (const wire of page.requests) this.surfaceIncomingPaymentRequest(wire);
      await this.persistPrCursorState(page.cursor, page.syncEpoch);
      if (!page.more) break;
      page = await api.listPaymentRequests({ role: 'incoming', since: page.cursor });
    }
  }

  /**
   * Decrypt a payment-request's recipient-addressed memo envelope into
   * `{ memo, senderNametag }` (the requester's message + nametag). The key is
   * the ECDH shared secret between THIS wallet (the payer) and the requester's
   * chain pubkey (`wire.fromPubkey`) — symmetric with the requester's
   * create-time derivation. Returns an empty bundle (and logs at debug) on any
   * absence/failure so the incoming view never wedges on an unreadable memo
   * (PR twin of #546/#547).
   */
  private decryptPaymentRequestMemo(
    wire: WalletApiPaymentRequest
  ): { memo?: string; senderNametag?: string } {
    if (wire.memo === undefined) return {};
    try {
      const key = deriveDeliveryEncryptionKey(this.host.deps!.identity.privateKey, wire.fromPubkey);
      return decryptDeliveryBundle(key, wire.memo);
    } catch {
      logger.debug('Payments', `Payment request ${wire.id.slice(0, 12)}… memo not addressed here / not decryptable`);
      return {};
    }
  }

  /** §16 wire status → the public {@link PaymentRequestStatus} display status. */
  private static readonly PR_WIRE_STATUS: Record<
    WalletApiPaymentRequest['status'],
    PaymentRequestStatus
  > = { open: 'pending', paid: 'paid', declined: 'rejected', expired: 'expired' };

  /** Terminal local statuses: a re-surfaced wire may advance a request INTO one, never out of it. */
  private static readonly PR_TERMINAL: ReadonlySet<PaymentRequestStatus> = new Set([
    'paid',
    'rejected',
    'expired',
  ]);

  /**
   * Map a §16 wire request onto the public {@link IncomingPaymentRequest}
   * surface, deduped by id (the in-memory id-dedup doubles as the replay guard
   * for cursor resets). Requests of EVERY status are surfaced so a reloaded
   * thin wallet rebuilds the CURRENT state of its incoming view (#556) — open
   * ones land as actionable `pending`, resolved ones carry their paid/declined
   * (→ `rejected`)/expired status. Only `open` requests fire the new-incoming
   * event + handlers; resolved requests are folded into the list silently, so a
   * reload (or a `syncEpoch` re-pull) never re-notifies for already-resolved
   * requests. Multi-asset requests surface their first asset (the module's
   * request surface is single-asset; module-created requests always are).
   */
  private surfaceIncomingPaymentRequest(wire: WalletApiPaymentRequest): void {
    // #583 defense-in-depth owner guard: only surface requests actually
    // addressed to THIS module's owner. Per-address client isolation means an
    // orphaned previous-address PR pump runs against its OWN client (its own
    // owner), so a wire for a different owner should never arrive here — but if
    // any shared state ever slips through, this drops it (and keeps it out of
    // the wrong owner's actionable view + cursor) rather than bleeding a foreign
    // request across addresses. Mirrors the engine.isOwnedBy delivery guard.
    if (wire.toPubkey !== this.host.deps!.identity.chainPubkey) {
      logger.warn(
        'Payments',
        `Incoming payment request ${wire.id.slice(0, 12)}… addressed to a different owner — skipping (owner guard)`
      );
      return;
    }

    let status = PaymentRequests.PR_WIRE_STATUS[wire.status];

    // #441 reload re-apply: a request linked to an in-flight transfer (durable
    // journal, loaded before hydration) must NOT be re-surfaced as payable. Read
    // the SYNCHRONOUS in-memory journal (loaded in pumpIncomingPaymentRequests /
    // resumeOpenIntents before any surface call).
    const settling = this.settlingJournal?.get(wire.id);
    if (settling) {
      if (wire.status === 'open') {
        // Hold non-payable; suppresses the new-incoming notify below.
        status = 'settling';
      } else {
        // Server already resolved (paid/declined/expired) — our deferred tell
        // landed in a prior session, or it expired. Drop the stale link and let
        // the terminal status flow. Fire-and-forget (surface is sync), but attach
        // a .catch so a storage I/O failure can't raise an unhandled rejection.
        void this.clearSettling(wire.id).catch((err) =>
          logger.warn('Payments', `Failed to clear stale settling link for ${wire.id}:`, err),
        );
      }
    }

    // §16 upsert: a request re-surfaces in the incoming ?since= delta at a higher seq when it is
    // resolved (paid/declined) or expired — on another device OR by THIS wallet's other session.
    // If we already hold it, advance a still-actionable request to its terminal server state and
    // emit the resolution event (so every session drops it from the actionable view); never
    // downgrade, and never re-notify a request we've already surfaced.
    const existing = this.paymentRequests.find((r) => r.id === wire.id);
    if (existing !== undefined) {
      if (PaymentRequests.PR_TERMINAL.has(status) && !PaymentRequests.PR_TERMINAL.has(existing.status)) {
        this.updatePaymentRequestStatus(wire.id, status);
      }
      return;
    }

    const coinId = wire.assets[0]?.coinId ?? '';
    const coinDef = TokenRegistry.getInstance().getDefinition(coinId);

    // S6: the memo is a recipient-addressed envelope keyed off
    // ECDH(payerPriv, requester chain pubkey = wire.fromPubkey) — symmetric
    // with the requester's create-time derivation (the PR twin of #546/#547).
    // It carries the requester's nametag AND message, so the payer renders
    // "@requester" + the message instead of a raw pubkey. An envelope not
    // addressed here, or any tamper, fails authentication and surfaces as
    // absent — never garbage, and never thrown into the view path. Decrypted
    // for resolved requests too (#554/dev.12), so a reloaded view renders the
    // memo/nametag of a paid/declined request, not a raw pubkey.
    const { memo: message, senderNametag } = this.decryptPaymentRequestMemo(wire);

    const request: IncomingPaymentRequest = {
      id: wire.id,
      senderPubkey: wire.fromPubkey,
      ...(senderNametag !== undefined ? { senderNametag } : {}),
      amount: (wire.assets[0]?.amount ?? 0n).toString(),
      coinId,
      symbol: coinDef?.symbol || coinId.slice(0, 8),
      ...(message !== undefined ? { message } : {}),
      requestId: wire.id,
      timestamp: wire.createdAt,
      status,
    };

    // Add to list (newest first)
    this.paymentRequests.unshift(request);

    // Notify ONLY for actionable (open) requests — a reload-hydrated resolved
    // request must not re-fire 'new incoming request' (#556). Open requests
    // surfaced during hydration DO notify, exactly as the prior bootstrap did.
    if (status === 'pending') {
      this.host.deps?.emitEvent('payment_request:incoming', request);
      for (const handler of this.paymentRequestHandlers) {
        try {
          handler(request);
        } catch (error) {
          logger.debug('Payments', 'Payment request handler error:', error);
        }
      }
    }

    logger.debug('Payments', `Incoming payment request: ${request.id} (${status}) for ${request.amount} ${request.symbol}`);
  }

  /**
   * Outgoing requests are a `?before=` backfill view (§16 — newest-first, no
   * gap-free tail): refresh only while something local still awaits a
   * response, paging until every pending id is resolved or the view drains.
   */
  private async refreshOutgoingPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    const pendingIds = new Set(
      [...this.outgoingPaymentRequests.values()].filter((r) => r.status === 'pending').map((r) => r.id)
    );
    if (pendingIds.size === 0) return;

    let before: string | undefined;
    for (;;) {
      const page = await api.listPaymentRequests({
        role: 'outgoing',
        ...(before !== undefined ? { before } : {}),
      });
      for (const wire of page.requests) {
        if (!pendingIds.delete(wire.id)) continue;
        this.applyOutgoingPaymentRequestState(wire);
      }
      if (pendingIds.size === 0 || !page.more || page.cursor === null) return;
      before = page.cursor;
    }
  }

  /** Fold a server-side status change into the outgoing surface (responses + expiry). */
  private applyOutgoingPaymentRequestState(wire: WalletApiPaymentRequest): void {
    if (wire.status === 'open') return;
    const outgoing = this.outgoingPaymentRequests.get(wire.id);
    if (!outgoing || outgoing.status !== 'pending') return;

    if (wire.status === 'expired') {
      // §10: expiry is server-owned, not client-inferred — fold the status in;
      // there is no responder, so no response is dispatched.
      outgoing.status = 'expired';
      return;
    }

    this.dispatchPaymentRequestResponse({
      id: wire.id,
      responderPubkey: wire.toPubkey,
      requestId: wire.id,
      responseType: wire.status === 'paid' ? 'paid' : 'rejected',
      ...(wire.transferId !== null ? { transferId: wire.transferId } : {}),
      timestamp: Date.now(),
    });
  }

  /**
   * #441: resolve every journaled settling payment request against a resume
   * outcome. Completed → send the deferred 'paid' response (server now told) and
   * resolve 'paid'. Aborted (nothing delivered) → clear journal, return to
   * payable. Still open → leave it. For an id accounted for by NONE of those
   * (a crash between resume-complete and the local write), consult the server
   * `listIntents('aborted')` authority: aborted → payable; else → paid (a
   * completed row the server GC'd). Direction-of-error is deliberate: the only
   * residual false-paid is a transfer that aborted server-side AND whose local
   * 'aborted' write was lost AND whose server aborted-row was later GC'd — it is
   * treated as paid, erring toward PAID-NEVER-RE-PAYABLE (no double-pay), the
   * invariant this fix exists to protect.
   */
  async reconcileSettlingPaymentRequests(
    outcome: { resumed: string[]; conflicted: string[]; failed: string[] },
    openIntentIds: Set<string>,
    localIntents: Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }> | undefined,
    localReadFailed: boolean,
  ): Promise<void> {
    if (this.reconcileInFlight) return; // an overlapping resume is already reconciling
    await this.ensureSettlingJournalLoaded();
    if (this.settlingJournal!.size === 0) return;
    if (localReadFailed) return; // #676 posture: dispositions unknown → leave settling, retry next sign-in
    this.reconcileInFlight = true;
    try {
      const resumed = new Set(outcome.resumed);
      const conflicted = new Set(outcome.conflicted); // aborted THIS run — nothing delivered

      // Server ABORTED authority — fetched lazily, only when a journaled id is
      // unaccounted-for by the cheap checks below (closes the false-paid crash gap
      // without a local-absence guess).
      let abortedIds: Set<string> | null = null;
      const abortedAuthority = async (): Promise<Set<string>> => {
        if (abortedIds) return abortedIds;
        const aborted = await this.host.deps!.walletApi!.listIntents('aborted');
        abortedIds = new Set(aborted.map((i) => i.transferId));
        return abortedIds;
      };

      for (const [requestId, entry] of [...this.settlingJournal!]) {
        const { transferId, createdAt } = entry;
        if (Date.now() - createdAt > 7 * 864e5) {
          logger.warn(
            'Payments',
            `Settling link ${requestId}→${transferId.slice(0, 8)}… is >7d old (stuck transfer?)`,
          );
        }
        const local = localIntents?.get(transferId);

        // A `committed` link (PartialSendConflictError) delivered value already;
        // its anchor intent is soft-aborted, so it will show aborted/conflicted —
        // but it must NEVER revert to payable (that re-pays the delivered leg).
        // Resolve it 'paid' unconditionally (retry the response until it lands).
        if (entry.committed) {
          await this.resolveSettledPaid(requestId, transferId);
        } else if (resumed.has(transferId) || local?.status === 'completed') {
          await this.resolveSettledPaid(requestId, transferId);
        } else if (conflicted.has(transferId) || local?.status === 'aborted' || local?.abortPending === true) {
          await this.revertSettlingToPayable(requestId);
        } else if (openIntentIds.has(transferId)) {
          // Still open (transient/stuck) → leave journal, retry next sign-in.
        } else {
          // Not resumed this run, not locally decided, not in the open list —
          // consult the server aborted authority.
          try {
            const aborted = await abortedAuthority();
            if (aborted.has(transferId)) await this.revertSettlingToPayable(requestId);
            else await this.resolveSettledPaid(requestId, transferId); // server GC'd a completed row
          } catch (e) {
            logger.warn(
              'Payments',
              `listIntents(aborted) failed during reconcile — deferring ${requestId} to next sign-in:`,
              e,
            );
          }
        }
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /** #441: the linked transfer completed — tell the server 'paid' and resolve 'paid'. */
  private async resolveSettledPaid(requestId: string, transferId: string): Promise<void> {
    const api = this.paymentRequestsApi();
    if (!api || typeof api.respondPaymentRequest !== 'function') return; // only wallet-api ports journal
    try {
      await api.respondPaymentRequest(requestId, { action: 'paid', transferId });
    } catch (err) {
      // Idempotent replay / expiry race: a 409 CONFLICT ('non-open') means the
      // request is already resolved server-side → swallow and clear. Any OTHER
      // error (network / 5xx) → leave the journal, retry next sign-in.
      if (!isNonOpenConflict(err)) {
        logger.warn('Payments', `Deferred paid response failed for ${requestId} (retried next sign-in):`, err);
        return;
      }
    }
    await this.clearSettling(requestId);
    this.updatePaymentRequestStatus(requestId, 'paid'); // reconcile in-memory if surfaced; else next pump sees wire 'paid'
  }

  /** #441: the linked transfer aborted — nothing was paid; clear the link and return to payable. */
  private async revertSettlingToPayable(requestId: string): Promise<void> {
    await this.clearSettling(requestId);
    // No-op if not in memory; the next pump re-surfaces the open wire as 'pending'.
    this.updatePaymentRequestStatus(requestId, 'pending');
  }
}
