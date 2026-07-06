/**
 * UXF Transfer — `DeliveryStrategy` resolver (T.2.C).
 *
 * Given a `(DeliveryStrategy, carBytes)` pair, this module computes the
 * concrete delivery decision the sender will use:
 *
 *  - `{ kind: 'inline', carBase64 }` — bundle ships inside the Nostr event.
 *  - `{ kind: 'cid',    cid, shouldPin }` — bundle is pinned to IPFS, the
 *    sender publishes only the CID by reference.
 *
 * The resolver is a **pure decision function**. It does NOT publish events,
 * does NOT speak to IPFS directly, and does NOT touch the outbox. The
 * sender orchestrator (T.2.D.1) wires the actual pin call through the
 * injected `publishToIpfs` callback so this module can be unit-tested
 * without an IPFS dependency.
 *
 * Spec references:
 *  - §3.3.1 Per-call sender overrides (`DeliveryStrategy`), inline-cap
 *           clamp behavior, and the deterministic INVALID/clamp choice
 *           (W12).
 *  - §3.3.2 Delivery-completion semantics — informs `shouldPin`'s meaning
 *           (always `true` for CID branches because the CID-by-reference
 *           form requires the bundle to be retrievable to satisfy the
 *           sender-side delivered-state precondition).
 *  - §12.2  NIP-11 dynamic relay-cap discovery (deferred — see TODO below).
 *
 * Boundary with downstream pieces:
 *  - The actual IPFS publish lives behind `publishToIpfs` (injected). On
 *    rejection, the resolver propagates the rejection — auto-fallback
 *    from CID to inline is **NOT** the resolver's job; it belongs to the
 *    sender orchestrator's retry/relay-policy layer (T.2.D.1).
 *  - The base64-encoded CAR string is produced via `carBytesToBase64`
 *    from `uxf/transfer-payload.ts` (T.1.D) so this module does not
 *    duplicate the encoding rules.
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors.js';
import type { DeliveryStrategy } from '../../../types/uxf-transfer.js';
import { carBytesToBase64 } from '../bundle/transfer-payload.js';

import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  MAX_INLINE_CAR_BYTES,
  RELAY_SAFE_CAP_BYTES,
  clampInlineCap,
  type ClampInlineCapResult,
} from './limits.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Telemetry record emitted by the resolver when it silently clamps a
 * caller-supplied `inlineCapBytes` override.
 *
 * The payload is intentionally narrow: callers wire this to whatever
 * structured logging or metric the host application prefers. The resolver
 * itself stays side-effect-free except for invoking the optional callback.
 *
 * @remarks
 * Telemetry is emitted ONLY for the oversized-cap clamp path
 * (`reason: 'above-relay-cap'`). Undersized caps are REJECTED with
 * `INVALID_INLINE_CAP` and never reach the telemetry path.
 */
export interface ClampTelemetry {
  /** Tag distinguishing this from future telemetry shapes. */
  readonly type: 'inline-cap-clamped';
  /** Structured detail of the clamp decision. */
  readonly clampInfo: ClampInfo;
}

/**
 * Diagnostic detail attached to inline decisions whose effective cap was
 * derived from a clamp. Mirrors the {@link ClampInlineCapResult} shape
 * from `limits.ts` but simplified for resolver consumers.
 */
export interface ClampInfo {
  /** The caller-supplied `inlineCapBytes` value (BEFORE clamp). */
  readonly originalCap: number;
  /** The cap actually used to make the inline-vs-CID decision. */
  readonly effectiveCap: number;
  /**
   * Why the resolver settled on this cap.
   *
   *  - `'ok'`              — caller's value was in range; no clamp.
   *  - `'above-relay-cap'` — caller's value exceeded `RELAY_SAFE_CAP_BYTES`;
   *                          silently clamped down (telemetry emitted).
   *  - `'default'`         — caller passed `auto` without `inlineCapBytes`;
   *                          we used `MAX_INLINE_CAR_BYTES` (16 KiB).
   */
  readonly reason: 'ok' | 'above-relay-cap' | 'default';
}

/**
 * Discriminated union of the resolver's possible outputs.
 *
 *  - `kind: 'inline'` — the sender will populate `carBase64` on the
 *    `uxf-car` payload and ship the bundle inline. When `shouldPin` is
 *    `true`, the orchestrator SHOULD additionally fire a fire-and-forget
 *    `publishToIpfs(carBytes)` so the same content-addressed CAR ends up
 *    pinned on the local IPFS node. The wire delivery mode stays inline
 *    — the pin is in addition, not a replacement (OUTBOX-SEND-FOLLOWUPS
 *    Item #6.a).
 *  - `kind: 'cid'`    — the sender will publish a `uxf-cid` payload
 *    referencing the returned CID; `shouldPin` is informational (always
 *    `true` in v1.0 — see field-level docs).
 */
export type DeliveryDecision =
  | {
      readonly kind: 'inline';
      /** Base64-encoded CAR bytes ready to drop on a `uxf-car` payload. */
      readonly carBase64: string;
      /**
       * Whether the orchestrator SHOULD additionally pin the inline CAR
       * to local IPFS (best-effort, fire-and-forget). Set to `true` when
       * a `publishToIpfs` callback was wired on the resolver call;
       * omitted (or `false`) when no publisher was supplied, so the
       * caller knows the inline payload is the ONLY copy.
       *
       * Rationale (OUTBOX-SEND-FOLLOWUPS Item #6.a): the inline path
       * historically left the sender with no local IPFS pin, so Item
       * #2's retention re-publish closure was forced to throw on
       * `'car-over-nostr'` re-publishes. With `shouldPin: true`, the
       * sender's local IPFS node has the CAR bytes available; the
       * re-publish closure can downgrade to CID-shape re-publish (Item
       * #2 final closure) regardless of the original wire mode.
       *
       * **Best-effort contract.** Failure of the pin call MUST NOT
       * abort the send — the wire delivery is already an inline
       * `uxf-car`, so the recipient is not blocked on the pin. The
       * orchestrator logs a warning on failure and proceeds.
       */
      readonly shouldPin?: boolean;
      /**
       * Present iff the inline decision was reached via `auto` mode.
       * `force-inline` decisions carry NO clampInfo because `force-inline`
       * never clamps (it either fits under the hard ceiling or throws).
       */
      readonly clampInfo?: ClampInfo;
    }
  | {
      readonly kind: 'cid';
      /** CIDv1 base32 string returned by `publishToIpfs`. */
      readonly cid: string;
      /**
       * Whether the sender SHOULD ensure the CAR is pinned. Always `true`
       * in v1.0: the CID-by-reference branch assumes the bundle is
       * retrievable for the delivered-state semantics in §3.3.2. Reserved
       * as a field for forward compatibility — a future "ephemeral CID"
       * branch could carry `false`.
       */
      readonly shouldPin: boolean;
    };

/**
 * Outcome of a successful `publishToIpfs` callback.
 *
 * The minimum surface the resolver needs is the CID; richer return shapes
 * (gateway list, pin status, ...) belong to the orchestrator. We keep this
 * an object literal (rather than a bare `string`) so callers can extend
 * the contract without breaking the resolver's signature.
 */
export interface PublishToIpfsResult {
  /** CIDv1 base32 string identifying the published CAR. */
  readonly cid: string;
}

/**
 * Caller-supplied IPFS publisher. Receives the raw CAR bytes; resolves with
 * the CID once the bytes are pinned and retrievable.
 *
 * **Failure semantics**: any rejection propagates verbatim to the caller of
 * {@link resolveDelivery}. The resolver does NOT auto-fallback to inline on
 * IPFS failure — that fallback policy belongs to the sender orchestrator
 * (T.2.D.1), which has the relay context to decide whether retry is
 * appropriate.
 *
 * **CID-correspondence contract (issue #200, Phase 1).** The returned
 * `cid` MUST equal `extractCarRootCid(carBytes)` (the dag-cbor CID of
 * the CAR's single root block). The wire `payload.bundleCid` on
 * `uxf-cid` envelopes uses `extractCarRootCid(carBytes)`, and the
 * recipient fetches that CID against the gateway. A publisher whose
 * returned CID differs from `extractCarRootCid(carBytes)` is buggy:
 *  - In the obvious failure mode the publisher pinned the bytes under
 *    a different CID (e.g. a raw CID via `pinToIpfs(carBytes)`), and
 *    the recipient's gateway fetch for `bundleCid` 404s indefinitely.
 *  - In the subtle failure mode the publisher pinned the right blocks
 *    but lied about the CID — the recipient succeeds anyway but the
 *    publisher's contract is broken.
 *
 * Use {@link createUxfCarPublisher} (from `./ipfs-publisher`) to obtain
 * the canonical, contract-compliant publisher. Rolling your own with
 * `pinToIpfs(carBytes)` is the documented footgun — do not do that.
 */
export type PublishToIpfsCallback = (
  carBytes: Uint8Array,
) => Promise<PublishToIpfsResult>;

/**
 * Caller-supplied telemetry sink. Invoked at most once per call to
 * {@link resolveDelivery}, only for the silent-clamp path. Synchronous —
 * the resolver does NOT await the callback. Errors thrown by the callback
 * propagate to the caller.
 */
export type EmitTelemetryCallback = (event: ClampTelemetry) => void;

/**
 * Inputs to {@link resolveDelivery}.
 */
export interface ResolveDeliveryOptions {
  /** The sender's per-call override (or default `{kind: 'auto'}`). */
  readonly strategy: DeliveryStrategy;
  /** The assembled CAR bytes whose delivery is being decided. */
  readonly carBytes: Uint8Array;
  /**
   * IPFS publisher; called on every CID-bound branch.
   *
   * **Optional** — when absent the resolver applies a CAR-inline fallback
   * for `auto` and `force-cid` CID branches:
   *  - `carBytes.byteLength <= RELAY_SAFE_CAP_BYTES` → falls back to
   *    `uxf-car` inline delivery so callers without an IPFS provider still
   *    work for reasonably-sized bundles (approach γ).
   *  - `carBytes.byteLength > RELAY_SAFE_CAP_BYTES` → throws
   *    `IPFS_PUBLISHER_REQUIRED` — the bundle is too large for inline
   *    Nostr delivery and an IPFS provider must be configured.
   *
   * Note: the `force-inline` branch ignores this field entirely (it
   * never calls the publisher).
   */
  readonly publishToIpfs?: PublishToIpfsCallback;
  /** Optional telemetry sink (silent-clamp emissions only). */
  readonly emitTelemetry?: EmitTelemetryCallback;
}

// =============================================================================
// 2. Public API — resolveDelivery
// =============================================================================

/**
 * Resolve a {@link DeliveryStrategy} against a CAR's actual byte length and
 * produce the concrete delivery decision.
 *
 * **Determinism contract** (§3.3.1, W12):
 *  - `auto`  + `inlineCapBytes < 1` (incl. NaN, ±Infinity, 0, negative)
 *    → throws `INVALID_INLINE_CAP`. Rejection is the deterministic choice
 *    per the spec's "MAY reject" paragraph.
 *  - `auto`  + `inlineCapBytes > RELAY_SAFE_CAP_BYTES` → silent clamp to
 *    `RELAY_SAFE_CAP_BYTES`; telemetry emitted with `reason:
 *    'above-relay-cap'`. Auto mode never publishes inline above the
 *    relay-safe ceiling.
 *  - `auto`  + `inlineCapBytes` in `[1, RELAY_SAFE_CAP_BYTES]` → used
 *    verbatim, no clamp, no telemetry.
 *  - `auto`  + no `inlineCapBytes` → uses `MAX_INLINE_CAR_BYTES` (16 KiB).
 *  - `force-inline` + `carBytes.length > RELAY_SAFE_CAP_BYTES` → throws
 *    `INLINE_CAR_TOO_LARGE`. The caller chose `force-inline` explicitly
 *    and must handle the relay-rejection branch.
 *  - `force-inline` + `carBytes.length <= RELAY_SAFE_CAP_BYTES` → inline
 *    decision regardless of `MAX_INLINE_CAR_BYTES`. (The 16 KiB default
 *    governs `auto`, not `force-inline`.)
 *  - `force-cid` + any size → CID decision, `shouldPin: true`. The IPFS
 *    publish runs even for tiny bundles by the caller's explicit choice
 *    (audit-by-CID, storage-constrained recipient, ...).
 *
 * **Side effects**: invokes `publishToIpfs` on every CID branch (which
 * MAY perform I/O). Invokes `emitTelemetry` at most once per call, and
 * only for the silent-clamp path. Throws synchronously for invalid caps;
 * throws asynchronously (via Promise rejection) for `INLINE_CAR_TOO_LARGE`,
 * `IPFS_PUBLISHER_REQUIRED`, and any error propagated from `publishToIpfs`.
 *
 * **CAR-inline fallback** (approach γ): when `publishToIpfs` is absent and
 * a CID branch would be selected, the resolver falls back to `uxf-car`
 * (inline delivery) if `carBytes.byteLength <= RELAY_SAFE_CAP_BYTES`.
 * This lets callers without an IPFS provider still send reasonably-sized
 * bundles. Bundles exceeding `RELAY_SAFE_CAP_BYTES` without a publisher
 * throw `IPFS_PUBLISHER_REQUIRED`.
 *
 * @throws {SphereError} `INVALID_INLINE_CAP` — auto mode with cap < 1 or
 *         non-finite (NaN, ±Infinity).
 * @throws {SphereError} `INLINE_CAR_TOO_LARGE` — force-inline mode with
 *         `carBytes.length > RELAY_SAFE_CAP_BYTES`.
 * @throws {SphereError} `FORCE_CID_NO_PUBLISHER` — `force-cid` strategy
 *         selected but `publishToIpfs` is absent. Steelman Wave 3:
 *         `force-cid` carries an explicit privacy intent and MUST NOT
 *         be silently downgraded to inline delivery. The caller must
 *         either wire a publisher or switch strategy.
 * @throws {SphereError} `IPFS_PUBLISHER_REQUIRED` — auto mode CID branch
 *         selected but `publishToIpfs` is absent AND
 *         `carBytes.byteLength > RELAY_SAFE_CAP_BYTES`. (force-cid no
 *         longer routes here — it raises `FORCE_CID_NO_PUBLISHER`
 *         regardless of size.)
 *
 * @see DeliveryStrategy in `types/uxf-transfer.ts`
 * @see clampInlineCap in `modules/payments/transfer/limits.ts`
 */
export async function resolveDelivery(
  options: ResolveDeliveryOptions,
): Promise<DeliveryDecision> {
  const { strategy, carBytes, publishToIpfs, emitTelemetry } = options;

  switch (strategy.kind) {
    case 'force-cid': {
      // Always pin, regardless of size. Caller's explicit choice — e.g.,
      // audit-by-CID or storage-constrained recipient (§3.3.1).
      //
      // **Steelman fix (Wave 3) — privacy regression hardening.** Earlier
      // revisions silently downgraded `force-cid` to inline delivery via
      // `carInlineFallback` when no `publishToIpfs` was wired AND the
      // CAR fit within `RELAY_SAFE_CAP_BYTES`. That defeated the entire
      // point of `force-cid`: the caller chose CID precisely BECAUSE
      // they did NOT want the bundle inlined on the relay (privacy
      // intent — the relay would otherwise see the bundle bytes).
      //
      // We now treat "force-cid + no publisher" as a HARD ERROR
      // (`FORCE_CID_NO_PUBLISHER`) rather than a silent downgrade. The
      // caller must either wire an IPFS publisher or, if the inline
      // leak is acceptable, switch to `auto` / `force-inline` so the
      // intent is explicit at the call site.
      if (publishToIpfs === undefined) {
        throw new SphereError(
          `resolveDelivery: force-cid strategy explicitly requires a` +
            ` publishToIpfs callback. The resolver REFUSES to silently` +
            ` downgrade to inline delivery because force-cid signals a` +
            ` privacy intent (the caller does NOT want the bundle inlined` +
            ` on the relay). Wire an IPFS publisher or switch to` +
            ` 'auto' / 'force-inline' if inline delivery is acceptable.`,
          'FORCE_CID_NO_PUBLISHER',
        );
      }
      const { cid } = await publishToIpfs(carBytes);
      return { kind: 'cid', cid, shouldPin: true };
    }

    case 'force-inline': {
      // Hard ceiling check — `force-inline` does NOT consult `MAX_INLINE_CAR_BYTES`
      // (the 16 KiB default governs `auto`, not the explicit force path).
      // The relevant cap is the relay-safe ceiling; above that we throw.
      if (carBytes.byteLength > RELAY_SAFE_CAP_BYTES) {
        throw new SphereError(
          `resolveDelivery: force-inline rejected — CAR is ${carBytes.byteLength} bytes, exceeds relay-safe ceiling of ${RELAY_SAFE_CAP_BYTES} bytes`,
          'INLINE_CAR_TOO_LARGE',
        );
      }
      // OUTBOX-SEND-FOLLOWUPS Item #6.a — flag the inline decision for
      // an orchestrator-side fire-and-forget pin when a publisher is
      // wired. The wire delivery stays inline (`uxf-car`); the pin is
      // additional best-effort durability so Item #2's retention
      // re-publish can fall back to CID-shape later.
      return inlineDecision(carBytes, publishToIpfs !== undefined);
    }

    case 'auto': {
      // 1. Validate caller-supplied cap (deterministic reject for < 1).
      //    We must check this BEFORE delegating to `clampInlineCap`,
      //    which would silently coerce `<= 0` to 1 ("below-min" reason).
      //    The resolver chooses REJECT for that branch (W12).
      const { inlineCapBytes } = strategy;
      const clampInfo = resolveAutoCap(inlineCapBytes, emitTelemetry);

      // 2. Decide inline vs CID against the effective cap.
      if (carBytes.byteLength <= clampInfo.effectiveCap) {
        // OUTBOX-SEND-FOLLOWUPS Item #6.a — flag for the orchestrator
        // fire-and-forget pin path (only when a publisher is wired).
        return {
          ...inlineDecision(carBytes, publishToIpfs !== undefined),
          clampInfo,
        };
      }

      // Bundle exceeds the (possibly-clamped) inline cap.
      //
      // **Issue #393 — automated CID delivery DISABLED.** When the kill-
      // switch {@link AUTOMATED_CID_DELIVERY_ENABLED} is `false` (the
      // current default; see `limits.ts` for the rationale), `auto`
      // mode is NOT allowed to promote oversized bundles to CID
      // delivery. Instead we treat the over-cap branch as
      // "inline-up-to-RELAY_SAFE_CAP_BYTES, throw beyond that," and we
      // direct the caller to {kind: 'force-cid'} for explicit opt-in.
      // The two branches below (publisher present vs absent + the
      // CAR-inline fallback) are KEPT IN PLACE behind the flag so the
      // re-enable is a single constant flip — no logic restoration
      // needed when the time comes.
      if (!AUTOMATED_CID_DELIVERY_ENABLED) {
        // Bundle fits within the relay-safe ceiling → silently inline,
        // ignoring `inlineCapBytes` for the CID-promotion decision
        // (the cap remains a soft hint for telemetry / future use).
        if (carBytes.byteLength <= RELAY_SAFE_CAP_BYTES) {
          return {
            ...inlineDecision(carBytes, publishToIpfs !== undefined),
            clampInfo,
          };
        }
        // Beyond the relay-safe ceiling: no automatic escape hatch.
        // Operator MUST pick `force-cid` (with publisher wired) to
        // ship bundles this large.
        throw new SphereError(
          `resolveDelivery: bundle is ${carBytes.byteLength} bytes, exceeds the ` +
            `relay-safe inline ceiling of ${RELAY_SAFE_CAP_BYTES} bytes, AND ` +
            `automated CID delivery is currently disabled (see ` +
            `AUTOMATED_CID_DELIVERY_ENABLED in modules/payments/transfer/limits.ts). ` +
            `Either reduce the source set so the bundle fits inline, or pass ` +
            `\`delivery: { kind: 'force-cid' }\` with an IPFS publisher wired ` +
            `via createNodeProviders/createBrowserProviders.`,
          'INLINE_CAR_TOO_LARGE',
        );
      }

      // ---- Code below this point only runs when the kill-switch is ON ----
      //
      // Bundle exceeds the (possibly-clamped) inline cap → CID branch.
      //
      // No-publisher fallback (approach γ): if no IPFS publisher is wired,
      // fall back to inline when the bundle fits within the relay-safe
      // ceiling. Throw IPFS_PUBLISHER_REQUIRED if too large. (Note:
      // `force-cid` does NOT reach this fallback per the steelman Wave 3
      // privacy fix — see the `force-cid` case above.)
      if (publishToIpfs === undefined) {
        return carInlineFallback(carBytes);
      }
      const { cid } = await publishToIpfs(carBytes);
      return { kind: 'cid', cid, shouldPin: true };
    }

    default: {
      // Exhaustiveness sentinel. If a future revision adds a new
      // discriminator (e.g., `kind: 'auto-with-fallback'`) without
      // updating this switch, the compiler errors here. This guard
      // prevents the runtime from silently dropping into the catch-all
      // (which would surface as a Promise<undefined> resolving to a
      // shape consumers can't handle).
      const _exhaustive: never = strategy;
      throw new SphereError(
        // istanbul ignore next — unreachable under TS strict; defense in depth.
        `resolveDelivery: unknown DeliveryStrategy kind: ${JSON.stringify(_exhaustive)}`,
        'INVALID_CONFIG',
      );
    }
  }
}

// =============================================================================
// 3. Internal helpers
// =============================================================================

/**
 * CAR-inline fallback for the `auto`-over-cap CID branch without a
 * publisher (approach γ).
 *
 * When `auto` mode would route a bundle through CID delivery (because it
 * exceeds the inline cap) but no `publishToIpfs` callback is wired, this
 * helper falls back to inline (`uxf-car`) delivery:
 *
 *  - `carBytes.byteLength <= RELAY_SAFE_CAP_BYTES` → returns an inline
 *    decision so the sender can still deliver without IPFS. `auto` mode
 *    expresses no privacy preference, so the relay-leak is acceptable.
 *  - `carBytes.byteLength > RELAY_SAFE_CAP_BYTES` → throws
 *    `IPFS_PUBLISHER_REQUIRED` (the bundle is too large for inline Nostr
 *    delivery; the caller must configure an IPFS publisher).
 *
 * **Steelman fix (Wave 3).** The `force-cid` branch no longer routes
 * through this helper — see the `force-cid` case in `resolveDelivery`,
 * which raises `FORCE_CID_NO_PUBLISHER` directly. `force-cid` signals an
 * explicit privacy intent that MUST NOT be silently downgraded.
 *
 * @internal
 */
function carInlineFallback(carBytes: Uint8Array): DeliveryDecision {
  if (carBytes.byteLength <= RELAY_SAFE_CAP_BYTES) {
    // Bundle fits within the relay-safe ceiling → inline fallback.
    //
    // **Load-bearing invariant**: this function is reachable ONLY from
    // the `auto`-CID branch in `resolveDelivery` when
    // `publishToIpfs === undefined` (see the guard at the call site).
    // The literal `false` argument below pins that invariant — if a
    // future refactor makes this function reachable WITH a publisher
    // wired, `shouldPin` would remain `undefined` and the orchestrator's
    // Item #6.a pin path would silently skip (no crash, but no pin
    // either). Any such refactor MUST either:
    //   (a) update this call to forward the publisher's presence
    //       (`inlineDecision(carBytes, publisherWired)`), OR
    //   (b) document why the no-pin behavior is correct for the new
    //       reachable path.
    return inlineDecision(carBytes, false);
  }
  throw new SphereError(
    `resolveDelivery: auto strategy selected CID delivery but no publishToIpfs` +
      ` callback was supplied and the CAR (${carBytes.byteLength} bytes) exceeds the` +
      ` relay-safe inline ceiling of ${RELAY_SAFE_CAP_BYTES} bytes.` +
      ' Configure an IPFS provider to send large bundles.',
    'IPFS_PUBLISHER_REQUIRED',
  );
}

/**
 * Build an `'inline'` {@link DeliveryDecision} with the
 * OUTBOX-SEND-FOLLOWUPS Item #6.a pin signal applied.
 *
 * When `publisherWired` is `true`, `shouldPin: true` is set so the
 * orchestrator can fire-and-forget a `publishToIpfs(carBytes)` call
 * after the inline send is on the wire. When `false`, the field is
 * omitted — the inline payload is the only copy of the CAR bytes.
 *
 * Pure: produces no I/O. The resolver remains a decision function;
 * the actual pin call lives in the orchestrator's pipeline.
 *
 * @internal
 */
function inlineDecision(
  carBytes: Uint8Array,
  publisherWired: boolean,
): { kind: 'inline'; carBase64: string; shouldPin?: boolean } {
  const base = { kind: 'inline' as const, carBase64: carBytesToBase64(carBytes) };
  return publisherWired ? { ...base, shouldPin: true } : base;
}

/**
 * Validate and normalize the caller-supplied `inlineCapBytes` for `auto`
 * mode.
 *
 * Three branches:
 *  1. `inlineCapBytes === undefined` → use `MAX_INLINE_CAR_BYTES` default;
 *     `reason: 'default'`. No telemetry — using the default is not a clamp.
 *  2. `inlineCapBytes < 1` (incl. NaN, ±Infinity, 0, negative) → THROW
 *     `INVALID_INLINE_CAP`. This is the deterministic-reject branch (W12).
 *     We do NOT delegate to `clampInlineCap` here because that helper
 *     SILENTLY coerces undersized values to 1 ("below-min" reason), which
 *     would conflict with the spec's deterministic-reject choice.
 *  3. `inlineCapBytes >= 1` → delegate to `clampInlineCap`, which clamps
 *     downward at `RELAY_SAFE_CAP_BYTES`. Emit telemetry iff the clamp
 *     fired (`reason: 'above-relay-cap'`).
 *
 * @internal
 */
function resolveAutoCap(
  inlineCapBytes: number | undefined,
  emitTelemetry: EmitTelemetryCallback | undefined,
): ClampInfo {
  if (inlineCapBytes === undefined) {
    // Issue #394 — default cap is RELAY_SAFE_CAP_BYTES (96 KiB, the Nostr
    // relay event-size ceiling). Previously the default was
    // MAX_INLINE_CAR_BYTES (16 KiB), which promoted bundles to CID
    // delivery at a quarter of the actual relay budget — over-eager and
    // costly when the bundle would have fit inline fine. The new default
    // makes auto-promotion trip NEAR the relay cap, so CID delivery is
    // reserved for bundles that genuinely cannot ship inline (typically
    // multi-hop chains with chained-transfer histories).
    //
    // MAX_INLINE_CAR_BYTES (16 KiB) is preserved as a documented soft
    // hint for callers that explicitly want a smaller cap — pass it via
    // `inlineCapBytes` and it'll be honored.
    return {
      originalCap: RELAY_SAFE_CAP_BYTES,
      effectiveCap: RELAY_SAFE_CAP_BYTES,
      reason: 'default',
    };
  }

  // Deterministic reject: undersized OR non-finite values.
  // `Number.isFinite(NaN) === false`, so this catches NaN as well as
  // ±Infinity. Strict `< 1` matches the spec's "cap < 1" wording.
  if (!Number.isFinite(inlineCapBytes) || inlineCapBytes < 1) {
    throw new SphereError(
      `resolveDelivery: inlineCapBytes must be a finite number >= 1 (got ${String(inlineCapBytes)})`,
      'INVALID_INLINE_CAP',
    );
  }

  // Delegate to the canonical clamper for the upper-bound branch. After
  // the deterministic-reject above, only values in `[1, +Infinity)` reach
  // here — `clampInlineCap` returns either `'ok'` or `'above-relay-cap'`.
  // It cannot return `'below-min'` from this call site (we already
  // rejected). We assert this invariant for defense in depth.
  const clamp: ClampInlineCapResult = clampInlineCap(inlineCapBytes);

  // istanbul ignore if — unreachable: the < 1 reject above guarantees
  // `clamp.reason` is `'ok'` or `'above-relay-cap'`. We retain the check
  // as a defensive backstop in case the validation logic upstream
  // is ever loosened.
  if (clamp.reason === 'below-min') {
    throw new SphereError(
      `resolveDelivery: clamp returned below-min for input ${String(inlineCapBytes)} (programmer error)`,
      'INVALID_INLINE_CAP',
    );
  }

  // Emit telemetry only on the silent-clamp path. Telemetry sinks are
  // OPTIONAL — operators that don't care can skip the field entirely.
  if (clamp.reason === 'above-relay-cap' && emitTelemetry !== undefined) {
    emitTelemetry({
      type: 'inline-cap-clamped',
      clampInfo: {
        originalCap: inlineCapBytes,
        effectiveCap: clamp.value,
        reason: 'above-relay-cap',
      },
    });
  }

  return {
    originalCap: inlineCapBytes,
    effectiveCap: clamp.value,
    reason: clamp.reason === 'ok' ? 'ok' : 'above-relay-cap',
  };
}

// =============================================================================
// 4. Future-extension marker
// =============================================================================

// TODO(T.future-NIP11): NIP-11 dynamic relay-cap discovery
//
// The `RELAY_SAFE_CAP_BYTES` ceiling is currently a fixed conservative 96 KiB
// chosen as the typical maximum across deployed Nostr relays (§3.3.1, §12.2).
// A future revision can probe the publishing relay's NIP-11
// `limitations.max_message_length` (or equivalent) and dynamically size the
// effective ceiling per-relay, with this resolver taking the per-call relay
// hint as an additional input.
//
// Extension point: the callable signature already passes a `ResolveDeliveryOptions`
// object. The future addition would extend the options shape with
// `relayMaxBytes?: number` (informational; sender preselects the publishing
// relay). The clamp logic would consume `Math.min(relayMaxBytes ??
// RELAY_SAFE_CAP_BYTES, RELAY_SAFE_CAP_BYTES)` as the effective ceiling.
// `INLINE_CAR_TOO_LARGE` semantics for `force-inline` would then become
// per-relay rather than per-protocol — but the error code stays the same.
//
// Until NIP-11 lands, the constant ceiling MUST be used (spec normative).
