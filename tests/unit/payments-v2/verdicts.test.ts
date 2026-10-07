import { afterEach, describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import { WalletCoinClaims } from '../../../modules/payments-v2/inventory/coin-claims';
import { TokenVerdicts, VERDICT_RETRY_MS } from '../../../modules/payments-v2/inventory/verdicts';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import type { SphereToken } from '../../../token-engine/types';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { memoryKV, type MemoryKV } from './support';

const BRIDGED_COIN = 'ab'.repeat(32);
const NATIVE_COIN = 'cd'.repeat(32);
const BRIDGED_TYPE = '6f'.repeat(32);
const OTHER_TYPE = '70'.repeat(32);
const REASON = new Uint8Array([0xc0, 0x01]);

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

async function wallet(kv: MemoryKV = memoryKV(), revision = 'vaults-1', held = new Map<string, SphereToken>()) {
  const engine = new FakeTokenEngine();
  const claims = new CoinClaims();
  claims.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds: [BRIDGED_COIN], revision, verify: vi.fn() });
  const getBlobs = vi.fn(async (ids: string[]) => {
    const found = ids.filter((id) => held.has(id)).map((id) => [id, held.get(id)!.blob.token] as const);
    return new Map(found);
  });
  const changed = vi.fn();
  const verdicts = new TokenVerdicts({ kv, claims, engine: () => engine, getBlobs, changed });
  let salt = 0;
  const mint = async (coinId: string, tokenType: string): Promise<SphereToken> => {
    salt += 1;
    const token = await engine.mintDataToken({
      recipientPubkey: engine.getIdentity().chainPubkey,
      data: await SpherePaymentData.fromValue({ assets: [{ coinId, amount: 10n }] }).encode(),
      tokenType: hexBytes(tokenType),
      salt: new Uint8Array(32).fill(salt),
      justification: REASON,
    });
    held.set(token.blob.tokenId, token);
    return token;
  };
  return { engine, verdicts, getBlobs, changed, mint, kv, held };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TokenVerdicts', () => {
  it('trusts a claimed coin only in a verified token of its issuing type, and every unclaimed coin', async () => {
    const { verdicts, mint, changed } = await wallet();
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const lookalike = await mint(BRIDGED_COIN, OTHER_TYPE);
    const native = await mint(NATIVE_COIN, OTHER_TYPE);

    expect(verdicts.standing(bridged.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    await verdicts.review([bridged.blob.tokenId, lookalike.blob.tokenId]);

    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(verdicts.standing(lookalike.blob.tokenId, BRIDGED_COIN)).toBe('refused');
    expect(verdicts.trusts(native.blob.tokenId, NATIVE_COIN)).toBe(true);
    expect(verdicts.isClaimed(BRIDGED_COIN)).toBe(true);
    expect(verdicts.isClaimed(NATIVE_COIN)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps a token that fails verification unverified, without checking it again', async () => {
    const { engine, verdicts, mint, changed } = await wallet();
    const counterfeit = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const verify = vi.spyOn(engine, 'verify').mockResolvedValue({ ok: false, reason: 'FAIL' });

    await verdicts.review([counterfeit.blob.tokenId]);
    await verdicts.review([counterfeit.blob.tokenId]);

    expect(verdicts.standing(counterfeit.blob.tokenId, BRIDGED_COIN)).toBe('refused');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('checks a token again later while its reason cannot be verified yet, and trusts it once it verifies', async () => {
    vi.useFakeTimers();
    const { engine, verdicts, mint, changed } = await wallet();
    const settling = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const verify = vi
      .spyOn(engine, 'verify')
      .mockRejectedValueOnce(new SphereError('lock short of its confirmations', 'MINT_REASON_UNVERIFIABLE'))
      .mockResolvedValue({ ok: true });
    await verdicts.start();

    await verdicts.review([settling.blob.tokenId]);
    await verdicts.review([settling.blob.tokenId]);
    expect(verdicts.standing(settling.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    expect(verify).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS);

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verdicts.trusts(settling.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    verdicts.stop();
  });

  it('remembers verified tokens across sessions, so a new session trusts them without checking again', async () => {
    const kv = memoryKV();
    const first = await wallet(kv);
    const kept = await first.mint(BRIDGED_COIN, BRIDGED_TYPE);
    await first.verdicts.review([kept.blob.tokenId]);

    const second = await wallet(kv);
    const verify = vi.spyOn(second.engine, 'verify');
    await second.verdicts.hydrate();
    await second.verdicts.review([kept.blob.tokenId]);

    expect(second.verdicts.trusts(kept.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('checks remembered tokens again once the issuance policies change', async () => {
    const kv = memoryKV();
    const first = await wallet(kv, 'vaults-1');
    const kept = await first.mint(BRIDGED_COIN, BRIDGED_TYPE);
    await first.verdicts.review([kept.blob.tokenId]);

    const second = await wallet(kv, 'vaults-2', first.held);
    const verify = vi.spyOn(second.engine, 'verify').mockResolvedValue({ ok: false, reason: 'FAIL' });
    await second.verdicts.hydrate();

    expect(second.verdicts.standing(kept.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    await second.verdicts.review([kept.blob.tokenId]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(second.verdicts.standing(kept.blob.tokenId, BRIDGED_COIN)).toBe('refused');
  });

  it('records a verified arrival of the issuing type and ignores a look-alike or a token without claimed coins', async () => {
    const { verdicts, mint, getBlobs } = await wallet();
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const lookalike = await mint(BRIDGED_COIN, OTHER_TYPE);

    await verdicts.accept(bridged);
    await verdicts.accept(lookalike);

    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(verdicts.trusts(lookalike.blob.tokenId, BRIDGED_COIN)).toBe(false);
    expect(getBlobs).not.toHaveBeenCalled();
  });

  it('passes a verified token on to the output split off it', async () => {
    const { verdicts, mint } = await wallet();
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const unchecked = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    await verdicts.accept(bridged);

    await verdicts.recordSplit(bridged.blob.tokenId, 'aa'.repeat(32));
    await verdicts.recordSplit(unchecked.blob.tokenId, 'bb'.repeat(32));

    expect(verdicts.trusts('aa'.repeat(32), BRIDGED_COIN)).toBe(true);
    expect(verdicts.trusts('bb'.repeat(32), BRIDGED_COIN)).toBe(false);
  });

  it('does not trust a blob whose decoded value carries no claimed coin, whatever the inventory lists', async () => {
    const { verdicts, mint } = await wallet();
    const native = await mint(NATIVE_COIN, BRIDGED_TYPE);

    await verdicts.review([native.blob.tokenId]);

    expect(verdicts.trusts(native.blob.tokenId, BRIDGED_COIN)).toBe(false);
  });

  it('writes the verified set in a shape a 0.18.0 client sharing the storage still loads', async () => {
    const kv = memoryKV();
    const { verdicts, mint } = await wallet(kv);
    const kept = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    await verdicts.review([kept.blob.tokenId]);
    const claims = new CoinClaims();
    claims.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds: [BRIDGED_COIN], revision: 'vaults-1', verify: vi.fn() });

    // 0.18.0's TokenVerdicts.load(), verbatim apart from the set it fills.
    const loaded0180 = (remembered: { fingerprint: string; tokenIds: string[] } | null): string[] => {
      const verified: string[] = [];
      if (remembered?.fingerprint !== claims.fingerprint()) return verified;
      for (const tokenId of remembered.tokenIds) verified.push(tokenId);
      return verified;
    };

    expect(loaded0180(await kv.get(STORE_KEYS.verifiedTokens))).toEqual([kept.blob.tokenId]);
  });

  it('skips a malformed remembered entry instead of failing every hydration', async () => {
    const kv = memoryKV();
    const first = await wallet(kv);
    const kept = await first.mint(BRIDGED_COIN, BRIDGED_TYPE);
    await first.verdicts.review([kept.blob.tokenId]);
    const record = (await kv.get<{ verified: unknown[] }>(STORE_KEYS.verifiedTokens))!;
    await kv.set(STORE_KEYS.verifiedTokens, { ...record, verified: [...record.verified, ['x', [['coin']]], ['y', 'nope'], 7] });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const second = await wallet(kv);
    await second.verdicts.hydrate();

    expect(second.verdicts.trusts(kept.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(warn).toHaveBeenCalledWith('PaymentsV2', expect.stringContaining('malformed entries'));
  });

  it('checks a token again later when its blob cannot be decoded yet, rather than refusing it for good', async () => {
    vi.useFakeTimers();
    const { engine, verdicts, mint } = await wallet();
    const token = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const decode = vi.spyOn(engine, 'decodeToken').mockRejectedValueOnce(new Error('engine still loading'));
    await verdicts.start();

    await verdicts.review([token.blob.tokenId]);
    expect(verdicts.standing(token.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(verdicts.trusts(token.blob.tokenId, BRIDGED_COIN)).toBe(true);
    verdicts.stop();
  });

  it('checks again later when the address has no engine yet', async () => {
    vi.useFakeTimers();
    const { engine, verdicts, mint, kv, getBlobs } = await wallet();
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    let available = false;
    const claims = new CoinClaims();
    claims.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds: [BRIDGED_COIN], verify: vi.fn() });
    const late = new TokenVerdicts({
      kv,
      claims,
      engine: () => {
        if (!available) throw new SphereError('paymentsV2: token engine unavailable', 'AGGREGATOR_ERROR');
        return engine;
      },
      getBlobs,
      changed: vi.fn(),
    });
    await late.start();

    await late.review([bridged.blob.tokenId]);
    available = true;
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS);

    expect(late.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    late.stop();
    verdicts.stop();
  });
});

describe('TokenVerdicts — claims that move (#833)', () => {
  const started: TokenVerdicts[] = [];

  afterEach(() => {
    for (const verdicts of started.splice(0)) verdicts.stop();
  });

  /** Plugin claims plus a registry whose claims the test replaces, as a refresh does. */
  function moving(plugin: CoinClaims, initial: Record<string, string> = {}) {
    let current: ReadonlyMap<string, string> = new Map(Object.entries(initial));
    const listeners = new Set<() => void>();
    const registry = {
      getIssuanceClaims: () => current,
      onDefinitionsChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const set = (next: Record<string, string>): void => {
      current = new Map(Object.entries(next));
      for (const listener of listeners) listener();
    };
    return { claims: new WalletCoinClaims(plugin, registry), set, listeners };
  }

  async function judged(claims: WalletCoinClaims, kv: MemoryKV = memoryKV(), held = new Map<string, SphereToken>()) {
    const engine = new FakeTokenEngine();
    const getBlobs = vi.fn(async (ids: string[]) => new Map(ids.filter((id) => held.has(id)).map((id) => [id, held.get(id)!.blob.token] as const)));
    const changed = vi.fn();
    const verdicts = new TokenVerdicts({ kv, claims, engine: () => engine, getBlobs, changed, holders: () => [...held.keys()] });
    const start = async (): Promise<void> => {
      started.push(verdicts);
      await verdicts.start();
    };
    let salt = 0;
    const mint = async (coinIds: string | string[], tokenType: string): Promise<SphereToken> => {
      salt += 1;
      const assets = (Array.isArray(coinIds) ? coinIds : [coinIds]).map((coinId) => ({ coinId, amount: 10n }));
      const token = await engine.mintDataToken({
        recipientPubkey: engine.getIdentity().chainPubkey,
        data: await SpherePaymentData.fromValue({ assets }).encode(),
        tokenType: hexBytes(tokenType),
        salt: new Uint8Array(32).fill(salt),
        justification: REASON,
      });
      held.set(token.blob.tokenId, token);
      return token;
    };
    return { engine, verdicts, start, getBlobs, changed, mint, kv, held };
  }

  function bridgePlugin(coinIds: string[] = [BRIDGED_COIN]): CoinClaims {
    const plugin = new CoinClaims();
    plugin.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds, verify: vi.fn() });
    return plugin;
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps a verified token trusted when the registry claims another coin, and re-judges only the tokens of that coin', async () => {
    const registry = moving(bridgePlugin());
    const { engine, verdicts, start, mint } = await judged(registry.claims);
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const native = await mint(NATIVE_COIN, OTHER_TYPE);
    await start();
    await verdicts.review([bridged.blob.tokenId]);
    const verify = vi.spyOn(engine, 'verify');

    registry.set({ [NATIVE_COIN]: BRIDGED_TYPE });

    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    await vi.waitFor(() => expect(verdicts.standing(native.blob.tokenId, NATIVE_COIN)).toBe('refused'));
    expect(verify).not.toHaveBeenCalled();
    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
  });

  it('stops counting a verdict the moment a coin its token carries changes issuer', async () => {
    const registry = moving(bridgePlugin());
    const { verdicts, mint } = await judged(registry.claims);
    const mixed = await mint([BRIDGED_COIN, NATIVE_COIN], BRIDGED_TYPE);
    await verdicts.review([mixed.blob.tokenId]);
    expect(verdicts.trusts(mixed.blob.tokenId, BRIDGED_COIN)).toBe(true);

    registry.set({ [NATIVE_COIN]: OTHER_TYPE });

    expect(verdicts.standing(mixed.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    await verdicts.review([mixed.blob.tokenId]);
    expect(verdicts.standing(mixed.blob.tokenId, BRIDGED_COIN)).toBe('refused');
  });

  it('remembers each verified token with the issuers it was verified under, so a restart keeps it unless one of its coins moved', async () => {
    const kv = memoryKV();
    const first = await judged(moving(bridgePlugin()).claims, kv);
    const bridged = await first.mint(BRIDGED_COIN, BRIDGED_TYPE);
    const mixed = await first.mint([BRIDGED_COIN, NATIVE_COIN], BRIDGED_TYPE);
    await first.verdicts.review([bridged.blob.tokenId, mixed.blob.tokenId]);

    const second = await judged(moving(bridgePlugin(), { [NATIVE_COIN]: OTHER_TYPE }).claims, kv, first.held);
    const verify = vi.spyOn(second.engine, 'verify');
    await second.verdicts.hydrate();

    expect(second.verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(second.verdicts.standing(mixed.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    await second.verdicts.review([bridged.blob.tokenId, mixed.blob.tokenId]);
    expect(verify).not.toHaveBeenCalled();
    expect(second.verdicts.standing(mixed.blob.tokenId, BRIDGED_COIN)).toBe('refused');
  });

  it('never trusts a verdict reached under claims that moved while the token was being checked', async () => {
    const registry = moving(bridgePlugin());
    const { engine, verdicts, mint } = await judged(registry.claims);
    const mixed = await mint([BRIDGED_COIN, NATIVE_COIN], BRIDGED_TYPE);
    let pass = (): void => undefined;
    const checking = new Promise<void>((resolve) => {
      pass = resolve;
    });
    const verify = vi.spyOn(engine, 'verify').mockImplementation(async () => {
      await checking;
      return { ok: true };
    });

    const review = verdicts.review([mixed.blob.tokenId]);
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    registry.set({ [NATIVE_COIN]: OTHER_TYPE });
    pass();
    await review;

    expect(verdicts.trusts(mixed.blob.tokenId, BRIDGED_COIN)).toBe(false);
    await verdicts.review([mixed.blob.tokenId]);
    expect(verdicts.standing(mixed.blob.tokenId, BRIDGED_COIN)).toBe('refused');
  });

  it('never vouches for a token of a type no policy here enforces: pending, never verified, never checked again', async () => {
    vi.useFakeTimers();
    const registry = moving(new CoinClaims(), { [BRIDGED_COIN]: BRIDGED_TYPE });
    const { engine, verdicts, start, mint, getBlobs } = await judged(registry.claims);
    const squat = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const lookalike = await mint(BRIDGED_COIN, OTHER_TYPE);
    const verify = vi.spyOn(engine, 'verify');
    await start();

    await verdicts.review([squat.blob.tokenId, lookalike.blob.tokenId]);
    await verdicts.accept(squat);
    await verdicts.recordSplit(squat.blob.tokenId, 'aa'.repeat(32));
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS * 4);

    expect(verdicts.standing(squat.blob.tokenId, BRIDGED_COIN)).toBe('pending');
    expect(verdicts.standing('aa'.repeat(32), BRIDGED_COIN)).toBe('pending');
    expect(verdicts.standing(lookalike.blob.tokenId, BRIDGED_COIN)).toBe('refused');
    expect(verify).not.toHaveBeenCalled();
    expect(getBlobs).toHaveBeenCalledTimes(1);
  });

  it("never lets a plugin's policy vouch for a coin only the registry claims, even for the plugin's own type", async () => {
    const registry = moving(bridgePlugin([BRIDGED_COIN]), { [NATIVE_COIN]: BRIDGED_TYPE });
    const { engine, verdicts, mint } = await judged(registry.claims);
    const squat = await mint(NATIVE_COIN, BRIDGED_TYPE);
    const verify = vi.spyOn(engine, 'verify').mockResolvedValue({ ok: true });

    await verdicts.review([squat.blob.tokenId]);
    await verdicts.accept(squat);

    expect(verdicts.standing(squat.blob.tokenId, NATIVE_COIN)).toBe('pending');
    expect(verify).not.toHaveBeenCalled();
  });

  it('restarts the retry backoff when the claims change, instead of waiting out the old one', async () => {
    vi.useFakeTimers();
    const registry = moving(bridgePlugin());
    const { engine, verdicts, start, mint } = await judged(registry.claims);
    const token = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const verify = vi.spyOn(engine, 'verify').mockRejectedValue(new Error('gateway down'));
    await start();
    await verdicts.review([token.blob.tokenId]);
    for (const backoff of [1, 2, 4, 8]) await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS * backoff);
    expect(verify).toHaveBeenCalledTimes(5);

    registry.set({ [NATIVE_COIN]: OTHER_TYPE });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(6));
    verify.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS);

    expect(verdicts.trusts(token.blob.tokenId, BRIDGED_COIN)).toBe(true);
  });

  it('while started, a claims change tells readers and judges the holders again; stopped, it does neither', async () => {
    const registry = moving(new CoinClaims());
    const { verdicts, start, mint, changed, getBlobs } = await judged(registry.claims);
    const lookalike = await mint(BRIDGED_COIN, OTHER_TYPE);
    await start();

    registry.set({ [BRIDGED_COIN]: BRIDGED_TYPE });

    await vi.waitFor(() => expect(verdicts.standing(lookalike.blob.tokenId, BRIDGED_COIN)).toBe('refused'));
    expect(changed).toHaveBeenCalled();
    verdicts.stop();
    expect(registry.listeners.size).toBe(0);
    changed.mockClear();
    getBlobs.mockClear();
    registry.set({});
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(getBlobs).not.toHaveBeenCalled();
  });
});
