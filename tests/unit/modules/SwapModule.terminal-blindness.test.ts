/**
 * SwapModule.terminal-blindness.test.ts
 *
 * Issue #447: SwapModule terminal-swap blindness in resolveSwapId,
 * getSwaps, and write-side methods.
 *
 * PR #446 (closing #445) added lazy-load for terminal swaps in
 * `getSwapStatus` only. Three other surfaces still treated terminal
 * swaps as unknown until this PR:
 *
 *   1. `resolveSwapId(prefix)` — iterated `this.swaps.values()` only,
 *      so `sphere swap status <prefix>` against a terminal swap threw
 *      SWAP_NOT_FOUND from the prefix-resolver before `getSwapStatus`
 *      ever ran.
 *   2. `getSwaps(filter)` — `Array.from(this.swaps.values())` only,
 *      with no way to surface terminal entries even via
 *      `excludeTerminal: false`.
 *   3. Write-side methods (`acceptSwap`, `cancelSwap`, `deposit`,
 *      `rejectSwap`, `verifyPayout`) — bare `this.swaps.get()`, so
 *      `cancelSwap` against a terminal id said "not found" while
 *      `getSwapStatus` against the same id said "completed".
 *
 * These tests pin the post-fix contract:
 *   - `resolveSwapId` consults `_storedTerminalEntries` for prefix
 *     matches.
 *   - `getSwaps({ includeTerminal: true })` materializes stub
 *     SwapRefs from the terminal index entries.
 *   - Write-side methods throw `SWAP_ALREADY_TERMINAL` (new code) for
 *     terminal swaps that lazy-load from storage, distinguishing them
 *     from truly-unknown ids that still throw `SWAP_NOT_FOUND`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { SwapIndexEntry } from '../../../modules/swap/types.js';

describe('SwapModule — terminal-swap blindness (Issue #447)', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  // Helper: seed a terminal index entry plus its storage record. This
  // mirrors the post-loadFromStorage state where terminal swaps within
  // the purge TTL are tracked in `_storedTerminalEntries` and remain
  // readable from storage, but are deliberately absent from `this.swaps`.
  function seedTerminalSwap(progress: 'completed' | 'cancelled' | 'failed', swapIdOverride?: string): { swapId: string; ref: ReturnType<typeof createTestSwapRef> } {
    const ref = createTestSwapRef({
      progress,
      ...(swapIdOverride ? { swapId: swapIdOverride } : {}),
    });
    const addressId = mocks.identity.directAddress!;
    const storageKey = `${addressId}_swap:${ref.swapId}`;
    mocks.storage._data.set(
      storageKey,
      JSON.stringify({ version: 1, swap: ref }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = module as any;
    m.terminalSwapIds.add(ref.swapId);
    const entry: SwapIndexEntry = {
      swapId: ref.swapId,
      progress,
      role: ref.role,
      createdAt: ref.createdAt,
    };
    m._storedTerminalEntries.push(entry);
    return { swapId: ref.swapId, ref };
  }

  // ==========================================================================
  // resolveSwapId — surface (1)
  // ==========================================================================

  describe('resolveSwapId', () => {
    it('finds a terminal swap by prefix from _storedTerminalEntries', () => {
      const { swapId } = seedTerminalSwap('completed');
      const prefix = swapId.slice(0, 8);

      const resolved = module.resolveSwapId(prefix);

      expect(resolved).toBe(swapId);
    });

    it('still finds a live swap by prefix (no regression)', () => {
      const ref = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, ref);
      const prefix = ref.swapId.slice(0, 8);

      const resolved = module.resolveSwapId(prefix);

      expect(resolved).toBe(ref.swapId);
    });

    it('throws SWAP_AMBIGUOUS_PREFIX when prefix matches a live AND a terminal swap', () => {
      // Force matching prefixes: terminal id starts with the live id's
      // first 8 chars. We construct a synthetic 64-hex terminal id that
      // shares the live ref's leading 8 chars but differs later.
      const liveRef = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, liveRef);
      const sharedPrefix = liveRef.swapId.slice(0, 8);
      const terminalId = sharedPrefix + 'f'.repeat(56);
      // Make sure the synthetic id differs from the live id.
      expect(terminalId).not.toBe(liveRef.swapId);
      seedTerminalSwap('completed', terminalId);

      expect(() => module.resolveSwapId(sharedPrefix)).toThrowError(
        expect.objectContaining({ code: 'SWAP_AMBIGUOUS_PREFIX' }),
      );
    });

    it('throws SWAP_AMBIGUOUS_PREFIX when prefix matches two terminal swaps', () => {
      // Two synthetic terminal ids sharing leading 8 hex chars.
      const a = 'cafebabe' + '1'.repeat(56);
      const b = 'cafebabe' + '2'.repeat(56);
      seedTerminalSwap('completed', a);
      seedTerminalSwap('cancelled', b);

      expect(() => module.resolveSwapId('cafebabe')).toThrowError(
        expect.objectContaining({ code: 'SWAP_AMBIGUOUS_PREFIX' }),
      );
    });

    it('still throws SWAP_NOT_FOUND when prefix matches nothing', () => {
      // No swaps live, no swaps terminal — prefix lookup must miss.
      expect(() => module.resolveSwapId('deadbeef')).toThrowError(
        expect.objectContaining({ code: 'SWAP_NOT_FOUND' }),
      );
    });

    it('dedupes a swap that briefly appears in both live and terminal index', () => {
      // During a terminal transition the same id can be present in
      // `this.swaps` AND in `_storedTerminalEntries` (the latter is
      // appended before the former is removed). The prefix lookup must
      // treat that as ONE match, not ambiguous.
      const ref = createTestSwapRef({ progress: 'completed' });
      injectSwapRef(module, ref);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = module as any;
      m._storedTerminalEntries.push({
        swapId: ref.swapId,
        progress: 'completed' as const,
        role: ref.role,
        createdAt: ref.createdAt,
      });

      const resolved = module.resolveSwapId(ref.swapId.slice(0, 8));
      expect(resolved).toBe(ref.swapId);
    });

    it('full 64-char hex id is returned as-is without scanning', () => {
      // Sanity: no swaps anywhere, full hex id round-trips.
      const fullId = 'a'.repeat(64);
      expect(module.resolveSwapId(fullId)).toBe(fullId);
    });

    it('rejects prefixes shorter than 4 hex chars with SWAP_INVALID_DEAL', () => {
      expect(() => module.resolveSwapId('abc')).toThrowError(
        expect.objectContaining({ code: 'SWAP_INVALID_DEAL' }),
      );
    });
  });

  // ==========================================================================
  // getSwaps — surface (2)
  // ==========================================================================

  describe('getSwaps with includeTerminal', () => {
    it('default behavior (no filter) still excludes terminal entries — no regression', () => {
      const live = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, live);
      seedTerminalSwap('completed');

      const results = module.getSwaps();

      expect(results).toHaveLength(1);
      expect(results[0].swapId).toBe(live.swapId);
    });

    it('includeTerminal: false (explicit) matches default behavior', () => {
      const live = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, live);
      seedTerminalSwap('completed');

      const results = module.getSwaps({ includeTerminal: false });

      expect(results).toHaveLength(1);
      expect(results[0].swapId).toBe(live.swapId);
    });

    it('includeTerminal: true surfaces terminal entries as stub SwapRefs', () => {
      const live = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, live);
      const { swapId: termId } = seedTerminalSwap('completed');

      const results = module.getSwaps({ includeTerminal: true });

      expect(results).toHaveLength(2);
      const termResult = results.find(s => s.swapId === termId);
      expect(termResult).toBeDefined();
      expect(termResult!.progress).toBe('completed');
      expect(termResult!.role).toBe('proposer');
      // Stub: deal/manifest are placeholders; manifest.swap_id is preserved.
      expect(termResult!.manifest.swap_id).toBe(termId);
      expect(termResult!.deal.partyA).toBe('');
      expect(termResult!.manifest.party_a_address).toBe('');
    });

    it('includeTerminal: true + excludeTerminal: true filters out terminal — excludeTerminal wins', () => {
      const live = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, live);
      seedTerminalSwap('completed');

      const results = module.getSwaps({
        includeTerminal: true,
        excludeTerminal: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0].swapId).toBe(live.swapId);
    });

    it('includeTerminal: true + progress filter narrows correctly across live + terminal', () => {
      const live = createTestSwapRef({ progress: 'announced' });
      injectSwapRef(module, live);
      const { swapId: completedId } = seedTerminalSwap('completed');
      seedTerminalSwap('cancelled', 'feed' + '0'.repeat(60));

      const results = module.getSwaps({
        includeTerminal: true,
        progress: 'completed',
      });

      expect(results).toHaveLength(1);
      expect(results[0].swapId).toBe(completedId);
    });

    it('includeTerminal: true + role filter applies to stub entries too', () => {
      const live = createTestSwapRef({ progress: 'announced', role: 'proposer' });
      injectSwapRef(module, live);
      // Terminal entry with acceptor role.
      const ref = createTestSwapRef({ progress: 'completed', role: 'acceptor' });
      const addressId = mocks.identity.directAddress!;
      mocks.storage._data.set(
        `${addressId}_swap:${ref.swapId}`,
        JSON.stringify({ version: 1, swap: ref }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = module as any;
      m.terminalSwapIds.add(ref.swapId);
      m._storedTerminalEntries.push({
        swapId: ref.swapId,
        progress: 'completed' as const,
        role: 'acceptor' as const,
        createdAt: ref.createdAt,
      });

      const results = module.getSwaps({
        includeTerminal: true,
        role: 'acceptor',
      });

      expect(results).toHaveLength(1);
      expect(results[0].swapId).toBe(ref.swapId);
      expect(results[0].role).toBe('acceptor');
    });

    it('dedupes when same id appears in both live working set and terminal index', () => {
      const ref = createTestSwapRef({ progress: 'completed' });
      injectSwapRef(module, ref);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = module as any;
      m._storedTerminalEntries.push({
        swapId: ref.swapId,
        progress: 'completed' as const,
        role: ref.role,
        createdAt: ref.createdAt,
      });

      const results = module.getSwaps({ includeTerminal: true });

      // Should appear ONCE — the live entry wins over the stub.
      expect(results).toHaveLength(1);
      // The live entry has a real deal, the stub has an empty one. We
      // expect the live entry to be returned.
      expect(results[0].deal.partyACurrency).not.toBe('');
    });
  });

  // ==========================================================================
  // Write-side methods — surface (3)
  // ==========================================================================

  describe('write-side: SWAP_ALREADY_TERMINAL for terminal swaps loaded from storage', () => {
    it('cancelSwap on a lazy-loadable terminal swap throws SWAP_ALREADY_TERMINAL (not SWAP_NOT_FOUND)', async () => {
      const { swapId } = seedTerminalSwap('completed');

      await expect(module.cancelSwap(swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_TERMINAL',
      });
    });

    it('acceptSwap on a lazy-loadable terminal swap throws SWAP_ALREADY_TERMINAL', async () => {
      const { swapId } = seedTerminalSwap('completed');

      await expect(module.acceptSwap(swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_TERMINAL',
      });
    });

    it('rejectSwap on a lazy-loadable terminal swap throws SWAP_ALREADY_TERMINAL', async () => {
      const { swapId } = seedTerminalSwap('completed');

      await expect(module.rejectSwap(swapId, 'late reject')).rejects.toMatchObject({
        code: 'SWAP_ALREADY_TERMINAL',
      });
    });

    it('deposit on a lazy-loadable terminal swap throws SWAP_ALREADY_TERMINAL', async () => {
      const { swapId } = seedTerminalSwap('completed');

      await expect(module.deposit(swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_TERMINAL',
      });
    });

    it('verifyPayout on a lazy-loadable terminal swap throws SWAP_ALREADY_TERMINAL', async () => {
      const { swapId } = seedTerminalSwap('cancelled');

      await expect(module.verifyPayout(swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_TERMINAL',
      });
    });
  });

  describe('write-side: SWAP_NOT_FOUND preserved for genuinely-unknown ids', () => {
    it('cancelSwap on an unknown id still throws SWAP_NOT_FOUND', async () => {
      const unknownId = 'f'.repeat(64);
      await expect(module.cancelSwap(unknownId)).rejects.toMatchObject({
        code: 'SWAP_NOT_FOUND',
      });
    });

    it('acceptSwap on an unknown id still throws SWAP_NOT_FOUND', async () => {
      const unknownId = 'f'.repeat(64);
      await expect(module.acceptSwap(unknownId)).rejects.toMatchObject({
        code: 'SWAP_NOT_FOUND',
      });
    });

    it('rejectSwap on an unknown id still throws SWAP_NOT_FOUND', async () => {
      const unknownId = 'f'.repeat(64);
      await expect(module.rejectSwap(unknownId)).rejects.toMatchObject({
        code: 'SWAP_NOT_FOUND',
      });
    });

    it('deposit on an unknown id still throws SWAP_NOT_FOUND', async () => {
      const unknownId = 'f'.repeat(64);
      await expect(module.deposit(unknownId)).rejects.toMatchObject({
        code: 'SWAP_NOT_FOUND',
      });
    });
  });

  describe('write-side: legacy fine-grained codes preserved for LIVE terminal swaps', () => {
    // When a swap is still in `this.swaps` but has transitioned to a
    // terminal state (the brief window before it's removed from the
    // working set), the legacy SWAP_ALREADY_COMPLETED /
    // SWAP_ALREADY_CANCELLED codes still apply. SWAP_ALREADY_TERMINAL
    // is reserved for terminal swaps that had to be lazy-loaded from
    // storage.
    it('cancelSwap on a LIVE completed swap throws SWAP_ALREADY_COMPLETED (not SWAP_ALREADY_TERMINAL)', async () => {
      const ref = createTestSwapRef({ progress: 'completed' });
      injectSwapRef(module, ref);

      await expect(module.cancelSwap(ref.swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_COMPLETED',
      });
    });

    it('cancelSwap on a LIVE cancelled swap throws SWAP_ALREADY_CANCELLED', async () => {
      const ref = createTestSwapRef({ progress: 'cancelled' });
      injectSwapRef(module, ref);

      await expect(module.cancelSwap(ref.swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_CANCELLED',
      });
    });

    it('rejectSwap on a LIVE completed swap throws SWAP_ALREADY_COMPLETED', async () => {
      const ref = createTestSwapRef({ progress: 'completed' });
      injectSwapRef(module, ref);

      await expect(module.rejectSwap(ref.swapId)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_COMPLETED',
      });
    });
  });
});
