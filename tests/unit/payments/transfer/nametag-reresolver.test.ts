/**
 * Tests for `modules/payments/transfer/nametag-reresolver.ts` (T.7.B.5 / C9).
 *
 * The re-resolver gates UI nametag display through the identity-binding
 * registry. These tests pin the contract and adversarial behavior:
 *
 *   1. Happy path: binding event nametag matches payload claim → return
 *      binding-attested value with `source: 'binding-event'`.
 *   2. Forged-payload case: binding event has 'bob', payload says 'alice'
 *      → return 'bob' (binding wins; payload is silently dropped). This
 *      is the C9 defense regression.
 *   3. No binding: lookup returns null → return `nametag: null,
 *      source: 'untrusted-payload'` (do NOT fall through to payload).
 *   4. Lookup throws: return `nametag: null,
 *      source: 'untrusted-payload'`.
 *   5. Transport missing the optional method: same.
 *   6. Empty senderPubkey: same.
 *   7. Pubkey-only binding (no nametag in event): return `nametag:
 *      null, source: 'binding-event'` (distinct from untrusted-payload
 *      because the lookup did succeed).
 *   8. Convenience adapter `resolveSenderInfoViaBinding` returns the
 *      binding event's `directAddress` only when the binding lookup
 *      succeeded.
 *
 * Spec references: §3.1, §5.6, §9.3.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  reresolveNametag,
  resolveSenderInfoViaBinding,
  type NametagResolver,
  type ReresolvedNametag,
} from '../../../../modules/payments/transfer/nametag-reresolver';
import type { PeerInfo } from '../../../../transport/transport-provider';

// =============================================================================
// 1. Test helpers
// =============================================================================

const SENDER_PUBKEY = 'a'.repeat(64);
const ATTACKER_PUBKEY = 'b'.repeat(64);

function peerInfo(opts: { nametag?: string; directAddress?: string }): PeerInfo {
  return {
    transportPubkey: SENDER_PUBKEY,
    chainPubkey: '02'.padEnd(66, 'c'),
    l1Address: 'alpha1example',
    directAddress: opts.directAddress ?? 'DIRECT://example',
    timestamp: 1700000000,
    ...(opts.nametag !== undefined ? { nametag: opts.nametag } : {}),
  };
}

function makeTransport(
  resolver: ((pubkey: string) => Promise<PeerInfo | null>) | null,
): NametagResolver {
  if (resolver === null) {
    // Transport that does NOT implement the optional method.
    return {};
  }
  return {
    resolveTransportPubkeyInfo: vi.fn(resolver),
  };
}

// =============================================================================
// 2. reresolveNametag — happy path (binding == payload)
// =============================================================================

describe('reresolveNametag — happy path', () => {
  it('returns binding nametag when binding matches payload claim', async () => {
    const transport = makeTransport(async () => peerInfo({ nametag: 'alice' }));

    const result: ReresolvedNametag = await reresolveNametag(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    expect(result).toMatchObject({ nametag: 'alice', source: 'binding-event' });
    expect(result.peerInfo).not.toBeNull();
    expect(result.peerInfo?.nametag).toBe('alice');
  });

  it('queries the registry by the AUTHENTICATED senderPubkey, not the payload claim', async () => {
    const fn = vi.fn(async () => peerInfo({ nametag: 'alice' }));
    const transport: NametagResolver = { resolveTransportPubkeyInfo: fn };

    await reresolveNametag(SENDER_PUBKEY, 'whatever-claim', transport);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(SENDER_PUBKEY);
  });
});

// =============================================================================
// 3. reresolveNametag — C9 forged-payload case (THE point of the module)
// =============================================================================

describe('reresolveNametag — forged-payload defense (C9)', () => {
  it('binding nametag wins over a forged payload nametag', async () => {
    // Hostile sender publishes from ATTACKER_PUBKEY but claims to be
    // 'alice' in the payload. The binding event for ATTACKER_PUBKEY
    // (registered honestly by the attacker, who controls that
    // pubkey's binding) says 'bob'. Per C9 the receiver displays
    // 'bob' — the attacker's REAL nametag — not the forged 'alice'.
    const transport = makeTransport(async () => peerInfo({ nametag: 'bob' }));

    const result = await reresolveNametag(
      ATTACKER_PUBKEY,
      'alice', // forged claim
      transport,
    );

    expect(result.nametag).toBe('bob');
    expect(result.source).toBe('binding-event');
  });

  it('binding nametag wins even when payload nametag is empty', async () => {
    const transport = makeTransport(async () => peerInfo({ nametag: 'bob' }));
    const result = await reresolveNametag(SENDER_PUBKEY, '', transport);
    expect(result).toMatchObject({ nametag: 'bob', source: 'binding-event' });
  });

  it('binding nametag wins even when payload nametag is undefined', async () => {
    const transport = makeTransport(async () => peerInfo({ nametag: 'bob' }));
    const result = await reresolveNametag(SENDER_PUBKEY, undefined, transport);
    expect(result).toMatchObject({ nametag: 'bob', source: 'binding-event' });
  });
});

// =============================================================================
// 4. reresolveNametag — no binding / transport failure
// =============================================================================

describe('reresolveNametag — no binding event', () => {
  it('returns null + untrusted-payload when lookup returns null', async () => {
    const transport = makeTransport(async () => null);

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    // Critical: do NOT fall through to the payload claim.
    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });

  it('returns null + untrusted-payload when lookup throws', async () => {
    const transport = makeTransport(async () => {
      throw new Error('network failure');
    });

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });

  it('returns null + untrusted-payload when transport lacks the optional method', async () => {
    const transport = makeTransport(null);

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });

  it('returns null + untrusted-payload when transport is undefined', async () => {
    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', undefined);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });

  it('returns null + untrusted-payload when senderPubkey is empty', async () => {
    const transport = makeTransport(async () => peerInfo({ nametag: 'alice' }));

    const result = await reresolveNametag('', 'alice', transport);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('untrusted-payload');
  });
});

// =============================================================================
// 5. reresolveNametag — pubkey-only binding (binding exists, no nametag)
// =============================================================================

describe('reresolveNametag — pubkey-only binding', () => {
  it('returns null + binding-event when binding exists but has no nametag', async () => {
    // The peer is registered (we know who they are) but has not
    // claimed a nametag. The C9 defense still applies: do NOT
    // surface the payload claim. Source IS 'binding-event' because
    // the registry lookup DID succeed — distinguishing this case
    // from "complete unknown" lets the UI render e.g.
    // "(known peer, no nametag)" vs "(unknown sender)".
    const transport = makeTransport(async () => peerInfo({}));

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('binding-event');
  });

  it('treats empty-string binding nametag the same as missing', async () => {
    const transport = makeTransport(async () => peerInfo({ nametag: '' }));

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    expect(result.nametag).toBeNull();
    expect(result.source).toBe('binding-event');
  });
});

// =============================================================================
// 6. reresolveNametag — never throws (best-effort contract)
// =============================================================================

describe('reresolveNametag — exception safety', () => {
  it('does not throw when transport throws non-Error', async () => {
    const transport: NametagResolver = {
      resolveTransportPubkeyInfo: vi.fn(async () => {
        throw 'string error';
      }),
    };

    await expect(
      reresolveNametag(SENDER_PUBKEY, 'alice', transport),
    ).resolves.toMatchObject({ nametag: null, source: 'untrusted-payload' });
  });

  it('does not throw when transport throws null', async () => {
    const transport: NametagResolver = {
      resolveTransportPubkeyInfo: vi.fn(async () => {
        throw null;
      }),
    };

    await expect(
      reresolveNametag(SENDER_PUBKEY, 'alice', transport),
    ).resolves.toMatchObject({ nametag: null, source: 'untrusted-payload' });
  });
});

// =============================================================================
// 7. resolveSenderInfoViaBinding — convenience adapter
// =============================================================================

describe('resolveSenderInfoViaBinding', () => {
  it('returns address + nametag from binding event when present', async () => {
    const transport = makeTransport(async () =>
      peerInfo({ nametag: 'alice', directAddress: 'DIRECT://alice-addr' }),
    );

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    expect(result.senderAddress).toBe('DIRECT://alice-addr');
    expect(result.senderNametag).toBe('alice');
    expect(result.senderNametagSource).toBe('binding-event');
  });

  it('drops senderNametag when binding has no nametag (pubkey-only bind)', async () => {
    const transport = makeTransport(async () =>
      peerInfo({ directAddress: 'DIRECT://known-peer' }),
    );

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice', // forged claim
      transport,
    );

    expect(result.senderAddress).toBe('DIRECT://known-peer');
    expect(result.senderNametag).toBeUndefined();
    expect(result.senderNametagSource).toBe('binding-event');
  });

  it('returns no senderAddress when binding lookup fails', async () => {
    const transport = makeTransport(async () => null);

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    expect(result.senderAddress).toBeUndefined();
    expect(result.senderNametag).toBeUndefined();
    expect(result.senderNametagSource).toBe('untrusted-payload');
  });

  it('forged payload nametag is NEVER surfaced', async () => {
    // Most important regression: even with the convenience adapter,
    // the forged nametag MUST NOT leak into senderNametag.
    const transport = makeTransport(async () => peerInfo({ nametag: 'bob' }));

    const result = await resolveSenderInfoViaBinding(
      ATTACKER_PUBKEY,
      'alice', // forged
      transport,
    );

    // C9: 'bob' wins — binding-attested.
    expect(result.senderNametag).toBe('bob');
    expect(result.senderNametag).not.toBe('alice');
    expect(result.senderNametagSource).toBe('binding-event');
  });

  it('treats binding-event errors as untrusted-payload', async () => {
    const transport = makeTransport(async () => {
      throw new Error('relay timeout');
    });

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    expect(result.senderAddress).toBeUndefined();
    expect(result.senderNametag).toBeUndefined();
    expect(result.senderNametagSource).toBe('untrusted-payload');
  });
});

// =============================================================================
// 8. Wave 3 / steelman: TOCTOU defense — single PeerInfo snapshot
// =============================================================================

describe('resolveSenderInfoViaBinding — single-snapshot TOCTOU defense', () => {
  it('reads nametag and directAddress from the SAME peerInfo snapshot', async () => {
    // The previous implementation called `resolveTransportPubkeyInfo`
    // TWICE: once for nametag, once for directAddress. A relay-side
    // actor could splice (nametag T0, directAddress T1) into the
    // result. Wave 3 fix: single call, both fields read from one
    // snapshot.
    const fn = vi.fn(async () =>
      peerInfo({ nametag: 'alice', directAddress: 'DIRECT://alice-real' }),
    );
    const transport: NametagResolver = { resolveTransportPubkeyInfo: fn };

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    expect(result.senderNametag).toBe('alice');
    expect(result.senderAddress).toBe('DIRECT://alice-real');
    expect(result.senderNametagSource).toBe('binding-event');
    // Critical regression: only ONE call to the registry. Two calls
    // re-open the TOCTOU window.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses to splice nametag + address from different snapshots', async () => {
    // Simulate the attack: each call returns a different snapshot
    // (different directAddress). With the fix in place, only the
    // FIRST snapshot is read; the attacker's second snapshot never
    // gets a chance to substitute its address.
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return peerInfo({ nametag: 'alice', directAddress: 'DIRECT://alice-real' });
      }
      // Hypothetical post-TOCTOU snapshot from a hostile relay.
      return peerInfo({ nametag: 'alice', directAddress: 'DIRECT://attacker' });
    });
    const transport: NametagResolver = { resolveTransportPubkeyInfo: fn };

    const result = await resolveSenderInfoViaBinding(
      SENDER_PUBKEY,
      'alice',
      transport,
    );

    // Address MUST come from the same snapshot as nametag — the
    // first-snapshot value, NOT the attacker's second snapshot.
    expect(result.senderAddress).toBe('DIRECT://alice-real');
    expect(result.senderAddress).not.toBe('DIRECT://attacker');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT call the registry a second time even when address is needed', async () => {
    const fn = vi.fn(async () =>
      peerInfo({ nametag: 'bob', directAddress: 'DIRECT://bob' }),
    );
    const transport: NametagResolver = { resolveTransportPubkeyInfo: fn };

    await resolveSenderInfoViaBinding(SENDER_PUBKEY, undefined, transport);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('peerInfo is null when binding lookup fails', async () => {
    const transport = makeTransport(async () => null);
    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);
    expect(result.peerInfo).toBeNull();
  });

  it('peerInfo is null when binding lookup throws', async () => {
    const transport = makeTransport(async () => {
      throw new Error('network failure');
    });
    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);
    expect(result.peerInfo).toBeNull();
  });

  it('peerInfo carries the same snapshot when binding succeeds', async () => {
    const snapshot = peerInfo({
      nametag: 'alice',
      directAddress: 'DIRECT://alice',
    });
    const transport = makeTransport(async () => snapshot);

    const result = await reresolveNametag(SENDER_PUBKEY, 'alice', transport);

    expect(result.peerInfo).toBe(snapshot);
    expect(result.peerInfo?.directAddress).toBe('DIRECT://alice');
  });
});
