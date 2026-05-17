/**
 * UXF Inter-Wallet Transfer — SENT ledger type (Issue #97)
 *
 * Profile-resident, IPFS-synced record of successfully-delivered token
 * bundles. Written by the sender after the outbox entry transitions to
 * a terminal-success status (`'delivered'` for conservative mode,
 * `'delivered-instant'` for instant mode). Lives under per-entry-key
 * `${addr}.sent.${id}` in the profile's OrbitDB key-value store.
 *
 * **Why a separate ledger from the outbox?**
 * - The outbox is an OPERATIONAL queue — entries are GC'd after they
 *   reach a terminal status (tombstoned). The SENT ledger is a
 *   PERMANENT record: once a token is delivered we never want to
 *   redeliver it, even after the outbox entry has been wiped.
 * - The crash-recovery sweeper (Issue #97 step 6) uses SENT membership
 *   to distinguish:
 *     - "token has a spending tx AND is in SENT" → no action needed
 *     - "token has a spending tx AND is NOT in OUTBOX or SENT" → crash
 *       happened between step 1 (append spending tx) and step 2
 *       (persist outbox entry); re-queue to OUTBOX.
 * - The duplicate-bundle guard (Issue #97 step 7) checks SENT before
 *   adding a token to a new bundle. Same token MAY be re-sent
 *   intentionally (idempotent unicity proofs) but the guard requires
 *   an explicit acknowledgment to avoid accidental double-spends.
 *
 * **Schema discriminator.** Every entry carries `_schemaVersion:
 * 'uxf-1'` so the legacy PaymentsModule.save() flush path skips them
 * (it filters by absence of `_schemaVersion`).
 *
 * @see UXF-TRANSFER-PROTOCOL §7 (companion to `UxfTransferOutboxEntry`)
 * @see profile/sent-ledger-writer.ts
 */

// =============================================================================
// 1. UxfSentLedgerEntry — §7 companion record
// =============================================================================

/**
 * Bundle-grained SENT ledger entry persisted under `${addr}.sent.${id}`
 * keys by the per-entry-key writer (PROFILE-ARCHITECTURE §10.12 / Wave
 * G.7).
 *
 * Fields mirror a subset of `UxfTransferOutboxEntry` — only the
 * load-bearing identifiers and the delivery method. We do NOT carry the
 * lifecycle status, retry counters, or error fields: SENT is by
 * definition terminal-success.
 */
export interface UxfSentLedgerEntry {
  /**
   * Schema discriminator. Always the literal `'uxf-1'`. Legacy
   * sphere-storage records lack this field — readers MUST check before
   * trusting the shape.
   */
  readonly _schemaVersion: 'uxf-1';

  /**
   * Stable id for this delivery (the outbox transferId at the time of
   * delivery). Primary key under `${addr}.sent.${id}`. Reusing the
   * outbox id makes correlation trivial: a successful send leaves
   * matching `${addr}.outbox.${id}` (tombstoned) and `${addr}.sent.${id}`
   * (live) records.
   */
  readonly id: string;

  /**
   * Tokens shipped in this bundle (genesis token ids). The sweeper uses
   * this list to determine SENT membership: "is tokenX in any SENT
   * entry?" → prefix-scan + scan tokenIds arrays. Empty array permitted
   * only for the txf-legacy migration synthetic case.
   */
  readonly tokenIds: ReadonlyArray<string>;

  /** CAR root CID of the UXF bundle that was delivered. */
  readonly bundleCid: string;

  /** Recipient's resolved transport pubkey (the published-to pubkey). */
  readonly recipientTransportPubkey: string;

  /** Optional recipient identifier (@nametag, DIRECT://..., etc.) for
   *  UI display only — unauthenticated on the wire. */
  readonly recipient?: string;

  /** Optional recipient nametag (without `@`) at send time. */
  readonly recipientNametag?: string;

  /** How the bundle was delivered to the relay. */
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr' | 'txf-legacy';

  /** Transfer mode at the time of delivery. */
  readonly mode: 'conservative' | 'instant' | 'txf';

  /** Wall-clock millisecond timestamp when the SENT entry was recorded
   *  (= the moment after the outbox transitioned to its terminal-success
   *  status). */
  readonly sentAt: number;

  /**
   * Lamport logical clock for CRDT tie-breaking — same rule as
   * `UxfTransferOutboxEntry.lamport`. The SentLedgerWriter bumps via
   * a DISTINCT address-scoped Lamport instance — intentionally NOT
   * shared with the OutboxWriter's Lamport (see
   * `profile/sent-ledger-writer.ts` module docs for the rationale:
   * SENT forms its own CRDT namespace; sharing a clock would over-
   * bump on unrelated outbox writes).
   */
  readonly lamport: number;

  /**
   * Optional Nostr event id returned by the relay's OK ack. Future
   * tooling can re-query the relay to verify the event is still
   * persisted (closing the "relay ack ≠ persistence" gap). Today the
   * field is for forensics only — no read path consumes it yet.
   */
  readonly nostrEventId?: string;

  /**
   * Optional millisecond timestamp marking when the unicity proof was
   * attached for this delivery's commitment(s). Instant mode only;
   * conservative mode awaits proofs BEFORE delivery so this field
   * coincides with `sentAt` and is omitted. Filled by the
   * FinalizationWorkerSender when it observes a proof for a requestId
   * still tracked by an outbox entry that has already moved to SENT.
   */
  readonly proofAttachedAt?: number;
}

// =============================================================================
// 2. Type guards
// =============================================================================

/**
 * Narrow runtime guard for {@link UxfSentLedgerEntry}. Returns true iff
 * `value` has the canonical `_schemaVersion: 'uxf-1'` discriminator AND
 * the load-bearing fields are well-shaped.
 *
 * Used by `SentLedgerWriter.readAll` to filter out tombstones, corrupt
 * values, and legacy non-UXF records that may share the same key
 * prefix during a migration window.
 */
export function isUxfSentLedgerEntry(value: unknown): value is UxfSentLedgerEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v._schemaVersion !== 'uxf-1') return false;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (!Array.isArray(v.tokenIds)) return false;
  for (const t of v.tokenIds) {
    if (typeof t !== 'string') return false;
  }
  if (typeof v.bundleCid !== 'string') return false;
  if (typeof v.recipientTransportPubkey !== 'string') return false;
  if (
    v.deliveryMethod !== 'car-over-nostr' &&
    v.deliveryMethod !== 'cid-over-nostr' &&
    v.deliveryMethod !== 'txf-legacy'
  ) {
    return false;
  }
  if (v.mode !== 'conservative' && v.mode !== 'instant' && v.mode !== 'txf') {
    return false;
  }
  // Issue #166 P4 #2 — range tightening. Both `sentAt` (epoch ms) and
  // `lamport` (logical clock) are non-negative integers by construction.
  // Reject negatives and non-integers (0.5) so corrupted ledger blobs
  // are filtered at the schema gate rather than poisoning downstream
  // comparisons (e.g. `existing.lamport >= e.lamport` in the
  // installOutboxWriter hydration coalesce).
  if (!Number.isInteger(v.sentAt) || (v.sentAt as number) < 0) return false;
  if (!Number.isInteger(v.lamport) || (v.lamport as number) < 0) return false;
  // Issue #166 P2 #3 — when nostrEventId is present (optional field),
  // require a non-empty string. Empty string is invalid because the
  // verifier worker uses it as a query key; an empty key would query
  // every event on the relay. Same shape rule as the OUTBOX guard.
  if (v.nostrEventId !== undefined) {
    if (typeof v.nostrEventId !== 'string' || (v.nostrEventId as string).length === 0) {
      return false;
    }
  }
  return true;
}
