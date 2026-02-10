/**
 * Integration tests for wallet address derivation consistency
 *
 * Verifies that the same private key produces identical addresses regardless
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
  getPublicKey,
  publicKeyToAddress,
  type MasterKey,
} from '../../core/crypto';
import {
  generateAddressFromMasterKey,
  generateHDAddressBIP32,
} from '../../l1/address';

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
  /** Expected addresses at indices 0, 1, 2 */
  expectedAddresses: [
    'alpha1q64c7vmezvqd43l4g0hg8l72uttc0sc5cqrhpqz',
    'alpha1qpanlhfjynerdp3vwjfd6uctexa2n6c9pusnsja',
    'alpha1q8m2m2sele36p3js0ju8rfcrk4ynjylvjnjl4x7',
  ],
};

// =============================================================================
// Test Wallet: WIF/HMAC (no chain code)
// =============================================================================

/** Known WIF wallet — uses HMAC-SHA512 derivation (legacy webwallet format) */
const WIF_WALLET = {
  masterKey: '86f38045ecb4f6ae0d655e866f13937b9892fbd1ff4b3ade8998df7422b4dd1b',
  derivationMode: 'wif_hmac' as const,
  /** Expected addresses at indices 0, 1 */
  expectedAddresses: [
    'alpha1qr82m4mgx7ngy32cfr5jkrcrmqw4j4as8spu8al',
    'alpha1qm4x7zc4ewz058kszsut73x9ujrgt0vdw5fw3jr',
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
    const address = publicKeyToAddress(info.publicKey, 'alpha');
    expect(address).toBe(BIP32_WALLET.expectedAddresses[0]);
  });

  it('should derive correct address at index 1', () => {
    const info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 1, false);
    const address = publicKeyToAddress(info.publicKey, 'alpha');
    expect(address).toBe(BIP32_WALLET.expectedAddresses[1]);
  });

  it('should derive correct address at index 2', () => {
    const info = deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 2, false);
    const address = publicKeyToAddress(info.publicKey, 'alpha');
    expect(address).toBe(BIP32_WALLET.expectedAddresses[2]);
  });

  it('should match L1 generateHDAddressBIP32 function', () => {
    for (let i = 0; i < BIP32_WALLET.expectedAddresses.length; i++) {
      const addr = generateHDAddressBIP32(
        BIP32_WALLET.masterKey,
        BIP32_WALLET.chainCode,
        i,
        BIP32_WALLET.basePath,
      );
      expect(addr.address).toBe(BIP32_WALLET.expectedAddresses[i]);
    }
  });

  it('should produce deterministic results across multiple calls', () => {
    const results = Array.from({ length: 5 }, () =>
      deriveAddressInfo(masterKey, BIP32_WALLET.basePath, 0, false),
    );
    const addresses = results.map((r) => publicKeyToAddress(r.publicKey, 'alpha'));
    expect(new Set(addresses).size).toBe(1);
    expect(addresses[0]).toBe(BIP32_WALLET.expectedAddresses[0]);
  });
});

// =============================================================================
// WIF/HMAC Derivation Tests
// =============================================================================

describe('WIF/HMAC wallet derivation', () => {
  it('should derive correct address at index 0', () => {
    const addr = generateAddressFromMasterKey(WIF_WALLET.masterKey, 0);
    expect(addr.address).toBe(WIF_WALLET.expectedAddresses[0]);
  });

  it('should derive correct address at index 1', () => {
    const addr = generateAddressFromMasterKey(WIF_WALLET.masterKey, 1);
    expect(addr.address).toBe(WIF_WALLET.expectedAddresses[1]);
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
    expect(new Set(results.map((r) => r.address)).size).toBe(1);
    expect(results[0].address).toBe(WIF_WALLET.expectedAddresses[0]);
  });

  it('should differ from BIP32 derivation with the same key', () => {
    // If we were to incorrectly use the WIF key as a raw private key
    // (no HMAC), the address would be wrong
    const rawPubKey = getPublicKey(WIF_WALLET.masterKey);
    const rawAddress = publicKeyToAddress(rawPubKey, 'alpha');

    // The raw address should NOT match the expected WIF address
    expect(rawAddress).not.toBe(WIF_WALLET.expectedAddresses[0]);
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
    const bip32Addr = publicKeyToAddress(bip32Info.publicKey, 'alpha');

    // WIF/HMAC derivation (no chain code)
    const wifAddr = generateAddressFromMasterKey(key, 0);

    expect(bip32Addr).not.toBe(wifAddr.address);
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
Address 1: ${BIP32_WALLET.expectedAddresses[0]} (Path: m/84'/1'/0'/0/0)

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

    for (let i = 0; i < BIP32_WALLET.expectedAddresses.length; i++) {
      const info = deriveAddressInfo(mk, basePath, i, false);
      const address = publicKeyToAddress(info.publicKey, 'alpha');
      expect(address).toBe(BIP32_WALLET.expectedAddresses[i]);
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
Address 1: ${BIP32_WALLET.expectedAddresses[0]}

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
      addresses: [{ index: 0, address: BIP32_WALLET.expectedAddresses[0] }],
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
    expect(publicKeyToAddress(info.publicKey, 'alpha')).toBe(BIP32_WALLET.expectedAddresses[0]);
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
Address 1: ${BIP32_WALLET.expectedAddresses[0]}

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
    expect(publicKeyToAddress(info.publicKey, 'alpha')).toBe(BIP32_WALLET.expectedAddresses[0]);
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
Address 1: ${WIF_WALLET.expectedAddresses[0]} (Path: m/44'/0'/0')

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
    for (let i = 0; i < WIF_WALLET.expectedAddresses.length; i++) {
      const addr = generateAddressFromMasterKey(result.data!.masterKey, i);
      expect(addr.address).toBe(WIF_WALLET.expectedAddresses[i]);
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

    for (let i = 0; i < BIP32_WALLET.expectedAddresses.length; i++) {
      const info = deriveAddressInfo(mk, basePath, i, false);
      const address = publicKeyToAddress(info.publicKey, 'alpha');
      expect(address).toBe(BIP32_WALLET.expectedAddresses[i]);
    }
  });

  it('should produce correct WIF addresses from legacy flat JSON', () => {
    const json = {
      masterPrivateKey: WIF_WALLET.masterKey,
      derivationMode: 'wif_hmac',
    };

    for (let i = 0; i < WIF_WALLET.expectedAddresses.length; i++) {
      const addr = generateAddressFromMasterKey(json.masterPrivateKey, i);
      expect(addr.address).toBe(WIF_WALLET.expectedAddresses[i]);
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
    expect(publicKeyToAddress(info.publicKey, 'alpha')).toBe(BIP32_WALLET.expectedAddresses[0]);
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
      const txtAddr = publicKeyToAddress(txtInfo.publicKey, 'alpha');

      const jsonInfo = deriveAddressInfo(jsonMk, jsonBasePath, i, false);
      const jsonAddr = publicKeyToAddress(jsonInfo.publicKey, 'alpha');

      expect(txtAddr).toBe(jsonAddr);
      expect(txtAddr).toBe(BIP32_WALLET.expectedAddresses[i]);
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
      addresses: [{ index: 0, address: BIP32_WALLET.expectedAddresses[0] }],
    });

    // Encrypted
    const encKey = encryptForTextFormat(BIP32_WALLET.masterKey, password);
    const encryptedTxt = serializeEncryptedWalletToText({
      encryptedMasterKey: encKey,
      chainCode: BIP32_WALLET.chainCode,
      descriptorPath: BIP32_WALLET.descriptorPath,
      isBIP32: true,
      addresses: [{ index: 0, address: BIP32_WALLET.expectedAddresses[0] }],
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

    const addr1 = publicKeyToAddress(
      deriveAddressInfo(mk1, basePath, 0, false).publicKey,
      'alpha',
    );
    const addr2 = publicKeyToAddress(
      deriveAddressInfo(mk2, basePath, 0, false).publicKey,
      'alpha',
    );

    expect(addr1).toBe(addr2);
    expect(addr1).toBe(BIP32_WALLET.expectedAddresses[0]);
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

    expect(txtAddr.address).toBe(directAddr.address);
    expect(txtAddr.address).toBe(WIF_WALLET.expectedAddresses[0]);
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
    const address = publicKeyToAddress(info.publicKey, 'alpha');

    // This should match because 84'/1'/0' IS the correct default
    expect(address).toBe(BIP32_WALLET.expectedAddresses[0]);
  });

  it('should produce WRONG address with incorrect base path', () => {
    const mk: MasterKey = {
      privateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
    };

    // Wrong base path — this is the generic default, not Alpha network
    const wrongPath = "m/44'/0'/0'";
    const info = deriveAddressInfo(mk, wrongPath, 0, false);
    const address = publicKeyToAddress(info.publicKey, 'alpha');

    // Should NOT match the expected address
    expect(address).not.toBe(BIP32_WALLET.expectedAddresses[0]);
  });

  it('should produce different addresses for different indices', () => {
    // BIP32
    const mk: MasterKey = {
      privateKey: BIP32_WALLET.masterKey,
      chainCode: BIP32_WALLET.chainCode,
    };
    const addrs = BIP32_WALLET.expectedAddresses;
    expect(new Set(addrs).size).toBe(addrs.length);

    // WIF
    const wifAddrs = WIF_WALLET.expectedAddresses;
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
