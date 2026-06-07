/**
 * Tests for `profile/helia-blockstore-pin-shim.ts` (issue #311).
 *
 * Covers:
 *   - Pin shim wraps `blockstore.put` and fires `helia.pins.add` for
 *     each emitted CID.
 *   - Pin failures DO NOT propagate into the put path.
 *   - Missing `helia.pins` API is handled gracefully (warn + no-op).
 *   - Idempotent install — second install on same helia is a no-op.
 *   - `requestPersistentStorage` returns the right shape across the
 *     Node / unsupported-browser / browser surfaces.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  installHeliaBlockstorePinShim,
  requestPersistentStorage,
  type HeliaWithPinsLike,
} from '../../../profile/helia-blockstore-pin-shim';
import { logger } from '../../../core/logger';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makePinsApi(behavior: 'ok' | 'reject' | 'throw' = 'ok'): {
  api: { add: (cid: unknown) => AsyncIterable<unknown> };
  calls: () => ReadonlyArray<string>;
} {
  const calls: string[] = [];
  const api = {
    add(cid: unknown): AsyncIterable<unknown> {
      const cidStr = String(cid);
      calls.push(cidStr);
      return (async function* () {
        if (behavior === 'reject') {
          throw new Error('pin rejected');
        }
        if (behavior === 'throw') {
          // Synchronously thrown — exercise the catch branch.
          throw new Error('boom');
        }
        yield cid;
      })();
    },
  };
  return { api, calls: () => [...calls] };
}

function makeBlockstore(behavior: 'ok' | 'reject' = 'ok'): {
  bs: { put: (cid: unknown, val: unknown) => Promise<void> };
  puts: () => ReadonlyArray<string>;
} {
  const puts: string[] = [];
  return {
    bs: {
      async put(cid: unknown, _val: unknown): Promise<void> {
        if (behavior === 'reject') {
          throw new Error('put rejected');
        }
        puts.push(String(cid));
      },
    },
    puts: () => [...puts],
  };
}

function makeHelia(opts: {
  withPins?: boolean;
  pinsBehavior?: 'ok' | 'reject' | 'throw';
  blockstoreBehavior?: 'ok' | 'reject';
}): {
  helia: HeliaWithPinsLike;
  pinCalls: () => ReadonlyArray<string>;
  putCalls: () => ReadonlyArray<string>;
} {
  const pins = opts.withPins === false
    ? undefined
    : makePinsApi(opts.pinsBehavior ?? 'ok');
  const blockstore = makeBlockstore(opts.blockstoreBehavior ?? 'ok');
  return {
    helia: {
      pins: pins?.api,
      blockstore: blockstore.bs,
    },
    pinCalls: () => (pins ? pins.calls() : []),
    putCalls: () => blockstore.puts(),
  };
}

// Wait one microtask + macrotask round so fire-and-forget pin Promises
// settle before we inspect counters.
async function flushAsync(): Promise<void> {
  // Multiple ticks because schedulePin awaits the put result, then
  // calls pins.add, then drains the async iterable.
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installHeliaBlockstorePinShim', () => {
  it('pins every block written via blockstore.put', async () => {
    const { helia, pinCalls, putCalls } = makeHelia({});
    const handle = installHeliaBlockstorePinShim(helia);

    await helia.blockstore!.put!('bafyABC', new Uint8Array([1, 2]));
    await helia.blockstore!.put!('bafyDEF', new Uint8Array([3, 4]));

    await flushAsync();

    expect(putCalls()).toEqual(['bafyABC', 'bafyDEF']);
    expect(pinCalls()).toEqual(['bafyABC', 'bafyDEF']);
    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(2);
    expect(counters.pinSucceeded).toBe(2);
    expect(counters.pinFailed).toBe(0);
    expect(handle.getPinnedCids()).toEqual(
      expect.arrayContaining(['bafyABC', 'bafyDEF']),
    );
  });

  it('pin rejection does NOT break the underlying put', async () => {
    const { helia, putCalls } = makeHelia({ pinsBehavior: 'reject' });
    const handle = installHeliaBlockstorePinShim(helia);

    // Should resolve cleanly even though pin rejects.
    await expect(
      helia.blockstore!.put!('bafyZZZ', new Uint8Array([7])),
    ).resolves.toBeUndefined();
    expect(putCalls()).toEqual(['bafyZZZ']);

    await flushAsync();
    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(1);
    expect(counters.pinSucceeded).toBe(0);
    expect(counters.pinFailed).toBe(1);
  });

  it('missing helia.pins is handled gracefully (no wrap)', async () => {
    const { helia, putCalls, pinCalls } = makeHelia({ withPins: false });
    const handle = installHeliaBlockstorePinShim(helia);

    await helia.blockstore!.put!('bafyXXX', new Uint8Array([1]));
    await flushAsync();

    expect(putCalls()).toEqual(['bafyXXX']);
    expect(pinCalls()).toEqual([]);
    // No pin attempts recorded when API is missing.
    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(0);
  });

  it('skips pin when underlying put rejects', async () => {
    const { helia } = makeHelia({ blockstoreBehavior: 'reject' });
    const handle = installHeliaBlockstorePinShim(helia);

    await expect(
      helia.blockstore!.put!('bafyREJ', new Uint8Array([1])),
    ).rejects.toThrow('put rejected');

    await flushAsync();
    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(1);
    // Pin was skipped because put rejected — bookkeeping reflects that.
    expect(counters.pinSucceeded).toBe(0);
    expect(counters.pinSkipped).toBeGreaterThanOrEqual(1);
  });

  it('second install on same helia is a no-op', async () => {
    const { helia, pinCalls } = makeHelia({});
    installHeliaBlockstorePinShim(helia);
    const putRef1 = helia.blockstore!.put;
    installHeliaBlockstorePinShim(helia);
    const putRef2 = helia.blockstore!.put;
    expect(putRef1).toBe(putRef2);

    await helia.blockstore!.put!('bafyDEDUP', new Uint8Array([1]));
    await flushAsync();
    // Only one pin call, not two.
    expect(pinCalls()).toEqual(['bafyDEDUP']);
  });

  it('skips pin for empty / non-string CID', async () => {
    const { helia, pinCalls } = makeHelia({});
    const handle = installHeliaBlockstorePinShim(helia);

    // Empty string after toString → skipped.
    await helia.blockstore!.put!({ toString: () => '' }, new Uint8Array([1]));
    await flushAsync();
    expect(pinCalls()).toEqual([]);
    const counters = handle.getCounters();
    expect(counters.pinSkipped).toBeGreaterThanOrEqual(1);
  });

  // Issue #330 follow-up — silence "Already pinned" noise.
  // When OrbitDB replays its OpLog, every block touched fires
  // `blockstore.put` again, which in turn fires `helia.pins.add`. Helia
  // rejects the second add with "Already pinned" — that's the EXPECTED
  // outcome for a CID we already pinned. Pre-fix this produced hundreds
  // of warn-log entries per second, freezing the page in DevTools. The
  // fix has two parts:
  //   1. Skip the `pins.add` round-trip when the in-memory Set already
  //      tracks the CID (saves the network/datastore call entirely).
  //   2. Catch the "Already pinned" error from helia and treat it as
  //      success without a warn (covers the case where the Set was
  //      reset by a destroy/reconnect but helia's pin records survive).
  it('pre-checks in-memory tracker and skips redundant pins.add calls', async () => {
    const { helia, pinCalls } = makeHelia({});
    const handle = installHeliaBlockstorePinShim(helia);

    await helia.blockstore!.put!('bafyAAA', new Uint8Array([1]));
    await flushAsync();
    // Same CID written again — pre-check should short-circuit.
    await helia.blockstore!.put!('bafyAAA', new Uint8Array([1]));
    await flushAsync();
    await helia.blockstore!.put!('bafyAAA', new Uint8Array([1]));
    await flushAsync();

    // Only ONE pins.add call should reach the API, even though put was
    // called three times for the same CID.
    expect(pinCalls()).toEqual(['bafyAAA']);
    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(3);
    expect(counters.pinSucceeded).toBe(3);
    expect(counters.pinFailed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Issue #419 — pin shim must pass `{ depth: 0 }` so Helia does NOT
  // walk descendants. Default `pins.add` is `depth: Infinity`, which
  // makes Helia decode each pinned block and walk its CID-link
  // descendants. Descendants that aren't yet on disk fall through to
  // Bitswap and time out — the failure surfaces as
  // `helia.pins.add failed for X: Failed to load block for Y` warnings
  // (X != Y). The shim's contract is "pin individual leaf blocks at
  // write time"; depth: 0 aligns Helia with that contract.
  // -------------------------------------------------------------------------

  it('invokes pins.add with { depth: 0 } so Helia does NOT walk descendants', async () => {
    const optionsSeen: unknown[] = [];
    const blockstore = makeBlockstore('ok');
    const pinsApi = {
      add(cid: unknown, options?: unknown): AsyncIterable<unknown> {
        optionsSeen.push(options);
        return (async function* () {
          yield cid;
        })();
      },
    };
    const helia: HeliaWithPinsLike = {
      blockstore: blockstore.bs,
      pins: pinsApi,
    };
    installHeliaBlockstorePinShim(helia);

    await helia.blockstore!.put!('bafyDEPTH', new Uint8Array([1]));
    await flushAsync();

    expect(optionsSeen.length).toBe(1);
    expect(optionsSeen[0]).toMatchObject({ depth: 0 });
  });

  it('survives a Helia stub that throws when asked to walk descendants', async () => {
    // Simulate Helia v6's real behaviour without depth: 0 — `pins.add`
    // walks the DAG, fails to load a referenced descendant, and throws
    // "Failed to load block for <child cid>". With our depth: 0 fix the
    // PRODUCTION Helia would not even attempt the walk, but a strict
    // stub helps us verify the shim's failure path stays well-behaved
    // (counters increment correctly, warn fires, put never throws).
    const blockstore = makeBlockstore('ok');
    const pinsApi = {
      add(_cid: unknown, _options?: unknown): AsyncIterable<unknown> {
        return (async function* () {
          throw new Error('Failed to load block for bafy_descendant');
           
          yield _cid;
        })();
      },
    };
    const helia: HeliaWithPinsLike = {
      blockstore: blockstore.bs,
      pins: pinsApi,
    };
    const handle = installHeliaBlockstorePinShim(helia);

    // Put MUST resolve cleanly even though pin descends-and-fails.
    await expect(
      helia.blockstore!.put!('bafyROOT', new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await flushAsync();

    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(1);
    expect(counters.pinSucceeded).toBe(0);
    expect(counters.pinFailed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Issue #419 — one-shot Helia config snapshot on FIRST pin failure.
  // Each subsequent failure must NOT re-emit the snapshot (otherwise it
  // floods the log just like the bare "Failed to load block" warnings
  // it's supposed to disambiguate).
  // -------------------------------------------------------------------------

  it('emits a Helia config snapshot exactly ONCE across many pin failures', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const blockstore = makeBlockstore('ok');
      const pinsApi = {
        add(_cid: unknown, _options?: unknown): AsyncIterable<unknown> {
          return (async function* () {
            throw new Error('Failed to load block for bafy_descendant');
             
            yield _cid;
          })();
        },
      };
      const helia: HeliaWithPinsLike = {
        blockstore: blockstore.bs,
        pins: pinsApi,
      };
      installHeliaBlockstorePinShim(helia);

      for (let i = 0; i < 5; i++) {
        await helia.blockstore!.put!(`bafyDUMP${i}`, new Uint8Array([i]));
      }
      await flushAsync();

      // Per-failure warn fires 5×; snapshot fires once.
      const snapshotLogs = warnSpy.mock.calls.filter((call) => {
        const msg = call[1];
        return typeof msg === 'string' && msg.includes('helia config snapshot');
      });
      expect(snapshotLogs.length).toBe(1);

      // The snapshot line should mention the structural fields we
      // promised in the doc-comment: blockstore, pins, libp2p,
      // peerCount. Failure to include them makes the diagnostic
      // surface less useful in production triage.
      const snapshotMsg = snapshotLogs[0][1] as string;
      expect(snapshotMsg).toMatch(/blockstore=/);
      expect(snapshotMsg).toMatch(/pins=/);
      expect(snapshotMsg).toMatch(/libp2p=(present|absent|unknown)/);
      expect(snapshotMsg).toMatch(/peerCount=/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT emit a config snapshot when "Already pinned" is the only failure surface', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const blockstore = makeBlockstore('ok');
      const pinsApi = {
        add(_cid: unknown, _options?: unknown): AsyncIterable<unknown> {
          return (async function* () {
            throw new Error('Already pinned');
             
            yield _cid;
          })();
        },
      };
      const helia: HeliaWithPinsLike = {
        blockstore: blockstore.bs,
        pins: pinsApi,
      };
      installHeliaBlockstorePinShim(helia);

      await helia.blockstore!.put!('bafyDUP', new Uint8Array([1]));
      await flushAsync();

      const snapshotLogs = warnSpy.mock.calls.filter((call) => {
        const msg = call[1];
        return typeof msg === 'string' && msg.includes('helia config snapshot');
      });
      // "Already pinned" classifies as success — the failure branch
      // never runs, and the snapshot stays silent.
      expect(snapshotLogs.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reflects an HTTP-only Helia (no libp2p) in the snapshot', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const blockstore = makeBlockstore('ok');
      const pinsApi = {
        add(_cid: unknown, _options?: unknown): AsyncIterable<unknown> {
          return (async function* () {
            throw new Error('something broke');
             
            yield _cid;
          })();
        },
      };
      // Helia handle WITHOUT a libp2p field — issue #266 HTTP-only mode.
      const helia: HeliaWithPinsLike = {
        blockstore: blockstore.bs,
        pins: pinsApi,
      };
      installHeliaBlockstorePinShim(helia);

      await helia.blockstore!.put!('bafyHTTP', new Uint8Array([1]));
      await flushAsync();

      const snapshotMsg = warnSpy.mock.calls.find((call) => {
        const msg = call[1];
        return typeof msg === 'string' && msg.includes('helia config snapshot');
      })?.[1] as string | undefined;
      expect(snapshotMsg).toBeTruthy();
      expect(snapshotMsg!).toMatch(/libp2p=absent/);
      expect(snapshotMsg!).toMatch(/peerCount=unknown/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reflects a libp2p-equipped Helia (with peers) in the snapshot', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const blockstore = makeBlockstore('ok');
      const pinsApi = {
        add(_cid: unknown, _options?: unknown): AsyncIterable<unknown> {
          return (async function* () {
            throw new Error('something broke');
             
            yield _cid;
          })();
        },
      };
      const heliaWithLibp2p = {
        blockstore: blockstore.bs,
        pins: pinsApi,
        libp2p: {
          getPeers: () => ['peer1', 'peer2', 'peer3'],
        },
      };
      installHeliaBlockstorePinShim(heliaWithLibp2p as unknown as HeliaWithPinsLike);

      await (heliaWithLibp2p.blockstore as { put: (cid: unknown, val: unknown) => Promise<void> })
        .put('bafyP2P', new Uint8Array([1]));
      await flushAsync();

      const snapshotMsg = warnSpy.mock.calls.find((call) => {
        const msg = call[1];
        return typeof msg === 'string' && msg.includes('helia config snapshot');
      })?.[1] as string | undefined;
      expect(snapshotMsg).toBeTruthy();
      expect(snapshotMsg!).toMatch(/libp2p=present/);
      expect(snapshotMsg!).toMatch(/peerCount=3/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('treats "Already pinned" from helia.pins.add as success (no warn)', async () => {
    // Custom pins API: throws "Already pinned" — simulates the helia
    // pin-tracker survived state where the in-memory Set was cleared
    // but the pin record persisted.
    const pinsApi = {
      add(cid: unknown): AsyncIterable<unknown> {
        return (async function* () {
          throw new Error('Already pinned');
           
          yield cid;
        })();
      },
    };
    const blockstore = makeBlockstore('ok');
    const helia: HeliaWithPinsLike = {
      blockstore: blockstore.bs,
      pins: pinsApi,
    } as unknown as HeliaWithPinsLike;
    const handle = installHeliaBlockstorePinShim(helia);

    await helia.blockstore!.put!('bafyDUP', new Uint8Array([1]));
    await flushAsync();

    const counters = handle.getCounters();
    expect(counters.pinAttempted).toBe(1);
    // Should be counted as SUCCESS, not failure.
    expect(counters.pinSucceeded).toBe(1);
    expect(counters.pinFailed).toBe(0);
    // CID is now tracked in the in-memory set.
    expect(handle.getPinnedCids()).toContain('bafyDUP');
  });
});

// ---------------------------------------------------------------------------
// requestPersistentStorage()
// ---------------------------------------------------------------------------

describe('requestPersistentStorage', () => {
  // Capture the original globalThis.navigator descriptor so we can
  // restore it after each test. Some test runners pre-populate navigator
  // with a jsdom shim; we override it case-by-case here.
  const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    if (origDescriptor) {
      Object.defineProperty(globalThis, 'navigator', origDescriptor);
    } else {
      // Eslint: navigator is on globalThis as `navigator` per the DOM lib.
      // Remove it cleanly.
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('returns { granted: false, supported: false } when navigator is undefined', async () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    const result = await requestPersistentStorage();
    expect(result).toEqual({ granted: false, supported: false });
  });

  it('returns { granted: false, supported: false } when navigator.storage.persist is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { /* no persist */ } },
      configurable: true,
    });
    const result = await requestPersistentStorage();
    expect(result).toEqual({ granted: false, supported: false });
  });

  it('returns { granted: true, supported: true } when persist resolves true', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          persist: vi.fn().mockResolvedValue(true),
        },
      },
      configurable: true,
    });
    const result = await requestPersistentStorage();
    expect(result).toEqual({ granted: true, supported: true });
  });

  it('returns { granted: false, supported: true } when persist resolves false', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          persist: vi.fn().mockResolvedValue(false),
        },
      },
      configurable: true,
    });
    const result = await requestPersistentStorage();
    expect(result).toEqual({ granted: false, supported: true });
  });

  it('returns { granted: false, supported: true } when persist throws', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          persist: vi.fn().mockRejectedValue(new Error('permissions policy denied')),
        },
      },
      configurable: true,
    });
    const result = await requestPersistentStorage();
    expect(result).toEqual({ granted: false, supported: true });
  });
});
