/**
 * Adversarial test — forged `payload.sender.nametag` (T.7.B.5 / C9 /
 * §3.1, §5.6, §9.3).
 *
 * **Threat model recap.** The Nostr event is signed (the sender's pubkey
 * is verified by the relay) but the `payload.sender.nametag` field is
 * a plaintext, attacker-controllable string in the outer envelope. A
 * hostile sender shipping from `K_attacker` can freely write
 * `nametag: 'alice'` (the victim's known nametag) into the wire payload
 * to mislead the recipient's UI into displaying a forged identity.
 *
 * **Defense (re-resolution).** Per §5.6 the recipient MUST re-resolve
 * the sender's nametag against the AUTHENTICATED Nostr signing pubkey
 * via the identity-binding-event registry. The binding-event nametag
 * (cryptographically signed by the registry publisher, who alone
 * controls that pubkey's bindings) wins; the payload claim is
 * dropped.
 *
 * **What this regression test pins.**
 *
 *   1. Forged `payload.sender.nametag` (attacker claims `@alice`)
 *      → re-resolved peerInfo shows the binding-attested nametag
 *      (e.g. attacker's REAL `@bob`), NOT the forged `alice`.
 *   2. The receive pipeline calls the binding registry with the
 *      AUTHENTICATED senderPubkey, NOT with the unauthenticated
 *      `payload.sender.transportPubkey` claim. (A separate hostile
 *      vector — confounding the registry lookup with a forged
 *      transport-pubkey field.)
 *   3. When the binding lookup fails (no binding event registered
 *      for the attacker pubkey, OR transport unavailable), the
 *      recipient surfaces NO nametag at all — the payload claim is
 *      NEVER displayed even when there's no positive evidence to
 *      contradict it. This is the worst-case defense: a brand-new
 *      attacker pubkey with no binding event must NOT be able to
 *      impersonate `@alice` simply by writing it into the payload.
 *
 * Spec references:
 *   - §3.1   `payload.sender.nametag` is UNAUTHENTICATED.
 *   - §5.6   "Do NOT trust `sender.nametag` for UI display unless
 *            re-resolved against the Nostr signing pubkey."
 *   - §9.3   Recipient receives a UXF bundle from an unknown sender.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  reresolveNametag,
  resolveSenderInfoViaBinding,
  type NametagResolver,
} from '../../../modules/payments/transfer/nametag-reresolver';
import type { PeerInfo } from '../../../transport/transport-provider';

// =============================================================================
// Adversarial fixtures
// =============================================================================

/**
 * The honest victim: `@alice` is registered to ALICE_PUBKEY. The
 * attacker hopes the receiver will display `@alice` because the
 * payload claims it.
 */
const ALICE_PUBKEY = 'a'.repeat(64);

/**
 * The attacker. Their REAL binding (which they registered honestly,
 * because they need a valid binding to send messages at all) is
 * `@bob`. The attacker WANTS the receiver to see `@alice`; the
 * defense forces the receiver to see `@bob` instead.
 */
const ATTACKER_PUBKEY = 'b'.repeat(64);

/**
 * A brand-new attacker with NO binding event at all. Worst case for
 * the defense: the receiver has no positive evidence of who this
 * pubkey is. The defense MUST refuse to surface the payload claim
 * even in this case.
 */
const NEW_ATTACKER_PUBKEY = 'c'.repeat(64);

function bindingFor(pubkey: string, nametag: string | undefined): PeerInfo {
  return {
    transportPubkey: pubkey,
    chainPubkey: '02'.padEnd(66, 'd'),
    l1Address: 'alpha1example',
    directAddress: `DIRECT://${pubkey.slice(0, 8)}`,
    timestamp: 1700000000,
    ...(nametag !== undefined ? { nametag } : {}),
  };
}

/**
 * Test transport that ONLY knows about explicitly-registered
 * bindings. Any pubkey not in the registry returns `null`, simulating
 * "no binding event found" — the worst case for the C9 defense.
 */
function bindingRegistry(
  bindings: ReadonlyMap<string, PeerInfo>,
): NametagResolver {
  return {
    resolveTransportPubkeyInfo: vi.fn(async (pubkey: string) => {
      return bindings.get(pubkey) ?? null;
    }),
  };
}

// =============================================================================
// 1. C9 core regression — forged nametag, attacker has its own binding
// =============================================================================

describe('Adversarial: forged payload.sender.nametag (C9 core regression)', () => {
  it('binding-attested @bob wins over forged payload @alice claim', async () => {
    // Setup: ALICE registered @alice. ATTACKER honestly registered @bob
    // (they need a valid binding to send any messages). The attacker
    // ships a UXF bundle from ATTACKER_PUBKEY but writes
    // `payload.sender.nametag = 'alice'` into the outer envelope,
    // hoping the receiver will display @alice.
    const registry = bindingRegistry(
      new Map<string, PeerInfo>([
        [ALICE_PUBKEY, bindingFor(ALICE_PUBKEY, 'alice')],
        [ATTACKER_PUBKEY, bindingFor(ATTACKER_PUBKEY, 'bob')],
      ]),
    );

    // Receiver re-resolves against the AUTHENTICATED signing pubkey
    // (ATTACKER_PUBKEY — the relay verified the signature), passing
    // the unauthenticated payload claim along for forensic reference.
    const result = await reresolveNametag(
      ATTACKER_PUBKEY,
      'alice', // forged claim from payload.sender.nametag
      registry,
    );

    // Critical invariant 1: the displayed nametag is the
    // BINDING-ATTESTED one (@bob), NOT the forged claim (@alice).
    expect(result.nametag).toBe('bob');
    expect(result.nametag).not.toBe('alice');

    // Critical invariant 2: source is `binding-event`, signaling
    // to the UI that the value is trusted.
    expect(result.source).toBe('binding-event');
  });

  it('the binding lookup is keyed by the AUTHENTICATED signing pubkey, not the payload claim', async () => {
    // Subtle adversarial vector: an attacker MIGHT also forge the
    // `payload.sender.transportPubkey` field hoping the recipient
    // will look up the WRONG pubkey in the registry (e.g. ALICE's,
    // which would return @alice). The defense: ignore the payload's
    // pubkey claim entirely and use ONLY the relay-verified signing
    // pubkey.
    const fn = vi.fn(async (pubkey: string) => {
      // The registry knows about both alice and the attacker.
      if (pubkey === ALICE_PUBKEY) return bindingFor(ALICE_PUBKEY, 'alice');
      if (pubkey === ATTACKER_PUBKEY) return bindingFor(ATTACKER_PUBKEY, 'bob');
      return null;
    });
    const registry: NametagResolver = { resolveTransportPubkeyInfo: fn };

    // The receiver has the AUTHENTICATED ATTACKER_PUBKEY (from the
    // relay's signature check). The payload's transportPubkey
    // claim is irrelevant — the re-resolver doesn't accept it.
    await reresolveNametag(ATTACKER_PUBKEY, 'alice', registry);

    // The registry was queried EXACTLY ONCE, with the ATTACKER's
    // pubkey, NOT with ALICE's.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(ATTACKER_PUBKEY);
    expect(fn).not.toHaveBeenCalledWith(ALICE_PUBKEY);
  });
});

// =============================================================================
// 2. C9 worst-case — attacker has NO binding event at all
// =============================================================================

describe('Adversarial: forged nametag with no attacker binding', () => {
  it('refuses to surface the forged payload nametag when binding lookup returns null', async () => {
    // Worst-case adversarial vector: a brand-new attacker pubkey with
    // NO binding event registered. The receiver has NO positive
    // evidence of who this pubkey is. A naive implementation that
    // "falls through" to the payload nametag when re-resolution fails
    // would let this attacker impersonate @alice trivially.
    //
    // The C9 defense forbids this fallback: when the binding lookup
    // returns null, the receiver displays NO nametag.
    const registry = bindingRegistry(
      new Map<string, PeerInfo>([
        [ALICE_PUBKEY, bindingFor(ALICE_PUBKEY, 'alice')],
        // NEW_ATTACKER_PUBKEY deliberately omitted — no binding
      ]),
    );

    const result = await reresolveNametag(
      NEW_ATTACKER_PUBKEY,
      'alice', // forged claim
      registry,
    );

    // The forged claim is dropped. The UI will render the
    // pubkey or "Unknown sender" — NEVER @alice.
    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });

  it('refuses to surface the forged payload nametag when transport is unreachable', async () => {
    // Variant: relay outage. The transport throws on lookup.
    // Without the C9 defense, an attacker timing their attack to a
    // relay outage window (or DOSing the relay) would get the same
    // free impersonation. The defense applies regardless of WHY
    // re-resolution failed.
    const registry: NametagResolver = {
      resolveTransportPubkeyInfo: vi.fn(async () => {
        throw new Error('relay timeout');
      }),
    };

    const result = await reresolveNametag(
      NEW_ATTACKER_PUBKEY,
      'alice',
      registry,
    );

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });
});

// =============================================================================
// 3. C9 — full receive-flow simulation via resolveSenderInfoViaBinding
// =============================================================================

describe('Adversarial: full receive-flow simulation', () => {
  it('IncomingTransfer-shaped output never carries a forged nametag', async () => {
    // Simulates the exact path PaymentsModule takes when emitting
    // `transfer:incoming`: it calls `resolveSenderInfoViaBinding`
    // and then spreads `senderNametag: senderInfo.senderNametag`
    // into the event payload. The C9 defense lives in the
    // resolveSenderInfoViaBinding return value.
    const registry = bindingRegistry(
      new Map<string, PeerInfo>([
        [ATTACKER_PUBKEY, bindingFor(ATTACKER_PUBKEY, 'bob')],
      ]),
    );

    const senderInfo = await resolveSenderInfoViaBinding(
      ATTACKER_PUBKEY,
      'alice', // forged
      registry,
    );

    // The payload event would be:
    //   { senderPubkey: ATTACKER_PUBKEY,
    //     senderNametag: senderInfo.senderNametag,  // <-- 'bob', not 'alice'
    //     ... }
    expect(senderInfo.senderNametag).toBe('bob');
    expect(senderInfo.senderNametag).not.toBe('alice');
    expect(senderInfo.senderNametagSource).toBe('binding-event');
  });

  it('IncomingTransfer drops senderNametag entirely when no binding (vs displaying forged)', async () => {
    // Worst case: brand-new attacker. The IncomingTransfer event
    // emitted to the UI has NO senderNametag field (since the
    // adapter uses `undefined` for "no nametag" so spreading the
    // result into an object literal omits the key per
    // `exactOptionalPropertyTypes` semantics).
    const registry = bindingRegistry(new Map());

    const senderInfo = await resolveSenderInfoViaBinding(
      NEW_ATTACKER_PUBKEY,
      'alice',
      registry,
    );

    expect(senderInfo.senderNametag).toBeUndefined();
    expect(senderInfo.senderNametagSource).toBe('untrusted-payload');

    // Construct the IncomingTransfer-shaped object the way
    // PaymentsModule does and confirm there is NO senderNametag
    // key at all (the UI cannot accidentally display 'alice').
    const eventPayload: Record<string, unknown> = {
      id: 'transfer-1',
      senderPubkey: NEW_ATTACKER_PUBKEY,
      senderNametag: senderInfo.senderNametag, // undefined
      tokens: [],
      receivedAt: 1700000000,
    };

    expect(eventPayload.senderNametag).toBeUndefined();
    expect(eventPayload.senderNametag).not.toBe('alice');
  });
});

// =============================================================================
// 4. Defense-in-depth — multiple forgery scenarios in one matrix
// =============================================================================

describe('Adversarial: forgery scenarios matrix', () => {
  // Pin the contract: in EVERY scenario below, the displayed
  // nametag is either the binding-attested value OR null —
  // NEVER the payload claim.
  it.each([
    {
      name: 'attacker has @bob binding, claims @alice',
      senderPubkey: ATTACKER_PUBKEY,
      payloadClaim: 'alice',
      bindings: [[ATTACKER_PUBKEY, 'bob']] as const,
      expectedNametag: 'bob',
      expectedSource: 'binding-event' as const,
    },
    {
      name: 'attacker has @bob binding, claims own real @bob (truthful payload)',
      senderPubkey: ATTACKER_PUBKEY,
      payloadClaim: 'bob',
      bindings: [[ATTACKER_PUBKEY, 'bob']] as const,
      expectedNametag: 'bob',
      expectedSource: 'binding-event' as const,
    },
    {
      name: 'attacker has pubkey-only binding, claims @alice',
      senderPubkey: ATTACKER_PUBKEY,
      payloadClaim: 'alice',
      bindings: [[ATTACKER_PUBKEY, undefined]] as const,
      expectedNametag: null,
      expectedSource: 'binding-event' as const,
    },
    {
      name: 'attacker has NO binding, claims @alice',
      senderPubkey: NEW_ATTACKER_PUBKEY,
      payloadClaim: 'alice',
      bindings: [] as const,
      expectedNametag: null,
      expectedSource: 'untrusted-payload' as const,
    },
    {
      name: 'attacker has NO binding, claims empty string (no payload)',
      senderPubkey: NEW_ATTACKER_PUBKEY,
      payloadClaim: '',
      bindings: [] as const,
      expectedNametag: null,
      expectedSource: 'untrusted-payload' as const,
    },
  ])(
    '$name → nametag=$expectedNametag, source=$expectedSource',
    async ({
      senderPubkey,
      payloadClaim,
      bindings,
      expectedNametag,
      expectedSource,
    }) => {
      const map = new Map<string, PeerInfo>();
      for (const [pk, nt] of bindings) {
        map.set(pk, bindingFor(pk, nt));
      }
      const registry = bindingRegistry(map);

      const result = await reresolveNametag(senderPubkey, payloadClaim, registry);

      expect(result.nametag).toBe(expectedNametag);
      expect(result.source).toBe(expectedSource);
      // Universal invariant: the payload claim is never a
      // non-null displayed nametag (when expectedNametag is null,
      // the result is null; when expectedNametag is non-null,
      // it is the binding-attested value, not the payload).
      if (payloadClaim && payloadClaim !== expectedNametag) {
        expect(result.nametag).not.toBe(payloadClaim);
      }
    },
  );
});
