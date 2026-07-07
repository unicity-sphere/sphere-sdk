/**
 * `publishUxfBundle` — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Public primitive that takes a pre-built UXF CAR bundle and puts it
 * on the wire via the standard TOKEN_TRANSFER pipeline (Nostr kind
 * 31113). Used today by `AccountingModule.deliverInvoice`; anticipated
 * to grow additional callers as more subsystems produce bundles they
 * want the token-pipeline wire path for (matching at-least-once gate,
 * shared receiver decode/route, OUTBOX coverage).
 *
 * See uxfv2-phase-5-payments-disposition.md §"send() orchestrator +
 * related" for the disposition entry. Behavior preserved verbatim from
 * PaymentsModule — including the Issue #401 best-effort inline-CAR pin
 * (fire-and-forget) and the OUTBOX/SENT write pair that lets the
 * NostrPersistenceVerifier + SendingRecoveryWorker cover this bundle
 * for free.
 */

import type { PeerInfo, TransportProvider } from '../../../../transport';
import type { FullIdentity } from '../../../../types';
import type { OutboxWriter } from '../../profile/outbox-writer';
import type { UxfTransferPayload } from '../../types/uxf-transfer';
import type { PublishToIpfsCallback } from '../delivery-resolver';
import { carBytesToBase64 } from '../../bundle/transfer-payload';
import { SphereError } from '../../../../core/errors';
import { logger } from '../../../../core/logger';
import type { SentWriterHost } from './worker-helpers';
import { writeSentEntryFromOutbox } from './worker-helpers';

/**
 * Host shim exposing the collaborators `publishUxfBundle` reaches for:
 *   - `identity` / `transport` — for wire publish and sender-field
 *     population;
 *   - `resolveTransportPubkey` — private facade helper (survives per
 *     the ledger at `modules/payments/send/recipient-resolve.ts`);
 *   - `publishToIpfs` — optional dep for the Issue #401 best-effort
 *     inline-CAR pin;
 *   - `outboxWriter` — nullable UXF outbox writer;
 *   - `sentLedgerWriter` — passed through the writeSentEntryFromOutbox
 *     helper's host shape;
 *   - `ensureInitialized` — facade-side guard.
 */
export interface PublishUxfBundleHost extends SentWriterHost {
  ensureInitialized(): void;
  readonly transport: TransportProvider;
  readonly identity: FullIdentity;
  readonly publishToIpfs: PublishToIpfsCallback | undefined;
  readonly outboxWriter: OutboxWriter | null;
  resolveTransportPubkey(recipient: string, peerInfo: PeerInfo | null): string;
}

/** Parameters mirror the facade method signature. */
export interface PublishUxfBundleParams {
  readonly recipient: string;
  readonly bundleCid: string;
  readonly tokenIds: ReadonlyArray<string>;
  readonly carBytes: Uint8Array;
  readonly publishViaIpfsCid?: boolean;
  readonly carBase64Inline?: string;
  readonly cidFetchGateways?: ReadonlyArray<string>;
  readonly memo?: string;
}

/** Result mirrors the facade method signature. */
export interface PublishUxfBundleResult {
  readonly nostrEventId: string;
  readonly recipientTransportPubkey: string;
  readonly recipientNametag?: string;
}

/**
 * Issue #397 — Publish a pre-built UXF CAR bundle to a recipient via
 * the standard TOKEN_TRANSFER pipeline (Nostr kind 31113).
 *
 * Wire shape:
 *  - `kind: 'uxf-car'` (default) — inline CAR base64 in the payload.
 *    `carBase64` is derived from `carBytes` if not pre-supplied.
 *  - `kind: 'uxf-cid'` (when `publishViaIpfsCid: true`) — the caller
 *    is responsible for IPFS-pinning the CAR beforehand; only the CID
 *    rides on the wire.
 *
 * Does NOT mint, sign, finalize, or otherwise mutate state — those
 * concerns belong in the higher-level `send` / `sendInstant` paths
 * which work with un-finalized source tokens. This primitive trusts
 * the caller to hand it a bundle whose contents are already terminal.
 *
 * @throws {SphereError} `INVALID_RECIPIENT` — recipient could not be
 *   resolved to a transport pubkey.
 * @throws {SphereError} `TRANSPORT_ERROR` — transport rejected the
 *   `sendTokenTransfer` call.
 * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
 */
export async function publishUxfBundle(
  host: PublishUxfBundleHost,
  params: PublishUxfBundleParams,
): Promise<PublishUxfBundleResult> {
  host.ensureInitialized();

  // Resolve recipient → transport pubkey. Mirrors the same two-step
  // pattern as `send`/`sendInstant` (transport.resolve → fallback
  // hex parsing inside `resolveTransportPubkey`).
  const peerInfo: PeerInfo | null =
    (await host.transport.resolve?.(params.recipient)) ?? null;
  const recipientTransportPubkey = host.resolveTransportPubkey(params.recipient, peerInfo);

  // Build the wire payload. Shape mirrors the canonical envelopes
  // produced by `instant-sender.ts` so legacy decoders + the receive
  // pipeline see identical wire bytes from both senders. `mode:
  // 'instant'` is the discriminator the receiver's ingest pool keys
  // on; it is advisory per §3.1 ("recipient processes per bundle
  // contents, not per this field").
  const tokenIds = params.tokenIds.slice();
  const senderField = {
    transportPubkey: host.identity.chainPubkey,
    ...(host.identity.nametag !== undefined ? { nametag: host.identity.nametag } : {}),
  };
  let payload: UxfTransferPayload;
  if (params.publishViaIpfsCid) {
    payload = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'instant',
      bundleCid: params.bundleCid,
      tokenIds,
      sender: senderField,
      ...(params.memo !== undefined ? { memo: params.memo } : {}),
      ...(params.cidFetchGateways && params.cidFetchGateways.length > 0
        ? { senderGateways: params.cidFetchGateways.slice() }
        : {}),
    };
  } else {
    const carBase64 = params.carBase64Inline ?? carBytesToBase64(params.carBytes);
    payload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: params.bundleCid,
      tokenIds,
      sender: senderField,
      ...(params.memo !== undefined ? { memo: params.memo } : {}),
      carBase64,
    };
  }

  // Issue #401 — best-effort local IPFS pin for the inline branch.
  // Mirrors `instant-sender.ts` Step 8.5: the SendingRecoveryWorker's
  // default republish callback ALWAYS converts to `'uxf-cid'` (PR #189
  // OUTBOX-SEND-FOLLOWUPS item #2), so the bundle CID MUST be fetchable
  // for republish to succeed end-to-end. The CID-branch caller already
  // pinned (AccountingModule line ~1515); the inline branch needs an
  // equivalent best-effort pin here so a retention drop on inline-CAR
  // invoices can still recover.
  //
  // Fire-and-forget — pin failure MUST NOT block the wire publish.
  // Idempotent at the IPFS layer (content-addressed; re-pin is a no-op).
  if (!params.publishViaIpfsCid && host.publishToIpfs !== undefined) {
    const publish = host.publishToIpfs;
    const carBytes = params.carBytes;
    void Promise.resolve()
      .then(() => publish(carBytes))
      .catch((pinErr) => {
        const message = pinErr instanceof Error ? pinErr.message : String(pinErr);
        logger.warn(
          'Payments',
          `publishUxfBundle: best-effort inline-CAR pin failed (Issue #401) — ` +
            `wire send unaffected; retention re-publish via SendingRecoveryWorker ` +
            `will publish 'uxf-cid' shape but receivers can't decode without the pin. ` +
            `bundleCid=${params.bundleCid} cause=${message}`,
        );
      });
  }

  // Issue #401 — OUTBOX wiring. Write a `'sending'` entry BEFORE the
  // transport publish so the SendingRecoveryWorker picks the entry up
  // if the publish crashes between this line and the ack write below.
  // Skip if no OUTBOX writer is installed (legacy/in-memory wallets,
  // bootstrap-only paths) — the existing fire-and-publish behavior
  // remains correct for those callers.
  const outboxWriter = host.outboxWriter;
  const deliveryMethod: 'cid-over-nostr' | 'car-over-nostr' =
    params.publishViaIpfsCid ? 'cid-over-nostr' : 'car-over-nostr';
  const outboxId = crypto.randomUUID();
  if (outboxWriter !== null) {
    const createdAt = Date.now();
    await outboxWriter.write({
      id: outboxId,
      bundleCid: params.bundleCid,
      tokenIds,
      deliveryMethod,
      recipient: params.recipient,
      recipientTransportPubkey,
      ...(peerInfo?.nametag !== undefined ? { recipientNametag: peerInfo.nametag } : {}),
      mode: 'instant',
      status: 'sending',
      outstandingRequestIds: [],
      completedRequestIds: [],
      ...(params.memo !== undefined ? { memo: params.memo } : {}),
      createdAt,
      updatedAt: createdAt,
      submitRetryCount: 0,
      proofErrorCount: 0,
    });
  }

  // Publish via TOKEN_TRANSFER (kind 31113) — same wire kind as
  // ordinary token transfers, so the receiver's existing ingest
  // pool + at-least-once gate cover this delivery for free.
  let nostrEventId: string;
  try {
    nostrEventId = await host.transport.sendTokenTransfer(recipientTransportPubkey, payload);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // The OUTBOX entry remains live at `'sending'`. The
    // SendingRecoveryWorker scans `'sending'` entries past
    // `stuckThresholdMs` (default 60s) and re-publishes via its
    // generic `'uxf-cid'` callback (PaymentsModule line ~2199).
    throw new SphereError(
      `publishUxfBundle: transport.sendTokenTransfer failed: ${message}`,
      'TRANSPORT_ERROR',
      cause,
    );
  }

  // Transition `'sending' → 'delivered'` once the relay ack lands.
  // Choosing the conservative-mode arc (NOT `'delivered-instant'`):
  // invoice bundles carry their own genesis proofs from the payee
  // and have no aggregator commitments to poll, so there's nothing
  // for the FinalizationWorker to do. `'delivered'` is the correct
  // resting state — the NostrPersistenceVerifier scans SENT past
  // `verifyDelayMs` and, on retention drop, rearms the OUTBOX entry
  // back to `'sending'` for the recovery worker to republish.
  if (outboxWriter !== null) {
    await outboxWriter.update(outboxId, (prev) => ({
      ...prev,
      status: 'delivered',
      nostrEventId,
      updatedAt: Date.now(),
    }));
    // Mirror the dispatcher's pattern (PaymentsModule line ~14569):
    // the OUTBOX `update` itself does not write SENT — that lives
    // in the orchestrator's `outbox.write` hook for normal sends.
    // For `publishUxfBundle` (no orchestrator), the SENT write is
    // an inline follow-up. The verifier reads the SENT ledger so
    // this step is what makes retention monitoring work for free.
    await writeSentEntryFromOutbox(
      host,
      {
        id: outboxId,
        bundleCid: params.bundleCid,
        tokenIds,
        deliveryMethod,
        recipient: params.recipient,
        recipientTransportPubkey,
        ...(peerInfo?.nametag !== undefined ? { recipientNametag: peerInfo.nametag } : {}),
        mode: 'instant',
        status: 'delivered',
        outstandingRequestIds: [],
        completedRequestIds: [],
        ...(params.memo !== undefined ? { memo: params.memo } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submitRetryCount: 0,
        proofErrorCount: 0,
        nostrEventId,
      },
      'publishUxfBundle',
    );
  }

  return {
    nostrEventId,
    recipientTransportPubkey,
    ...(peerInfo?.nametag !== undefined ? { recipientNametag: peerInfo.nametag } : {}),
  };
}
