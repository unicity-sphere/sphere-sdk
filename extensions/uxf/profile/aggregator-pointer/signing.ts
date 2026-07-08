/**
 * SigningService wrapper (T-A8) — v2 migration (Wave 6-P2-16).
 *
 * The v2 `SigningService` constructor uses the 32-byte input directly AS the
 * scalar. There is no v1-style `createFromSecret` hash-then-scalar helper on
 * the v2 SDK. For testnet2 the pointer signing key is therefore derived
 * one-to-one from the HKDF `signingSeed`: `pubkey = curve.G * signingSeed`.
 *
 * Non-interop note: this changes the derived `signingPubKey` for every wallet
 * relative to the v1 pointer layer (which SHA-256-hashed the seed via
 * `createFromSecret`). Testnet2 wallets are fresh; there is no wallet on both
 * networks. The wrapper still exists — it captures `signingPubKey` as hex
 * for use in `MUTEX_KEY` / `PENDING_VERSION_KEY` / `BLOCKED_FLAG_KEY`
 * templates.
 */

import { SigningService } from '../../../../token-engine/sdk.js';
import type { SecretKey } from './secret-key.js';

export interface PointerSigner {
  readonly service: SigningService;
  readonly signingPubKey: Uint8Array; // 33-byte compressed secp256k1
  readonly signingPubKeyHex: string;
}

/**
 * Build the pointer-layer signer from the HKDF-derived signingSeed.
 *
 * v2 semantics: `new SigningService(seed)` uses the seed AS the scalar.
 * The caller-owned `signingSeed.reveal()` copy is zeroed after use.
 */
export async function buildPointerSigner(signingSeed: SecretKey): Promise<PointerSigner> {
  const seed = signingSeed.reveal();
  try {
    const service = new SigningService(seed);
    const signingPubKey = service.publicKey;
    const signingPubKeyHex = bytesToHex(signingPubKey);
    return { service, signingPubKey, signingPubKeyHex };
  } finally {
    seed.fill(0);
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
