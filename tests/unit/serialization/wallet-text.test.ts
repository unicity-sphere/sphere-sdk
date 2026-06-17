/**
 * Tests for serialization/wallet-text.ts
 * Covers text-based wallet backup format parsing and serialization
 */

import { describe, it, expect } from 'vitest';
import {
  isWalletTextFormat,
  isTextWalletEncrypted,
  parseWalletText,
  parseAndDecryptWalletText,
  serializeWalletToText,
  serializeEncryptedWalletToText,
  encryptForTextFormat,
  decryptTextFormatKey,
  type WalletTextExportParams,
} from '../../../serialization/wallet-text';

// =============================================================================
// Test Fixtures
// =============================================================================

const SAMPLE_MASTER_KEY = 'a'.repeat(64);
const SAMPLE_CHAIN_CODE = 'b'.repeat(64);
const PASSWORD = 'test-password-123';

const SAMPLE_ADDRESSES = [
  { index: 0, address: '02abc123', path: "m/84'/1'/0'/0/0" },
  { index: 1, address: '02def456', path: "m/84'/1'/0'/0/1" },
];

// Sample unencrypted wallet text
const UNENCRYPTED_WALLET_TEXT = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${SAMPLE_MASTER_KEY}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${SAMPLE_CHAIN_CODE}

DESCRIPTOR PATH: 84'/1'/0'

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.

YOUR ADDRESSES:
Address 1: 02abc123 (Path: m/84'/1'/0'/0/0)
Address 2: 02def456 (Path: m/84'/1'/0'/0/1)

Generated on: 1/27/2026, 12:00:00 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

// Sample encrypted wallet text (we'll generate the encrypted key)
const createEncryptedWalletText = (encryptedKey: string) => `UNICITY WALLET DETAILS
===========================

ENCRYPTED MASTER KEY (password protected):
${encryptedKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${SAMPLE_CHAIN_CODE}

DESCRIPTOR PATH: 84'/1'/0'

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Encrypted with password
To use this key, you will need the password you set in the wallet.

YOUR ADDRESSES:
Address 1: 02abc123 (Path: m/84'/1'/0'/0/0)

Generated on: 1/27/2026, 12:00:00 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

// Sample HMAC wallet (no chain code)
const HMAC_WALLET_TEXT = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${SAMPLE_MASTER_KEY}

WALLET TYPE: Standard wallet (HMAC-based)

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.

YOUR ADDRESSES:
Address 1: 02abc123 (Path: m/44'/0'/0')

Generated on: 1/27/2026, 12:00:00 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

// =============================================================================
// Format Detection Tests
// =============================================================================

describe('isWalletTextFormat()', () => {
  it('should detect valid wallet text format', () => {
    expect(isWalletTextFormat(UNENCRYPTED_WALLET_TEXT)).toBe(true);
  });

  it('should detect encrypted wallet text format', () => {
    const encrypted = createEncryptedWalletText('U2FsdGVkX1+test');
    expect(isWalletTextFormat(encrypted)).toBe(true);
  });

  it('should reject non-wallet content', () => {
    expect(isWalletTextFormat('Hello World')).toBe(false);
    expect(isWalletTextFormat('{"json": "data"}')).toBe(false);
    expect(isWalletTextFormat('')).toBe(false);
  });

  it('should require both header and key section', () => {
    // Header only
    expect(isWalletTextFormat('UNICITY WALLET DETAILS')).toBe(false);

    // Key only
    expect(isWalletTextFormat('MASTER PRIVATE KEY (keep secret!):\ntest')).toBe(false);
  });
});

describe('isTextWalletEncrypted()', () => {
  it('should detect encrypted wallet', () => {
    const encrypted = createEncryptedWalletText('U2FsdGVkX1+test');
    expect(isTextWalletEncrypted(encrypted)).toBe(true);
  });

  it('should detect unencrypted wallet', () => {
    expect(isTextWalletEncrypted(UNENCRYPTED_WALLET_TEXT)).toBe(false);
  });
});

// =============================================================================
// Encryption/Decryption Tests
// =============================================================================

describe('encryptForTextFormat() and decryptTextFormatKey()', () => {
  it('should encrypt and decrypt master key', () => {
    const encrypted = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    const decrypted = decryptTextFormatKey(encrypted, PASSWORD);

    expect(decrypted).toBe(SAMPLE_MASTER_KEY);
  });

  it('should return null for wrong password', () => {
    const encrypted = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    const decrypted = decryptTextFormatKey(encrypted, 'wrong-password');

    expect(decrypted).not.toBe(SAMPLE_MASTER_KEY);
  });

  it('should produce base64 output', () => {
    const encrypted = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);
  });

  it('should handle unicode passwords', () => {
    const unicodePassword = 'пароль-123-🔐';
    const encrypted = encryptForTextFormat(SAMPLE_MASTER_KEY, unicodePassword);
    const decrypted = decryptTextFormatKey(encrypted, unicodePassword);

    expect(decrypted).toBe(SAMPLE_MASTER_KEY);
  });
});

// =============================================================================
// Parse Unencrypted Wallet Tests
// =============================================================================

describe('parseWalletText()', () => {
  it('should parse unencrypted BIP32 wallet', () => {
    const result = parseWalletText(UNENCRYPTED_WALLET_TEXT);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(result.data!.chainCode).toBe(SAMPLE_CHAIN_CODE);
    expect(result.data!.derivationMode).toBe('bip32');
  });

  it('should parse HMAC wallet (no chain code)', () => {
    const result = parseWalletText(HMAC_WALLET_TEXT);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(result.data!.chainCode).toBeUndefined();
    expect(result.data!.derivationMode).toBe('wif_hmac');
  });

  it('should extract descriptor path', () => {
    const result = parseWalletText(UNENCRYPTED_WALLET_TEXT);

    expect(result.success).toBe(true);
    expect(result.data!.descriptorPath).toBe("84'/1'/0'");
  });

  it('should return needsPassword for encrypted wallet', () => {
    const encrypted = createEncryptedWalletText('U2FsdGVkX1+test');
    const result = parseWalletText(encrypted);

    expect(result.success).toBe(false);
    expect(result.needsPassword).toBe(true);
  });

  it('should fail for invalid content', () => {
    const result = parseWalletText('invalid content');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should fail if master key is missing', () => {
    const noKeyContent = `UNICITY WALLET DETAILS
===========================

WALLET TYPE: BIP32 hierarchical deterministic wallet
`;
    const result = parseWalletText(noKeyContent);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not find');
  });
});

// =============================================================================
// Parse Encrypted Wallet Tests
// =============================================================================

describe('parseAndDecryptWalletText()', () => {
  it('should parse and decrypt encrypted wallet', () => {
    const encryptedKey = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    const walletText = createEncryptedWalletText(encryptedKey);

    const result = parseAndDecryptWalletText(walletText, PASSWORD);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(result.data!.chainCode).toBe(SAMPLE_CHAIN_CODE);
  });

  it('should fail with wrong password', () => {
    const encryptedKey = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    const walletText = createEncryptedWalletText(encryptedKey);

    const result = parseAndDecryptWalletText(walletText, 'wrong-password');

    expect(result.success).toBe(false);
    expect(result.error).toContain('incorrect password');
  });

  it('should parse unencrypted wallet without password', () => {
    const result = parseAndDecryptWalletText(UNENCRYPTED_WALLET_TEXT, PASSWORD);

    expect(result.success).toBe(true);
    expect(result.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
  });

  it('should extract chain code from encrypted wallet', () => {
    const encryptedKey = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);
    const walletText = createEncryptedWalletText(encryptedKey);

    const result = parseAndDecryptWalletText(walletText, PASSWORD);

    expect(result.success).toBe(true);
    expect(result.data!.chainCode).toBe(SAMPLE_CHAIN_CODE);
    expect(result.data!.derivationMode).toBe('bip32');
  });
});

// =============================================================================
// Serialization Tests
// =============================================================================

describe('serializeWalletToText()', () => {
  const params: WalletTextExportParams = {
    masterPrivateKey: SAMPLE_MASTER_KEY,
    masterPrivateKeyWIF: '5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF',
    chainCode: SAMPLE_CHAIN_CODE,
    descriptorPath: "84'/1'/0'",
    isBIP32: true,
    addresses: SAMPLE_ADDRESSES,
  };

  it('should serialize BIP32 wallet', () => {
    const text = serializeWalletToText(params);

    expect(text).toContain('UNICITY WALLET DETAILS');
    expect(text).toContain(SAMPLE_MASTER_KEY);
    expect(text).toContain(SAMPLE_CHAIN_CODE);
    expect(text).toContain('BIP32 hierarchical deterministic wallet');
    expect(text).toContain('Not encrypted');
  });

  it('should include WIF key', () => {
    const text = serializeWalletToText(params);

    expect(text).toContain('WIF FORMAT');
    expect(text).toContain('5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF');
  });

  it('should include addresses', () => {
    const text = serializeWalletToText(params);

    expect(text).toContain('02abc123');
    expect(text).toContain('02def456');
    expect(text).toContain("m/84'/1'/0'/0/0");
  });

  it('should serialize HMAC wallet (no chain code)', () => {
    const hmacParams: WalletTextExportParams = {
      masterPrivateKey: SAMPLE_MASTER_KEY,
      isBIP32: false,
      addresses: [{ index: 0, address: '02test' }],
    };

    const text = serializeWalletToText(hmacParams);

    expect(text).toContain('Standard wallet (HMAC-based)');
    expect(text).not.toContain('CHAIN CODE');
  });

  it('should include timestamp', () => {
    const text = serializeWalletToText(params);

    expect(text).toContain('Generated on:');
  });

  it('should include warning', () => {
    const text = serializeWalletToText(params);

    expect(text).toContain('WARNING');
    expect(text).toContain('master private key');
  });
});

describe('serializeEncryptedWalletToText()', () => {
  it('should serialize encrypted wallet', () => {
    const encryptedKey = 'U2FsdGVkX1+encrypted_content_here';

    const text = serializeEncryptedWalletToText({
      encryptedMasterKey: encryptedKey,
      chainCode: SAMPLE_CHAIN_CODE,
      descriptorPath: "84'/1'/0'",
      isBIP32: true,
      addresses: SAMPLE_ADDRESSES,
    });

    expect(text).toContain('UNICITY WALLET DETAILS');
    expect(text).toContain('ENCRYPTED MASTER KEY');
    expect(text).toContain(encryptedKey);
    expect(text).toContain('Encrypted with password');
  });

  it('should include chain code', () => {
    const text = serializeEncryptedWalletToText({
      encryptedMasterKey: 'encrypted',
      chainCode: SAMPLE_CHAIN_CODE,
      isBIP32: true,
      addresses: [],
    });

    expect(text).toContain(SAMPLE_CHAIN_CODE);
  });

  it('should not include unencrypted master key', () => {
    const text = serializeEncryptedWalletToText({
      encryptedMasterKey: 'encrypted',
      isBIP32: false,
      addresses: [],
    });

    expect(text).not.toContain('MASTER PRIVATE KEY (keep secret!)');
  });
});

// =============================================================================
// Round-Trip Tests
// =============================================================================

describe('Round-trip serialization', () => {
  it('should round-trip unencrypted BIP32 wallet', () => {
    const params: WalletTextExportParams = {
      masterPrivateKey: SAMPLE_MASTER_KEY,
      chainCode: SAMPLE_CHAIN_CODE,
      descriptorPath: "84'/1'/0'",
      isBIP32: true,
      addresses: SAMPLE_ADDRESSES,
    };

    const serialized = serializeWalletToText(params);
    const parsed = parseWalletText(serialized);

    expect(parsed.success).toBe(true);
    expect(parsed.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(parsed.data!.chainCode).toBe(SAMPLE_CHAIN_CODE);
    expect(parsed.data!.derivationMode).toBe('bip32');
  });

  it('should round-trip encrypted wallet', () => {
    const encryptedKey = encryptForTextFormat(SAMPLE_MASTER_KEY, PASSWORD);

    const serialized = serializeEncryptedWalletToText({
      encryptedMasterKey: encryptedKey,
      chainCode: SAMPLE_CHAIN_CODE,
      isBIP32: true,
      addresses: SAMPLE_ADDRESSES,
    });

    const parsed = parseAndDecryptWalletText(serialized, PASSWORD);

    expect(parsed.success).toBe(true);
    expect(parsed.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(parsed.data!.chainCode).toBe(SAMPLE_CHAIN_CODE);
  });

  it('should round-trip HMAC wallet', () => {
    const params: WalletTextExportParams = {
      masterPrivateKey: SAMPLE_MASTER_KEY,
      isBIP32: false,
      addresses: [{ index: 0, address: '02test' }],
    };

    const serialized = serializeWalletToText(params);
    const parsed = parseWalletText(serialized);

    expect(parsed.success).toBe(true);
    expect(parsed.data!.masterKey).toBe(SAMPLE_MASTER_KEY);
    expect(parsed.data!.chainCode).toBeUndefined();
    expect(parsed.data!.derivationMode).toBe('wif_hmac');
  });
});
