/**
 * Nametag re-resolver — UXF Inter-Wallet Transfer recipient (T.7.B.5 / C9).
 *
 * **Threat model.** `payload.sender.nametag` arrives on the wire as a
 * plaintext, attacker-controllable field of the outer envelope (§3.1).
 * The Nostr event's signing pubkey is verified by the relay and is the
 * only authenticated piece of sender identity at the wire layer; the
 * `sender.nametag` claim is NOT covered by `bundleCid` and NOT covered
 * by any signature we verify locally. A hostile sender SHIPPING from
 * pubkey `K_attacker` can therefore put ANY string (e.g. `"alice"`,
 * the victim's nametag) into `payload.sender.nametag` to mislead the
 * recipient's UI into displaying a forged identity.
 *
 * **Defense (§5.6, §9.3).** Before any UI-bound surface (`transfer:incoming`
 * payload, history entries, conversation/contact UIs), the recipient
 * MUST re-resolve the sender's nametag against the AUTHENTICATED Nostr
 * signing pubkey via the identity-binding-event registry
 * ({@link TransportProvider.resolveTransportPubkeyInfo}). The binding
 * event is itself signed by its claimed pubkey, so the binding-event
 * nametag is a cryptographically-attested statement by the binding
 * publisher (the only publisher who can publish for that pubkey, per
 * the relay's signature gate) — NOT a plaintext claim by an arbitrary
 * sender.
 *
 * **Decision rule.**
 *
 * | Scenario                                              | UI nametag                | source                  |
 * |-------------------------------------------------------|---------------------------|-------------------------|
 * | Binding event found, has `nametag`                    | `binding.nametag`         | `'binding-event'`       |
 * | Binding event found, no `nametag` (pubkey-only bind)  | `null`                    | `'binding-event'`       |
 * | Binding lookup returns `null` (no binding registered) | `null`                    | `'untrusted-payload'`   |
 * | Binding lookup throws / transport unavailable         | `null`                    | `'untrusted-payload'`   |
 *
 * **Why we DEFAULT to `null` when the binding lookup fails.**
 *
 * The protocol's safety story rests on "never display a sender-supplied
 * nametag without re-resolution". If we surface `payload.sender.nametag`
 * whenever the binding lookup is inconclusive, we open the C9 attack on
 * exactly the network-partition / first-encounter / new-pubkey paths
 * that an adversary can RELIABLY trigger:
 *
 *   - A new attacker pubkey has no binding event by definition (the
 *     attacker can simply NOT publish one). Without re-resolver
 *     gating, the attacker's first DM trivially impersonates `@alice`.
 *   - A relay outage temporarily makes binding lookups fail. Without
 *     gating, an attacker timing their attack to a relay outage
 *     window (or DOSing the relay to create one) gets the same
 *     impersonation.
 *
 * The only safe default is: **no binding-attested nametag → no UI
 * nametag**. The recipient sees `null`, the UI typically renders the
 * pubkey or "Unknown sender", and the user has the chance to
 * out-of-band-verify.
 *
 * The `source: 'untrusted-payload'` discriminator is preserved on the
 * return value so DOWNSTREAM consumers MAY make an informed decision
 * (e.g. a debug-mode UI could display "claimed: @alice (UNVERIFIED)"
 * but production UIs MUST respect the `null` and not auto-trust).
 *
 * **What this module does NOT do.**
 *
 *   1. We do NOT verify that the binding event's `transportPubkey`
 *      matches the sender's signing pubkey *byte-for-byte*. The
 *      binding registry is queried BY signing pubkey
 *      ({@link TransportProvider.resolveTransportPubkeyInfo}), so the
 *      precondition is enforced by the registry contract — a binding
 *      event for some OTHER pubkey will simply not be returned.
 *      Verifying this here would re-implement the registry.
 *   2. We do NOT detect "binding nametag != payload nametag" as an
 *      anomaly. The binding-event nametag wins unconditionally; a
 *      mismatch is silently corrected. Surfacing the mismatch as an
 *      operator alert is a future enhancement (the protocol does not
 *      currently mandate it; mismatch is not a SECURITY violation —
 *      it's just the sender being lazy or out-of-date).
 *   3. We do NOT cache results. The transport's binding-event
 *      registry is responsible for caching its own lookups; doing it
 *      here would create a stale-cache TOCTOU between this module
 *      and `resolveTransportPubkeyInfo()`.
 *
 * Spec references:
 *   - §3.1   `UxfTransferPayloadBase.sender.nametag` is UNAUTHENTICATED.
 *   - §5.6   "Do NOT trust `sender.nametag` for UI display unless
 *            re-resolved against the Nostr signing pubkey."
 *   - §9.3   Recipient receives a UXF bundle from an unknown sender.
 *
 * @packageDocumentation
 */

import type { PeerInfo, TransportProvider } from '../../../transport/transport-provider.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Provenance of the UI-displayable nametag, surfaced for downstream
 * UIs that want to differentiate "trusted (binding-attested)" from
 * "unknown (no attestation)".
 */
export type ReresolvedNametagSource =
  /**
   * Nametag came from an identity-binding event published BY the sender's
   * signing pubkey. This is the only trusted source; the binding event is
   * cryptographically signed.
   *
   * If the binding event existed but did not declare a nametag (pubkey-only
   * registration), the resolver still returns this source with
   * `nametag: null` — meaning "we know who this pubkey is, they have not
   * registered a nametag".
   */
  | 'binding-event'
  /**
   * No binding event found OR the lookup failed (network error, transport
   * does not implement `resolveTransportPubkeyInfo`). The resolver
   * deliberately returns `nametag: null` and refuses to surface
   * `payload.sender.nametag` — see module-level docs for rationale.
   */
  | 'untrusted-payload';

/**
 * Result of {@link reresolveNametag}.
 *
 * Both fields together are the contract: callers MUST display
 * `nametag` (which may be `null`); they MAY use `source` to badge the
 * UI (e.g. "verified via binding") but MUST NOT use `source` to
 * upgrade an `untrusted-payload` result into a displayed nametag by
 * substituting the payload value — the resolver has already made
 * that policy decision.
 */
export interface ReresolvedNametag {
  /**
   * The canonical nametag for UI display, or `null` if no
   * binding-attested nametag is available.
   *
   * Always `null` when `source === 'untrusted-payload'`.
   */
  readonly nametag: string | null;
  /** Provenance discriminator — see {@link ReresolvedNametagSource}. */
  readonly source: ReresolvedNametagSource;
  /**
   * The {@link PeerInfo} snapshot the binding registry returned for
   * `senderPubkey`, or `null` when no binding event was found / the
   * lookup failed. Surfaced so callers needing additional fields
   * (e.g. `directAddress`) can read them from the SAME snapshot that
   * supplied `nametag` — eliminating the TOCTOU window where a
   * relay-side actor could splice the nametag from snapshot T0 with
   * the address from snapshot T1.
   *
   * Wave 3 / steelman: when both the nametag and the address are
   * needed, callers MUST consume them from this single `peerInfo`
   * rather than re-querying `resolveTransportPubkeyInfo` separately.
   * See `resolveSenderInfoViaBinding` for the canonical pattern.
   */
  readonly peerInfo: PeerInfo | null;
}

// =============================================================================
// 2. Public API — reresolveNametag
// =============================================================================

/**
 * Minimal transport surface required by {@link reresolveNametag}.
 *
 * Decoupled from the full {@link TransportProvider} so unit tests can
 * inject a stub without standing up a Nostr provider, and so callers
 * (e.g. PaymentsModule) can pass `this.deps.transport` directly via
 * structural typing.
 */
export interface NametagResolver {
  /** Identity-binding-event lookup. Optional — see contract notes. */
  resolveTransportPubkeyInfo?(transportPubkey: string): Promise<PeerInfo | null>;
}

/**
 * Re-resolve a sender's display nametag against the identity-binding
 * registry (C9 defense per §5.6, §9.3).
 *
 * **Contract.**
 *   - The binding event for `senderPubkey` (if any) wins.
 *   - The unauthenticated `payloadSenderNametag` is NEVER displayed
 *     directly; it is accepted as a parameter ONLY for two purposes:
 *       (a) downstream loggers that want to correlate the original
 *           claim with the resolved value (out-of-band of this
 *           function's return value);
 *       (b) future telemetry that flags "binding != payload" as a
 *           potential adversarial signal.
 *   - If the binding lookup fails for ANY reason (no binding,
 *     transport returns `null`, the optional method is not
 *     implemented, the call throws), this function returns
 *     `{nametag: null, source: 'untrusted-payload'}`.
 *
 * **Inputs.**
 *   - `senderPubkey` — the AUTHENTICATED Nostr signing pubkey
 *                      (verified by the relay). 64-hex-char string.
 *   - `payloadSenderNametag` — the unauthenticated `payload.sender.nametag`
 *                              claim from the wire envelope (or
 *                              `undefined` if the sender omitted it).
 *                              Accepted but NEVER trusted; see contract.
 *   - `transport` — a {@link NametagResolver} (typically
 *                   `this.deps.transport`).
 *
 * **Output.** Always defined; `nametag` may be `null`.
 *
 * **Failure handling.** This function NEVER throws. Errors thrown by
 * `resolveTransportPubkeyInfo` are caught and translated to
 * `source: 'untrusted-payload'` because the safety contract requires
 * a graceful "no nametag" fallback (the caller is on a UI emission
 * path; throwing here would either crash the UI or force every
 * caller to wrap in try/catch).
 *
 * @param senderPubkey - The authenticated Nostr signing pubkey of
 *                       the bundle sender (NOT the unauthenticated
 *                       `payload.sender.transportPubkey`).
 * @param payloadSenderNametag - The unauthenticated nametag claim
 *                               from the wire envelope, accepted but
 *                               never trusted.
 * @param transport - Transport provider that implements
 *                    `resolveTransportPubkeyInfo`.
 * @returns The re-resolved nametag (or `null`) and its provenance.
 */
export async function reresolveNametag(
  senderPubkey: string,
  payloadSenderNametag: string | undefined,
  transport: NametagResolver | undefined,
): Promise<ReresolvedNametag> {
  // Reference the parameter so eslint knows it is part of the
  // contract surface even when the body deliberately ignores it.
  // (See module-level docs for rationale.)
  void payloadSenderNametag;

  // Contract: empty / non-string senderPubkey is treated as
  // "no binding lookup possible" — fall through to untrusted.
  // We do NOT throw because the C9 defense is best-effort: throwing
  // here would block the UI emission path, which is worse than
  // silently downgrading to `null` (the payload nametag is dropped
  // either way).
  if (typeof senderPubkey !== 'string' || senderPubkey.length === 0) {
    return { nametag: null, source: 'untrusted-payload', peerInfo: null };
  }

  if (!transport || typeof transport.resolveTransportPubkeyInfo !== 'function') {
    // Transport does not implement the binding lookup. Per
    // contract, do NOT trust the payload claim. Caller's UI will
    // render "Unknown sender" or the pubkey.
    return { nametag: null, source: 'untrusted-payload', peerInfo: null };
  }

  let peerInfo: PeerInfo | null;
  try {
    peerInfo = await transport.resolveTransportPubkeyInfo(senderPubkey);
  } catch {
    // Transport / network error. Best-effort C9 defense:
    // refuse to display payload nametag.
    return { nametag: null, source: 'untrusted-payload', peerInfo: null };
  }

  if (peerInfo === null) {
    // No binding event registered for this pubkey. The sender is
    // either brand new, never registered a nametag, or the relay
    // is partitioned. In all three cases the safe answer is the
    // same: do NOT display the payload claim.
    return { nametag: null, source: 'untrusted-payload', peerInfo: null };
  }

  // Binding event found. The nametag (if any) is binding-attested.
  // A pubkey-only binding (no nametag in the binding event) returns
  // `nametag: null` with source `'binding-event'` — meaning "we
  // recognize this pubkey, they have not registered a nametag".
  // This is distinct from `'untrusted-payload'` because we DID
  // succeed at the registry lookup — downstream UIs can use the
  // distinction to render e.g. "(known peer, no nametag)" vs
  // "(unknown sender)".
  //
  // Wave 3 / steelman: also surface the FULL `peerInfo` snapshot so
  // callers (notably `resolveSenderInfoViaBinding`) read both the
  // nametag and the directAddress from the SAME registry response,
  // eliminating the TOCTOU window where two consecutive
  // `resolveTransportPubkeyInfo` calls could see different values
  // (relay cache poisoning / mid-flight re-publication).
  const bindingNametag = peerInfo.nametag;
  if (typeof bindingNametag === 'string' && bindingNametag.length > 0) {
    return { nametag: bindingNametag, source: 'binding-event', peerInfo };
  }
  return { nametag: null, source: 'binding-event', peerInfo };
}

// =============================================================================
// 3. Convenience adapter — `resolveSenderInfo` shape
// =============================================================================

/**
 * Convenience adapter for callers that need the legacy
 * `{ senderAddress?, senderNametag? }` shape used by
 * `PaymentsModule.resolveSenderInfo`. Internally calls
 * {@link reresolveNametag} for the nametag and returns the
 * binding-event's `directAddress` alongside.
 *
 * Returns `senderAddress` only when the binding lookup succeeded;
 * `undefined` otherwise. `senderNametag` is `undefined` (rather
 * than `null`) for compatibility with the existing call sites that
 * spread this object into history-entry constructors and emit
 * payloads — TypeScript's `exactOptionalPropertyTypes` interprets
 * `undefined` as "field absent" which is the desired no-display
 * behavior.
 *
 * @internal — used by `PaymentsModule.resolveSenderInfo` to keep the
 *             current call shape; new callers should prefer
 *             {@link reresolveNametag} directly.
 */
export async function resolveSenderInfoViaBinding(
  senderTransportPubkey: string,
  payloadSenderNametag: string | undefined,
  transport: NametagResolver | undefined,
): Promise<{
  senderAddress?: string;
  senderNametag?: string;
  /** C9 audit: provenance of `senderNametag` per the re-resolver contract. */
  senderNametagSource: ReresolvedNametagSource;
}> {
  const reresolved = await reresolveNametag(
    senderTransportPubkey,
    payloadSenderNametag,
    transport,
  );

  // Wave 3 / steelman fix (TOCTOU): read `directAddress` from the
  // SAME `peerInfo` snapshot that supplied `nametag`. The previous
  // implementation called `resolveTransportPubkeyInfo` a SECOND time
  // for the address — a relay-side actor could return different
  // PeerInfo between the two calls, splicing `nametag: 'alice'` from
  // snapshot T0 with `directAddress: K_attacker` from snapshot T1
  // (cache poison / flapping binding). The single-snapshot read
  // closes that window: if the registry returned (nametag, address)
  // together, the receiver consumes them together; if it returned
  // a snapshot without the address (pubkey-only binding), the
  // receiver leaves `senderAddress` undefined rather than running
  // a second query that could see a fresher, conflicting answer.
  let senderAddress: string | undefined;
  if (
    reresolved.source === 'binding-event' &&
    reresolved.peerInfo !== null &&
    typeof reresolved.peerInfo.directAddress === 'string' &&
    reresolved.peerInfo.directAddress.length > 0
  ) {
    senderAddress = reresolved.peerInfo.directAddress;
  }

  return {
    ...(senderAddress !== undefined ? { senderAddress } : {}),
    ...(reresolved.nametag !== null ? { senderNametag: reresolved.nametag } : {}),
    senderNametagSource: reresolved.source,
  };
}

// =============================================================================
// 4. Re-export TransportProvider compat shim — keep callers happy
// =============================================================================

/**
 * Type alias kept for callers that pass `TransportProvider` directly.
 * Both `TransportProvider` and the lighter {@link NametagResolver}
 * structural shape are accepted by {@link reresolveNametag}.
 */
export type ReresolverTransport = NametagResolver | TransportProvider;
