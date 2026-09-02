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

import { parseTrackedAddresses } from '../../../storage/tracked-addresses';

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
