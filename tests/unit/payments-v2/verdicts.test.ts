import { afterEach, describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import { TokenVerdicts, VERDICT_RETRY_MS } from '../../../modules/payments-v2/inventory/verdicts';
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

async function wallet(kv: MemoryKV = memoryKV()) {
  const engine = new FakeTokenEngine();
  const claims = new CoinClaims();
  claims.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds: [BRIDGED_COIN], verify: vi.fn() });
  const held = new Map<string, SphereToken>();
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
  return { engine, verdicts, getBlobs, changed, mint, kv };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TokenVerdicts', () => {
  it('trusts a claimed coin only in a verified token of its issuing type, and every unclaimed coin', async () => {
    const { verdicts, mint, changed } = await wallet();
    const bridged = await mint(BRIDGED_COIN, BRIDGED_TYPE);
    const lookalike = await mint(BRIDGED_COIN, OTHER_TYPE);
    const native = await mint(NATIVE_COIN, OTHER_TYPE);

    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(false);
    await verdicts.review([bridged.blob.tokenId, lookalike.blob.tokenId]);

    expect(verdicts.trusts(bridged.blob.tokenId, BRIDGED_COIN)).toBe(true);
    expect(verdicts.trusts(lookalike.blob.tokenId, BRIDGED_COIN)).toBe(false);
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

    expect(verdicts.trusts(counterfeit.blob.tokenId, BRIDGED_COIN)).toBe(false);
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
    expect(verdicts.trusts(settling.blob.tokenId, BRIDGED_COIN)).toBe(false);
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
