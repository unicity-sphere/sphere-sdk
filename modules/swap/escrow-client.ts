/**
 * Escrow Client — Stateless helper functions for escrow DM communication
 *
 * Provides retry-wrapped DM senders for the three outbound escrow message
 * types (announce, status query, request invoice), escrow address resolution,
 * and sender verification. All functions are pure/stateless — state lives in
 * SwapModule and SwapRef.
 *
 * @see docs/SWAP-SPEC.md §5 (acceptSwap escrow announcement)
 * @see docs/SWAP-SPEC.md §8 (status query)
 * @see docs/SWAP-IMPLEMENTATION-PLAN.md T1.2
 *
 * @module
 */

import { logger } from '../../core/logger.js';
import { SphereError } from '../../core/errors.js';
import {
  buildAnnounceDM,
  buildAnnounceDM_v2,
  buildStatusQueryDM,
  buildRequestInvoiceDM,
} from './dm-protocol.js';
import type { SwapDeal, SwapManifest, ManifestSignatures, ManifestAuxiliary, SwapModuleConfig, SwapModuleDependencies } from './types.js';

/** Logger tag for all escrow-client operations. */
const TAG = 'SwapEscrow';

/** Base delay for exponential backoff (ms). */
const BASE_DELAY_MS = 2000;

/** Maximum delay cap for exponential backoff (ms). */
const MAX_DELAY_MS = 16000;

/** Jitter factor: delay is randomized within ±JITTER_FACTOR of the computed delay. */
const JITTER_FACTOR = 0.25;

// =============================================================================
// withRetry — Exponential backoff with jitter
// =============================================================================

/**
 * Exponential backoff with jitter for escrow DM sends.
 * Retries up to `maxRetries` times with 2s base delay, 16s max.
 *
 * The delay doubles on each retry and is capped at {@link MAX_DELAY_MS}.
 * A random jitter of +/-25% is applied to prevent thundering herd.
 *
 * @param fn - The async operation to retry
 * @param maxRetries - Maximum number of retry attempts (0 = no retries, just one attempt)
 * @param label - Human-readable label for log messages (e.g., 'announce', 'status')
 * @returns The result of the first successful invocation of `fn`
 * @throws The last error encountered if all attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check for cancellation before each attempt
    if (signal?.aborted) {
      throw new Error(`${label}: aborted`);
    }
    try {
      return await fn();
    } catch (err: unknown) {
      // If aborted mid-attempt, stop retrying immediately
      if (signal?.aborted) throw err;
      lastError = err;

      if (attempt < maxRetries) {
        const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        const jitter = baseDelay * JITTER_FACTOR * (2 * Math.random() - 1);
        const delay = Math.round(baseDelay + jitter);

        logger.warn(
          TAG,
          `${label}: attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms`,
          err instanceof Error ? err.message : err,
        );

        // Interruptible delay: resolves early if signal fires.
        // Guard first: addEventListener on an already-aborted AbortSignal does not
        // fire in Node.js v22, so check .aborted synchronously inside the executor.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error(`${label}: aborted during retry delay`));
            return;
          }
          const t = setTimeout(resolve, delay);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error(`${label}: aborted during retry delay`));
          }, { once: true });
        });
      }
    }
  }

  logger.error(
    TAG,
    `${label}: all ${maxRetries + 1} attempts failed`,
    lastError instanceof Error ? lastError.message : lastError,
  );

  throw lastError;
}

// =============================================================================
// resolveEscrowAddress — Resolve escrow from deal or config default
// =============================================================================

/**
 * Resolve the escrow address from the deal or config default.
 * Returns the resolved DIRECT:// address and chain pubkey.
 *
 * Resolution priority:
 * 1. `deal.escrowAddress` (explicit per-deal override)
 * 2. `config.defaultEscrowAddress` (module-level default)
 *
 * If neither is set, throws `SWAP_INVALID_DEAL`. If the address cannot
 * be resolved via the transport layer, throws `SWAP_RESOLVE_FAILED`.
 *
 * @param deal - The swap deal containing an optional escrow address
 * @param config - The swap module config containing an optional default escrow address
 * @param resolve - Transport-level peer resolution function
 * @returns Resolved escrow DIRECT:// address and transport pubkey (for DM sender verification)
 * @throws {SphereError} `SWAP_INVALID_DEAL` if no escrow address is configured
 * @throws {SphereError} `SWAP_RESOLVE_FAILED` if the escrow address cannot be resolved
 */
export async function resolveEscrowAddress(
  deal: SwapDeal,
  config: SwapModuleConfig,
  resolve: (identifier: string) => Promise<{ directAddress: string; chainPubkey: string; transportPubkey?: string } | null>,
): Promise<{ escrowDirectAddress: string; escrowPubkey: string }> {
  const escrowAddr = deal.escrowAddress ?? config.defaultEscrowAddress;

  if (!escrowAddr) {
    throw new SphereError(
      'No escrow address provided in deal or module config',
      'SWAP_INVALID_DEAL',
    );
  }

  logger.debug(TAG, `Resolving escrow address: ${escrowAddr}`);

  const peer = await resolve(escrowAddr);

  if (!peer) {
    throw new SphereError(
      `Failed to resolve escrow address: ${escrowAddr}`,
      'SWAP_RESOLVE_FAILED',
    );
  }

  return {
    escrowDirectAddress: peer.directAddress,
    escrowPubkey: peer.transportPubkey ?? peer.chainPubkey,
  };
}

// =============================================================================
// sendAnnounce — Submit manifest to escrow
// =============================================================================

/**
 * Send an `announce` DM to the escrow service with the swap manifest.
 *
 * The escrow deduplicates by swap_id, so this is safe to call multiple
 * times (e.g., on recovery after crash). Wrapped in {@link withRetry}
 * with 5 retries for resilience against transient transport failures.
 *
 * @param communications - CommunicationsModule subset for DM sending
 * @param escrowPubkey - Escrow's transport pubkey (DM recipient)
 * @param manifest - The swap manifest to announce
 */
export async function sendAnnounce(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  manifest: SwapManifest,
): Promise<void> {
  const dm = buildAnnounceDM(manifest);
  await withRetry(
    () => communications.sendDM(escrowPubkey, dm).then(() => undefined),
    5,
    'announce',
  );
}

// =============================================================================
// sendAnnounce_v2 — Submit signed manifest to escrow (protocol v2)
// =============================================================================

/**
 * Send a v2 `announce` DM to the escrow service with the swap manifest,
 * both party signatures, chain pubkeys, and optional nametag binding proofs.
 *
 * In protocol v2 the escrow verifies both signatures before creating the
 * swap record. The escrow deduplicates by swap_id, so this is safe to call
 * multiple times (e.g., on recovery after crash). Wrapped in {@link withRetry}
 * with 5 retries for resilience against transient transport failures.
 *
 * @param communications - CommunicationsModule subset for DM sending
 * @param escrowPubkey - Escrow's transport pubkey (DM recipient)
 * @param manifest - The swap manifest to announce
 * @param signatures - Both party consent signatures
 * @param chainPubkeys - Both party 33-byte compressed chain pubkeys
 * @param auxiliary - Optional nametag binding proofs
 */
export async function sendAnnounce_v2(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  manifest: SwapManifest,
  signatures: ManifestSignatures,
  chainPubkeys: { party_a: string; party_b: string },
  auxiliary?: ManifestAuxiliary,
  signal?: AbortSignal,
): Promise<void> {
  const dm = buildAnnounceDM_v2(manifest, signatures, chainPubkeys, auxiliary);
  await withRetry(
    () => communications.sendDM(escrowPubkey, dm).then(() => undefined),
    5,
    'announce_v2',
    signal,
  );
}

// =============================================================================
// sendStatusQuery — Query escrow for current swap state
// =============================================================================

/**
 * Send a `status` query DM to the escrow service.
 *
 * The escrow responds asynchronously with a `status_result` DM containing
 * the current swap state, deposit coverage, and payout invoice IDs.
 * Wrapped in {@link withRetry} with 3 retries.
 *
 * @param communications - CommunicationsModule subset for DM sending
 * @param escrowPubkey - Escrow's transport pubkey (DM recipient)
 * @param swapId - The swap ID to query (64 lowercase hex chars)
 */
export async function sendStatusQuery(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  swapId: string,
): Promise<void> {
  const dm = buildStatusQueryDM(swapId);
  await withRetry(
    () => communications.sendDM(escrowPubkey, dm).then(() => undefined),
    3,
    'status',
  );
}

// =============================================================================
// sendRequestInvoice — Request delivery of a deposit or payout invoice
// =============================================================================

/**
 * Send a `request_invoice` DM to the escrow service.
 *
 * Used to request (re-)delivery of a deposit or payout invoice token
 * when the original `invoice_delivery` DM was lost due to transport
 * failure or client crash before import. Wrapped in {@link withRetry}
 * with 3 retries.
 *
 * @param communications - CommunicationsModule subset for DM sending
 * @param escrowPubkey - Escrow's transport pubkey (DM recipient)
 * @param swapId - The swap ID (64 lowercase hex chars)
 * @param invoiceType - Whether to request the deposit or payout invoice
 */
export async function sendRequestInvoice(
  communications: SwapModuleDependencies['communications'],
  escrowPubkey: string,
  swapId: string,
  invoiceType: 'deposit' | 'payout',
): Promise<void> {
  const dm = buildRequestInvoiceDM(swapId, invoiceType);
  await withRetry(
    () => communications.sendDM(escrowPubkey, dm).then(() => undefined),
    3,
    'request_invoice',
  );
}

// =============================================================================
// verifyEscrowSender — Authenticate escrow DMs
// =============================================================================

/**
 * Verify that a DM came from the expected escrow service.
 *
 * Performs a constant-time-irrelevant string comparison of the sender's
 * chain pubkey against the expected escrow pubkey. This is a simple
 * identity check, not a cryptographic signature verification (the
 * transport layer handles NIP-04/NIP-17 encryption and authentication).
 *
 * @param senderPubkey - Chain pubkey of the DM sender
 * @param expectedEscrowPubkey - Chain pubkey of the expected escrow
 * @returns `true` if the sender matches the expected escrow
 */
export function verifyEscrowSender(
  senderPubkey: string,
  expectedEscrowPubkey: string,
): boolean {
  return senderPubkey === expectedEscrowPubkey;
}
