/**
 * `parseTrackedAddresses` is deliberately REPAIRING — an odd `hidden` or a missing
 * timestamp must not delete one of the user's addresses. The index is the single
 * exception, and it is a money-safety one: the address path is rebuilt as
 * `.../${index}` and `deriveKeyAtPath` parseInt()s that segment (core/crypto.ts), so a
 * stored `1.5` derives index 1's keys and the row ALIASES a real address — a second
 * registry entry, with its own hidden flag and timestamps, silently steering funds at
 * an address the user already has. Negatives and NaN have no valid derivation at all.
 *
 * `Number.isFinite` accepted every one of those.
 */
import { describe, expect, it } from 'vitest';

import { SphereError } from '../../../core/errors';
import { mergeTrackedAddresses, parseTrackedAddresses } from '../../../storage/tracked-addresses';
import type { TrackedAddressEntry } from '../../../types';

function stored(...addresses: unknown[]): string {
  return JSON.stringify({ version: 1, addresses });
}

describe('parseTrackedAddresses — the index must be a non-negative integer', () => {
  it('drops a fractional index rather than letting it alias a real address', () => {
    // parseInt('1.5') === 1: this row would derive index 1's keys.
    const parsed = parseTrackedAddresses(
      stored(
        { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 1, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 1.5, hidden: true, createdAt: 2, updatedAt: 2 },
      ),
    );

    expect(parsed.map((e) => e.index)).toEqual([0, 1]);
  });

  it('drops a negative index', () => {
    const parsed = parseTrackedAddresses(
      stored(
        { index: -1, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
      ),
    );

    expect(parsed.map((e) => e.index)).toEqual([0]);
  });

  it('drops the whole rejection set at once, keeping only the valid rows', () => {
    // The fractional and negative cases again, now beside every other shape an index
    // can arrive in. A NaN index cannot round-trip — JSON.stringify writes it as null —
    // but an overflowing literal can: JSON.parse('1e999') is Infinity.
    expect(JSON.parse(stored({ index: NaN })).addresses[0].index).toBeNull();
    const row = (index: string): string =>
      `{"index":${index},"hidden":false,"createdAt":1,"updatedAt":1}`;
    const parsed = parseTrackedAddresses(
      `{"version":1,"addresses":[${[
        row('1.5'),
        row('-1'),
        row('null'), // what a NaN write leaves behind
        row('1e999'), // Infinity
        row('"2"'), // a number-shaped string
        '{"hidden":false,"createdAt":1,"updatedAt":1}', // no index at all
        row('0'),
        row('2'),
      ].join(',')}]}`,
    );

    expect(parsed.map((e) => e.index)).toEqual([0, 2]);
  });

  it('keeps every integer index, including 0', () => {
    const parsed = parseTrackedAddresses(
      stored(
        { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 7, hidden: true, createdAt: 2, updatedAt: 3 },
      ),
    );

    expect(parsed).toEqual([
      { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
      { index: 7, hidden: true, createdAt: 2, updatedAt: 3 },
    ]);
  });

  it('keeps unknown extra fields on a valid row — a newer writer own columns survive', () => {
    // A row written by a future version must round-trip through an older reader, or the
    // merge-on-write turns every save by this Sphere into a downgrade of the other one.
    const parsed = parseTrackedAddresses(
      stored({ index: 3, hidden: false, createdAt: 1, updatedAt: 1, label: 'savings', pinned: true }),
    );

    expect(parsed).toEqual([
      { index: 3, hidden: false, createdAt: 1, updatedAt: 1, label: 'savings', pinned: true },
    ]);
  });
});

/**
 * The ceiling half of the same guard. `deriveChildKey` (core/crypto.ts) serializes the
 * child number as `index.toString(16).padStart(8, '0')` — and `padStart` only ever ADDS
 * characters. An index above 0xffffffff therefore emits MORE than eight hex digits and
 * pushes extra bytes into the HMAC input: the derivation silently stops being BIP32, with
 * no error and no log, producing a key no other wallet implementation can reproduce.
 * (2**53-1 survives a JSON round-trip intact, so this is reachable from stored data.)
 *
 * Each clause is pinned on its own so a regression names itself: dropping `<= 0xffffffff`
 * must red only the over-range row, dropping `>= 0` only the negative one.
 */
describe('parseTrackedAddresses — the index must fit a BIP32 child number (uint32)', () => {
  it('keeps 0xffffffff — the largest child number BIP32 can express', () => {
    const parsed = parseTrackedAddresses(
      stored({ index: 0xffffffff, hidden: false, createdAt: 1, updatedAt: 1 }),
    );

    expect(parsed.map((e) => e.index)).toEqual([4294967295]);
  });

  it('keeps 0x80000000 — a hardened index is legal, not out of range', () => {
    // deriveChildKey treats >= 0x80000000 as hardened derivation; the whole hardened
    // half of the range is valid, so a ceiling set at the threshold would delete
    // addresses the wallet can perfectly well derive.
    const parsed = parseTrackedAddresses(
      stored({ index: 0x80000000, hidden: false, createdAt: 1, updatedAt: 1 }),
    );

    expect(parsed.map((e) => e.index)).toEqual([2147483648]);
  });

  it('drops 0x100000000 — one past the ceiling, where the child number grows a 9th digit', () => {
    // (0x100000000).toString(16) === '100000000': nine hex digits, one whole byte more
    // than BIP32's serialization allows.
    expect((0x100000000).toString(16).padStart(8, '0')).toHaveLength(9);

    const parsed = parseTrackedAddresses(
      stored(
        { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 0x100000000, hidden: false, createdAt: 2, updatedAt: 2 },
      ),
    );

    expect(parsed.map((e) => e.index)).toEqual([0]);
  });

  it('keeps 0 — the floor is inclusive, and the ceiling check must not swallow it', () => {
    const parsed = parseTrackedAddresses(
      stored({ index: 0, hidden: false, createdAt: 1, updatedAt: 1 }),
    );

    expect(parsed.map((e) => e.index)).toEqual([0]);
  });
});

/**
 * The same rule on the WRITE, where it is a refusal rather than a drop.
 *
 * Enforced only on read, `saveTrackedAddresses([{ index: 1.5, ... }])` STORED the row and
 * reported success; the next load silently dropped it, so the address the caller believes
 * it activated is simply absent — and before any of that, the live Sphere derives index 1's
 * keys for it. Dropping the row here instead of throwing would keep the false success.
 */
describe('mergeTrackedAddresses — an underivable incoming index refuses the write', () => {
  const ok = (index: number): TrackedAddressEntry =>
    ({ index, hidden: false, createdAt: 1, updatedAt: 1 });
  const bad = (index: unknown): TrackedAddressEntry =>
    ({ index, hidden: false, createdAt: 1, updatedAt: 1 }) as unknown as TrackedAddressEntry;

  it.each([
    ['a fractional index, which parseInt()s onto another address', 1.5],
    ['a negative index, which has no BIP32 derivation at all', -1],
    ['one past the uint32 ceiling, where the child number grows a 9th hex digit', 0x100000000],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string, which Number.isInteger rejects', '1'],
    ['undefined', undefined],
  ])('refuses %s', (_why, index) => {
    expect(() => mergeTrackedAddresses([ok(0)], [bad(index)])).toThrow(
      /not a BIP32 child number/,
    );
  });

  it('refuses with a typed VALIDATION_ERROR, so a caller can tell it from a disk failure', () => {
    try {
      mergeTrackedAddresses([], [bad(1.5)]);
      expect.unreachable('the merge must not accept an underivable index');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('VALIDATION_ERROR');
      expect((err as SphereError).message).toContain('1.5');
    }
  });

  it('refuses the WHOLE call, so no half-written registry reaches the store', () => {
    // The good rows travel with the bad one; returning them would let the provider
    // persist a partial snapshot and call the save a success.
    expect(() => mergeTrackedAddresses([ok(0)], [ok(1), bad(2.5), ok(3)])).toThrow(SphereError);
  });

  it('accepts the whole legal range — 0, hardened, and 0xffffffff', () => {
    const merged = mergeTrackedAddresses([], [ok(0), ok(0x80000000), ok(0xffffffff)]);
    expect(merged.map((e) => e.index)).toEqual([0, 2147483648, 4294967295]);
  });

  it('FILTERS a bad row already on disk instead of refusing, so one cannot brick writes', () => {
    // Stored rows are read tolerantly; throwing on them would make every later write of a
    // legitimate address fail for as long as the bad row sits in the file.
    const merged = mergeTrackedAddresses([bad(1.5), ok(0)], [ok(1)]);
    expect(merged.map((e) => e.index)).toEqual([0, 1]);
  });
});
