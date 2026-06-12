import { describe, it, expect } from 'vitest';

import { seal, open } from '../../../vault-aead/aead';

const KEY32 = new Uint8Array(32).map((_, i) => i + 1); // 01,02,...,20
const NONCE24 = new Uint8Array(24).map((_, i) => 0xa0 + i); // a0,a1,...,b7
const PT = new TextEncoder().encode('vault-aead plaintext payload');
const AAD = new TextEncoder().encode('bound-aad');

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('vault-aead seal/open (xchacha20poly1305, 24-byte nonce)', () => {
  it('round-trips plaintext', () => {
    const ct = seal(KEY32, NONCE24, PT, AAD);
    const recovered = open(KEY32, NONCE24, ct, AAD);
    expect(Buffer.from(recovered).equals(Buffer.from(PT))).toBe(true);
  });

  it('open with wrong AAD throws (tag failure)', () => {
    const ct = seal(KEY32, NONCE24, PT, AAD);
    const wrongAad = new TextEncoder().encode('other-aad');
    expect(() => open(KEY32, NONCE24, ct, wrongAad)).toThrow();
  });

  it('seal with a 12-byte nonce throws (proves xchacha, not chacha)', () => {
    const shortNonce = new Uint8Array(12).fill(0x05);
    expect(() => seal(KEY32, shortNonce, PT, AAD)).toThrow();
  });

  it('pinned KAT: fixed (key,nonce,pt,aad) -> fixed base64 ct', () => {
    const ct = seal(KEY32, NONCE24, PT, AAD);
    // KAT — generated once from the real xchacha20poly1305 implementation.
    expect(b64(ct)).toBe(
      '8lPwc9ff5kTBaCuIQg7rWt9uEvcCS3i7zlinZUGcX1SAG4wh6GcGQvwTTFY=',
    );
  });
});
