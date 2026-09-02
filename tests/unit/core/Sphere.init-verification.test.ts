/**
 * `Sphere.init({ verification })` reaches the Sphere-OWNED engine (#769.2).
 *
 * init() does not build the engine itself — it dispatches to load() or create()
 * depending on whether a wallet already exists, and each call site lists the
 * options it forwards by hand. The option was silently dropped there, so a
 * consumer opting into the worker pool at the documented entry point got the
 * sequential verifier with no error and no log.
 *
 * The existing worker-pool suite (tests/unit/token-engine/worker-verification.test.ts)
 * builds the engine DIRECTLY, so it cannot see a forwarding hole: both branches
 * are pinned here instead, because forgetting one is exactly the shape of the bug.
 *
 * The discriminator is which verifier the engine ends up holding. A probe token is
 * not a real SDK token, so the pool verifier rejects while `Token.verify` (the
 * sequential path, which the probe stubs) resolves — the control cases show the
 * probe really does answer differently either way, so a rejection here means the
 * pool, not an unrelated failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sphere, type SphereInitOptions } from '../../../core/Sphere';
import type { OracleProvider } from '../../../oracle';
import type { TransportProvider } from '../../../transport';
import type { ITokenEngine, SphereToken, VerificationWorker } from '../../../token-engine';
import { VerificationStatus } from '../../../token-engine/sdk';
import { TEST_NETWORK } from '../../test-network';
import { makeMockProviders } from './support/mock-providers';

/** Never actually spawned: the pool rejects a probe token before it acquires a worker. */
class NoopWorker implements VerificationWorker {
  onerror: ((event: { message: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

/** The engine Sphere built for the active address — the thing money operations use. */
function engineOf(sphere: Sphere): ITokenEngine {
  const engine = (sphere as unknown as { _tokenEngine?: ITokenEngine })._tokenEngine;
  expect(engine, 'Sphere built no token engine — the test would be vacuous').toBeDefined();
  return engine as ITokenEngine;
}

/** A token whose only job is to record whether the SEQUENTIAL path was taken. */
function probeToken(): { token: SphereToken; verify: ReturnType<typeof vi.fn> } {
  const verify = vi.fn().mockResolvedValue({ status: VerificationStatus.OK });
  return { token: { sdkToken: { verify } } as unknown as SphereToken, verify };
}

describe('Sphere.init forwards `verification` to the engine it builds (#769.2)', () => {
  let live: Sphere | null = null;

  afterEach(async () => {
    if (live) {
      try { await live.destroy(); } catch { /* already torn down */ }
    }
    live = null;
  });

  async function initWith(
    walletExists: boolean,
    verification?: SphereInitOptions['verification'],
  ): Promise<{ sphere: Sphere; created: boolean }> {
    const providers = makeMockProviders({ walletExists });
    const { sphere, created } = await Sphere.init({
      storage: providers.storage,
      transport: providers.transport as unknown as TransportProvider,
      oracle: providers.oracle as unknown as OracleProvider,
      walletApi: providers.walletApi,
      network: TEST_NETWORK,
      autoGenerate: true,
      ...(verification ? { verification } : {}),
    });
    live = sphere;
    return { sphere, created };
  }

  it('create branch (no wallet yet): the configured pool verifier owns verify()', async () => {
    const createWorker = vi.fn(() => new NoopWorker());
    const { sphere, created } = await initWith(false, { createWorker });
    expect(created, 'this test must exercise create(), not load()').toBe(true);

    const { token, verify } = probeToken();
    await expect(engineOf(sphere).verify(token)).rejects.toBeDefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('load branch (wallet already exists): the configured pool verifier owns verify()', async () => {
    const createWorker = vi.fn(() => new NoopWorker());
    const { sphere, created } = await initWith(true, { createWorker });
    expect(created, 'this test must exercise load(), not create()').toBe(false);

    const { token, verify } = probeToken();
    await expect(engineOf(sphere).verify(token)).rejects.toBeDefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('control — create branch without the option keeps the sequential verifier', async () => {
    const { sphere, created } = await initWith(false);
    expect(created).toBe(true);

    const { token, verify } = probeToken();
    await expect(engineOf(sphere).verify(token)).resolves.toEqual({ ok: true });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('control — load branch without the option keeps the sequential verifier', async () => {
    const { sphere, created } = await initWith(true);
    expect(created).toBe(false);

    const { token, verify } = probeToken();
    await expect(engineOf(sphere).verify(token)).resolves.toEqual({ ok: true });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
