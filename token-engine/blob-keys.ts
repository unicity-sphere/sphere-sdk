/**
 * token-engine/blob-keys.ts — protocol-true delivery keys from TokenBlob bytes.
 *
 * The wallet-api backend keys mailbox entries on the SDK's PROTOCOL state hash
 * (`token.latestTransaction.calculateStateHash().imprint`, hex) — NOT a plain
 * sha256 over the token bytes (wallet-api src/validation/chain.ts; §8.2 step 4
 * validates a deposit's claimed stateHash against exactly this value, and
 * entry_id = SHA-256(tokenId ‖ stateHash) builds on it). Any client-side
 * delivery id or deposit claim MUST use this derivation; a bytes-hash variant
 * 422s on deposit and misses every entry on ack.
 *
 * Lives in token-engine because decoding requires the SDK (the one-import-point
 * rule, see ./sdk.ts).
 */
import { HexConverter, Token } from './sdk';
import { decodeTokenBlob } from './token-blob';

export interface DeliveryKeys {
  /** Genesis-stable 64-hex token id (TokenBlob.tokenId). */
  readonly tokenId: string;
  /** The SDK's per-state hash: hex of the DataHash imprint of the latest state. */
  readonly stateHash: string;
}

/** Derive the backend-true (tokenId, stateHash) for a finished token blob. */
export async function deriveDeliveryKeys(blobBytes: Uint8Array): Promise<DeliveryKeys> {
  const blob = decodeTokenBlob(blobBytes);
  const token = await Token.fromCBOR(blob.token);
  const stateHash = HexConverter.encode((await token.latestTransaction.calculateStateHash()).imprint);
  return { tokenId: blob.tokenId, stateHash };
}
