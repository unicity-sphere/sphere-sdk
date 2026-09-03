/**
 * `sharedCell` — the one place SDK state is allowed to be PROCESS-wide.
 *
 * Why it exists: tsup builds every subpath export as its own bundle with
 * `splitting: false` (tsup.shared.js), so `@unicitylabs/sphere-sdk` and
 * `@unicitylabs/sphere-sdk/core` each carry a private copy of every module they
 * import — and the ESM and CJS outputs duplicate them again. Module-level state is
 * therefore per-BUNDLE. For state that answers a question about IDENTITY ("is this
 * the same backing store?", "have I seen this object?") a second copy is not a
 * cache miss, it is a WRONG ANSWER: #766's `clear()` destroying a Sphere it does not
 * own, one entry point at a time. `core/logger.ts` already stores its state on
 * globalThis for the same reason.
 *
 * Two module copies are simulated with `vi.resetModules()` + two dynamic imports.
 * That is a real second module instance in one realm sharing one globalThis — which
 * is exactly the shape of the hazard. It does NOT reproduce a second REALM (an
 * iframe, a worker): those have their own globalThis and cannot be joined by any
 * in-process mechanism, and nothing here claims otherwise.
 *
 * The key is versioned (`_v1`) because the SHAPE of the cells is not a public
 * contract: a future release that changes a cell's fields moves to `_v2` rather than
 * handing an old reader a structure it cannot use. Within a version, `intact()`
 * still re-validates — a globalThis key is reachable by any page script, so a
 * foreign or hostile value must be refused rather than adopted, and must not throw
 * on the way in. Nothing secret is ever stored: instances and counters only.
 */

import { describe, expect, it, vi } from 'vitest';

import { sharedCell } from '../../../core/global-cell';

const CELLS_KEY = '__sphere_sdk_cells_v1__';

interface Counter { n: number }

const isCounter = (candidate: object): boolean => typeof (candidate as Partial<Counter>).n === 'number';

let seq = 0;
const uniqueName = (): string => `test.cell.${++seq}`;

const host = (): Record<string, unknown> => globalThis as unknown as Record<string, unknown>;

/** The live bag, created on demand — the tests that plant a value need it to exist. */
function bag(): Record<string, unknown> {
  sharedCell<Counter>(uniqueName(), () => ({ n: 0 }), isCounter);
  return host()[CELLS_KEY] as Record<string, unknown>;
}

async function freshCopy(): Promise<typeof import('../../../core/global-cell')> {
  vi.resetModules();
  return import('../../../core/global-cell');
}

describe('sharedCell survives the bundle split', () => {
  it('hands two module copies the SAME cell', async () => {
    const copyA = await freshCopy();
    const copyB = await freshCopy();
    expect(copyA.sharedCell, 'two genuinely separate module instances').not.toBe(copyB.sharedCell);

    const name = uniqueName();
    const a = copyA.sharedCell<Counter>(name, () => ({ n: 0 }), isCounter);
    a.n = 7;
    const b = copyB.sharedCell<Counter>(name, () => ({ n: 0 }), isCounter);

    expect(b, 'the second copy must not mint its own').toBe(a);
    expect(b.n).toBe(7);
  });

  it('keeps differently-named cells apart', () => {
    const one = sharedCell<Counter>(uniqueName(), () => ({ n: 1 }), isCounter);
    const two = sharedCell<Counter>(uniqueName(), () => ({ n: 2 }), isCounter);

    expect(one).not.toBe(two);
    expect(two.n).toBe(2);
  });
});

describe('sharedCell refuses what it finds rather than trusting it', () => {
  it('replaces a cell of the wrong shape instead of handing it to the SDK', () => {
    const cells = bag();
    const name = uniqueName();
    cells[name] = { n: 'not a number' };

    const cell = sharedCell<Counter>(name, () => ({ n: 5 }), isCounter);

    expect(cell.n).toBe(5);
    expect(cells[name], 'the impostor is evicted, not left for the next reader').toBe(cell);
  });

  it('treats a validator that throws as a refusal, not a crash', () => {
    const cells = bag();
    const name = uniqueName();
    // A page script can leave anything here, including a trap that throws on read.
    cells[name] = new Proxy({}, { get(): never { throw new Error('hostile'); } });

    const cell = sharedCell<Counter>(name, () => ({ n: 3 }), isCounter);

    expect(cell.n).toBe(3);
  });

  it('keeps one stable cell per bundle when the bag itself is frozen', async () => {
    const saved = Object.getOwnPropertyDescriptor(host(), CELLS_KEY);
    try {
      // A page can freeze the bag it can reach; the write fails, and re-minting a cell
      // per CALL would hand two callers in one bundle two different registries.
      Object.defineProperty(host(), CELLS_KEY, {
        value: Object.freeze({}), writable: true, configurable: true, enumerable: false,
      });
      const copy = await freshCopy();
      const name = uniqueName();

      const first = copy.sharedCell<Counter>(name, () => ({ n: 1 }), isCounter);
      first.n = 4;
      const again = copy.sharedCell<Counter>(name, () => ({ n: 1 }), isCounter);

      expect(again).toBe(first);
      expect(again.n).toBe(4);
    } finally {
      if (saved) Object.defineProperty(host(), CELLS_KEY, saved);
      else delete host()[CELLS_KEY];
    }
  });

  it('does not crash when a non-object is sitting at the globalThis key', async () => {
    const saved = Object.getOwnPropertyDescriptor(host(), CELLS_KEY);
    try {
      Object.defineProperty(host(), CELLS_KEY, {
        value: 'hostile', writable: true, configurable: true, enumerable: false,
      });
      const copy = await freshCopy();

      const cell = copy.sharedCell<Counter>(uniqueName(), () => ({ n: 1 }), isCounter);

      expect(cell.n, 'import-time state must not depend on what the page left behind').toBe(1);
      expect(typeof host()[CELLS_KEY], 'the string was replaced by a real bag').toBe('object');
    } finally {
      if (saved) Object.defineProperty(host(), CELLS_KEY, saved);
      else delete host()[CELLS_KEY];
    }
  });
});

describe('what the cell exposes to the page', () => {
  it('is a single non-enumerable property — instances and counters, never key material', () => {
    sharedCell<Counter>(uniqueName(), () => ({ n: 0 }), isCounter);

    const descriptor = Object.getOwnPropertyDescriptor(host(), CELLS_KEY);
    expect(descriptor?.enumerable, 'not something an Object.keys(globalThis) dump walks into').toBe(false);
    expect(Object.keys(globalThis)).not.toContain(CELLS_KEY);
  });

  // LAST in the file on purpose: the key it plants cannot be made configurable again.
  it('degrades to bundle-local cells when globalThis refuses the key', async () => {
    const saved = Object.getOwnPropertyDescriptor(host(), CELLS_KEY);
    try {
      Object.defineProperty(host(), CELLS_KEY, {
        value: 'locked', writable: true, configurable: false, enumerable: false,
      });
      const copy = await freshCopy();
      const name = uniqueName();

      const first = copy.sharedCell<Counter>(name, () => ({ n: 1 }), isCounter);
      first.n = 9;
      const again = copy.sharedCell<Counter>(name, () => ({ n: 1 }), isCounter);

      expect(again, 'one stable cell per bundle is the floor, never a fresh one per call').toBe(first);
      expect(again.n).toBe(9);
      expect(host()[CELLS_KEY], 'and the host property is left exactly as it was found').toBe('locked');
    } finally {
      // Non-configurable now, but still writable: a valid bag at the key is all any
      // later caller needs, because an existing object is never re-installed.
      host()[CELLS_KEY] = saved?.value ?? {};
    }
  });
});
