// SHA-pinned from unicity-sphere/sphere-sdk main@ce758f6b — do not modify without a re-sync note.
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
import { unwrapTokenBlobBytes } from './token-blob';

export interface DeliveryKeys {
  /** Genesis-stable 64-hex token id (TokenBlob.tokenId). */
  readonly tokenId: string;
  /** The SDK's per-state hash: hex of the DataHash imprint of the latest state. */
  readonly stateHash: string;
}

/**
 * Derive the backend-true (tokenId, stateHash) for a finished token blob.
 * Accepts BOTH byte forms — the sphere envelope (the cross-port blob format)
 * and raw wallet-api wire bytes (what the §16 API serves — §5.2/§8.2). Both
 * keys come from the DECODED token (never trusted from an envelope field), so
 * the pair is identical for either form of the same token.
 */
export async function deriveDeliveryKeys(blobBytes: Uint8Array): Promise<DeliveryKeys> {
  const token = await Token.fromCBOR(unwrapTokenBlobBytes(blobBytes));
  const stateHash = HexConverter.encode((await token.latestTransaction.calculateStateHash()).imprint);
  return { tokenId: HexConverter.encode(token.id.bytes), stateHash };
}
