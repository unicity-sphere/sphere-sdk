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
