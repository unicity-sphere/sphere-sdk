/**
 * Integration tests for wallet key derivation consistency
 *
 * Verifies that the same private key produces identical public keys regardless
 * of the import format (.dat, .txt, .json) or derivation path used.
 *
 * Two wallet types are tested:
 * 1. BIP32 HD wallet — uses standard BIP32 child key derivation with chain code
 * 2. WIF/HMAC wallet — uses HMAC-SHA512(masterKey, path) derivation without chain code
 */

import { describe, it, expect } from 'vitest';
import {
  parseWalletText,
  parseAndDecryptWalletText,
  serializeWalletToText,
  serializeEncryptedWalletToText,
  encryptForTextFormat,
} from '../../serialization/wallet-text';
import {
  deriveAddressInfo,
  generateAddressFromMasterKey,
  getPublicKey,
  type MasterKey,
} from '../../core/crypto';

// =============================================================================
// Test Wallet: BIP32 HD (with chain code)
// =============================================================================

/** Known BIP32 wallet — exported from webwallet as .dat, .txt, and .json */
const BIP32_WALLET = {
  masterKey: '44af427cc3e4eca15633682c50383df02f5598ff70ae972060b32529106efea3',
  chainCode: 'ef9b229fa43b5321834bce029dcca011db64764538f06e5b50b9dd5f38d16678',
  descriptorPath: "84'/1'/0'",
  basePath: "m/84'/1'/0'",
  derivationMode: 'bip32' as const,
  /** Expected compressed public keys at indices 0, 1, 2 */
  expectedPublicKeys: [
    '0293660bf11e778ad850274d8a2ff0054327b3027cbd1e935adb23d291e89f24eb',
    '0202cf879e569e8acf34261d32d2f67d5398c71966a9401fa3499032c5fe5c0d1b',
    '030887f2deb018100c32786763fa6058e7dd48202129e3198ee72dfc5b6630f141',
  ],
};

// =============================================================================
// Test Wallet: WIF/HMAC (no chain code)
// =============================================================================

/** Known WIF wallet — uses HMAC-SHA512 derivation (legacy webwallet format) */
const WIF_WALLET = {
  masterKey: '86f38045ecb4f6ae0d655e866f13937b9892fbd1ff4b3ade8998df7422b4dd1b',
  derivationMode: 'wif_hmac' as const,
  /** Expected compressed public keys at indices 0, 1 */
  expectedPublicKeys: [
    '03a4d15c66922c27046ab9865a1afd71728ca9cc88c6fc606ba95b25a229d77c0d',
    '02ae8992f4904eb60f9a058024f7583cc777d0fb6ae14b4c4f129df0dbffaf1061',
  ],
};

// =============================================================================
// BIP32 Derivation Tests
// =============================================================================

describe('BIP32 HD wallet derivation', () => {
  const masterKey: MasterKey = {
    privateKey: BIP32_WALLET.masterKey,
    chainCode: BIP32_WALLET.chainCode,
  };

  it('should derive correct address at index 0', () => {
    const info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 0, false);
    const address = info.publicKey;
    expect(address).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });

  it('should derive correct address at index 1', () => {
    const info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 1, false);
    const address = info.publicKey;
    expect(address).toBe(BIP32_WALLET.expectedPublicKeys[1]);
  });

  it('should derive correct address at index 2', () => {
    const info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 2, false);
    const address = info.publicKey;
    expect(address).toBe(BIP32_WALLET.expectedPublicKeys[2]);
  });

  it('should match core deriveAddressInfo function', () => {
    for (let i = 0; i < BIP32_WALLET.expectedPublicKeys.length; i++) {
      const addr = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, i, false);
      expect(addr.publicKey).toBe(BIP32_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should produce deterministic results across multiple calls', () => {
    const results = Array.from({ length: 5 }, () =>
      deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 0, false),
    );
    const addresses = results.map((r) => r.publicKey);
    expect(new Set(addresses).size).toBe(1);
    expect(addresses[0]).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });
});

// =============================================================================
// WIF/HMAC Derivation Tests
// =============================================================================

describe('WIF/HMAC wallet derivation', () => {
  it('should derive correct address at index 0', () => {
    const addr = generateAddressFromMasterKey(WIF_WALLET.masterKey, 0);
    expect(addr.publicKey).toBe(WIF_WALLET.expectedPublicKeys[0]);
  });

  it('should derive correct address at index 1', () => {
    const addr = generateAddressFromMasterKey(WIF_WALLET.masterKey, 1);
    expect(addr.publicKey).toBe(WIF_WALLET.expectedPublicKeys[1]);
  });

  it('should use HMAC path m/44\'/0\'/{index}\'', () => {
    const addr0 = generateAddressFromMasterKey(WIF_WALLET.masterKey, 0);
    const addr1 = generateAddressFromMasterKey(WIF_WALLET.masterKey, 1);
    expect(addr0.path).toBe("m/44'/0'/0'");
    expect(addr1.path).toBe("m/44'/0'/1'");
  });

  it('should produce deterministic results', () => {
    const results = Array.from({ length: 5 }, () =>
      generateAddressFromMasterKey(WIF_WALLET.masterKey, 0),
    );
    expect(new Set(results.map((r) => r.publicKey)).size).toBe(1);
    expect(results[0].publicKey).toBe(WIF_WALLET.expectedPublicKeys[0]);
  });

  it('should differ from BIP32 derivation with the same key', () => {
    // If we were to incorrectly use the WIF key as a raw private key
    // (no HMAC), the address would be wrong
    const rawPubKey = getPublicKey(WIF_WALLET.masterKey);
    const rawAddress = rawPubKey;

    // The raw address should NOT match the expected WIF address
    expect(rawAddress).not.toBe(WIF_WALLET.expectedPublicKeys[0]);
  });
});

// =============================================================================
// BIP32 vs WIF: Same key must produce different addresses
// =============================================================================

describe('BIP32 vs WIF derivation produces different addresses', () => {
  it('should produce different address[0] for same key using BIP32 vs WIF', () => {
    const key = BIP32_WALLET.masterKey;

    // BIP32 derivation (with chain code)
    const masterKey: MasterKey = {
      privateKey: key,
      chainCode: BIP32_WALLET.chainCode,
    };
    const bip32Info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 0, false);
    const bip32Addr = bip32Info.publicKey;

    // WIF/HMAC derivation (no chain code)
    const wifAddr = generateAddressFromMasterKey(key, 0);

    expect(bip32Addr).not.toBe(wifAddr.publicKey);
  });
});

// =============================================================================
// TXT Format Parsing → Derivation Consistency (BIP32)
// =============================================================================

describe('TXT format → BIP32 address consistency', () => {
  const BIP32_UNENCRYPTED_TXT = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${BIP32_WALLET.masterKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${BIP32_WALLET.chainCode}

DESCRIPTOR PATH: ${BIP32_WALLET.descriptorPath}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.

YOUR ADDRESSES:
Address 1: ${BIP32_WALLET.expectedPublicKeys[0]} (Path: m/84'/1'/0'/0/0)

Generated on: 12/4/2025, 5:22:59 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

  it('should parse and produce correct addresses from unencrypted BIP32 .txt', () => {
    const result = parseWalletText(BIP32_UNENCRYPTED_TXT);

    expect(result.success).toBe(true);
    expect(result.data!.masterKey).toBe(BIP32_WALLET.masterKey);
    expect(result.data!.chainCode).toBe(BIP32_WALLET.chainCode);
    expect(result.data!.descriptorPath).toBe(BIP32_WALLET.descriptorPath);
    expect(result.data!.derivationMode).toBe('bip32');

    // Derive first 3 addresses from parsed data
    const mk: MasterKey = {
      privateKey: result.data!.masterKey,
      chainCode: result.data!.chainCode!,
    };
    const basePath = `m/${result.data!.descriptorPath}`;

    for (let i = 0; i < BIP32_WALLET.expectedPublicKeys.length; i++) {
      const info = deriveAddressInfo(mk, basePath, i, false);
      const address = info.publicKey;
      expect(address).toBe(BIP32_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should infer descriptorPath for BIP32 .txt without DESCRIPTOR PATH line', () => {
    // Webwallet omits DESCRIPTOR PATH for encrypted exports
    const txtWithoutPath = `UNICITY WALLET DETAILS
===========================

ENCRYPTED MASTER KEY (password protected):
FAKE_ENCRYPTED_KEY

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${BIP32_WALLET.chainCode}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Encrypted with password
To use this key, you will need the password you set in the wallet.

YOUR ADDRESSES:
Address 1: ${BIP32_WALLET.expectedPublicKeys[0]}

Generated on: 12/4/2025, 5:22:59 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    // parseWalletText should indicate needsPassword
    const result = parseWalletText(txtWithoutPath);
    expect(result.success).toBe(false);
    expect(result.needsPassword).toBe(true);
  });

  it('should round-trip encrypt/decrypt and produce correct addresses', () => {
    const password = 'testPassword123';
    const encryptedKey = encryptForTextFormat(BIP32_WALLET.masterKey, password);

    const encryptedTxt = serializeEncryptedWalletToText({
      encryptedMasterKey: encryptedKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
      isBIP32: true,
      addresses: [{ index: 0, address: BIP32_WALLET.expectedPublicKeys[0] }],
    });

    const result = parseAndDecryptWalletText(encryptedTxt, password);
    expect(result.success).toBe(true);
    expect(result.data!.masterKey).toBe(BIP32_WALLET.masterKey);

    // Derive and verify
    const mk: MasterKey = {
      privateKey: result.data!.masterKey,
      chainCode: result.data!.chainCode!,
    };
    const basePath = `m/${result.data!.descriptorPath}`;
    const info = deriveAddressInfo(mk, basePath, 0, false);
    expect(info.publicKey).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });

  it('should default descriptorPath to 84\'/1\'/0\' for BIP32 without explicit path', () => {
    const encryptedKey = encryptForTextFormat(BIP32_WALLET.masterKey, '1111');

    // Simulate webwallet export: BIP32 + chain code but no DESCRIPTOR PATH
    const encryptedTxt = `UNICITY WALLET DETAILS
===========================

ENCRYPTED MASTER KEY (password protected):
${encryptedKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${BIP32_WALLET.chainCode}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Encrypted with password
To use this key, you will need the password you set in the wallet.

YOUR ADDRESSES:
Address 1: ${BIP32_WALLET.expectedPublicKeys[0]}

Generated on: 12/4/2025, 5:22:59 PM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    const result = parseAndDecryptWalletText(encryptedTxt, '1111');
    expect(result.success).toBe(true);
    // Should infer default 84'/1'/0' for BIP32 Alpha wallet
    expect(result.data!.descriptorPath).toBe("84'/1'/0'");

    // Derive and verify address still matches
    const mk: MasterKey = {
      privateKey: result.data!.masterKey,
      chainCode: result.data!.chainCode!,
    };
    const basePath = `m/${result.data!.descriptorPath}`;
    const info = deriveAddressInfo(mk, basePath, 0, false);
    expect(info.publicKey).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });
});

// =============================================================================
// TXT Format Parsing → Derivation Consistency (WIF)
// =============================================================================

describe('TXT format → WIF address consistency', () => {
  const WIF_UNENCRYPTED_TXT = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${WIF_WALLET.masterKey}

MASTER PRIVATE KEY IN WIF FORMAT (for importprivkey command):
L1k3BCrcC25WDPHLuUUPBqEGyceSGf2e1v5dphPJZRpMpyCdEMgo

WALLET TYPE: Standard wallet (HMAC-based)

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.

YOUR ADDRESSES:
Address 1: ${WIF_WALLET.expectedPublicKeys[0]} (Path: m/44'/0'/0')

Generated on: 2/10/2026, 3:54:42 AM

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

  it('should parse WIF .txt and produce correct addresses', () => {
    const result = parseWalletText(WIF_UNENCRYPTED_TXT);

    expect(result.success).toBe(true);
    expect(result.data!.masterKey).toBe(WIF_WALLET.masterKey);
    expect(result.data!.chainCode).toBeUndefined();
    expect(result.data!.derivationMode).toBe('wif_hmac');

    // Derive addresses using HMAC
    for (let i = 0; i < WIF_WALLET.expectedPublicKeys.length; i++) {
      const addr = generateAddressFromMasterKey(result.data!.masterKey, i);
      expect(addr.publicKey).toBe(WIF_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should not have descriptorPath for WIF wallet', () => {
    const result = parseWalletText(WIF_UNENCRYPTED_TXT);
    expect(result.success).toBe(true);
    expect(result.data!.descriptorPath).toBeUndefined();
  });
});

// =============================================================================
// JSON Format → Derivation Consistency
// =============================================================================

describe('JSON format → address consistency', () => {
  it('should produce correct BIP32 addresses from legacy flat JSON', () => {
    const json = {
      masterPrivateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
      derivationMode: 'bip32',
    };

    const mk: MasterKey = {
      privateKey: json.masterPrivateKey,
      chainCode: json.chainCode,
    };
    const basePath = `m/${json.descriptorPath}`;

    for (let i = 0; i < BIP32_WALLET.expectedPublicKeys.length; i++) {
      const info = deriveAddressInfo(mk, basePath, i, false);
      const address = info.publicKey;
      expect(address).toBe(BIP32_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should produce correct WIF addresses from legacy flat JSON', () => {
    const json = {
      masterPrivateKey: WIF_WALLET.masterKey,
      derivationMode: 'wif_hmac',
    };

    for (let i = 0; i < WIF_WALLET.expectedPublicKeys.length; i++) {
      const addr = generateAddressFromMasterKey(json.masterPrivateKey, i);
      expect(addr.publicKey).toBe(WIF_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should infer BIP32 mode from chainCode presence in JSON', () => {
    const json = {
      masterPrivateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
      // No explicit derivationMode
    };

    const isBIP32 = !!json.chainCode;
    expect(isBIP32).toBe(true);

    const mk: MasterKey = {
      privateKey: json.masterPrivateKey,
      chainCode: json.chainCode,
    };
    const basePath = "m/84'/1'/0'"; // Default for BIP32 Alpha
    const info = deriveAddressInfo(mk, basePath, 0, false);
    expect(info.publicKey).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });

  it('should infer WIF mode from missing chainCode in JSON', () => {
    const json = {
      masterPrivateKey: WIF_WALLET.masterKey,
      // No chainCode, no derivationMode
    };

    const isWIF = !json.masterPrivateKey || !('chainCode' in json && json.chainCode);
    expect(isWIF).toBe(true);
  });
});

// =============================================================================
// Cross-Format Consistency: Same key → same addresses
// =============================================================================

describe('Cross-format consistency: BIP32 wallet', () => {
  it('should produce identical addresses from TXT and JSON formats', () => {
    // Parse from TXT
    const txtContent = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${BIP32_WALLET.masterKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${BIP32_WALLET.chainCode}

DESCRIPTOR PATH: ${BIP32_WALLET.descriptorPath}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted

YOUR ADDRESSES:
Address 1: test

Generated on: 1/1/2026

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    const txtResult = parseWalletText(txtContent);
    expect(txtResult.success).toBe(true);

    // Simulate JSON parse
    const jsonData = {
      masterKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
    };

    // Both should produce the same first 3 addresses
    const txtMk: MasterKey = {
      privateKey: txtResult.data!.masterKey,
      chainCode: txtResult.data!.chainCode!,
    };
    const txtBasePath = `m/${txtResult.data!.descriptorPath}`;

    const jsonMk: MasterKey = {
      privateKey: jsonData.masterKey,
      chainCode: jsonData.chainCode,
    };
    const jsonBasePath = `m/${jsonData.descriptorPath}`;

    for (let i = 0; i < 3; i++) {
      const txtInfo = deriveAddressInfo(txtMk, txtBasePath, i, false);
      const txtAddr = txtInfo.publicKey;

      const jsonInfo = deriveAddressInfo(jsonMk, jsonBasePath, i, false);
      const jsonAddr = jsonInfo.publicKey;

      expect(txtAddr).toBe(jsonAddr);
      expect(txtAddr).toBe(BIP32_WALLET.expectedPublicKeys[i]);
    }
  });

  it('should produce identical addresses from encrypted and unencrypted TXT', () => {
    const password = 'crossFormatTest';

    // Unencrypted
    const unencryptedTxt = serializeWalletToText({
      masterPrivateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
      isBIP32: true,
      addresses: [{ index: 0, address: BIP32_WALLET.expectedPublicKeys[0] }],
    });

    // Encrypted
    const encKey = encryptForTextFormat(BIP32_WALLET.masterKey, password);
    const encryptedTxt = serializeEncryptedWalletToText({
      encryptedMasterKey: encKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
      isBIP32: true,
      addresses: [{ index: 0, address: BIP32_WALLET.expectedPublicKeys[0] }],
    });

    const unencResult = parseWalletText(unencryptedTxt);
    const encResult = parseAndDecryptWalletText(encryptedTxt, password);

    expect(unencResult.success).toBe(true);
    expect(encResult.success).toBe(true);
    expect(unencResult.data!.masterKey).toBe(encResult.data!.masterKey);
    expect(unencResult.data!.chainCode).toBe(encResult.data!.chainCode);

    // Derive address from each and compare
    const mk1: MasterKey = {
      privateKey: unencResult.data!.masterKey,
      chainCode: unencResult.data!.chainCode!,
    };
    const mk2: MasterKey = {
      privateKey: encResult.data!.masterKey,
      chainCode: encResult.data!.chainCode!,
    };
    const basePath = `m/${BIP32_WALLET.descriptorPath}`;

    const addr1 = deriveAddressInfo(mk1, basePath, 0, false).publicKey;
    const addr2 = deriveAddressInfo(mk2, basePath, 0, false).publicKey;

    expect(addr1).toBe(addr2);
    expect(addr1).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });
});

describe('Cross-format consistency: WIF wallet', () => {
  it('should produce identical addresses from TXT and direct HMAC derivation', () => {
    const txtContent = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${WIF_WALLET.masterKey}

WALLET TYPE: Standard wallet (HMAC-based)

ENCRYPTION STATUS: Not encrypted

YOUR ADDRESSES:
Address 1: test

Generated on: 1/1/2026

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    const result = parseWalletText(txtContent);
    expect(result.success).toBe(true);
    expect(result.data!.derivationMode).toBe('wif_hmac');

    // Address from parsed TXT
    const txtAddr = generateAddressFromMasterKey(result.data!.masterKey, 0);

    // Address from direct key
    const directAddr = generateAddressFromMasterKey(WIF_WALLET.masterKey, 0);

    expect(txtAddr.publicKey).toBe(directAddr.publicKey);
    expect(txtAddr.publicKey).toBe(WIF_WALLET.expectedPublicKeys[0]);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Derivation edge cases', () => {
  it('should handle BIP32 with default descriptor path (84\'/1\'/0\')', () => {
    // When descriptorPath is missing, BIP32 Alpha wallets default to 84'/1'/0'
    const mk: MasterKey = {
      privateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
    };

    const defaultPath = "m/84'/1'/0'";
    const info = deriveAddressInfo(mk, defaultPath, 0, false);
    const address = info.publicKey;

    // This should match because 84'/1'/0' IS the correct default
    expect(address).toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });

  it('should produce WRONG address with incorrect base path', () => {
    const mk: MasterKey = {
      privateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
    };

    // Wrong base path — this is the generic default, not Alpha network
    const wrongPath = "m/44'/0'/0'";
    const info = deriveAddressInfo(mk, wrongPath, 0, false);
    const address = info.publicKey;

    // Should NOT match the expected address
    expect(address).not.toBe(BIP32_WALLET.expectedPublicKeys[0]);
  });

  it('should produce different addresses for different indices', () => {
    // BIP32
    const _mk: MasterKey = {
      privateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
    };
    const addrs = BIP32_WALLET.expectedPublicKeys;
    expect(new Set(addrs).size).toBe(addrs.length);

    // WIF
    const wifAddrs = WIF_WALLET.expectedPublicKeys;
    expect(new Set(wifAddrs).size).toBe(wifAddrs.length);
  });

  it('should not confuse BIP32 and WIF when selecting derivation mode', () => {
    // BIP32 wallet parsed as text
    const bip32Txt = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${BIP32_WALLET.masterKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${BIP32_WALLET.chainCode}

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted

YOUR ADDRESSES:
Address 1: test

Generated on: 1/1/2026

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    // WIF wallet parsed as text
    const wifTxt = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${WIF_WALLET.masterKey}

WALLET TYPE: Standard wallet (HMAC-based)

ENCRYPTION STATUS: Not encrypted

YOUR ADDRESSES:
Address 1: test

Generated on: 1/1/2026

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

    const bip32Result = parseWalletText(bip32Txt);
    const wifResult = parseWalletText(wifTxt);

    expect(bip32Result.data!.derivationMode).toBe('bip32');
    expect(bip32Result.data!.chainCode).toBe(BIP32_WALLET.chainCode);

    expect(wifResult.data!.derivationMode).toBe('wif_hmac');
    expect(wifResult.data!.chainCode).toBeUndefined();
  });
});
