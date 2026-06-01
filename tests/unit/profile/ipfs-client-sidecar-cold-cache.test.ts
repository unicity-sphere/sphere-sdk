/**
 * Tests for the sidecar per-gateway adaptive cold-cache in
 * `profile/ipfs-client.ts`.
 *
 * Symptom motivating the cache (2026-06-01): a steady-state wallet load
 * walks an old Profile bundle, probing the sidecar for every block. Each
 * block has been promoted out of the sidecar (the sidecar correctly GCs
 * after `block_stat` confirms availability in Kubo), so every probe 404s.
 * Chrome auto-logs every non-2xx `fetch()` to the console even when the
 * JS swallows the result — producing ~100 visible failed-fetch lines per
 * load.
 *
 * Fix: after SIDECAR_COLD_MISS_THRESHOLD (3) consecutive 404s on a
 * gateway, both `tryReadFromSidecar` and `submitToSidecarBestEffort`
 * short-circuit *before* issuing the fetch, for SIDECAR_COLD_DURATION_MS
 * (60 s). A successful hit (or a 200 submit) resets the counter and
 * re-arms the fast path immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

import {
  pinToIpfs,
  fetchFromIpfs,
  _resetSidecarColdState,
} from '../../../profile/ipfs-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cidForBytes(bytes: Uint8Array): string {
  return CID.createV1(raw.code, createDigest(0x12, sha256(bytes))).toString();
}

interface RecordedFetch {
  readonly url: string;
  readonly method: string;
}

interface MockHandlers {
  pinHandler?: () => Response | Promise<Response>;
  sidecarSubmitHandler?: () => Response | Promise<Response>;
  sidecarBlobHandler?: () => Response | Promise<Response>;
  blockGetHandler?: () => Response | Promise<Response>;
}

function installFetchMock(handlers: MockHandlers): {
  recorded: RecordedFetch[];
  restore: () => void;
} {
  const recorded: RecordedFetch[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    recorded.push({ url, method });

    if (url.includes('/sidecar/submit')) {
      return (handlers.sidecarSubmitHandler ?? (() => new Response(null, { status: 404 })))();
    }
    if (url.includes('/sidecar/blob')) {
      return (handlers.sidecarBlobHandler ?? (() => new Response(null, { status: 404 })))();
    }
    if (url.includes('/api/v0/dag/put')) {
      return (
        handlers.pinHandler ??
        (() => new Response(JSON.stringify({ Cid: { '/': 'bafkqaaa' } }), { status: 200 }))
      )();
    }
    if (url.includes('/api/v0/block/get')) {
      return (handlers.blockGetHandler ?? (() => new Response(null, { status: 404 })))();
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return {
    recorded,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const GATEWAY = 'https://gw.example.test';
const THRESHOLD = 3; // matches SIDECAR_COLD_MISS_THRESHOLD

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sidecar cold-cache (2026-06-01 noise reduction)', () => {
  beforeEach(() => {
    _resetSidecarColdState();
  });

  afterEach(() => {
    _resetSidecarColdState();
  });

  // -------------------------------------------------------------------------
  // Submit path
  // -------------------------------------------------------------------------

  it('submit: short-circuits after N consecutive 404s on the gateway', async () => {
    // All submits 404. After THRESHOLD 404s the gateway is marked cold and
    // subsequent submits skip the fetch entirely.
    const { recorded, restore } = installFetchMock({
      sidecarSubmitHandler: () => new Response(null, { status: 404 }),
    });
    try {
      for (let i = 0; i < THRESHOLD + 5; i++) {
        const bytes = new TextEncoder().encode(`payload-${i}`);
        await pinToIpfs([GATEWAY], bytes);
        // Detach: submit is fire-and-forget. Yield so its .then() runs and
        // the cold-state update lands before the next iteration.
        await new Promise((r) => setTimeout(r, 5));
      }

      const submitCalls = recorded.filter((r) => r.url.includes('/sidecar/submit'));
      // Exactly THRESHOLD submits issued; the rest short-circuited.
      expect(submitCalls.length).toBe(THRESHOLD);
    } finally {
      restore();
    }
  });

  it('submit: 200 hit resets the counter so cold-state never trips', async () => {
    // Alternate hit/miss/miss — the counter resets on each hit and we
    // never accumulate THRESHOLD misses in a row.
    let n = 0;
    const { recorded, restore } = installFetchMock({
      sidecarSubmitHandler: () => {
        const ok = n % 3 === 0;
        n += 1;
        return new Response(null, { status: ok ? 200 : 404 });
      },
    });
    try {
      for (let i = 0; i < 9; i++) {
        const bytes = new TextEncoder().encode(`payload-${i}`);
        await pinToIpfs([GATEWAY], bytes);
        await new Promise((r) => setTimeout(r, 5));
      }
      const submitCalls = recorded.filter((r) => r.url.includes('/sidecar/submit'));
      // All 9 submits issued — counter never reached threshold thanks to
      // the periodic 200 reset.
      expect(submitCalls.length).toBe(9);
    } finally {
      restore();
    }
  });

  it('submit: 503/413 do NOT count as cold misses (sidecar is alive under load)', async () => {
    // 503 = cache_full back-pressure (sidecar healthy, rejecting load).
    // We must NOT cool down the gateway in this case — the next pin may
    // succeed and we want to keep the fast path enabled.
    const { recorded, restore } = installFetchMock({
      sidecarSubmitHandler: () => new Response(null, { status: 503 }),
    });
    try {
      for (let i = 0; i < THRESHOLD + 3; i++) {
        const bytes = new TextEncoder().encode(`payload-${i}`);
        await pinToIpfs([GATEWAY], bytes);
        await new Promise((r) => setTimeout(r, 5));
      }
      const submitCalls = recorded.filter((r) => r.url.includes('/sidecar/submit'));
      // All issued — 503 didn't trip the cold cache.
      expect(submitCalls.length).toBe(THRESHOLD + 3);
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  it('read: short-circuits after N consecutive 404s on the gateway', async () => {
    // All sidecar reads 404; the underlying block/get also 404s. We just
    // want to confirm /sidecar/blob is queried <=THRESHOLD times across
    // many fetches.
    const { recorded, restore } = installFetchMock({
      sidecarBlobHandler: () => new Response(null, { status: 404 }),
      blockGetHandler: () => new Response(null, { status: 404 }),
    });
    try {
      for (let i = 0; i < THRESHOLD + 5; i++) {
        const bytes = new TextEncoder().encode(`read-payload-${i}`);
        const cid = cidForBytes(bytes);
        // Each fetch will fail (no real backing store), but the test only
        // cares about the sidecar probe count.
        try {
          await fetchFromIpfs([GATEWAY], cid);
        } catch {
          /* expected — no real bytes */
        }
      }
      const sidecarReads = recorded.filter((r) => r.url.includes('/sidecar/blob'));
      expect(sidecarReads.length).toBe(THRESHOLD);
    } finally {
      restore();
    }
  });

  it('read: a hit resets the counter', async () => {
    // First 2 misses, then a real hit, then 3 more misses. The hit at
    // index 2 resets the counter, so we should see all 6 sidecar probes
    // (none short-circuited).
    let n = 0;
    const { recorded, restore } = installFetchMock({
      sidecarBlobHandler: () => {
        const idx = n;
        n += 1;
        if (idx === 2) {
          // Return real bytes that hash to a CID we know.
          const hit = new TextEncoder().encode('hit-bytes');
          return new Response(hit as BlobPart, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
        }
        return new Response(null, { status: 404 });
      },
      blockGetHandler: () => new Response(null, { status: 404 }),
    });
    try {
      // Build the CID that the hit returns, so the verifier passes on idx=2.
      const hitBytes = new TextEncoder().encode('hit-bytes');
      const hitCid = cidForBytes(hitBytes);

      for (let i = 0; i < 6; i++) {
        // Use hitCid every time so the verifyCidMatchesBytes check passes
        // on the one iteration that the mock returns hit-bytes.
        try {
          await fetchFromIpfs([GATEWAY], hitCid);
        } catch {
          /* expected for the miss iterations */
        }
      }
      const sidecarReads = recorded.filter((r) => r.url.includes('/sidecar/blob'));
      // No short-circuit: the hit at iteration 2 cleared the counter,
      // and we never accumulated 3 consecutive misses afterward.
      expect(sidecarReads.length).toBe(6);
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // Cooldown duration
  // -------------------------------------------------------------------------

  it('re-arms after the cooldown window expires', async () => {
    // Stub Date.now directly rather than via vi.useFakeTimers — the latter
    // also patches setTimeout, which conflicts with the AbortSignal.timeout
    // used inside fetch. We only need to control the cold-state clock.
    let nowMs = 1_000_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const { recorded, restore } = installFetchMock({
      sidecarBlobHandler: () => new Response(null, { status: 404 }),
      blockGetHandler: () => new Response(null, { status: 404 }),
    });
    try {
      // Burst N misses to enter cold state.
      for (let i = 0; i < THRESHOLD; i++) {
        const bytes = new TextEncoder().encode(`payload-${i}`);
        try {
          await fetchFromIpfs([GATEWAY], cidForBytes(bytes));
        } catch {
          /* expected */
        }
      }
      const beforeCooldown = recorded.filter((r) => r.url.includes('/sidecar/blob')).length;
      expect(beforeCooldown).toBe(THRESHOLD);

      // One more attempt while cold — should be short-circuited.
      try {
        await fetchFromIpfs([GATEWAY], cidForBytes(new TextEncoder().encode('coldcheck')));
      } catch {
        /* expected */
      }
      const duringCooldown = recorded.filter((r) => r.url.includes('/sidecar/blob')).length;
      expect(duringCooldown).toBe(THRESHOLD); // no new sidecar fetch

      // Advance the cold-state clock past the 60 s cooldown.
      nowMs += 61_000;

      // Now a new probe should fire (coldUntil has passed). On 404, it
      // re-enters cold state — but the probe itself counts as one new
      // sidecar fetch.
      try {
        await fetchFromIpfs([GATEWAY], cidForBytes(new TextEncoder().encode('rearm')));
      } catch {
        /* expected */
      }
      const afterCooldown = recorded.filter((r) => r.url.includes('/sidecar/blob')).length;
      expect(afterCooldown).toBe(THRESHOLD + 1);
    } finally {
      restore();
      nowSpy.mockRestore();
    }
  });
});
