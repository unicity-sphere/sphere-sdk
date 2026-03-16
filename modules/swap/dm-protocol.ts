/**
 * Swap DM Protocol — Message builders and parsers
 *
 * Handles the two distinct DM channels used by the SwapModule:
 *
 * 1. **Peer-to-peer (wallet <-> wallet):** Proposal, acceptance, and rejection
 *    messages exchanged between counterparties. These use a string prefix
 *    (`swap_proposal:`, `swap_acceptance:`, `swap_rejection:`) followed by
 *    a JSON payload for easy discrimination from other DM traffic.
 *
 * 2. **Escrow (wallet <-> escrow service):** Structured JSON messages with
 *    a `type` field discriminator. Outbound messages are `announce`, `status`,
 *    and `request_invoice`. Inbound messages are parsed into the
 *    {@link EscrowMessage} discriminated union.
 *
 * All builders produce a `string` suitable for `CommunicationsModule.sendDM()`.
 * The universal parser {@link parseSwapDM} accepts any DM content and returns
 * a typed discriminated union or `null` for unrecognized content.
 *
 * @see docs/SWAP-SPEC.md sections 2.4-2.5 for message type definitions
 * @see docs/SWAP-SPEC.md section 12 for DM processing handlers
 * @see escrow-service/docs/protocol-spec.md for escrow wire format
 *
 * @module
 */

import type {
  SwapManifest,
  SwapProposalMessage,
  SwapAcceptanceMessage,
  SwapRejectionMessage,
  EscrowMessage,
} from './types.js';

// =============================================================================
// Constants — DM prefix markers for peer-to-peer messages
// =============================================================================

/** Prefix for swap proposal DMs (wallet -> wallet). */
export const SWAP_PROPOSAL_PREFIX = 'swap_proposal:';

/** Prefix for swap acceptance DMs (wallet -> wallet). */
export const SWAP_ACCEPTANCE_PREFIX = 'swap_acceptance:';

/** Prefix for swap rejection DMs (wallet -> wallet). */
export const SWAP_REJECTION_PREFIX = 'swap_rejection:';

// =============================================================================
// Known escrow message types (for parsing and detection)
// =============================================================================

/**
 * Set of all escrow-to-wallet message `type` values that the SwapModule
 * recognizes. Used by {@link isSwapDM} for fast detection and by
 * {@link parseEscrowMessage} for validation.
 */
const KNOWN_ESCROW_TYPES: ReadonlySet<string> = new Set([
  'announce_result',
  'invoice_delivery',
  'status_result',
  'payment_confirmation',
  'swap_cancelled',
  'bounce_notification',
  'error',
]);

/**
 * Maximum DM content length (UTF-16 code units) accepted before parsing.
 * Prevents excessive memory allocation on malformed input.
 */
const MAX_DM_LENGTH = 131_072;

// =============================================================================
// Discriminated union for parsed swap DMs
// =============================================================================

/**
 * Result of parsing a swap-related DM. Discriminated on `kind`:
 *
 * - `proposal` — peer-to-peer swap proposal
 * - `acceptance` — peer-to-peer swap acceptance
 * - `rejection` — peer-to-peer swap rejection
 * - `escrow` — any escrow-to-wallet message
 */
export type ParsedSwapDM =
  | { readonly kind: 'proposal'; readonly payload: SwapProposalMessage }
  | { readonly kind: 'acceptance'; readonly payload: SwapAcceptanceMessage }
  | { readonly kind: 'rejection'; readonly payload: SwapRejectionMessage }
  | { readonly kind: 'escrow'; readonly payload: EscrowMessage };

// =============================================================================
// P2P Message Builders (wallet <-> wallet)
// =============================================================================

/**
 * Build a swap proposal DM string.
 *
 * The proposer sends this to the counterparty. It includes the full manifest
 * so the receiver can independently verify the swap_id hash, inspect the
 * deal terms, and decide whether to accept.
 *
 * @param manifest - The swap manifest (addresses already resolved to DIRECT://)
 * @param escrow - Escrow service address (@nametag or DIRECT://)
 * @param message - Optional human-readable description of the deal
 * @returns DM content string with `swap_proposal:` prefix
 */
export function buildProposalDM(
  manifest: SwapManifest,
  escrow: string,
  message?: string,
): string {
  const payload: SwapProposalMessage = {
    type: 'swap_proposal',
    version: 1,
    manifest,
    escrow,
    ...(message !== undefined && message !== '' ? { message } : {}),
  };
  return SWAP_PROPOSAL_PREFIX + JSON.stringify(payload);
}

/**
 * Build a swap acceptance DM string.
 *
 * The acceptor sends this to the proposer after reviewing and agreeing
 * to the deal terms. Upon receiving this, the proposer (or acceptor,
 * depending on the protocol flow) announces the manifest to the escrow.
 *
 * @param swapId - The swap ID (64 lowercase hex chars) being accepted
 * @returns DM content string with `swap_acceptance:` prefix
 */
export function buildAcceptanceDM(swapId: string): string {
  const payload: SwapAcceptanceMessage = {
    type: 'swap_acceptance',
    version: 1,
    swap_id: swapId,
  };
  return SWAP_ACCEPTANCE_PREFIX + JSON.stringify(payload);
}

/**
 * Build a swap rejection DM string.
 *
 * The acceptor sends this to the proposer to decline the deal.
 * The proposer transitions the swap to `cancelled` upon receipt.
 *
 * @param swapId - The swap ID (64 lowercase hex chars) being rejected
 * @param reason - Optional human-readable reason for rejection
 * @returns DM content string with `swap_rejection:` prefix
 */
export function buildRejectionDM(swapId: string, reason?: string): string {
  const payload: SwapRejectionMessage = {
    type: 'swap_rejection',
    version: 1,
    swap_id: swapId,
    ...(reason !== undefined && reason !== '' ? { reason } : {}),
  };
  return SWAP_REJECTION_PREFIX + JSON.stringify(payload);
}

// =============================================================================
// Escrow Outbound Message Builders (wallet -> escrow)
// =============================================================================

/**
 * Build an `announce` DM to submit a swap manifest to the escrow service.
 *
 * Both parties may send this independently. The escrow deduplicates by
 * swap_id and responds with `announce_result`.
 *
 * @param manifest - The swap manifest (wire format with DIRECT:// addresses)
 * @returns JSON string suitable for DM to the escrow
 */
export function buildAnnounceDM(manifest: SwapManifest): string {
  return JSON.stringify({
    type: 'announce',
    manifest,
  });
}

/**
 * Build a `status` query DM for the escrow service.
 *
 * The escrow responds with `status_result` containing the current swap
 * state, deposit coverage, and payout invoice IDs.
 *
 * @param swapId - The swap ID (64 lowercase hex chars) to query
 * @returns JSON string suitable for DM to the escrow
 */
export function buildStatusQueryDM(swapId: string): string {
  return JSON.stringify({
    type: 'status',
    swap_id: swapId,
  });
}

/**
 * Build a `request_invoice` DM for the escrow service.
 *
 * Used to request (re-)delivery of a deposit or payout invoice token.
 * Necessary when the original `invoice_delivery` DM was lost due to
 * transport failure or client crash before import.
 *
 * @param swapId - The swap ID (64 lowercase hex chars)
 * @param invoiceType - Whether to request the deposit or payout invoice
 * @returns JSON string suitable for DM to the escrow
 */
export function buildRequestInvoiceDM(
  swapId: string,
  invoiceType: 'deposit' | 'payout',
): string {
  return JSON.stringify({
    type: 'request_invoice',
    swap_id: swapId,
    invoice_type: invoiceType,
  });
}

// =============================================================================
// Universal Parser
// =============================================================================

/**
 * Parse a DM content string into a typed swap message.
 *
 * Tries peer-to-peer prefixed formats first (cheaper string prefix check),
 * then attempts JSON parse for escrow messages. Returns `null` for any
 * content that is not a recognized swap DM.
 *
 * This function never throws. Malformed JSON, missing fields, or unknown
 * message types all result in `null`.
 *
 * @param content - Raw DM content string
 * @returns Parsed discriminated union, or `null` if not a swap DM
 */
export function parseSwapDM(content: string): ParsedSwapDM | null {
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_DM_LENGTH) {
    return null;
  }

  // --- Try P2P prefixed formats first (most specific, cheapest check) ---

  if (content.startsWith(SWAP_PROPOSAL_PREFIX)) {
    return parseProposal(content.slice(SWAP_PROPOSAL_PREFIX.length));
  }

  if (content.startsWith(SWAP_ACCEPTANCE_PREFIX)) {
    return parseAcceptance(content.slice(SWAP_ACCEPTANCE_PREFIX.length));
  }

  if (content.startsWith(SWAP_REJECTION_PREFIX)) {
    return parseRejection(content.slice(SWAP_REJECTION_PREFIX.length));
  }

  // --- Try escrow JSON format ---

  // Quick guard: escrow messages are always JSON objects
  if (content.charCodeAt(0) !== 0x7B /* '{' */) {
    return null;
  }

  return parseEscrowMessage(content);
}

/**
 * Quick check whether a DM content string is a swap-related message.
 *
 * Performs only prefix checks and a lightweight JSON probe -- does NOT
 * fully parse or validate the message. Use {@link parseSwapDM} for
 * full parsing with type safety.
 *
 * @param content - Raw DM content string
 * @returns `true` if the content appears to be a swap DM
 */
export function isSwapDM(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_DM_LENGTH) {
    return false;
  }

  // P2P prefixed messages
  if (
    content.startsWith(SWAP_PROPOSAL_PREFIX) ||
    content.startsWith(SWAP_ACCEPTANCE_PREFIX) ||
    content.startsWith(SWAP_REJECTION_PREFIX)
  ) {
    return true;
  }

  // Escrow JSON messages: quick probe for `"type":` followed by a known type
  if (content.charCodeAt(0) !== 0x7B /* '{' */) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    return typeof obj.type === 'string' && KNOWN_ESCROW_TYPES.has(obj.type);
  } catch {
    return false;
  }
}

// =============================================================================
// Internal Parsers
// =============================================================================

/**
 * Parse a swap proposal payload (after prefix has been stripped).
 */
function parseProposal(json: string): ParsedSwapDM | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (obj.type !== 'swap_proposal') return null;
  if (typeof obj.version !== 'number') return null;
  if (!isValidManifest(obj.manifest)) return null;
  if (typeof obj.escrow !== 'string' || obj.escrow.length === 0) return null;

  // Optional message field
  if (obj.message !== undefined && typeof obj.message !== 'string') return null;

  const payload: SwapProposalMessage = {
    type: 'swap_proposal',
    version: 1,
    manifest: obj.manifest as SwapManifest,
    escrow: obj.escrow as string,
    ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
  };

  return { kind: 'proposal', payload };
}

/**
 * Parse a swap acceptance payload (after prefix has been stripped).
 */
function parseAcceptance(json: string): ParsedSwapDM | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.type !== 'swap_acceptance') return null;
  if (typeof obj.version !== 'number') return null;
  if (!isValidSwapId(obj.swap_id)) return null;

  const payload: SwapAcceptanceMessage = {
    type: 'swap_acceptance',
    version: 1,
    swap_id: obj.swap_id as string,
  };

  return { kind: 'acceptance', payload };
}

/**
 * Parse a swap rejection payload (after prefix has been stripped).
 */
function parseRejection(json: string): ParsedSwapDM | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.type !== 'swap_rejection') return null;
  if (typeof obj.version !== 'number') return null;
  if (!isValidSwapId(obj.swap_id)) return null;

  // Optional reason field
  if (obj.reason !== undefined && typeof obj.reason !== 'string') return null;

  const payload: SwapRejectionMessage = {
    type: 'swap_rejection',
    version: 1,
    swap_id: obj.swap_id as string,
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
  };

  return { kind: 'rejection', payload };
}

/**
 * Parse an escrow JSON message. Returns `null` for unrecognized types
 * or malformed payloads.
 */
function parseEscrowMessage(json: string): ParsedSwapDM | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const msgType = obj.type;
  if (typeof msgType !== 'string' || !KNOWN_ESCROW_TYPES.has(msgType)) {
    return null;
  }

  // Validate per message type and construct the typed payload
  switch (msgType) {
    case 'announce_result':
      return parseAnnounceResult(obj);
    case 'invoice_delivery':
      return parseInvoiceDelivery(obj);
    case 'status_result':
      return parseStatusResult(obj);
    case 'payment_confirmation':
      return parsePaymentConfirmation(obj);
    case 'swap_cancelled':
      return parseSwapCancelled(obj);
    case 'bounce_notification':
      return parseBounceNotification(obj);
    case 'error':
      return parseEscrowError(obj);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-type escrow message validators
// ---------------------------------------------------------------------------

function parseAnnounceResult(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;
  if (typeof obj.state !== 'string') return null;
  if (typeof obj.deposit_invoice_id !== 'string') return null;
  if (typeof obj.is_new !== 'boolean') return null;

  return {
    kind: 'escrow',
    payload: {
      type: 'announce_result',
      swap_id: obj.swap_id as string,
      state: obj.state as string,
      deposit_invoice_id: obj.deposit_invoice_id as string,
      is_new: obj.is_new as boolean,
      created_at: (obj.created_at ?? 0) as number | string,
    },
  };
}

function parseInvoiceDelivery(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;
  if (obj.invoice_type !== 'deposit' && obj.invoice_type !== 'payout') return null;
  // invoice_token is required but opaque (TxfToken JSON) -- just check presence
  if (obj.invoice_token === undefined || obj.invoice_token === null) return null;

  return {
    kind: 'escrow',
    payload: {
      type: 'invoice_delivery',
      swap_id: obj.swap_id as string,
      invoice_type: obj.invoice_type as 'deposit' | 'payout',
      ...(typeof obj.invoice_id === 'string' ? { invoice_id: obj.invoice_id } : {}),
      invoice_token: obj.invoice_token,
      ...(isObject(obj.payment_instructions) ? { payment_instructions: obj.payment_instructions as EscrowPaymentInstructions } : {}),
    },
  };
}

function parseStatusResult(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;
  if (typeof obj.state !== 'string') return null;

  // Explicitly pick known fields to avoid prototype pollution from spread
  const payload: Record<string, unknown> = {
    type: 'status_result' as const,
    swap_id: obj.swap_id as string,
    state: obj.state as string,
  };
  // Copy only safe, non-prototype fields for extensibility
  for (const key of Object.keys(obj)) {
    if (key !== 'type' && key !== 'swap_id' && key !== 'state') {
      payload[key] = obj[key];
    }
  }

  return {
    kind: 'escrow',
    payload: payload as EscrowMessage,
  };
}

function parsePaymentConfirmation(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;

  // Explicitly pick known fields to avoid prototype pollution from spread
  const payload: Record<string, unknown> = {
    type: 'payment_confirmation' as const,
    swap_id: obj.swap_id as string,
  };
  // Copy party field if present
  if (typeof obj.party === 'string') {
    payload.party = obj.party;
  }
  // Copy only safe, non-prototype fields for extensibility
  for (const key of Object.keys(obj)) {
    if (key !== 'type' && key !== 'swap_id' && key !== 'party') {
      payload[key] = obj[key];
    }
  }

  return {
    kind: 'escrow',
    payload: payload as EscrowMessage,
  };
}

function parseSwapCancelled(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;
  if (typeof obj.reason !== 'string') return null;

  return {
    kind: 'escrow',
    payload: {
      type: 'swap_cancelled',
      swap_id: obj.swap_id as string,
      reason: obj.reason as string,
      ...(typeof obj.deposits_returned === 'boolean' ? { deposits_returned: obj.deposits_returned } : {}),
    },
  };
}

function parseBounceNotification(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (!isValidSwapId(obj.swap_id)) return null;
  if (typeof obj.reason !== 'string') return null;
  if (typeof obj.returned_amount !== 'string') return null;
  if (typeof obj.returned_currency !== 'string') return null;

  return {
    kind: 'escrow',
    payload: {
      type: 'bounce_notification',
      swap_id: obj.swap_id as string,
      reason: obj.reason as string,
      returned_amount: obj.returned_amount as string,
      returned_currency: obj.returned_currency as string,
    },
  };
}

function parseEscrowError(obj: Record<string, unknown>): ParsedSwapDM | null {
  if (typeof obj.error !== 'string') return null;

  return {
    kind: 'escrow',
    payload: {
      type: 'error',
      error: obj.error as string,
      ...(typeof obj.swap_id === 'string' ? { swap_id: obj.swap_id } : {}),
      ...(Array.isArray(obj.details) ? { details: obj.details } : {}),
    },
  };
}

// =============================================================================
// Validation Helpers
// =============================================================================

/** 64 lowercase hex characters (SHA-256 digest). */
const SWAP_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Check whether a value is a valid swap ID (64 lowercase hex chars).
 */
function isValidSwapId(value: unknown): value is string {
  return typeof value === 'string' && SWAP_ID_RE.test(value);
}

/**
 * Shallow structural check for a manifest object. Does NOT verify
 * the swap_id hash (that requires canonicalize + SHA-256 and is
 * handled by manifest.ts). Only ensures the shape is correct for
 * safe transport.
 */
function isValidManifest(value: unknown): value is SwapManifest {
  if (!isObject(value)) return false;
  const m = value as Record<string, unknown>;

  return (
    isValidSwapId(m.swap_id) &&
    typeof m.party_a_address === 'string' && m.party_a_address.length > 0 &&
    typeof m.party_b_address === 'string' && m.party_b_address.length > 0 &&
    typeof m.party_a_currency_to_change === 'string' && m.party_a_currency_to_change.length > 0 &&
    typeof m.party_a_value_to_change === 'string' && m.party_a_value_to_change.length > 0 &&
    typeof m.party_b_currency_to_change === 'string' && m.party_b_currency_to_change.length > 0 &&
    typeof m.party_b_value_to_change === 'string' && m.party_b_value_to_change.length > 0 &&
    typeof m.timeout === 'number' && Number.isInteger(m.timeout)
  );
}

/**
 * Type guard: non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Internal type used only for type-safe payment_instructions narrowing
// ---------------------------------------------------------------------------

type EscrowPaymentInstructions = {
  readonly your_currency: string;
  readonly your_amount: string;
  readonly memo: string;
};
