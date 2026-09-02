/**
 * `debug: false` at a Sphere entry point must turn the process-global logger OFF (#766).
 *
 * The logger's state lives on `globalThis` so it is shared across tsup bundles — which
 * makes it a PROCESS-global flag, not a per-Sphere one. All four entry points used to
 * write it truthy-only (`if (options.debug) logger.configure({ debug: true })`), so the
 * flag was ONE-WAY: once anything switched debug on — a provider factory, an earlier
 * Sphere, a consumer calling `logger.configure` directly — no later `Sphere.init({ debug:
 * false })` could ever quieten it again. A wallet that logs every operation forever is a
 * privacy leak the consumer has no documented way to stop.
 *
 * `tests/unit/core/logger.test.ts` proves `logger.configure({ debug: false })` works; it
 * cannot see whether Sphere ever CALLS it. That is the hole this file closes.
 *
 * The suite discriminates WHICH of the four sites broke, because each one is written out
 * by hand and any one can be reverted with the other three intact:
 *   - `init` is its own site: it does NOT forward `debug` to the create/load call it
 *     dispatches to (see the option lists in `Sphere.init`), so both init tests fail
 *     together and only when line ~640 regresses.
 *   - the direct `create` / `load` / `import` tests each fail alone.
 *
 * The omission cases guard the other half of the contract — `!== undefined` rather than
 * `?? false`. `debug` left out must leave whatever the provider factory or the consumer
 * set, so a Sphere built without an opinion never silences someone else's logging.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import { logger } from '../../../core/logger';
import type { OracleProvider } from '../../../oracle';
import type { TransportProvider } from '../../../transport';
import { TEST_NETWORK } from '../../test-network';
import { makeMockProviders, TEST_MNEMONIC, type MockProviders } from './support/mock-providers';

/** A second valid BIP39 vector, so import() writes a different wallet than it reads. */
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('Sphere entry points honour `debug: false` (#766)', () => {
  let providers: MockProviders;
  let live: Sphere | null = null;

  beforeEach(() => {
    live = null;
    // The state every test starts from: SOMETHING already turned debug on. The handler
    // keeps the debug lines the Sphere entry points emit out of the test output; it does
    // not affect `isDebugEnabled`, which is the flag under test.
    logger.reset();
    logger.configure({ debug: true, handler: () => {} });
    expect(logger.isDebugEnabled(), 'the fixture must start with debug ON').toBe(true);
  });

  afterEach(async () => {
    if (live) {
      try { await live.destroy(); } catch { /* already torn down */ }
    }
    live = null;
    logger.reset();
  });

  function base(walletExists: boolean): MockProviders {
    providers = makeMockProviders({ walletExists });
    return providers;
  }

  function common(p: MockProviders) {
    return {
      storage: p.storage,
      transport: p.transport as unknown as TransportProvider,
      oracle: p.oracle as unknown as OracleProvider,
      walletApi: p.walletApi,
      network: TEST_NETWORK,
    };
  }

  // ===========================================================================
  // debug: false must turn the global flag OFF
  // ===========================================================================

  it('init() — create branch (no wallet yet)', async () => {
    const p = base(false);
    const { sphere, created } = await Sphere.init({
      ...common(p),
      autoGenerate: true,
      debug: false,
    });
    live = sphere;

    expect(created, 'this test must exercise init()’s create branch').toBe(true);
    expect(logger.isDebugEnabled()).toBe(false);
  });

  it('init() — load branch (wallet already exists)', async () => {
    const p = base(true);
    const { sphere, created } = await Sphere.init({
      ...common(p),
      autoGenerate: true,
      debug: false,
    });
    live = sphere;

    expect(created, 'this test must exercise init()’s load branch').toBe(false);
    expect(logger.isDebugEnabled()).toBe(false);
  });

  it('create() called directly', async () => {
    const p = base(false);
    live = await Sphere.create({ ...common(p), mnemonic: TEST_MNEMONIC, debug: false });

    expect(logger.isDebugEnabled()).toBe(false);
  });

  it('load() called directly', async () => {
    const p = base(true);
    live = await Sphere.load({ ...common(p), debug: false });

    expect(logger.isDebugEnabled()).toBe(false);
  });

  it('import() called directly', async () => {
    const p = base(false);
    live = await Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC, debug: false });

    expect(logger.isDebugEnabled()).toBe(false);
  });

  // ===========================================================================
  // debug OMITTED must leave the current value alone (`!== undefined`, not `?? false`)
  // ===========================================================================

  describe('`debug` omitted leaves the flag where it was', () => {
    it('init() — create branch', async () => {
      const p = base(false);
      const { sphere, created } = await Sphere.init({ ...common(p), autoGenerate: true });
      live = sphere;

      expect(created).toBe(true);
      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('init() — load branch', async () => {
      const p = base(true);
      const { sphere, created } = await Sphere.init({ ...common(p), autoGenerate: true });
      live = sphere;

      expect(created).toBe(false);
      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('create() called directly', async () => {
      const p = base(false);
      live = await Sphere.create({ ...common(p), mnemonic: TEST_MNEMONIC });

      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('load() called directly', async () => {
      const p = base(true);
      live = await Sphere.load({ ...common(p) });

      expect(logger.isDebugEnabled()).toBe(true);
    });

    it('import() called directly', async () => {
      const p = base(false);
      live = await Sphere.import({ ...common(p), mnemonic: OTHER_MNEMONIC });

      expect(logger.isDebugEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // The one-way trap itself: an explicit `true` still works, and a later `false` undoes it
  // ===========================================================================

  it('a debug:true init followed by a debug:false init ends up OFF', async () => {
    // The exact sequence the old code could not express. Two Spheres, one storage each,
    // because that is how a consumer hits it: enable debug while diagnosing, then build
    // the next wallet with it off.
    logger.configure({ debug: false });

    const first = base(false);
    const a = await Sphere.init({ ...common(first), autoGenerate: true, debug: true });
    expect(logger.isDebugEnabled()).toBe(true);
    await a.sphere.destroy();

    const second = base(false);
    const b = await Sphere.init({ ...common(second), autoGenerate: true, debug: false });
    live = b.sphere;

    expect(logger.isDebugEnabled()).toBe(false);
  });
});
