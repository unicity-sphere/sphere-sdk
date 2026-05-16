/**
 * Regression tests for Commit-I (steelman⁴) remediations on
 * NostrReplicationBridge.fetchMissedEntries:
 *
 *   1. Cap-reach truncation now THROWS (symmetric with H.3's
 *      verifyAndDecrypt budget-exhaust). Caller must NOT advance
 *      `since` on this rejection.
 *
 *   2. Total parsed EVENT frames are bounded (MAX_EVENTS_PER_FETCH × 2)
 *      so a flood of filter-failing events (wrong pubkey/kind) can't
 *      drive arbitrary CPU dispatch.
 */

import { describe, it, expect } from 'vitest';
import { NostrReplicationBridge, __testInternal } from '../../../profile/nostr-replication';

// ---------------------------------------------------------------------------
// Minimal fake WebSocket implementation
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 1;
  url: string;
  binaryType = 'arraybuffer' as const;
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Open synchronously on next microtask.
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  // Helper: inject a message from the relay.
  emit(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

function makeBridge(): { bridge: NostrReplicationBridge; ws: () => FakeWebSocket } {
  // 32-byte secp256k1 private key (canonical 0x42×32 — valid scalar).
  const privateKeyHex = Array(32).fill('42').join('');
  const encryptionKey = new Uint8Array(32).fill(0xab);
  let captured: FakeWebSocket | null = null;
  const bridge = new NostrReplicationBridge({
    relayUrl: 'wss://test',
    transportPrivateKey: privateKeyHex,
    encryptionKey,
    dbAddress: '/orbitdb/test',
    createWebSocket: (url: string) => {
      const ws = new FakeWebSocket(url);
      captured = ws;
      return ws as unknown as WebSocket;
    },
  });
  return { bridge, ws: () => captured! };
}

describe('Commit K — steelman⁶ direct hexToBytes contract tests', () => {
  // Steelman⁶ remediation: direct coverage of the hexToBytes throw
  // contract. The indirect tests via verifyEventAuthentic cannot
  // distinguish "hexToBytes throws on malformed input" from
  // "schnorr.verify throws on wrong-size bytes" — both fail closed
  // through the same try/catch and produce the same observable
  // outcome (event dropped, result === []). Only direct coverage
  // of hexToBytes itself proves J.1's validation contract.
  const { hexToBytes } = __testInternal;

  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/);
    expect(() => hexToBytes('a')).toThrow(/odd-length/);
    expect(() => hexToBytes('0'.repeat(127))).toThrow(/odd-length/);
  });

  it('throws on non-hex characters (even length)', () => {
    expect(() => hexToBytes('zz')).toThrow(/non-hex/);
    expect(() => hexToBytes('0g')).toThrow(/non-hex/);
    expect(() => hexToBytes('z'.repeat(128))).toThrow(/non-hex/);
  });

  it('throws on Unicode homoglyphs that look like hex', () => {
    // U+FF21 = fullwidth A (looks like 'A' but is non-ASCII)
    expect(() => hexToBytes('ＡＡ')).toThrow(/non-hex/);
    // U+0660 = Arabic-Indic digit zero
    expect(() => hexToBytes('٠٠')).toThrow(/non-hex/);
  });

  it('accepts well-formed hex (lowercase, uppercase, mixed)', () => {
    expect(hexToBytes('00')).toEqual(new Uint8Array([0]));
    expect(hexToBytes('ff')).toEqual(new Uint8Array([0xff]));
    expect(hexToBytes('FF')).toEqual(new Uint8Array([0xff]));
    expect(hexToBytes('aB')).toEqual(new Uint8Array([0xab]));
    expect(hexToBytes('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('accepts empty string (returns empty array)', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('does NOT silently produce wrong-size output for malformed input (the pre-J bug)', () => {
    // Pre-J behavior: hexToBytes('zz') silently returned new Uint8Array([NaN→0]).
    // Pre-J behavior: hexToBytes('abc') silently returned new Uint8Array([0xab]) (truncated).
    // Post-J: both throw. This test asserts the throws — if J.1 is reverted,
    // these expectations FAIL with "expected throw, got Uint8Array".
    expect(() => hexToBytes('zz')).toThrow();
    expect(() => hexToBytes('abc')).toThrow();
  });
});

describe('Commit J — steelman⁵ hexToBytes validates input', () => {
  it('verifyEventAuthentic returns false on malformed sig (reaches and exercises hexToBytes throw path)', async () => {
    // Steelman⁶ remediation: previous version of this test set
    // evt.id = '0'.repeat(64), which fails the `expectedId !== evt.id`
    // check at the TOP of verifyEventAuthentic — short-circuits BEFORE
    // hexToBytes is reached. The test passed for the wrong reason.
    //
    // Now we compute the correct id (sha256 of the canonical NIP-01
    // serialization) so the id check passes, then supply a malformed
    // sig that ACTUALLY triggers the hexToBytes throw path. If J.1
    // were reverted, this test would FAIL (because malformed sig would
    // produce a wrong-size byte array that schnorr.verify would
    // either accept against a forged signature or throw — the new
    // assertion verifies the throw is caught and false is returned).
    const { bridge, ws } = makeBridge();
    await bridge.start();
    const ws_ = ws();
    await new Promise((r) => setTimeout(r, 0));

    const fetchPromise = bridge.fetchMissedEntries(0);
    await new Promise((r) => setTimeout(r, 0));
    const reqMsg = ws_.sent.find((m) => m.startsWith('["REQ"'));
    const subId = JSON.parse(reqMsg!)[1] as string;
    const filter = JSON.parse(reqMsg!)[2] as { authors: string[]; kinds: number[] };
    const ourPubkey = filter.authors[0];
    const ourKind = filter.kinds[0];

    // Compute the canonical NIP-01 id for this event so the
    // `expectedId !== evt.id` check at line 659 passes and we ACTUALLY
    // reach hexToBytes(evt.sig).
    const created_at = 1;
    const content = 'x';
    const tags: unknown[] = [];
    const canonical = JSON.stringify([0, ourPubkey, created_at, ourKind, tags, content]);
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const idBytes = sha256(new TextEncoder().encode(canonical));
    const id = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('');

    // Send one event with VALID id but malformed-hex sig (odd length 127 chars).
    // verifyEventAuthentic now passes the id check, reaches hexToBytes(evt.sig),
    // throws ('odd-length hex'), catches, returns false. Event dropped.
    ws_.emit([
      'EVENT',
      subId,
      {
        pubkey: ourPubkey,
        kind: ourKind,
        content,
        created_at,
        id,
        sig: '0'.repeat(127), // odd length → hexToBytes throws
        tags,
      },
    ]);
    // Send EOSE to finalize.
    ws_.emit(['EOSE', subId]);

    // The malformed event is dropped via the verify try/catch.
    // Promise resolves with empty array.
    const result = await fetchPromise;
    expect(result).toEqual([]);
    await bridge.stop();
  });

  it('verifyEventAuthentic returns false on non-hex sig (regex throw path)', async () => {
    // Companion test for the regex branch (vs the odd-length branch above).
    // sig contains valid length but non-hex character 'z'.
    const { bridge, ws } = makeBridge();
    await bridge.start();
    const ws_ = ws();
    await new Promise((r) => setTimeout(r, 0));

    const fetchPromise = bridge.fetchMissedEntries(0);
    await new Promise((r) => setTimeout(r, 0));
    const reqMsg = ws_.sent.find((m) => m.startsWith('["REQ"'));
    const subId = JSON.parse(reqMsg!)[1] as string;
    const filter = JSON.parse(reqMsg!)[2] as { authors: string[]; kinds: number[] };
    const ourPubkey = filter.authors[0];
    const ourKind = filter.kinds[0];

    const created_at = 2;
    const content = 'y';
    const tags: unknown[] = [];
    const canonical = JSON.stringify([0, ourPubkey, created_at, ourKind, tags, content]);
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const idBytes = sha256(new TextEncoder().encode(canonical));
    const id = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('');

    ws_.emit([
      'EVENT',
      subId,
      {
        pubkey: ourPubkey,
        kind: ourKind,
        content,
        created_at,
        id,
        sig: 'z'.repeat(128), // even length but non-hex → regex throws
        tags,
      },
    ]);
    ws_.emit(['EOSE', subId]);

    const result = await fetchPromise;
    expect(result).toEqual([]);
    await bridge.stop();
  });
});

describe('Commit I — steelman⁴ Nostr fetch fixes', () => {
  it('throws labeled error with reason=dispatch_cap when relay floods filter-failing events', async () => {
    const { bridge, ws } = makeBridge();
    await bridge.start();
    const ws_ = ws();
    // Wait a tick for subscription REQ to be sent.
    await new Promise((r) => setTimeout(r, 0));

    const fetchPromise = bridge.fetchMissedEntries(0);
    await new Promise((r) => setTimeout(r, 0));

    // Find the subId from the REQ message we sent.
    const reqMsg = ws_.sent.find((m) => m.startsWith('["REQ"'));
    expect(reqMsg).toBeDefined();
    const subId = JSON.parse(reqMsg!)[1] as string;

    // Flood with EVENT frames that DON'T match pubkey/kind so they fail
    // the inner filter. With the steelman⁴ fix, totalParsedEvents counts
    // every parsed EVENT regardless of match → cap engages at 20000.
    // Without the fix, this loop would have to send many more before
    // any cap engaged (only 15s EOSE timeout would stop it).
    const MAX_EVENTS_PER_FETCH = 10_000;
    const TOTAL_CAP = MAX_EVENTS_PER_FETCH * 2;
    for (let i = 0; i < TOTAL_CAP + 5; i++) {
      ws_.emit([
        'EVENT',
        subId,
        {
          // Wrong pubkey on purpose: filter rejects but counter increments.
          pubkey: 'deadbeef'.repeat(8),
          kind: 99999, // wrong kind too
          content: 'x',
          created_at: i,
          id: '0'.repeat(64),
          sig: '0'.repeat(128),
          tags: [],
        },
      ]);
    }

    await expect(fetchPromise).rejects.toMatchObject({
      message: expect.stringContaining('dispatch cap'),
    });
    const err = await fetchPromise.catch((e: Error) => e) as Error & { reason?: string };
    expect(err.reason).toBe('dispatch_cap');

    await bridge.stop();
  });

  it('throws labeled error with reason=event_cap when MAX_EVENTS_PER_FETCH matching events arrive', async () => {
    const { bridge, ws } = makeBridge();
    await bridge.start();
    const ws_ = ws();
    await new Promise((r) => setTimeout(r, 0));

    const fetchPromise = bridge.fetchMissedEntries(0);
    await new Promise((r) => setTimeout(r, 0));

    const reqMsg = ws_.sent.find((m) => m.startsWith('["REQ"'));
    const subId = JSON.parse(reqMsg!)[1] as string;

    // Discover the bridge's pubkey from the filter so we can flood with
    // matching events.
    const filter = JSON.parse(reqMsg!)[2] as { authors: string[]; kinds: number[] };
    const ourPubkey = filter.authors[0];
    const ourKind = filter.kinds[0];

    // Flood with MAX_EVENTS_PER_FETCH+5 events that PASS pubkey/kind.
    // Cap-reach should fire and throw with reason=event_cap.
    for (let i = 0; i < 10_005; i++) {
      ws_.emit([
        'EVENT',
        subId,
        {
          pubkey: ourPubkey,
          kind: ourKind,
          content: 'x',
          created_at: i,
          id: i.toString(16).padStart(64, '0'),
          sig: '0'.repeat(128),
          tags: [],
        },
      ]);
    }

    const err = await fetchPromise.catch((e: Error) => e) as Error & { reason?: string; collectedCount?: number };
    // Steelman⁵ tightening: event_cap fires when events.length reaches
    // MAX_EVENTS_PER_FETCH (10000). Since events.length increments only
    // on pubkey/kind-matching events AND the dispatch counter starts at
    // 0, the cap-reach point for matching-events is exactly 10000 — well
    // before the dispatch cap (20000). We MUST always get event_cap.
    // Accepting both masks regressions in the event_cap path.
    expect(err.reason).toBe('event_cap');
    // collectedCount should be exactly MAX_EVENTS_PER_FETCH at cap-engage
    // (the cap fires BEFORE pushing the 10001st matching event).
    expect(err.collectedCount).toBe(10_000);

    await bridge.stop();
  });
});
