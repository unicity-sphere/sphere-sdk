import { describe, it, expect } from 'vitest';
import { nextBackoffMs, abortableSleep } from '../../../lib/time/backoff';

describe('lib/time/backoff', () => {
  it('nextBackoffMs grows exponentially without jitter', () => {
    const a = nextBackoffMs(1, { baseMs: 100, factor: 2, jitter: 0 });
    const b = nextBackoffMs(2, { baseMs: 100, factor: 2, jitter: 0 });
    const c = nextBackoffMs(3, { baseMs: 100, factor: 2, jitter: 0 });
    expect(a).toBe(100);
    expect(b).toBe(200);
    expect(c).toBe(400);
  });

  it('nextBackoffMs caps at maxMs', () => {
    const v = nextBackoffMs(10, { baseMs: 1000, factor: 2, maxMs: 5000, jitter: 0 });
    expect(v).toBe(5000);
  });

  it('nextBackoffMs applies bounded jitter', () => {
    const raw = 1000;
    for (let i = 0; i < 20; i++) {
      const v = nextBackoffMs(1, { baseMs: raw, jitter: 0.2 });
      // ±20% of 1000 = 800..1200
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it('abortableSleep resolves after ms elapsed', async () => {
    const t0 = Date.now();
    await abortableSleep(20);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(15);
  });

  it('abortableSleep rejects on abort', async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('abortableSleep rejects immediately if already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10_000, ac.signal)).rejects.toThrow(/aborted/i);
  });
});
