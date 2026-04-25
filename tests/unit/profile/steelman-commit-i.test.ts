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
import { NostrReplicationBridge } from '../../../profile/nostr-replication';

// ---------------------------------------------------------------------------
// Minimal fake WebSocket implementation
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 1;
  url: string;
  binaryType: 'arraybuffer' = 'arraybuffer';
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

describe('Commit J — steelman⁵ hexToBytes validates input', () => {
  it('verifyEventAuthentic returns false on malformed hex (does not throw / does not silently produce zero bytes)', async () => {
    // Build a bridge with a synthetic event whose `sig`/`id`/`pubkey` are
    // malformed hex. Steelman⁵: hexToBytes now throws, the surrounding
    // try/catch in verifyEventAuthentic returns false. Pre-J the silent
    // zero-coercion would let the schnorr.verify call see an attacker-
    // controlled wrong-shape buffer.
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

    // Send one event with malformed-hex sig (odd length 127 chars).
    ws_.emit([
      'EVENT',
      subId,
      {
        pubkey: ourPubkey,
        kind: ourKind,
        content: 'x',
        created_at: 1,
        id: '0'.repeat(64),
        sig: '0'.repeat(127), // odd length → hexToBytes throws
        tags: [],
      },
    ]);
    // Send EOSE to finalize.
    ws_.emit(['EOSE', subId]);

    // The malformed event is dropped silently by verify (try/catch).
    // Promise resolves with empty array (only the EOSE-collected events).
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
