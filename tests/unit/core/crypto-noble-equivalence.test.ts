/**
 * Golden-vector equivalence tests for the elliptic → @noble/curves migration (#674).
 *
 * The expected values below were captured from the elliptic-based implementation
 * (v0.11.11, commit facaca6e) BEFORE the migration. They encode the cross-language
 * signature contract: the aggregator-subscription proxy verifies these exact bytes
 * server-side in Java/BouncyCastle (`SphereSignedMessage.java`) for SGW auth —
 * v = 31 + recoveryId (0..3), r and s as 32-byte big-endian hex (low-S,
 * RFC6979-deterministic), pubkeys as 33-byte compressed SEC1 lowercase hex.
 *
 * DO NOT update these literals to make a failing implementation pass. A mismatch
 * means the implementation regressed — byte-drift here breaks wallet auth against
 * deployed verifiers.
 */

import { describe, it, expect } from 'vitest';
import {
  getPublicKey,
  hashSignMessage,
  signMessage,
  verifySignedMessage,
  recoverPubkeyFromSignature,
  deriveChildKey,
  deriveAddressInfo,
  entropyToMnemonic,
  identityFromMnemonicSync,
  DEFAULT_DERIVATION_PATH,
} from '../../../core/crypto';

/** secp256k1 half order — signatures must be low-S (canonical / BTC-compatible). */
const HALF_ORDER = BigInt(
  '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0'
);

interface GoldenVector {
  name: string;
  privateKey: string;
  message: string;
  compressed: string;
  uncompressed: string;
  hash: string;
  signature: string;
  recovered: string;
}

// 560-byte message — exercises the 3-byte varint (0xfd) length-prefix path.
const LONG_MESSAGE = 'sphere-golden-'.repeat(40);

const GOLDEN_VECTORS: GoldenVector[] = [
  {
    name: 'privkey=1 (30 leading zero bytes), empty message',
    privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
    message: '',
    compressed: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    uncompressed:
      '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
    hash: 'f06f7738d0de178c64ab309c40ce34bd31031f7295a53ce8bb287baf2104d3a6',
    signature:
      '20760a3ce2064403629e85c70f238c952806b6039fdc8af7190360dff7d4c5ec13795533d2baab2b9c8eb5e0204bb5cd47d1ef8a633efc7355f4ff400f67d81338',
    recovered: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  },
  {
    name: 'leading-zero-byte key, unicode message',
    privateKey: '00a1b2c3d4e5f60718293a4b5c6d7e8f9091a2b3c4d5e6f708192a3b4c5d6e7f',
    message: 'héllo ⚡ ünïcode 日本語 🚀',
    compressed: '030c0557c356f97ce5745d75a8eaf80d4ddffdb42223a4de66a7e75fa4b7b2488b',
    uncompressed:
      '040c0557c356f97ce5745d75a8eaf80d4ddffdb42223a4de66a7e75fa4b7b2488bd5e64ee33890f71f5ff7bcf80b638c219dda42e8f7a0890ae2bd0feeed31ee11',
    hash: 'a4560ce2c8d28581fd0a41c9ad89db2e51d92cff356936fb12a3cbc8722cd6ba',
    signature:
      '2089de3618c2d700698989f1a37fa4fa408901e39159b1523670bd6ce28151a92915d0a363e25fdb7c2ea9e70b3f2cc3f32a9c326e07c8b440a612b0ee52ceb7ee',
    recovered: '030c0557c356f97ce5745d75a8eaf80d4ddffdb42223a4de66a7e75fa4b7b2488b',
  },
  {
    name: "24-word-derived key (m/44'/0'/0'/0/0 of all-zero entropy), ascii message",
    privateKey: 'cb4793fa23e98437e2d37655eaaa59cf03a0637ea890f85a85d91946e9214c64',
    message: 'SGW auth challenge 42',
    compressed: '0342d943b8dba93a4ce29b858479c67f1e4f1110eecbe1f83dc01b455eb8b123b3',
    uncompressed:
      '0442d943b8dba93a4ce29b858479c67f1e4f1110eecbe1f83dc01b455eb8b123b372ff98e283aebf0b5209a6546a47db8fbc307ba4d3c2146d31179a9de6464693',
    hash: '9621f61f90b57aa1790b7f0bbbdb2f26583a8eb150e430075409c379a77b17d8',
    signature:
      '1fb44295d43e99c69270e69746ca5751b934c6fc1ff1606bb9826754f6ea529b0e47a2e287b3542e32e6b0a7ff0015835c00b3b7f1bc9dadd85e8121fbd04cfadd',
    recovered: '0342d943b8dba93a4ce29b858479c67f1e4f1110eecbe1f83dc01b455eb8b123b3',
  },
  {
    name: 'n-1 private key, short message',
    privateKey: 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
    message: 'test',
    compressed: '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    uncompressed:
      '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798b7c52588d95c3b9aa25b0403f1eef75702e84bb7597aabe663b82f6f04ef2777',
    hash: 'cf21516be50d2c5fffc8818f37e785bfbf6f702dfcd54a42a8a3c4b6e69e84a8',
    signature:
      '20f4da5417bf62f23531e9eb95ba2fcb9c033690f5a2a274e2274a76822f0c1a362b156433a5b3b356040210fcd241ee6ee835be59e9b90e7e336e1e17b7712d75',
    recovered: '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  },
  {
    name: 'mid-range key, long message (>252 bytes, 3-byte varint path)',
    privateKey: '4242424242424242424242424242424242424242424242424242424242424242',
    message: LONG_MESSAGE,
    compressed: '0324653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c',
    uncompressed:
      '0424653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c119fc5009a032aa9fe47f5e149bb8442f71f884ccb516590686d8ff6ab91c613',
    hash: '11b343b6165986e28395a81d01c0808992f7d1dbe21e86624e6f707075b443f3',
    signature:
      '20a414dacddb5b83b7c3b951ba141c7bed366adeb96b724a5af7ba2887a63078dd387e66205ae3766b81b79af07b3d5956b589f039b4eb105f9fb5e4154507ab87',
    recovered: '0324653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c',
  },
];

describe('crypto noble equivalence — golden vectors captured from elliptic v0.11.11', () => {
  describe.each(GOLDEN_VECTORS)('$name', (v) => {
    it('getPublicKey — compressed (33-byte, 02/03 prefix)', () => {
      const pub = getPublicKey(v.privateKey, true);
      expect(pub).toBe(v.compressed);
      expect(pub).toMatch(/^0[23][0-9a-f]{64}$/);
    });

    it('getPublicKey — uncompressed (65-byte, 04 prefix)', () => {
      const pub = getPublicKey(v.privateKey, false);
      expect(pub).toBe(v.uncompressed);
      expect(pub).toMatch(/^04[0-9a-f]{128}$/);
    });

    it('getPublicKey — default is compressed', () => {
      expect(getPublicKey(v.privateKey)).toBe(v.compressed);
    });

    it('hashSignMessage — double-SHA256 varint digest', () => {
      expect(hashSignMessage(v.message)).toBe(v.hash);
    });

    it('signMessage — byte-identical v+r+s (RFC6979 deterministic)', () => {
      expect(signMessage(v.privateKey, v.message)).toBe(v.signature);
    });

    it('signMessage — SphereSignedMessage.java format contract (130 lowercase hex, v=31+recId, low-S)', () => {
      const sig = signMessage(v.privateKey, v.message);
      // Java: SIGNATURE_PATTERN = ^[0-9a-f]{130}$
      expect(sig).toMatch(/^[0-9a-f]{130}$/);
      // Java: recoveryId = v - 31, must be in [0..3]
      const recoveryId = parseInt(sig.slice(0, 2), 16) - 31;
      expect(recoveryId).toBeGreaterThanOrEqual(0);
      expect(recoveryId).toBeLessThanOrEqual(3);
      // Canonical low-S (elliptic {canonical:true} ≡ noble lowS default)
      const s = BigInt('0x' + sig.slice(66, 130));
      expect(s <= HALF_ORDER).toBe(true);
    });

    it('verifySignedMessage — accepts the golden signature', () => {
      expect(verifySignedMessage(v.message, v.signature, v.compressed)).toBe(true);
    });

    it('verifySignedMessage — rejects a tampered signature', () => {
      // Flip the last nibble of s
      const last = v.signature.slice(-1);
      const flipped = (parseInt(last, 16) ^ 0x1).toString(16);
      const tampered = v.signature.slice(0, -1) + flipped;
      expect(verifySignedMessage(v.message, tampered, v.compressed)).toBe(false);
    });

    it('recoverPubkeyFromSignature — recovers the golden compressed pubkey', () => {
      expect(recoverPubkeyFromSignature(v.message, v.signature)).toBe(v.recovered);
    });
  });

  describe('EC-dependent BIP32 derivation (non-hardened branch uses the compressed pubkey)', () => {
    // 24-word mnemonic from all-zero 256-bit entropy (standard BIP39 test vector)
    const MNEMONIC_24 = entropyToMnemonic('00'.repeat(32));

    it('all-zero-entropy 24-word mnemonic is stable', () => {
      expect(MNEMONIC_24).toBe(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
          'abandon abandon abandon abandon abandon art'
      );
    });

    it('master key from 24-word mnemonic is byte-identical', () => {
      const master = identityFromMnemonicSync(MNEMONIC_24);
      expect(master.privateKey).toBe(
        '235b34cd7c9f6d7e4595ffe9ae4b1cb5606df8aca2b527d20a07c8f56b2342f4'
      );
      expect(master.chainCode).toBe(
        'f40eaad21641ca7cb5ac00f9ce21cac9ba070bb673a237f7bce57acda54386a4'
      );
    });

    it('non-hardened deriveChildKey (index 0) is byte-identical', () => {
      const master = identityFromMnemonicSync(MNEMONIC_24);
      const child = deriveChildKey(master.privateKey, master.chainCode, 0);
      expect(child.privateKey).toBe(
        'da44d2b30836e1ca7c38b2b32fb5f62e07209364248e8a3eb86ffa2aa2ff3af1'
      );
      expect(child.chainCode).toBe(
        '720f054103868ffcccf40da0f9002350d6deffd0b2e88ec5a8f4231d6db7f155'
      );
    });

    it("deriveAddressInfo at m/44'/0'/0'/0/0 is byte-identical", () => {
      const master = identityFromMnemonicSync(MNEMONIC_24);
      const addr = deriveAddressInfo(master, DEFAULT_DERIVATION_PATH, 0);
      expect(addr.privateKey).toBe(
        'cb4793fa23e98437e2d37655eaaa59cf03a0637ea890f85a85d91946e9214c64'
      );
      expect(addr.publicKey).toBe(
        '0342d943b8dba93a4ce29b858479c67f1e4f1110eecbe1f83dc01b455eb8b123b3'
      );
      expect(addr.path).toBe("m/44'/0'/0'/0/0");
    });
  });
});

describe('recovery-id v-byte wiring — all four values [0..3] exercised (#674 review)', () => {
  // signMessage cannot naturally emit recoveryId 2/3 (needs R.x >= n, probability
  // ~2^-128 under RFC6979), so no golden signMessage vector can cover them. But
  // verify/recover ACCEPT external v in [0..3], so decode wiring for 2/3 must
  // still be exercised: take the privkey=1 vector (recoveryId 1, v=0x20) and
  // tamper the v byte to every other value, driving addRecoveryBit(0/2/3) for
  // real. A wiring bug that mapped 2/3 onto 0/1 would let a wrong byte recover
  // the signer — these assertions would catch it.
  const v = GOLDEN_VECTORS[0];
  const signer = v.recovered;
  const rs = v.signature.slice(2); // r||s (128 hex), v byte stripped

  it('v = 31 + recoveryId is a bijection over [0..3]', () => {
    for (const rec of [0, 1, 2, 3]) {
      const vByte = (31 + rec).toString(16).padStart(2, '0');
      expect(parseInt(vByte, 16) - 31).toBe(rec);
    }
  });

  it('only the correct recovery byte (0x20) recovers the signer; 0x1f/0x21/0x22 do not', () => {
    const tryRecover = (vByte: string): string | null => {
      try {
        return recoverPubkeyFromSignature(v.message, vByte + rs);
      } catch {
        return null; // no valid point for this recovery id — acceptable
      }
    };
    expect(tryRecover('20')).toBe(signer); // recoveryId 1
    for (const vByte of ['1f', '21', '22']) {
      // recoveryId 0, 2, 3 — must reach noble and never return the signer
      expect(tryRecover(vByte)).not.toBe(signer);
    }
  });

  it('verifySignedMessage accepts only the correct recovery byte', () => {
    expect(verifySignedMessage(v.message, '20' + rs, signer)).toBe(true);
    for (const vByte of ['1f', '21', '22']) {
      expect(verifySignedMessage(v.message, vByte + rs, signer)).toBe(false);
    }
  });
});

describe('private-key input validation (#674 review)', () => {
  const VALID = '0000000000000000000000000000000000000000000000000000000000000001';

  it('getPublicKey rejects a right-length key with a non-hex char (no silent zero-coercion)', () => {
    // 'gg' would coerce to 0x00 in hexToBytes → a different valid key, no error.
    expect(() => getPublicKey('gg' + VALID.slice(2))).toThrow(/expected 64 hex/);
  });

  it('getPublicKey rejects wrong-length keys', () => {
    expect(() => getPublicKey('0102')).toThrow(/expected 64 hex/);
    expect(() => getPublicKey('')).toThrow(/expected 64 hex/);
  });

  it('signMessage rejects a right-length key with a non-hex char', () => {
    expect(() => signMessage('gg' + VALID.slice(2), 'msg')).toThrow(/expected 64 hex/);
  });

  it('a valid key still succeeds unchanged', () => {
    expect(getPublicKey(VALID)).toBe(GOLDEN_VECTORS[0].compressed);
  });
});
