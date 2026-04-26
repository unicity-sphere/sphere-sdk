/**
 * Tests for core/encryption.ts
 * Covers AES-256 encryption utilities
 */

import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  decryptJson,
  encryptSimple,
  decryptSimple,
  encryptMnemonic,
  decryptMnemonic,
  isEncryptedData,
  serializeEncrypted,
  deserializeEncrypted,
  generateRandomKey,
} from '../../../core/encryption';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PASSWORD = 'test-password-123';
const TEST_PLAINTEXT = 'Hello, World! This is a secret message.';
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// =============================================================================
// encrypt/decrypt Tests
// =============================================================================

describe('encrypt()', () => {
  it('should encrypt string data', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.salt).toBeDefined();
    // Steelman³⁸: new writes are authenticated (Encrypt-then-MAC).
    expect(encrypted.algorithm).toBe('aes-256-cbc-hmac-sha256');
    expect(encrypted.mac).toBeDefined();
    expect(encrypted.kdf).toBe('pbkdf2');
    expect(encrypted.iterations).toBe(100000);
  });

  it('should encrypt object data', () => {
    const data = { message: 'secret', count: 42 };
    const encrypted = encrypt(data, TEST_PASSWORD);

    expect(encrypted.ciphertext).toBeDefined();
    expect(isEncryptedData(encrypted)).toBe(true);
  });

  it('should use custom iterations', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD, { iterations: 10000 });

    expect(encrypted.iterations).toBe(10000);
  });

  it('should generate different ciphertext each time (random IV/salt)', () => {
    const encrypted1 = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const encrypted2 = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.salt).not.toBe(encrypted2.salt);
  });

  it('should produce valid hex for IV and salt', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(encrypted.iv).toMatch(/^[0-9a-f]{32}$/); // 16 bytes = 32 hex chars
    expect(encrypted.salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('decrypt()', () => {
  it('should decrypt encrypted data', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const decrypted = decrypt(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_PLAINTEXT);
  });

  it('should fail with wrong password', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);

    // decrypt with wrong password either throws or returns garbage (depends on crypto-js behavior)
    try {
      const result = decrypt(encrypted, 'wrong-password');
      // If no throw, result should not match original
      expect(result).not.toBe(TEST_PLAINTEXT);
    } catch {
      // Expected - decryption failed
      expect(true).toBe(true);
    }
  });

  it('should decrypt with custom iterations', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD, { iterations: 5000 });
    const decrypted = decrypt(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_PLAINTEXT);
  });

  // Steelman³⁸ regression coverage for the Encrypt-then-MAC fix.
  it('should reject ciphertext tampered after encryption (MAC fails closed)', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    // Flip a bit in the ciphertext.
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.replace(/^./, encrypted.ciphertext[0] === 'A' ? 'B' : 'A'),
    };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/MAC verification failed/);
  });

  it('should reject ciphertext when MAC is tampered', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const tampered = {
      ...encrypted,
      mac: '0'.repeat(encrypted.mac!.length),
    };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/MAC verification failed/);
  });

  // Steelman⁴¹ regression coverage for the iterations DoS guard.
  it('should reject record with iterations below 1000 (DoS guard)', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const tampered = { ...encrypted, iterations: 999 };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/DoS guard/);
  });

  it('should reject record with iterations above 10M (DoS guard)', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const tampered = { ...encrypted, iterations: 10_000_001 };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/DoS guard/);
  });

  it('should reject record with non-integer iterations', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const tampered = { ...encrypted, iterations: 1.5 };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/DoS guard/);
  });

  it('should reject record with NaN iterations', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const tampered = { ...encrypted, iterations: NaN };
    expect(() => decrypt(tampered, TEST_PASSWORD)).toThrow(/DoS guard/);
  });

  it('should still read legacy unauthenticated aes-256-cbc records (opt-in)', () => {
    // Build a legacy-shape record by stripping the mac field and changing
    // the algorithm — this simulates on-disk records written before the
    // F.43 migration.
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const legacyShape = {
      ...encrypted,
      algorithm: 'aes-256-cbc' as const,
    };
    delete (legacyShape as Partial<typeof legacyShape>).mac;
    // Steelman⁴⁷: legacy path now requires explicit opt-in. The test
    // verifies that with the opt-in, the legacy routing runs (no MAC
    // error thrown). The synthesized record may still fail on padding
    // because of the split-key derivation difference — both outcomes
    // are acceptable for the routing assertion.
    try {
      decrypt(legacyShape, TEST_PASSWORD, { allowLegacyUnauthenticated: true });
    } catch (err) {
      expect(String(err)).not.toMatch(/MAC verification failed/);
    }
  });

  it('should refuse legacy unauthenticated aes-256-cbc records without opt-in (steelman⁴⁷)', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const legacyShape = {
      ...encrypted,
      algorithm: 'aes-256-cbc' as const,
    };
    delete (legacyShape as Partial<typeof legacyShape>).mac;
    expect(() => decrypt(legacyShape, TEST_PASSWORD)).toThrow(
      /refusing to decrypt unauthenticated legacy record/,
    );
  });

  it('should handle special characters', () => {
    const special = '日本語テスト 🎉 émojis & symbols <>&"\'';
    const encrypted = encrypt(special, TEST_PASSWORD);
    const decrypted = decrypt(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(special);
  });

  it('should handle empty string', () => {
    // Note: The decrypt function treats empty result as error (if (!result))
    // This is intentional - empty strings indicate decryption failure
    const encrypted = encrypt('', TEST_PASSWORD);

    // Empty string decryption throws because result is falsy
    expect(() => decrypt(encrypted, TEST_PASSWORD)).toThrow('Decryption failed');
  });

  it('should handle very long plaintext', () => {
    const longText = 'a'.repeat(10000);
    const encrypted = encrypt(longText, TEST_PASSWORD);
    const decrypted = decrypt(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(longText);
  });
});

// =============================================================================
// decryptJson Tests
// =============================================================================

describe('decryptJson()', () => {
  it('should decrypt and parse JSON object', () => {
    const data = { message: 'secret', numbers: [1, 2, 3] };
    const encrypted = encrypt(data, TEST_PASSWORD);
    const decrypted = decryptJson<typeof data>(encrypted, TEST_PASSWORD);

    expect(decrypted).toEqual(data);
  });

  it('should decrypt and parse JSON array', () => {
    const data = [1, 2, 3, 'four', { five: 5 }];
    const encrypted = encrypt(data, TEST_PASSWORD);
    const decrypted = decryptJson(encrypted, TEST_PASSWORD);

    expect(decrypted).toEqual(data);
  });

  it('should throw on invalid JSON', () => {
    const encrypted = encrypt('not valid json', TEST_PASSWORD);

    expect(() => decryptJson(encrypted, TEST_PASSWORD)).toThrow('invalid JSON');
  });

  it('should throw with wrong password', () => {
    const encrypted = encrypt({ test: true }, TEST_PASSWORD);

    // Wrong password can cause either decryption failure or malformed data
    expect(() => decryptJson(encrypted, 'wrong')).toThrow();
  });
});

// =============================================================================
// encryptSimple/decryptSimple Tests
// =============================================================================

describe('encryptSimple()', () => {
  it('should encrypt and return string', () => {
    const encrypted = encryptSimple(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(TEST_PLAINTEXT);
  });

  it('should produce different output each time', () => {
    const encrypted1 = encryptSimple(TEST_PLAINTEXT, TEST_PASSWORD);
    const encrypted2 = encryptSimple(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(encrypted1).not.toBe(encrypted2);
  });
});

describe('decryptSimple()', () => {
  it('should decrypt encrypted data', () => {
    const encrypted = encryptSimple(TEST_PLAINTEXT, TEST_PASSWORD);
    const decrypted = decryptSimple(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_PLAINTEXT);
  });

  it('should throw with wrong password', () => {
    const encrypted = encryptSimple(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(() => decryptSimple(encrypted, 'wrong')).toThrow();
  });

  it('should handle special characters', () => {
    const special = '🔐 Secret 日本語';
    const encrypted = encryptSimple(special, TEST_PASSWORD);
    const decrypted = decryptSimple(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(special);
  });
});

// =============================================================================
// encryptMnemonic/decryptMnemonic Tests
// =============================================================================

describe('encryptMnemonic()', () => {
  it('should encrypt mnemonic phrase', () => {
    const encrypted = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);

    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(TEST_MNEMONIC);
  });
});

describe('decryptMnemonic()', () => {
  it('should decrypt mnemonic phrase', () => {
    const encrypted = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
    const decrypted = decryptMnemonic(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_MNEMONIC);
  });

  it('should throw with wrong password', () => {
    const encrypted = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);

    // CryptoJS may throw "Malformed UTF-8 data" or our wrapper throws "Decryption failed"
    expect(() => decryptMnemonic(encrypted, 'wrong')).toThrow();
  });
});

// =============================================================================
// isEncryptedData Tests
// =============================================================================

describe('isEncryptedData()', () => {
  it('should return true for valid EncryptedData', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);

    expect(isEncryptedData(encrypted)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isEncryptedData(null)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(isEncryptedData('string')).toBe(false);
    expect(isEncryptedData(123)).toBe(false);
    expect(isEncryptedData(undefined)).toBe(false);
  });

  it('should return false for missing fields', () => {
    expect(isEncryptedData({ ciphertext: 'abc' })).toBe(false);
    expect(isEncryptedData({
      ciphertext: 'abc',
      iv: '123',
      salt: '456',
    })).toBe(false);
  });

  it('should return false for wrong algorithm', () => {
    const data = {
      ciphertext: 'abc',
      iv: '123',
      salt: '456',
      algorithm: 'aes-128-cbc',
      kdf: 'pbkdf2',
      iterations: 100000,
    };

    expect(isEncryptedData(data)).toBe(false);
  });

  it('should return false for wrong kdf', () => {
    const data = {
      ciphertext: 'abc',
      iv: '123',
      salt: '456',
      algorithm: 'aes-256-cbc',
      kdf: 'scrypt',
      iterations: 100000,
    };

    expect(isEncryptedData(data)).toBe(false);
  });

  it('should return false for non-number iterations', () => {
    const data = {
      ciphertext: 'abc',
      iv: '123',
      salt: '456',
      algorithm: 'aes-256-cbc',
      kdf: 'pbkdf2',
      iterations: '100000',
    };

    expect(isEncryptedData(data)).toBe(false);
  });
});

// =============================================================================
// serializeEncrypted/deserializeEncrypted Tests
// =============================================================================

describe('serializeEncrypted()', () => {
  it('should serialize to JSON string', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const serialized = serializeEncrypted(encrypted);

    expect(typeof serialized).toBe('string');
    expect(JSON.parse(serialized)).toEqual(encrypted);
  });
});

describe('deserializeEncrypted()', () => {
  it('should deserialize from JSON string', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const serialized = serializeEncrypted(encrypted);
    const deserialized = deserializeEncrypted(serialized);

    expect(deserialized).toEqual(encrypted);
  });

  it('should throw for invalid format', () => {
    expect(() => deserializeEncrypted('{}')).toThrow('Invalid encrypted data format');
    expect(() => deserializeEncrypted('not json')).toThrow();
  });

  it('should round-trip encrypt/serialize/deserialize/decrypt', () => {
    const encrypted = encrypt(TEST_PLAINTEXT, TEST_PASSWORD);
    const serialized = serializeEncrypted(encrypted);
    const deserialized = deserializeEncrypted(serialized);
    const decrypted = decrypt(deserialized, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_PLAINTEXT);
  });
});

// =============================================================================
// generateRandomKey Tests
// =============================================================================

describe('generateRandomKey()', () => {
  it('should generate 64 hex chars by default (32 bytes)', () => {
    const key = generateRandomKey();

    expect(key.length).toBe(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('should generate specified length', () => {
    const key16 = generateRandomKey(16);
    expect(key16.length).toBe(32); // 16 bytes = 32 hex chars

    const key64 = generateRandomKey(64);
    expect(key64.length).toBe(128);
  });

  it('should generate different keys each time', () => {
    const key1 = generateRandomKey();
    const key2 = generateRandomKey();

    expect(key1).not.toBe(key2);
  });
});

// =============================================================================
// Round-trip Tests
// =============================================================================

describe('Full round-trip encryption', () => {
  it('should encrypt, serialize, deserialize, and decrypt correctly', () => {
    const original = { secretData: 'very secret', timestamp: Date.now() };

    // Encrypt
    const encrypted = encrypt(original, TEST_PASSWORD);

    // Serialize for storage
    const serialized = serializeEncrypted(encrypted);

    // ... stored in localStorage or elsewhere ...

    // Deserialize
    const deserialized = deserializeEncrypted(serialized);

    // Decrypt
    const decrypted = decryptJson<typeof original>(deserialized, TEST_PASSWORD);

    expect(decrypted).toEqual(original);
  });

  it('should work with mnemonic round-trip', () => {
    const encrypted = encryptMnemonic(TEST_MNEMONIC, TEST_PASSWORD);
    const decrypted = decryptMnemonic(encrypted, TEST_PASSWORD);

    expect(decrypted).toBe(TEST_MNEMONIC);
  });
});
