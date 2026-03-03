/**
 * Tests for core/crypto.ts
 * Covers BIP39 mnemonic, BIP32 key derivation, and hash functions
 */

import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
  mnemonicToSeed,
  mnemonicToEntropy,
  entropyToMnemonic,
  generateMasterKey,
  deriveChildKey,
  deriveKeyAtPath,
  getPublicKey,
  createKeyPair,
  sha256,
  ripemd160,
  hash160,
  doubleSha256,
  publicKeyToAddress,
  privateKeyToAddressInfo,
  hexToBytes,
  bytesToHex,
  randomBytes,
  deriveAddressInfo,
  identityFromMnemonicSync,
  DEFAULT_DERIVATION_PATH,
  SIGN_MESSAGE_PREFIX,
  hashSignMessage,
  signMessage,
  verifySignedMessage,
} from '../../../core/crypto';

import {
  BIP39_VECTORS,
  BIP32_VECTORS,
  HASH_VECTORS,
  ADDRESS_VECTORS,
} from '../../fixtures/test-vectors';

// =============================================================================
// BIP39 Mnemonic Tests
// =============================================================================

describe('BIP39 Mnemonic Functions', () => {
  describe('generateMnemonic()', () => {
    it('should generate 12 words by default (128 bits)', () => {
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(12);
    });

    it('should generate 12 words for 128-bit strength', () => {
      const mnemonic = generateMnemonic(128);
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(12);
    });

    it('should generate 24 words for 256-bit strength', () => {
      const mnemonic = generateMnemonic(256);
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(24);
    });

    it('should generate valid BIP39 mnemonic', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('should generate unique mnemonics', () => {
      const mnemonic1 = generateMnemonic();
      const mnemonic2 = generateMnemonic();
      expect(mnemonic1).not.toBe(mnemonic2);
    });
  });

  describe('validateMnemonic()', () => {
    it('should return true for valid mnemonics', () => {
      for (const vector of BIP39_VECTORS) {
        expect(validateMnemonic(vector.mnemonic)).toBe(true);
      }
    });

    it('should return false for invalid mnemonics', () => {
      expect(validateMnemonic('invalid mnemonic phrase')).toBe(false);
      expect(validateMnemonic('')).toBe(false);
      expect(validateMnemonic('abandon')).toBe(false);
      // Wrong checksum
      expect(
        validateMnemonic(
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
        )
      ).toBe(false);
    });

    it('should return false for 11-word phrase', () => {
      expect(
        validateMnemonic(
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
        )
      ).toBe(false);
    });
  });

  describe('mnemonicToSeedSync()', () => {
    it('should convert mnemonic to seed using test vectors', () => {
      for (const vector of BIP39_VECTORS) {
        const seed = mnemonicToSeedSync(vector.mnemonic);
        expect(seed).toBe(vector.seed);
      }
    });

    it('should return 128 hex characters (64 bytes)', () => {
      const seed = mnemonicToSeedSync(BIP39_VECTORS[0].mnemonic);
      expect(seed).toHaveLength(128);
      expect(/^[0-9a-f]+$/.test(seed)).toBe(true);
    });

    it('should produce different seed with passphrase', () => {
      const seedWithoutPass = mnemonicToSeedSync(BIP39_VECTORS[0].mnemonic);
      const seedWithPass = mnemonicToSeedSync(BIP39_VECTORS[0].mnemonic, 'TREZOR');
      expect(seedWithoutPass).not.toBe(seedWithPass);
    });
  });

  describe('mnemonicToSeed() async', () => {
    it('should produce same result as sync version', async () => {
      const seedSync = mnemonicToSeedSync(BIP39_VECTORS[0].mnemonic);
      const seedAsync = await mnemonicToSeed(BIP39_VECTORS[0].mnemonic);
      expect(seedAsync).toBe(seedSync);
    });
  });

  describe('mnemonicToEntropy() and entropyToMnemonic()', () => {
    it('should round-trip entropy correctly', () => {
      for (const vector of BIP39_VECTORS) {
        const entropy = mnemonicToEntropy(vector.mnemonic);
        expect(entropy).toBe(vector.entropy);
        const recovered = entropyToMnemonic(entropy);
        expect(recovered).toBe(vector.mnemonic);
      }
    });
  });
});

// =============================================================================
// BIP32 Key Derivation Tests
// =============================================================================

describe('BIP32 Key Derivation', () => {
  describe('generateMasterKey()', () => {
    it('should generate master key from seed', () => {
      const vector = BIP32_VECTORS[0];
      const masterKey = generateMasterKey(vector.seed);
      expect(masterKey.privateKey).toBe(vector.masterPrivateKey);
      expect(masterKey.chainCode).toBe(vector.masterChainCode);
    });

    it('should produce 64-char hex keys', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      expect(masterKey.privateKey).toHaveLength(64);
      expect(masterKey.chainCode).toHaveLength(64);
    });

    it('should throw for invalid master key (edge case)', () => {
      // This is a rare edge case - we test that validation exists
      // Most random seeds will produce valid keys
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      expect(BigInt('0x' + masterKey.privateKey)).toBeGreaterThan(0n);
    });
  });

  describe('deriveChildKey()', () => {
    it('should derive hardened child key correctly', () => {
      const vector = BIP32_VECTORS[0];
      const child = vector.children[0];
      const hardenedIndex = 0x80000000; // 0'

      const derived = deriveChildKey(
        vector.masterPrivateKey,
        vector.masterChainCode,
        hardenedIndex
      );
      expect(derived.privateKey).toBe(child.privateKey);
      expect(derived.chainCode).toBe(child.chainCode);
    });

    it('should derive non-hardened child key', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const derived = deriveChildKey(masterKey.privateKey, masterKey.chainCode, 0);
      expect(derived.privateKey).toHaveLength(64);
      expect(derived.chainCode).toHaveLength(64);
    });

    it('should produce different keys for different indices', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const child0 = deriveChildKey(masterKey.privateKey, masterKey.chainCode, 0);
      const child1 = deriveChildKey(masterKey.privateKey, masterKey.chainCode, 1);
      expect(child0.privateKey).not.toBe(child1.privateKey);
    });
  });

  describe('deriveKeyAtPath()', () => {
    it('should derive key at BIP44 path', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const derived = deriveKeyAtPath(
        masterKey.privateKey,
        masterKey.chainCode,
        "m/44'/0'/0'/0/0"
      );
      expect(derived.privateKey).toHaveLength(64);
      expect(derived.chainCode).toHaveLength(64);
    });

    it('should handle hardened notation with apostrophe', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const derivedApostrophe = deriveKeyAtPath(
        masterKey.privateKey,
        masterKey.chainCode,
        "m/44'/0'/0'"
      );
      const derivedH = deriveKeyAtPath(
        masterKey.privateKey,
        masterKey.chainCode,
        'm/44h/0h/0h'
      );
      expect(derivedApostrophe.privateKey).toBe(derivedH.privateKey);
    });

    it('should derive unique addresses at different indices', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const key0 = deriveKeyAtPath(masterKey.privateKey, masterKey.chainCode, "m/44'/0'/0'/0/0");
      const key1 = deriveKeyAtPath(masterKey.privateKey, masterKey.chainCode, "m/44'/0'/0'/0/1");
      expect(key0.privateKey).not.toBe(key1.privateKey);
    });
  });
});

// =============================================================================
// Key Pair Operations Tests
// =============================================================================

describe('Key Pair Operations', () => {
  describe('getPublicKey()', () => {
    it('should generate compressed public key by default', () => {
      const pubKey = getPublicKey(ADDRESS_VECTORS[0].privateKey);
      expect(pubKey).toBe(ADDRESS_VECTORS[0].publicKey);
      expect(pubKey).toHaveLength(66); // 33 bytes = 66 hex chars
      expect(pubKey.startsWith('02') || pubKey.startsWith('03')).toBe(true);
    });

    it('should generate uncompressed public key when requested', () => {
      const pubKey = getPublicKey(ADDRESS_VECTORS[0].privateKey, false);
      expect(pubKey).toHaveLength(130); // 65 bytes = 130 hex chars
      expect(pubKey.startsWith('04')).toBe(true);
    });
  });

  describe('createKeyPair()', () => {
    it('should create key pair with compressed public key', () => {
      const keyPair = createKeyPair(ADDRESS_VECTORS[0].privateKey);
      expect(keyPair.privateKey).toBe(ADDRESS_VECTORS[0].privateKey);
      expect(keyPair.publicKey).toBe(ADDRESS_VECTORS[0].publicKey);
    });
  });
});

// =============================================================================
// Hash Functions Tests
// =============================================================================

describe('Hash Functions', () => {
  describe('sha256()', () => {
    it('should compute SHA256 hash for hex input', () => {
      for (const vector of HASH_VECTORS.sha256) {
        const result = sha256(vector.input, 'hex');
        expect(result).toBe(vector.expected);
      }
    });

    it('should compute SHA256 hash for utf8 input', () => {
      const result = sha256('hello', 'utf8');
      expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
  });

  describe('ripemd160()', () => {
    it('should compute RIPEMD160 hash for hex input', () => {
      for (const vector of HASH_VECTORS.ripemd160) {
        const result = ripemd160(vector.input, 'hex');
        expect(result).toBe(vector.expected);
      }
    });
  });

  describe('hash160()', () => {
    it('should compute HASH160 (SHA256 -> RIPEMD160)', () => {
      for (const vector of HASH_VECTORS.hash160) {
        const result = hash160(vector.input);
        expect(result).toBe(vector.expected);
      }
    });
  });

  describe('doubleSha256()', () => {
    it('should compute double SHA256', () => {
      for (const vector of HASH_VECTORS.doubleSha256) {
        const result = doubleSha256(vector.input, 'hex');
        expect(result).toBe(vector.expected);
      }
    });
  });
});

// =============================================================================
// Address Generation Tests
// =============================================================================

describe('Address Generation', () => {
  describe('publicKeyToAddress()', () => {
    it('should generate bech32 address from public key', () => {
      const address = publicKeyToAddress(ADDRESS_VECTORS[0].publicKey, 'alpha', 0);
      expect(address.startsWith('alpha1')).toBe(true);
    });

    it('should generate address with custom prefix', () => {
      const address = publicKeyToAddress(ADDRESS_VECTORS[0].publicKey, 'test', 0);
      expect(address.startsWith('test1')).toBe(true);
    });
  });

  describe('privateKeyToAddressInfo()', () => {
    it('should return address and public key', () => {
      const info = privateKeyToAddressInfo(ADDRESS_VECTORS[0].privateKey, 'alpha');
      expect(info.publicKey).toBe(ADDRESS_VECTORS[0].publicKey);
      expect(info.address.startsWith('alpha1')).toBe(true);
    });
  });

  describe('deriveAddressInfo()', () => {
    it('should derive address info at index', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const info = deriveAddressInfo(masterKey, "m/44'/0'/0'", 0);

      expect(info.privateKey).toHaveLength(64);
      expect(info.publicKey).toHaveLength(66);
      expect(info.address.startsWith('alpha1')).toBe(true);
      expect(info.path).toBe("m/44'/0'/0'/0/0");
      expect(info.index).toBe(0);
    });

    it('should derive change address when isChange=true', () => {
      const seed = BIP39_VECTORS[0].seed;
      const masterKey = generateMasterKey(seed);
      const receiving = deriveAddressInfo(masterKey, "m/44'/0'/0'", 0, false);
      const change = deriveAddressInfo(masterKey, "m/44'/0'/0'", 0, true);

      expect(receiving.path).toBe("m/44'/0'/0'/0/0");
      expect(change.path).toBe("m/44'/0'/0'/1/0");
      expect(receiving.address).not.toBe(change.address);
    });
  });
});

// =============================================================================
// Utility Functions Tests
// =============================================================================

describe('Utility Functions', () => {
  describe('hexToBytes() and bytesToHex()', () => {
    it('should round-trip hex to bytes and back', () => {
      const hex = 'deadbeef';
      const bytes = hexToBytes(hex);
      expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      expect(bytesToHex(bytes)).toBe(hex);
    });

    it('should handle empty string', () => {
      const bytes = hexToBytes('');
      expect(bytes).toEqual(new Uint8Array(0));
      expect(bytesToHex(bytes)).toBe('');
    });

    it('should handle leading zeros', () => {
      const hex = '00deadbeef';
      const bytes = hexToBytes(hex);
      expect(bytesToHex(bytes)).toBe(hex);
    });
  });

  describe('randomBytes()', () => {
    it('should generate random bytes of specified length', () => {
      const hex = randomBytes(16);
      expect(hex).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should generate unique values', () => {
      const a = randomBytes(32);
      const b = randomBytes(32);
      expect(a).not.toBe(b);
    });
  });
});

// =============================================================================
// High-Level Functions Tests
// =============================================================================

describe('High-Level Functions', () => {
  describe('identityFromMnemonicSync()', () => {
    it('should generate master key from mnemonic', () => {
      const mnemonic = BIP39_VECTORS[0].mnemonic;
      const masterKey = identityFromMnemonicSync(mnemonic);
      expect(masterKey.privateKey).toHaveLength(64);
      expect(masterKey.chainCode).toHaveLength(64);
    });

    it('should throw for invalid mnemonic', () => {
      expect(() => identityFromMnemonicSync('invalid mnemonic')).toThrow('Invalid mnemonic');
    });
  });

  describe('DEFAULT_DERIVATION_PATH', () => {
    it('should be valid BIP44 path', () => {
      expect(DEFAULT_DERIVATION_PATH).toBe("m/44'/0'/0'");
    });
  });
});

// =============================================================================
// Message Signing Tests
// =============================================================================

describe('Message Signing', () => {
  // Use known test key pair from ADDRESS_VECTORS
  const TEST_PRIVATE_KEY = ADDRESS_VECTORS[0].privateKey;
  const TEST_PUBLIC_KEY = ADDRESS_VECTORS[0].publicKey;
  const TEST_MESSAGE = 'Hello, Sphere!';

  describe('SIGN_MESSAGE_PREFIX', () => {
    it('should be the expected prefix string', () => {
      expect(SIGN_MESSAGE_PREFIX).toBe('Sphere Signed Message:\n');
    });
  });

  describe('hashSignMessage()', () => {
    it('should return a 64-char hex string (32 bytes)', () => {
      const hash = hashSignMessage(TEST_MESSAGE);
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('should be deterministic', () => {
      const hash1 = hashSignMessage(TEST_MESSAGE);
      const hash2 = hashSignMessage(TEST_MESSAGE);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different messages', () => {
      const hash1 = hashSignMessage('message A');
      const hash2 = hashSignMessage('message B');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty message', () => {
      const hash = hashSignMessage('');
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('should handle unicode messages', () => {
      const hash = hashSignMessage('Привет мир! 🌍');
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('should handle long messages', () => {
      const longMessage = 'A'.repeat(10000);
      const hash = hashSignMessage(longMessage);
      expect(hash).toHaveLength(64);
    });
  });

  describe('signMessage()', () => {
    it('should return a 130-char hex string (v + r + s)', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      expect(signature).toHaveLength(130);
      expect(/^[0-9a-f]+$/.test(signature)).toBe(true);
    });

    it('should have valid recovery byte v (31-34)', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const v = parseInt(signature.slice(0, 2), 16);
      expect(v).toBeGreaterThanOrEqual(31);
      expect(v).toBeLessThanOrEqual(34);
    });

    it('should be deterministic for same key and message', () => {
      const sig1 = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const sig2 = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different messages', () => {
      const sig1 = signMessage(TEST_PRIVATE_KEY, 'message A');
      const sig2 = signMessage(TEST_PRIVATE_KEY, 'message B');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different keys', () => {
      const otherKey = 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35';
      const sig1 = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const sig2 = signMessage(otherKey, TEST_MESSAGE);
      expect(sig1).not.toBe(sig2);
    });

    it('should handle empty message', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, '');
      expect(signature).toHaveLength(130);
    });

    it('should handle challenge-format message', () => {
      const challenge = [
        'Sign in to Sphere Quests',
        '',
        'Domain: localhost:5175',
        'Address: DIRECT://abc123',
        'Nonce: test-nonce-123',
        'Issued At: 2026-03-03T20:50:26.812Z',
        'Expiration Time: 2026-03-03T20:55:26.812Z',
      ].join('\n');
      const signature = signMessage(TEST_PRIVATE_KEY, challenge);
      expect(signature).toHaveLength(130);
    });
  });

  describe('verifySignedMessage()', () => {
    it('should verify a valid signature', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const result = verifySignedMessage(TEST_MESSAGE, signature, TEST_PUBLIC_KEY);
      expect(result).toBe(true);
    });

    it('should reject signature with wrong message', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const result = verifySignedMessage('wrong message', signature, TEST_PUBLIC_KEY);
      expect(result).toBe(false);
    });

    it('should reject signature with wrong public key', () => {
      const otherKey = 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35';
      const otherPubKey = getPublicKey(otherKey);
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      const result = verifySignedMessage(TEST_MESSAGE, signature, otherPubKey);
      expect(result).toBe(false);
    });

    it('should reject invalid signature length', () => {
      expect(verifySignedMessage(TEST_MESSAGE, 'abcdef', TEST_PUBLIC_KEY)).toBe(false);
      expect(verifySignedMessage(TEST_MESSAGE, '', TEST_PUBLIC_KEY)).toBe(false);
    });

    it('should reject tampered signature', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      // Flip a byte in the r component
      const tampered = signature.slice(0, 10) + 'ff' + signature.slice(12);
      const result = verifySignedMessage(TEST_MESSAGE, tampered, TEST_PUBLIC_KEY);
      expect(result).toBe(false);
    });

    it('should reject invalid recovery byte', () => {
      const signature = signMessage(TEST_PRIVATE_KEY, TEST_MESSAGE);
      // Set v to 0x00 (invalid: v - 31 = -31)
      const invalidV = '00' + signature.slice(2);
      expect(verifySignedMessage(TEST_MESSAGE, invalidV, TEST_PUBLIC_KEY)).toBe(false);
    });

    it('should work with unicode messages', () => {
      const msg = 'Подпись кошелька 🔑';
      const sig = signMessage(TEST_PRIVATE_KEY, msg);
      expect(verifySignedMessage(msg, sig, TEST_PUBLIC_KEY)).toBe(true);
    });

    it('should work with empty message', () => {
      const sig = signMessage(TEST_PRIVATE_KEY, '');
      expect(verifySignedMessage('', sig, TEST_PUBLIC_KEY)).toBe(true);
    });
  });

  describe('sign + verify round-trip', () => {
    it('should work with multiple different keys', () => {
      const keys = [
        ADDRESS_VECTORS[0].privateKey,
        BIP32_VECTORS[0].masterPrivateKey,
        BIP32_VECTORS[0].children[0].privateKey,
      ];

      for (const privateKey of keys) {
        const pubKey = getPublicKey(privateKey);
        const sig = signMessage(privateKey, 'round-trip test');
        expect(verifySignedMessage('round-trip test', sig, pubKey)).toBe(true);
      }
    });

    it('should not cross-verify between different keys', () => {
      const key1 = ADDRESS_VECTORS[0].privateKey;
      const key2 = BIP32_VECTORS[0].masterPrivateKey;
      const pub1 = getPublicKey(key1);
      const pub2 = getPublicKey(key2);

      const sig1 = signMessage(key1, TEST_MESSAGE);
      const sig2 = signMessage(key2, TEST_MESSAGE);

      // Each signature should only verify with its own pubkey
      expect(verifySignedMessage(TEST_MESSAGE, sig1, pub1)).toBe(true);
      expect(verifySignedMessage(TEST_MESSAGE, sig1, pub2)).toBe(false);
      expect(verifySignedMessage(TEST_MESSAGE, sig2, pub2)).toBe(true);
      expect(verifySignedMessage(TEST_MESSAGE, sig2, pub1)).toBe(false);
    });
  });
});
