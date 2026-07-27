/**
 * The single convergence point for every host-side exit: router resolved, router threw,
 * onIntent settled, deadline, setLocked, revokeSession, setUnavailable, destroy.
 *
 * The whole "exactly one frame per id" mechanism is settle() returning null the second
 * time — the caller MUST then send nothing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { InFlightRegistry } from '../../../connect/host/InFlightRegistry';
import type { InFlightEntry } from '../../../connect/host/InFlightRegistry';

afterEach(() => { vi.useRealTimers(); });

function make(onExpire = vi.fn()) {
  return { reg: new InFlightRegistry({ onExpire }), onExpire };
}

describe('InFlightRegistry', () => {
  it('starts empty', () => {
    const { reg } = make();
    expect(reg.size).toBe(0);
    expect(reg.has('nope')).toBe(false);
  });

  it('add() registers, arms a deadline and hands back an AbortController', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { reg } = make();

    const entry = reg.add('a', 'query', 25_000);

    expect(entry.id).toBe('a');
    expect(entry.kind).toBe('query');
    expect(entry.deadline).toBe(1_000_000 + 25_000);
    expect(entry.controller.signal.aborted).toBe(false);
    expect(reg.size).toBe(1);
    expect(reg.has('a')).toBe(true);
  });

  it('settle() removes, aborts and returns the entry exactly once', () => {
    const { reg } = make();
    const entry = reg.add('a', 'query', 25_000);

    const first = reg.settle('a');
    expect(first).toBe(entry);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(reg.size).toBe(0);

    // The whole "exactly one frame per id" mechanism.
    expect(reg.settle('a')).toBeNull();
  });

  it('settle() on an unknown id returns null and does not throw', () => {
    const { reg } = make();
    expect(reg.settle('ghost')).toBeNull();
  });

  it('the deadline aborts, removes and calls onExpire — once', () => {
    vi.useFakeTimers();
    const { reg, onExpire } = make();
    const entry = reg.add('a', 'intent', 90_000);

    vi.advanceTimersByTime(90_001);

    expect(onExpire).toHaveBeenCalledTimes(1);
    const expired = onExpire.mock.calls[0][0] as InFlightEntry;
    expect(expired.id).toBe('a');
    expect(expired.kind).toBe('intent');
    // It must CANCEL, not merely answer: a host that answers while the wallet modal is
    // still on screen creates a double-submit.
    expect(entry.controller.signal.aborted).toBe(true);
    expect(reg.size).toBe(0);
    expect(reg.settle('a')).toBeNull();
  });

  it('a settled entry never expires afterwards', () => {
    vi.useFakeTimers();
    const { reg, onExpire } = make();
    reg.add('a', 'query', 25_000);

    reg.settle('a');
    vi.advanceTimersByTime(60_000);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('settleAll() returns every entry in insertion order, aborted and emptied', () => {
    vi.useFakeTimers();
    const { reg, onExpire } = make();
    reg.add('a', 'query', 25_000);
    reg.add('b', 'intent', 90_000);
    reg.add('c', 'query', 25_000);

    const all = reg.settleAll();

    expect(all.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(all.every((e) => e.controller.signal.aborted)).toBe(true);
    expect(reg.size).toBe(0);

    vi.advanceTimersByTime(120_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('a duplicate id reuses the existing entry instead of arming a second timer', () => {
    vi.useFakeTimers();
    const { reg, onExpire } = make();
    const first = reg.add('a', 'query', 25_000);

    const second = reg.add('a', 'query', 25_000);

    expect(second).toBe(first);
    expect(reg.size).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('destroy() clears every timer WITHOUT invoking onExpire', () => {
    vi.useFakeTimers();
    const { reg, onExpire } = make();
    reg.add('a', 'query', 25_000);
    reg.add('b', 'intent', 90_000);

    reg.destroy();

    expect(reg.size).toBe(0);
    vi.advanceTimersByTime(200_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('never awaits — add/settle/settleAll are synchronous', () => {
    const { reg } = make();
    const entry = reg.add('a', 'query', 25_000);
    expect(entry).not.toBeInstanceOf(Promise);
    expect(reg.settle('a')).not.toBeInstanceOf(Promise);
    expect(reg.settleAll()).toEqual([]);
  });
});
