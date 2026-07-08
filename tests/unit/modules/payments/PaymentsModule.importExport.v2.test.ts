/**
 * PaymentsModule import/export + repository API — Phase 6 v2 slim rebuild
 * coverage.
 *
 * The slim rebuild exposes a subset of the v1 repository API that consumer
 * bootstrap code + AccountingModule still call:
 *
 *   - `addToken(t)` → adds a token to the in-memory map and persists.
 *   - `updateToken(t)` → replaces an existing token (no-op for unknown).
 *   - `removeToken(id)` → drops + records tombstone (covered in tombstone
 *     suite).
 *   - `exportTokens()` → returns the current wallet token list.
 *   - `importTokens(data)` → **v2 slim stub** returning empty added/skipped/
 *     rejected arrays. This wave locks in the current shape; flag the stub
 *     as a real bug surface if v2 wants proper import semantics.
 *   - `onTokenChange(cb)` → fires on addToken(); consumer wiring seam.
 *   - `getArchivedTokens()`, `mergeArchivedTokens()`, `pruneArchivedTokens()`
 *     — v2 slim retains as API-stable but archive is unused on happy path.
 *   - `getForkedTokens()`, `storeForkedToken()`, `mergeForkedTokens()`,
 *     `pruneForkedTokens()` — same as archived.
 *
 * BUG FLAG: `importTokens()` currently drops the caller's payload and
 * returns three empty arrays. If any consumer relies on it to hydrate a
 * v2 blob into the wallet, that hydration path is silently broken. See
 * final test + report.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  makeV2Harness,
  mint,
  resetTokenSeq,
} from './__fixtures__/v2-harness';
import type { Token } from '../../../../types';
// Wave 6-P2-18: the v1 `TxfToken` alias is deleted. The archive / forked
// remote-merge APIs are `Map<string, unknown>` in the v2 slim rebuild.

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'ext-token-1',
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '500',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('PaymentsModule import/export + repository API (v2 slim)', () => {
  beforeEach(() => {
    resetTokenSeq();
  });

  it('exportTokens() returns the current wallet tokens', async () => {
    const h = await makeV2Harness();
    const a = await mint(h, 'UCT', 100n);
    const b = await mint(h, 'USDU', 200n);

    const exported = h.module.exportTokens();
    expect(Array.isArray(exported)).toBe(true);
    expect(exported).toHaveLength(2);
    const ids = (exported as Token[]).map((t) => t.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('addToken() adds a NEW token and returns true', async () => {
    const h = await makeV2Harness();
    const t = makeToken();
    const added = await h.module.addToken(t);
    expect(added).toBe(true);
    const tokens = h.module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(t.id);
    expect(tokens[0].amount).toBe('500');
  });

  it('addToken() returns false for a duplicate id (no re-add, no duplicate persist)', async () => {
    const h = await makeV2Harness();
    const t = makeToken();
    await h.module.addToken(t);
    const savedBefore = h.storage.saved.length;

    const secondAdd = await h.module.addToken(t);
    expect(secondAdd).toBe(false);
    expect(h.module.getTokens()).toHaveLength(1);
    // No extra save.
    expect(h.storage.saved.length).toBe(savedBefore);
  });

  it('updateToken() replaces an existing token; no-op for unknown id', async () => {
    const h = await makeV2Harness();
    const t = makeToken({ amount: '100' });
    await h.module.addToken(t);

    await h.module.updateToken({ ...t, amount: '999' });
    expect(h.module.getToken(t.id)!.amount).toBe('999');

    const savedBefore = h.storage.saved.length;
    await h.module.updateToken({ ...t, id: 'unknown-id', amount: '1' });
    // Unknown id → no persist.
    expect(h.storage.saved.length).toBe(savedBefore);
    expect(h.module.getToken('unknown-id')).toBeUndefined();
  });

  it('onTokenChange() fires when addToken() succeeds and NOT when it dedups', async () => {
    const h = await makeV2Harness();
    const seen: Array<{ tokenId: string; sdkData: string }> = [];
    const unsub = h.module.onTokenChange((tokenId, sdkData) => {
      seen.push({ tokenId, sdkData });
    });

    const t = makeToken();
    await h.module.addToken(t);
    await h.module.addToken(t); // duplicate — should not fire

    expect(seen).toHaveLength(1);
    expect(seen[0].tokenId).toBe(t.id);
    unsub();
  });

  it('onTokenChange() unsub prevents further callbacks', async () => {
    const h = await makeV2Harness();
    const seen: string[] = [];
    const unsub = h.module.onTokenChange((id) => seen.push(id));
    unsub();
    await h.module.addToken(makeToken());
    expect(seen).toHaveLength(0);
  });

  it('archived tokens: empty by default; mergeArchivedTokens accepts a remote map', async () => {
    const h = await makeV2Harness();
    expect(h.module.getArchivedTokens().size).toBe(0);
    expect(h.module.getBestArchivedVersion('none')).toBeNull();

    const remote = new Map<string, unknown>([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['a', { id: 'a' } as any],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['b', { id: 'b' } as any],
    ]);
    const added = await h.module.mergeArchivedTokens(remote);
    expect(added).toBe(2);
    expect(h.module.getArchivedTokens().size).toBe(2);
    // Re-merge the same map → all skipped (0 added).
    const added2 = await h.module.mergeArchivedTokens(remote);
    expect(added2).toBe(0);
  });

  it('forked tokens: storeForkedToken adds; mergeForkedTokens dedups', async () => {
    const h = await makeV2Harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await h.module.storeForkedToken('t1', 'state-a', { id: 't1' } as any);
    expect(h.module.getForkedTokens().size).toBe(1);

    const remote = new Map<string, unknown>([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['t1', { id: 't1' } as any],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['t2', { id: 't2' } as any],
    ]);
    const added = await h.module.mergeForkedTokens(remote);
    expect(added).toBe(1);
    expect(h.module.getForkedTokens().size).toBe(2);
  });

  it('tokens survive a load/save round-trip via addToken() → save → load()', async () => {
    const h1 = await makeV2Harness();
    // Two "external" tokens with sdkData that the fake engine can decode.
    const t = await mint(h1, 'UCT', 100n);
    const saved = h1.storage.saved[h1.storage.saved.length - 1];

    const h2 = await makeV2Harness({ initialStorageData: saved });
    const reloaded = h2.module.getTokens();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(t.id);
    expect(reloaded[0].amount).toBe('100');
    expect(reloaded[0].coinId).toBe('UCT');
  });

  it('BUG FLAG: importTokens() currently returns three empty arrays regardless of input', async () => {
    const h = await makeV2Harness();
    // Try to import a v2-shaped blob — the stub drops it silently.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await h.module.importTokens({ tokens: [{ id: 'foo' }] } as any);
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    // Wallet is unchanged — the caller's payload was silently dropped.
    expect(h.module.getTokens()).toHaveLength(0);
  });
});
