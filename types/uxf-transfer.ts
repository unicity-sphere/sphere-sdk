/**
 * UXF Inter-Wallet Transfer Wire Format — Types & Runtime Guards (T.1.A)
 *
 * Defines the discriminated union that travels in Nostr `TOKEN_TRANSFER`
 * encrypted event content for the UXF transfer protocol v1.0.
 *
 * Spec references:
 * - §3.1   `UxfTransferPayload` discriminated union
 * - §3.2   `kind: 'uxf-car'`  — small bundles, inline base64 CAR bytes
 * - §3.3   `kind: 'uxf-cid'`  — large bundles, CID-by-reference
 * - §3.3.1 Per-call sender overrides (`DeliveryStrategy`)
 * - §3.4   TXF (legacy) wire shape — 4 structural shapes
 * - §5.6   Replay / duplicate / merge handling (idempotency invariants)
 * - §9.3   Unknown-sender threat model (sender.nametag UNAUTHENTICATED)
 *
 * NOTE: this module is types-only. It does NOT import `MAX_INLINE_CAR_BYTES`,
 * `INLINE_CAR_RELAY_CEILING_BYTES`, or any limit constants — those belong to
 * T.1.D. Consumers (T.1.B.1 / T.1.C / T.1.D / T.3.A) read this barrel for
 * shape definitions and structural guards.
 *
 * Companion module: `types/txf.ts` (the on-disk TXF token shape, distinct
 * from the legacy wire shapes enumerated below — §3.4 is about the wire
 * envelope a peer publishes on Nostr, not about token storage).
 */

// =============================================================================
// 1. Common envelope base — §3.1
// =============================================================================

/**
 * Common fields shared by both `uxf-car` and `uxf-cid` payloads.
 *
 * @remarks
 * - `bundleCid` is the canonical bundle identity (CIDv1, base32, multibase
 *   prefix `b`). It is REQUIRED and authenticates the bundle contents
 *   when the receiver re-derives it from the CAR bytes. See §3.2/§3.3.
 * - `tokenIds` is ADVISORY ONLY — the receiver processes every token-root
 *   element it finds in the CAR pool and filters by ownership. Senders
 *   populate this for UI/audit; receivers MUST NOT use it for security
 *   gating (§5.6).
 * - `memo` is UNAUTHENTICATED — the outer envelope is not covered by
 *   `bundleCid`. Display-only.
 * - `sender.nametag` is UNAUTHENTICATED on the wire. The receiver MUST
 *   re-resolve the nametag against the Nostr signing pubkey via the
 *   identity-binding event before any UI display (§9.3, T.7.B.5).
 */
export interface UxfTransferPayloadBase {
  /** Discriminator — `'uxf-car'` for inline, `'uxf-cid'` for by-reference. */
  readonly kind: 'uxf-car' | 'uxf-cid';
  /** Protocol version of THIS payload schema. Increment on breaking changes. */
  readonly version: '1.0';
  /** Transfer mode used by the sender. ADVISORY — recipient processes per
   *  bundle contents, not per this field. */
  readonly mode: 'conservative' | 'instant';
  /** Bundle CID — CIDv1, base32-encoded (multibase prefix 'b'). REQUIRED. */
  readonly bundleCid: string;
  /** Token IDs the sender claims are in this bundle. ADVISORY ONLY (§5.6).
   *  Lowercase-hex matching the BYTE_FIELDS canonical form for `tokenId`. */
  readonly tokenIds: readonly string[];
  /** Optional sender memo. UNAUTHENTICATED — outer envelope is not covered
   *  by `bundleCid`. */
  readonly memo?: string;
  /** Sender identity. UNAUTHENTICATED on wire — see field-level docs. */
  readonly sender?: {
    /** 64-hex (32-byte secp256k1 x-coordinate, NIP-19 nsec-derived). */
    readonly transportPubkey: string;
    /**
     * Plaintext nametag claim. UNTRUSTED ON WIRE — display ONLY after
     * re-resolving against the Nostr signing pubkey via the
     * identity-binding event. See §9.3 and T.7.B.5.
     */
    readonly nametag?: string;
  };
}

/**
 * `kind: 'uxf-car'` — inline CAR bundle delivered inside the Nostr event.
 *
 * Used when the assembled CAR fits under the configured inline cap
 * (default 16 KiB, hard ceiling 96 KiB — see T.1.D for limit constants).
 * No IPFS round-trip required; recipient base64-decodes and verifies the
 * embedded bytes against `bundleCid`.
 *
 * @see §3.2
 */
export interface UxfTransferPayloadCar extends UxfTransferPayloadBase {
  readonly kind: 'uxf-car';
  /**
   * Base64-encoded CAR bytes. SIZE-CAPPED at the inline ceiling enforced by
   * the sender. The recipient also enforces an upper bound and rejects
   * oversize payloads with `INLINE_CAR_TOO_LARGE`.
   */
  readonly carBase64: string;
}

/**
 * `kind: 'uxf-cid'` — CID-by-reference, used for bundles exceeding the
 * inline cap. Sender pins the CAR to IPFS, sends only the CID over Nostr.
 *
 * The receiver fetches the CAR via the verified-CAR pipeline using its
 * own configured gateway list. `senderGateways` is an INFORMATIONAL hint;
 * a hostile sender could lie, so the verification layer always rehashes
 * the fetched bytes against `bundleCid`.
 *
 * @see §3.3
 */
export interface UxfTransferPayloadCid extends UxfTransferPayloadBase {
  readonly kind: 'uxf-cid';
  /** Optional gateway hint set the sender used (informational only). */
  readonly senderGateways?: readonly string[];
}

// =============================================================================
// 2. Legacy wire shapes — §3.4
// =============================================================================
//
// `'txf'` mode does NOT use `UxfTransferPayload`. The legacy sender emits one
// Nostr `TOKEN_TRANSFER` event per token with one of FOUR existing shapes.
// Recipients accept these indefinitely (per §10). These structural shapes are
// replicated here intentionally — we do not import the SDK legacy modules so
// that this types module stays leaf-level (no upstream cycles). The canonical
// runtime shapes live elsewhere in the codebase:
//
//   - Sphere TXF (single-token):       `serialization/txf-serializer.ts`
//   - V6 COMBINED_TRANSFER:            `types/instant-split.ts`
//   - V5/V4 INSTANT_SPLIT:             `types/instant-split.ts`
//   - SDK legacy `{token, proof}`:     `@unicitylabs/state-transition-sdk`
//
// Detection precedence (used by `isLegacyTokenTransferPayload`):
//   1) V6 `COMBINED_TRANSFER` — `type === 'COMBINED_TRANSFER' && version === '6.0'`
//   2) V5/V4 `INSTANT_SPLIT`  — `type === 'INSTANT_SPLIT'      && version ∈ {'4.0','5.0'}`
//   3) Sphere TXF (single)    — `sourceToken && transferTx`
//   4) SDK legacy             — `token && proof`
// V6 and V5 share the `type` field; the `version` discriminator separates them.
// We check V6 BEFORE V5 because V6 may carry a nested V5 split-bundle in
// `splitBundle` and we never want to misclassify the outer payload as V5.
// Sphere TXF and SDK legacy are mutually exclusive on field names.

/**
 * Legacy Sphere TXF single-token transfer (current pre-UXF default).
 * Shape: `{sourceToken, transferTx, memo?, sender?}` (§3.4).
 */
export interface LegacySphereTxfPayload {
  /** Serialized source token (SDK token JSON or storage shape). */
  readonly sourceToken: unknown;
  /** Serialized transfer transaction. */
  readonly transferTx: unknown;
  readonly memo?: string;
  readonly sender?: {
    readonly transportPubkey?: string;
    readonly nametag?: string;
  };
}

/**
 * Legacy V6 multi-token combined transfer.
 * Shape: `{type: 'COMBINED_TRANSFER', version: '6.0', ...}` (§3.4).
 *
 * @remarks Canonical type lives at `types/instant-split.ts ::
 * CombinedTransferBundleV6`. Replicated structurally here as the legacy
 * detector only requires the discriminator fields, not the full payload.
 */
export interface LegacyCombinedTransferPayload {
  readonly type: 'COMBINED_TRANSFER';
  readonly version: '6.0';
  readonly [k: string]: unknown;
}

/**
 * Legacy V5/V4 instant-split transfer.
 * Shape: `{type: 'INSTANT_SPLIT', version: '4.0' | '5.0', ...}` (§3.4).
 *
 * @remarks Canonical types live at `types/instant-split.ts ::
 * InstantSplitBundleV4 | InstantSplitBundleV5`.
 */
export interface LegacyInstantSplitPayload {
  readonly type: 'INSTANT_SPLIT';
  readonly version: '4.0' | '5.0';
  readonly [k: string]: unknown;
}

/**
 * Legacy SDK-shape transfer.
 * Shape: `{token, proof}` (§3.4).
 */
export interface LegacySdkPayload {
  readonly token: unknown;
  readonly proof: unknown;
  readonly [k: string]: unknown;
}

/**
 * Union of all four legacy wire shapes (§3.4).
 *
 * @remarks Note that legacy payloads do NOT carry a `kind` field on the
 * wire — they are recognized STRUCTURALLY via {@link isLegacyTokenTransferPayload}.
 * The TypeScript-level discrimination of {@link UxfTransferPayload} happens
 * via the presence vs. absence of `kind`.
 */
export type LegacyTokenTransferPayload =
  | LegacySphereTxfPayload
  | LegacyCombinedTransferPayload
  | LegacyInstantSplitPayload
  | LegacySdkPayload;

// =============================================================================
// 3. Top-level union — §3.1
// =============================================================================

/**
 * Top-level wire payload published in Nostr `TOKEN_TRANSFER` events.
 *
 * TypeScript discrimination:
 *  - `kind === 'uxf-car'` → {@link UxfTransferPayloadCar}
 *  - `kind === 'uxf-cid'` → {@link UxfTransferPayloadCid}
 *  - no `kind` field      → {@link LegacyTokenTransferPayload} (one of 4 shapes)
 *
 * Use {@link isUxfTransferPayload} / {@link isLegacyTokenTransferPayload}
 * for runtime narrowing; both are paranoid against null/undefined/primitives.
 */
export type UxfTransferPayload =
  | UxfTransferPayloadCar
  | UxfTransferPayloadCid
  | LegacyTokenTransferPayload;

// =============================================================================
// 4. Per-call delivery strategy — §3.3.1
// =============================================================================

/**
 * Sender-side per-call override controlling inline-vs-CID delivery.
 *
 * - `{kind: 'auto'}` (default) — sender picks `uxf-car` if the CAR fits
 *   under `inlineCapBytes` (default 16 KiB; clamped to the relay-safe
 *   ceiling enforced by T.1.D), else `uxf-cid`.
 * - `{kind: 'force-inline'}` — sender insists on `uxf-car`. If the CAR
 *   exceeds the relay's max event size, the publish fails with
 *   `INLINE_CAR_TOO_LARGE` — the caller chose this branch explicitly.
 * - `{kind: 'force-cid'}` — sender insists on pinning to IPFS even for
 *   tiny bundles (e.g., storage-constrained recipient, audit-by-CID).
 *
 * @see §3.3.1
 */
export type DeliveryStrategy =
  | { readonly kind: 'auto'; readonly inlineCapBytes?: number }
  | { readonly kind: 'force-inline' }
  | { readonly kind: 'force-cid' };

// =============================================================================
// 5. Runtime guards
// =============================================================================

/**
 * @internal helper — true iff `value` is a non-null object (excludes arrays
 * and primitives) safely accessible as `Record<string, unknown>`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow runtime guard for `UxfTransferPayloadCar`. Validates the
 * discriminator, version literal, mode value, required fields, and
 * `carBase64` presence as a string.
 */
export function isUxfTransferPayloadCar(value: unknown): value is UxfTransferPayloadCar {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'uxf-car') return false;
  if (value.version !== '1.0') return false;
  if (value.mode !== 'conservative' && value.mode !== 'instant') return false;
  if (typeof value.bundleCid !== 'string' || value.bundleCid.length === 0) return false;
  if (!Array.isArray(value.tokenIds)) return false;
  // Defense-in-depth: cap advisory tokenIds length to bound per-bundle
  // memory during ingest. Mirrors `MAX_CLAIMED_TOKEN_IDS = 256` in
  // `modules/payments/transfer/limits.ts` (kept literal here to keep
  // `types/uxf-transfer.ts` a leaf module without an inward dep).
  if (value.tokenIds.length > 256) return false;
  // Steelman fix: validate every entry is a non-empty string. Without
  // this, `tokenIds: [null, 42, {}]` passes structural validation and
  // downstream `${tokenId}` coercion produces 'null' / 'undefined' /
  // '[object Object]' that pollute per-token counters and disposition
  // keys.
  for (const t of value.tokenIds) {
    if (typeof t !== 'string' || t.length === 0) return false;
  }
  if (typeof value.carBase64 !== 'string') return false;
  if (value.carBase64.length === 0) return false;
  return true;
}

/**
 * Narrow runtime guard for `UxfTransferPayloadCid`. Same envelope checks
 * as `uxf-car` minus `carBase64`; `senderGateways` is optional and not
 * structurally enforced here.
 */
export function isUxfTransferPayloadCid(value: unknown): value is UxfTransferPayloadCid {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'uxf-cid') return false;
  if (value.version !== '1.0') return false;
  if (value.mode !== 'conservative' && value.mode !== 'instant') return false;
  if (typeof value.bundleCid !== 'string' || value.bundleCid.length === 0) return false;
  if (!Array.isArray(value.tokenIds)) return false;
  // Defense-in-depth tokenIds cap; see `isUxfTransferPayloadCar`.
  if (value.tokenIds.length > 256) return false;
  for (const t of value.tokenIds) {
    if (typeof t !== 'string' || t.length === 0) return false;
  }
  // Steelman fix: forward-compat — a 'uxf-cid' payload must NOT carry
  // an inline `carBase64`. The two shapes are mutually exclusive on the
  // wire. Reject hostile shapes like {kind:'uxf-cid', carBase64:'...'}
  // that would otherwise pass both narrowed guards in succession.
  if ('carBase64' in value) return false;
  return true;
}

/**
 * Runtime guard for the top-level union. Returns `true` for either UXF kind
 * or any of the four legacy shapes. Returns `false` on null, undefined,
 * primitives, arrays, missing/unknown discriminator, missing fields,
 * or wrong version literal.
 *
 * @remarks Paranoid by design — every negative input documented in
 * §5.6 idempotency tests must trip this guard to `false`.
 */
export function isUxfTransferPayload(value: unknown): value is UxfTransferPayload {
  if (!isPlainObject(value)) return false;

  // UXF v1.0 shapes carry an explicit `kind` discriminator.
  if (value.kind === 'uxf-car') return isUxfTransferPayloadCar(value);
  if (value.kind === 'uxf-cid') return isUxfTransferPayloadCid(value);

  // Unknown `kind` value (e.g., `'uxf-future'`, `'invalid'`, number) is a
  // hard reject — silent fall-through to legacy detection would let a
  // malformed UXF v2.x payload masquerade as a legacy shape.
  if (value.kind !== undefined) return false;

  // No `kind` → fall through to structural legacy recognition.
  return isLegacyTokenTransferPayload(value);
}

/**
 * Runtime guard recognizing the four legacy wire shapes from §3.4.
 *
 * Detection precedence (documented at top of file):
 *   1) V6 `COMBINED_TRANSFER` — `type === 'COMBINED_TRANSFER' && version === '6.0'`
 *   2) V5/V4 `INSTANT_SPLIT`  — `type === 'INSTANT_SPLIT'      && version ∈ {'4.0','5.0'}`
 *   3) Sphere TXF (single)    — `sourceToken && transferTx`
 *   4) SDK legacy             — `token && proof`
 *
 * V6 is checked BEFORE V5: a V6 `CombinedTransferBundle` may embed a V5
 * `splitBundle` field internally, but the OUTER discriminator unambiguously
 * picks V6 and the structural recognizer must not overshoot into the inner
 * shape.
 */
export function isLegacyTokenTransferPayload(value: unknown): value is LegacyTokenTransferPayload {
  if (!isPlainObject(value)) return false;

  // Precedence 1 — V6 COMBINED_TRANSFER
  if (value.type === 'COMBINED_TRANSFER' && value.version === '6.0') return true;

  // Precedence 2 — V5/V4 INSTANT_SPLIT
  if (
    value.type === 'INSTANT_SPLIT' &&
    (value.version === '4.0' || value.version === '5.0')
  ) {
    return true;
  }

  // Precedence 3 — Sphere TXF single-token
  if (value.sourceToken !== undefined && value.transferTx !== undefined) return true;

  // Precedence 4 — SDK legacy `{token, proof}`. Guard against partial
  // overlap with Sphere TXF (which doesn't have these fields).
  if (value.token !== undefined && value.proof !== undefined) return true;

  return false;
}
