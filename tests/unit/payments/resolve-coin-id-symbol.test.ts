/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 9.5 — `resolveCoinIdSymbol` unit tests.
 *
 * Verifies that the private `resolveCoinIdSymbol` helper on
 * {@link PaymentsModule} correctly maps short ticker symbols (e.g. `'UCT'`,
 * `'USDU'`) to their canonical 64/68-char hex `coinId` via the
 * {@link TokenRegistry} singleton, and that all three UXF dispatcher entry
 * points call it before delegating to `requireLegacyCoinSlot`.
 *
 * Background: the legacy `instantSplitSend` arm already performed this
 * resolution inline (at two call-sites). The UXF dispatchers
 * (`dispatchUxfConservativeSend`, `dispatchUxfInstantSend`,
 * `dispatchTxfSend`) were missing it, causing `validateTargets` to receive
 * an unknown `coinId` (`available=0`) and return `INSUFFICIENT_BALANCE` for
 * any caller that passed a symbol-style `coinId` such as `'UCT'`.
 *
 * Fix (Phase 9.5): extracted `resolveCoinIdSymbol` and applied it at the
 * top of all three dispatchers.
 *
 * Coverage:
 *  1. Helper — canonical hex pass-through (no registry hit needed).
 *  2. Helper — symbol resolved via registry when no literal match.
 *  3. Helper — unknown symbol left unchanged (graceful degradation).
 *  4. Helper — symbol already a literal match skips registry lookup.
 *  5. Helper — `additionalAssets` coin entries resolved alongside primary.
 *  6. Helper — NFT entries in `additionalAssets` left untouched.
 *  7. Dispatcher integration — `dispatchUxfConservativeSend` receives the
 *     resolved coinId.
 *  8. Dispatcher integration — `dispatchUxfInstantSend` receives the
 *     resolved coinId.
 *  9. Dispatcher integration — `dispatchTxfSend` receives the resolved
 *     coinId.
 *
 * @module tests/unit/payments/resolve-coin-id-symbol
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import { TokenRegistry } from '../../../registry/TokenRegistry';
import type { TransferRequest } from '../../../types';

// =============================================================================
// Constants
// =============================================================================

const UCT_HEX =
  'aabbccdd00112233445566778899aabbccddeeff0011223344556677889900aa';
const USDU_HEX =
  'ffeeddcc00112233445566778899ffeeddcc00112233445566778899ffeedd00';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build a minimal {@link PaymentsModule} instance with:
 *  - An in-memory token pool that you control.
 *  - `resolveCoinIdSymbol` callable via `(module as any).resolveCoinIdSymbol`.
 *  - The three dispatcher methods stubbed to capture their first argument so
 *    integration tests can assert which `coinId` they received.
 */
function makeModule(opts: {
  /** Tokens pre-loaded into the in-memory map (keyed by token.id). */
  tokens?: Array<{ id: string; coinId: string }>;
} = {}) {
  const module = new PaymentsModule({ features: { senderUxf: true } });

  // Inject just enough `deps` to let `send()` and the capability warning pass
  // through without throwing.
  (module as any).deps = {
    transport: { resolve: vi.fn(async () => null) },
    emitEvent: vi.fn(),
    identity: { chainPubkey: '02' + 'aa'.repeat(32), directAddress: '' },
  };

  // Populate the token pool.
  const tokenMap = new Map<string, { id: string; coinId: string }>();
  for (const t of opts.tokens ?? []) {
    tokenMap.set(t.id, t);
  }
  (module as any).tokens = tokenMap;

  // Capture what each dispatcher receives as its first argument.
  const capturedRequests: Record<string, TransferRequest[]> = {
    uxfConservative: [],
    uxfInstant: [],
    txf: [],
  };
  const stubResult = () =>
    Promise.resolve({
      id: 'stub',
      status: 'completed' as const,
      tokens: [],
      tokenTransfers: [],
    });

  (module as any).dispatchUxfConservativeSend = vi.fn((req: TransferRequest) => {
    capturedRequests.uxfConservative.push(req);
    return stubResult();
  });
  (module as any).dispatchUxfInstantSend = vi.fn((req: TransferRequest) => {
    capturedRequests.uxfInstant.push(req);
    return stubResult();
  });
  (module as any).dispatchTxfSend = vi.fn((req: TransferRequest) => {
    capturedRequests.txf.push(req);
    return stubResult();
  });
  (module as any).maybeEmitCapabilityWarning = vi.fn(async () => undefined);

  return { module, capturedRequests };
}

/**
 * Configure the {@link TokenRegistry} singleton with a minimal map of
 * symbol → definition.  Resets after each test.
 */
function stubRegistry(entries: Array<{ id: string; symbol: string }>) {
  const instance = TokenRegistry.getInstance();
  const defs = new Map(
    entries.map((e) => [
      e.id,
      {
        id: e.id,
        symbol: e.symbol,
        name: e.symbol,
        decimals: 18,
        iconUrl: '',
        coingeckoId: '',
        priceFeedId: '',
      },
    ]),
  );
  // Inject the definitions directly into the singleton's private map so we
  // don't need a full registry initialisation cycle.
  (instance as any).definitions = defs;
  // Build the reverse symbol → definition index used by getDefinitionBySymbol.
  const bySymbol = new Map<string, (typeof defs extends Map<string, infer V> ? V : never)>();
  for (const def of defs.values()) {
    bySymbol.set(def.symbol, def);
  }
  (instance as any).definitionsBySymbol = bySymbol;
}

// =============================================================================
// Tests
// =============================================================================

describe('resolveCoinIdSymbol — helper unit tests', () => {
  afterEach(() => {
    // Reset any registry state written by stubRegistry.
    (TokenRegistry.getInstance() as any).definitions = new Map();
    (TokenRegistry.getInstance() as any).definitionsBySymbol = new Map();
  });

  it('1. canonical hex coinId passes through unchanged (no registry lookup)', () => {
    stubRegistry([{ id: UCT_HEX, symbol: 'UCT' }]);
    const { module } = makeModule({
      tokens: [{ id: 't1', coinId: UCT_HEX }],
    });
    const req: TransferRequest = { recipient: '@bob', coinId: UCT_HEX, amount: '1000' };
    const out = (module as any).resolveCoinIdSymbol(req);
    // Literal match → same object reference (no allocation).
    expect(out).toBe(req);
    expect(out.coinId).toBe(UCT_HEX);
  });

  it('2. symbol resolved to hex when no literal match exists', () => {
    stubRegistry([{ id: UCT_HEX, symbol: 'UCT' }]);
    const { module } = makeModule({
      // Token pool has the hex coinId, not the symbol.
      tokens: [{ id: 't1', coinId: UCT_HEX }],
    });
    const req: TransferRequest = { recipient: '@bob', coinId: 'UCT', amount: '1000' };
    const out = (module as any).resolveCoinIdSymbol(req);
    expect(out.coinId).toBe(UCT_HEX);
    // New object created because coinId changed.
    expect(out).not.toBe(req);
  });

  it('3. unknown symbol left unchanged (graceful degradation)', () => {
    stubRegistry([]); // empty registry
    const { module } = makeModule();
    const req: TransferRequest = { recipient: '@bob', coinId: 'UNKNOWN', amount: '1' };
    const out = (module as any).resolveCoinIdSymbol(req);
    expect(out.coinId).toBe('UNKNOWN');
    // Same object — nothing changed.
    expect(out).toBe(req);
  });

  it('4. symbol that is ALREADY a literal match in the token pool skips registry', () => {
    // Contrived case: token pool uses 'UCT' as its coinId directly.
    stubRegistry([{ id: UCT_HEX, symbol: 'UCT' }]);
    const { module } = makeModule({
      tokens: [{ id: 't1', coinId: 'UCT' }],
    });
    const registrySpy = vi.spyOn(
      TokenRegistry.getInstance(),
      'getDefinitionBySymbol',
    );
    const req: TransferRequest = { recipient: '@bob', coinId: 'UCT', amount: '1000' };
    const out = (module as any).resolveCoinIdSymbol(req);
    // Literal match found → registry NOT consulted.
    expect(registrySpy).not.toHaveBeenCalled();
    // coinId unchanged.
    expect(out.coinId).toBe('UCT');
    registrySpy.mockRestore();
  });

  it('5. additionalAssets coin entries are resolved alongside primary coinId', () => {
    stubRegistry([
      { id: UCT_HEX, symbol: 'UCT' },
      { id: USDU_HEX, symbol: 'USDU' },
    ]);
    const { module } = makeModule({
      tokens: [
        { id: 't1', coinId: UCT_HEX },
        { id: 't2', coinId: USDU_HEX },
      ],
    });
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
      additionalAssets: [
        { kind: 'coin', coinId: 'USDU', amount: '500' },
      ],
    };
    const out = (module as any).resolveCoinIdSymbol(req);
    expect(out.coinId).toBe(UCT_HEX);
    expect(out.additionalAssets).toHaveLength(1);
    expect((out.additionalAssets as any)[0].coinId).toBe(USDU_HEX);
  });

  it('6. NFT entries in additionalAssets are left untouched', () => {
    stubRegistry([{ id: UCT_HEX, symbol: 'UCT' }]);
    const { module } = makeModule({
      tokens: [{ id: 't1', coinId: UCT_HEX }],
    });
    const nftEntry = { kind: 'nft' as const, tokenId: '0xdeadbeef' };
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
      additionalAssets: [nftEntry],
    };
    const out = (module as any).resolveCoinIdSymbol(req);
    expect(out.coinId).toBe(UCT_HEX);
    // NFT entry object is the exact same reference.
    expect((out.additionalAssets as any)[0]).toBe(nftEntry);
    expect((out.additionalAssets as any)[0].tokenId).toBe('0xdeadbeef');
  });
});

// =============================================================================
// Dispatcher integration — verify each real dispatcher calls resolveCoinIdSymbol
// =============================================================================
//
// Strategy: call each dispatcher method directly via `(module as any)`
// with a token pool populated with the hex coinId but a request carrying the
// symbol.  The real dispatcher body runs its `resolveCoinIdSymbol` call first;
// we short-circuit the rest by spying on `requireLegacyCoinSlot` (the first
// call after resolution) and throwing a sentinel error so the dispatcher
// aborts early without needing oracle / transport / signing service stubs.
//
// The sentinel error is caught per-test; the assertion is that `resolveSpy`
// was called with the SYMBOL and returned the HEX value.

describe('resolveCoinIdSymbol — real dispatcher integration', () => {
  beforeEach(() => {
    stubRegistry([{ id: UCT_HEX, symbol: 'UCT' }]);
  });

  afterEach(() => {
    (TokenRegistry.getInstance() as any).definitions = new Map();
    (TokenRegistry.getInstance() as any).definitionsBySymbol = new Map();
    vi.restoreAllMocks();
  });

  function makeRealModule() {
    const module = new PaymentsModule({ features: { senderUxf: true } });

    // Token pool: canonical hex coinId so literal-match fails for 'UCT'.
    const tokenMap = new Map([['t1', { id: 't1', coinId: UCT_HEX }]]);
    (module as any).tokens = tokenMap;

    // Minimal deps so `ensureInitialized` passes inside the dispatcher.
    (module as any).deps = {
      transport: { resolve: vi.fn(async () => null) },
      emitEvent: vi.fn(),
      identity: { chainPubkey: '02' + 'aa'.repeat(32), directAddress: '' },
      oracle: {},
    };

    // Spy on resolveCoinIdSymbol — wraps the REAL implementation.
    const resolveSpy = vi.spyOn(module as any, 'resolveCoinIdSymbol');

    return { module, resolveSpy };
  }

  it('7. dispatchUxfConservativeSend calls resolveCoinIdSymbol on the symbol request', async () => {
    const { module, resolveSpy } = makeRealModule();

    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
    };

    // The dispatcher will throw after resolution (missing oracle stubs) — that
    // is expected and caught.  We only care that resolveCoinIdSymbol ran first.
    try {
      await (module as any).dispatchUxfConservativeSend(req);
    } catch { /* expected — oracle/transport stubs are minimal */ }

    expect(resolveSpy).toHaveBeenCalledWith(req);
    // The return value must have been the hex coinId.
    const returnedRequest = resolveSpy.mock.results[0]?.value as TransferRequest | undefined;
    expect(returnedRequest?.coinId).toBe(UCT_HEX);
  });

  it('8. dispatchUxfInstantSend calls resolveCoinIdSymbol on the symbol request', async () => {
    const { module, resolveSpy } = makeRealModule();

    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '5000',
    };

    try {
      await (module as any).dispatchUxfInstantSend(req);
    } catch { /* expected */ }

    expect(resolveSpy).toHaveBeenCalledWith(req);
    const returnedRequest = resolveSpy.mock.results[0]?.value as TransferRequest | undefined;
    expect(returnedRequest?.coinId).toBe(UCT_HEX);
  });

  it('9. dispatchTxfSend calls resolveCoinIdSymbol on the symbol request', async () => {
    const { module, resolveSpy } = makeRealModule();

    const req: TransferRequest = {
      recipient: '@alice',
      coinId: 'UCT',
      amount: '1',
    };

    try {
      await (module as any).dispatchTxfSend(req, 'conservative');
    } catch { /* expected */ }

    expect(resolveSpy).toHaveBeenCalledWith(req);
    const returnedRequest = resolveSpy.mock.results[0]?.value as TransferRequest | undefined;
    expect(returnedRequest?.coinId).toBe(UCT_HEX);
  });
});
