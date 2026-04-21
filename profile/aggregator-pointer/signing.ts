/**
 * SigningService wrapper (T-A8) — enforces SPEC §4.3 `createFromSecret`
 * discipline.
 *
 * The SDK's raw `new SigningService(privKey)` constructor uses the
 * 32-byte input AS the scalar. createFromSecret SHA-256-hashes the
 * input first, producing a different signingPubKey for the same seed.
 * These are non-interoperable. This wrapper ensures the pointer layer
 * always uses createFromSecret.
 *
 * The wrapper also captures signingPubKey as hex for use in
 * MUTEX_KEY / PENDING_VERSION_KEY / BLOCKED_FLAG_KEY templates.
 */

import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js';
import type { SecretKey } from './secret-key.js';

export interface PointerSigner {
  readonly service: SigningService;
  readonly signingPubKey: Uint8Array; // 33-byte compressed secp256k1
  readonly signingPubKeyHex: string;
}

/**
 * Build the pointer-layer signer from the HKDF-derived signingSeed.
 *
 * Uses SigningService.createFromSecret(seed) — NEVER the raw
 * constructor. Tests (and P4 AST-grep) enforce this.
 */
export async function buildPointerSigner(signingSeed: SecretKey): Promise<PointerSigner> {
  const seed = signingSeed.reveal();
  try {
    const service = await SigningService.createFromSecret(seed);
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
