/**
 * SwapModule.status.test.ts
 *
 * UT-SWAP-STATUS-001 through UT-SWAP-STATUS-008
 * Tests for getSwapStatus() and getSwaps() methods.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  SphereError,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';

describe('SwapModule — getSwapStatus / getSwaps', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-001: getSwapStatus returns SwapRef copy
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-001: getSwapStatus returns local SwapRef with all expected fields', async () => {
    const ref = createTestSwapRef({ progress: 'announced' });
    injectSwapRef(module, ref);

    const result = await module.getSwapStatus(ref.swapId);

    expect(result.swapId).toBe(ref.swapId);
    expect(result.progress).toBe('announced');
    expect(result.role).toBe(ref.role);
    expect(result.deal).toEqual(ref.deal);
    expect(result.manifest).toEqual(ref.manifest);
    expect(result.createdAt).toBe(ref.createdAt);
    expect(result.updatedAt).toBe(ref.updatedAt);

    // Verify it is a copy, not the same reference
    expect(result).not.toBe(ref);
    expect(result.deal).not.toBe(ref.deal);
    expect(result.manifest).not.toBe(ref.manifest);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-002: getSwapStatus optionally queries escrow via DM
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-002: getSwapStatus sends status DM to escrow when queryEscrow is true', async () => {
    const ref = createTestSwapRef({ progress: 'awaiting_counter' });
    injectSwapRef(module, ref);

    await module.getSwapStatus(ref.swapId, { queryEscrow: true });

    // Wait for the fire-and-forget DM to be sent
    await vi.waitFor(() => {
      expect(mocks.communications.sendDM).toHaveBeenCalledWith(
        DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
        expect.stringContaining('status'),
      );
    });

    // resolve() should have been called with the escrow address
    expect(mocks.resolve).toHaveBeenCalledWith(DEFAULT_TEST_ESCROW_ADDRESS);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-003: getSwapStatus on non-existent swap throws SWAP_NOT_FOUND
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-003: getSwapStatus on non-existent swap throws SWAP_NOT_FOUND', async () => {
    await expect(module.getSwapStatus('nonexistent_id_' + '0'.repeat(48))).rejects.toMatchObject({ code: 'SWAP_NOT_FOUND' });
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-004: getSwaps returns all tracked swaps
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-004: getSwaps returns all tracked swaps', async () => {
    const ref1 = createTestSwapRef({
      progress: 'proposed',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'UCT',
        partyAAmount: '1000000',
        partyBCurrency: 'USDU',
        partyBAmount: '500000',
        timeout: 300,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    const ref2 = createTestSwapRef({
      progress: 'awaiting_counter',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    const ref3 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps();
    expect(results).toHaveLength(3);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-005: getSwaps with progress filter
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-005: getSwaps with progress filter returns matching swaps only', async () => {
    const ref1 = createTestSwapRef({ progress: 'proposed' });
    const ref2 = createTestSwapRef({
      progress: 'awaiting_counter',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });
    const ref3 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps({ progress: 'proposed' });
    expect(results).toHaveLength(1);
    expect(results[0].progress).toBe('proposed');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-006: getSwaps with role filter
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-006: getSwaps with role filter returns matching role only', async () => {
    const ref1 = createTestSwapRef({ role: 'proposer', progress: 'proposed' });
    const ref2 = createTestSwapRef({
      role: 'acceptor',
      progress: 'proposed',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);

    const results = module.getSwaps({ role: 'acceptor' });
    expect(results).toHaveLength(1);
    expect(results[0].role).toBe('acceptor');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-007: getSwaps excludeTerminal (default behavior)
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-007: getSwaps with excludeTerminal filters out terminal states', async () => {
    const ref1 = createTestSwapRef({ progress: 'proposed' });
    const ref2 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });
    const ref3 = createTestSwapRef({
      progress: 'cancelled',
      deal: {
        partyA: 'DIRECT://0000aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa1',
        partyB: 'DIRECT://0000bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb222bbb2',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps({ excludeTerminal: true });
    expect(results).toHaveLength(1);
    expect(results[0].progress).toBe('proposed');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-008: getSwaps empty returns empty array
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-008: getSwaps returns empty array when no swaps exist', () => {
    const results = module.getSwaps();
    expect(results).toEqual([]);
    expect(results).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-009 / -010 / -011: terminal-swap lazy load from storage
  //
  // `loadFromStorage` deliberately keeps terminal swap records OUT of
  // `this.swaps` to bound memory across the terminalPurgeTtlMs window
  // (default 7 days), but `getSwapStatus` is the one public surface where
  // callers legitimately want to query a terminal swap — soak verifications
  // re-open the CLI after a swap reaches `completed` and run `sphere swap
  // status $id` to confirm the terminal state. Without the lazy-load
  // fallback that call throws SWAP_NOT_FOUND even though the record is
  // sitting in storage.
  // --------------------------------------------------------------------------

  it('UT-SWAP-STATUS-009: getSwapStatus lazy-loads a terminal swap from storage on cache miss', async () => {
    // Set up: a completed swap that is in terminalSwapIds + storage, but NOT
    // in `this.swaps` (matches the post-loadFromStorage state for terminal
    // entries within the purge TTL window).
    const ref = createTestSwapRef({ progress: 'completed' });
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${ref.swapId}`;
    mocks.storage._data.set(
      storageKey,
      JSON.stringify({ version: 1, swap: ref }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).terminalSwapIds.add(ref.swapId);

    const result = await module.getSwapStatus(ref.swapId);

    expect(result.swapId).toBe(ref.swapId);
    expect(result.progress).toBe('completed');
    expect(result.deal).toEqual(ref.deal);

    // The lazy load must NOT poison `this.swaps` — the memory bound that
    // loadFromStorage establishes for the active set has to survive a
    // status query against an arbitrary terminal entry. Subsequent
    // queries re-read from storage; that's the trade-off.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((module as any).swaps.has(ref.swapId)).toBe(false);
  });

  it('UT-SWAP-STATUS-010: lazy-load returns SWAP_NOT_FOUND when id is not in terminalSwapIds', async () => {
    // Guard: even when a record happens to be in storage under the same
    // key shape, lazy-load MUST gate on terminalSwapIds membership.
    // Otherwise getSwapStatus could be coerced into reading arbitrary
    // storage keys (e.g. a stale record from a previous session that
    // was never accepted) and resurrecting them as if they were
    // terminal.
    const ref = createTestSwapRef({ progress: 'completed' });
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${ref.swapId}`;
    mocks.storage._data.set(
      storageKey,
      JSON.stringify({ version: 1, swap: ref }),
    );
    // Deliberately do NOT add to terminalSwapIds.

    await expect(module.getSwapStatus(ref.swapId)).rejects.toMatchObject({
      code: 'SWAP_NOT_FOUND',
    });
  });

  it('UT-SWAP-STATUS-011: lazy-load is resilient to storage corruption — falls back to SWAP_NOT_FOUND', async () => {
    // If the persisted record is malformed JSON or missing the `swap`
    // field, the lazy load must not throw — it should degrade to
    // SWAP_NOT_FOUND so the caller gets the same surface as a
    // truly-unknown id. Avoids a corrupted record poisoning the
    // module's bootstrap path.
    const swapId = 'corrupted_terminal_' + '0'.repeat(48);
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${swapId}`;
    mocks.storage._data.set(storageKey, '{this is not valid json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).terminalSwapIds.add(swapId);

    await expect(module.getSwapStatus(swapId)).rejects.toMatchObject({
      code: 'SWAP_NOT_FOUND',
    });
  });

  it('UT-SWAP-STATUS-013: queryEscrow=true on a lazy-loaded terminal swap is refused (DM would be dropped)', async () => {
    // The downstream `status_result` DM handler resolves the swap via
    // `this.swaps.get` — it has no path for lazy-loading from storage,
    // so an escrow response to a lazy-loaded swap is silently dropped
    // on arrival. `getSwapStatus` must therefore refuse the DM in the
    // first place, even when the caller explicitly opted in. This test
    // pins that contract.
    const ref = createTestSwapRef({ progress: 'completed' });
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${ref.swapId}`;
    mocks.storage._data.set(
      storageKey,
      JSON.stringify({ version: 1, swap: ref }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).terminalSwapIds.add(ref.swapId);

    // Caller explicitly asks for an escrow query. The lazy-load path
    // logs a debug line and skips the DM.
    const result = await module.getSwapStatus(ref.swapId, { queryEscrow: true });

    expect(result.swapId).toBe(ref.swapId);
    // Give the fire-and-forget chain a tick to settle so a regression
    // that DID send the DM has a chance to be observed by the mock.
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('UT-SWAP-STATUS-012: lazy-load prefers the in-memory entry when both exist (no double-read)', async () => {
    // If a swap is in `this.swaps` AND in storage (e.g. an active swap
    // that just transitioned to terminal in this process), the in-
    // memory ref wins. The storage-read path must not fire.
    const ref = createTestSwapRef({ progress: 'announced' });
    injectSwapRef(module, ref);

    // Sabotage storage with a stale record so the test fails loudly
    // if the lazy-load path runs by mistake.
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${ref.swapId}`;
    mocks.storage._data.set(
      storageKey,
      JSON.stringify({
        version: 1,
        swap: { ...ref, progress: 'completed' },
      }),
    );

    const result = await module.getSwapStatus(ref.swapId);
    expect(result.progress).toBe('announced');
  });
});
