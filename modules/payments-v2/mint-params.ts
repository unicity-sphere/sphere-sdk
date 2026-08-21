import type { MintParams } from '../../token-engine';

export function mintParams(recipientPubkey: Uint8Array, coinId: string, amount: bigint): MintParams {
  return { recipientPubkey, value: { assets: [{ coinId, amount }] } };
}
