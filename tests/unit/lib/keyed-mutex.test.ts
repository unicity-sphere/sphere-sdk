import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../../../lib/concurrency/keyed-mutex';

describe('lib/concurrency/keyed-mutex', () => {
  it('serializes concurrent calls with the same key', async () => {
    const mu = new KeyedMutex();
    const seen: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const task = async (tag: string) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(r => setTimeout(r, 10));
      seen.push(tag);
      inFlight--;
    };
    await Promise.all([
      mu.withLock('token-A', () => task('A1')),
      mu.withLock('token-A', () => task('A2')),
      mu.withLock('token-A', () => task('A3')),
    ]);
    expect(seen).toEqual(['A1', 'A2', 'A3']);
    expect(maxConcurrent).toBe(1);
  });

  it('runs different keys concurrently', async () => {
    const mu = new KeyedMutex();
    let concurrentPeak = 0;
    let inFlight = 0;
    const task = async () => {
      inFlight++;
      concurrentPeak = Math.max(concurrentPeak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all([
      mu.withLock('A', task),
      mu.withLock('B', task),
      mu.withLock('C', task),
    ]);
    expect(concurrentPeak).toBeGreaterThanOrEqual(2);
  });

  it('releases lock on exception', async () => {
    const mu = new KeyedMutex();
    await expect(
      mu.withLock('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Second call must be able to acquire.
    const result = await mu.withLock('k', async () => 42);
    expect(result).toBe(42);
  });
});
