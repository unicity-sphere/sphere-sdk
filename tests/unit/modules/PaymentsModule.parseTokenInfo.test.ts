/**
 * parseTokenInfo — v2 engine path (B1, path B).
 *
 * When an engine is passed and tokenData is the v2 engine blob (hex of
 * CBOR(TokenBlob)), the coin/amount come from engine.readValue and the
 * genesis-stable tokenId from engine.tokenId. Without an engine the legacy v1
 * TXF parsing is used (and a blob string falls through to the UNKNOWN defaults).
 */
import { describe, it, expect } from 'vitest';
import { parseTokenInfo } from '../../../modules/payments/PaymentsModule';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';

const PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(9)]); // 33 bytes
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex

async function blobSdkData(fake: FakeTokenEngine, coinId: string, amount: bigint): Promise<string> {
  const st = await fake.mint({ recipientPubkey: PUBKEY, value: { assets: [{ coinId, amount }] } });
  return bytesToHex(encodeTokenBlob(fake.encodeToken(st)));
}

describe('parseTokenInfo — v2 engine path (B1)', () => {
  it('reads coinId/amount/tokenId from a blob via the engine', async () => {
    const fake = new FakeTokenEngine();
    const st = await fake.mint({ recipientPubkey: PUBKEY, value: { assets: [{ coinId: UCT, amount: 100n }] } });
    const sdkData = bytesToHex(encodeTokenBlob(fake.encodeToken(st)));

    const info = await parseTokenInfo(sdkData, fake);

    expect(info.coinId).toBe(UCT);
    expect(info.amount).toBe('100');
    expect(info.tokenId).toBe(fake.tokenId(st));
  });

  it('carries the genesis tokenId even for a value-less (data) token', async () => {
    const fake = new FakeTokenEngine();
    const dt = await fake.mintDataToken({ recipientPubkey: PUBKEY, data: new Uint8Array([1, 2, 3]) });
    const sdkData = bytesToHex(encodeTokenBlob(fake.encodeToken(dt)));

    const info = await parseTokenInfo(sdkData, fake);

    expect(info.tokenId).toBe(fake.tokenId(dt));
    expect(info.coinId).toBe('UNKNOWN'); // value-less → defaults for coin fields
  });

  it('without an engine, a blob string falls through to UNKNOWN defaults', async () => {
    const fake = new FakeTokenEngine();
    const sdkData = await blobSdkData(fake, UCT, 100n);

    const info = await parseTokenInfo(sdkData); // no engine

    expect(info.coinId).toBe('UNKNOWN');
    expect(info.amount).toBe('0');
  });
});
