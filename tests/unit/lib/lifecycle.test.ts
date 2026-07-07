import { describe, it, expect } from 'vitest';
import { ModuleLifecycle } from '../../../lib/module/lifecycle';

describe('lib/module/lifecycle', () => {
  it('coalesces concurrent load() calls', async () => {
    const lc = new ModuleLifecycle();
    let runs = 0;
    const runner = async () => {
      runs++;
      await new Promise(r => setTimeout(r, 5));
    };
    await Promise.all([lc.load(runner), lc.load(runner), lc.load(runner)]);
    expect(runs).toBe(1);
    expect(lc.isLoaded).toBe(true);
  });

  it('is a no-op when already loaded', async () => {
    const lc = new ModuleLifecycle();
    let runs = 0;
    await lc.load(async () => {
      runs++;
    });
    await lc.load(async () => {
      runs++;
    });
    expect(runs).toBe(1);
  });

  it('allows retry after a failed load', async () => {
    const lc = new ModuleLifecycle();
    await expect(
      lc.load(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lc.isLoaded).toBe(false);
    await lc.load(async () => {
      /* ok */
    });
    expect(lc.isLoaded).toBe(true);
  });

  it('ensureInitialized throws before initialize, then succeeds', () => {
    const lc = new ModuleLifecycle();
    expect(() => lc.ensureInitialized('Test')).toThrow(/Test not initialized/);
    lc.markInitialized();
    expect(() => lc.ensureInitialized('Test')).not.toThrow();
  });

  it('ensureNotDestroyed throws once destroyed', () => {
    const lc = new ModuleLifecycle();
    lc.markDestroyed();
    expect(() => lc.ensureNotDestroyed('Test')).toThrow(/Test has been destroyed/);
  });
});
