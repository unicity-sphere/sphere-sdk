/**
 * Tests for core/timeout.ts (timeoutSignal).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { timeoutSignal } from '../../../core/timeout';

describe('timeoutSignal()', () => {
  it('returns a non-aborted AbortSignal on the native fast-path', () => {
    const signal = timeoutSignal(1000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  // sphere-sdk#617: iOS 15 / older Android WebViews / in-app browsers lack
  // AbortSignal.timeout. Before the fix the call sites threw
  // "AbortSignal.timeout is not a function" and Swap / Top Up crashed.
  describe('fallback path (runtime without AbortSignal.timeout)', () => {
    let original: typeof AbortSignal.timeout;

    beforeEach(() => {
      original = AbortSignal.timeout;
      // Simulate an engine that does not implement AbortSignal.timeout.
      Object.defineProperty(AbortSignal, 'timeout', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(AbortSignal, 'timeout', {
        value: original,
        configurable: true,
        writable: true,
      });
    });

    it('does not throw and returns a working AbortSignal when the native API is absent', () => {
      expect(typeof AbortSignal.timeout).not.toBe('function');
      const signal = timeoutSignal(50);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('aborts once the timeout elapses, with a TimeoutError reason matching native semantics', () => {
      const signal = timeoutSignal(50);
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(49);
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe('TimeoutError');
    });
  });
});
