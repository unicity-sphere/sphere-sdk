/**
 * Generate test fixture files for wallet import/export tests
 * Run with: npx ts-node tests/integration/fixtures/generate-fixtures.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import CryptoJS from 'crypto-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = __dirname;
const TEST_PASSWORD = 'SphereTest123';
const TEST_MASTER_KEY = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';
const TEST_CHAIN_CODE = 'b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6b7b8b9b0b1b2';

// Legacy webwallet encryption parameters (must match wallet-text.ts)
const LEGACY_SALT = 'alpha_wallet_salt';
const LEGACY_ITERATIONS = 100000;

/**
 * Derive encryption key using original webwallet parameters (matches wallet-text.ts)
 */
function deriveLegacyKey(password: string): string {
  return CryptoJS.PBKDF2(password, LEGACY_SALT, {
    keySize: 256 / 32,
    iterations: LEGACY_ITERATIONS,
    hasher: CryptoJS.algo.SHA1,
  }).toString();
}

/**
 * Encrypt master key for text format export (matches wallet-text.ts)
 */
function encryptForTextFormat(masterPrivateKey: string, password: string): string {
  const key = deriveLegacyKey(password);
  return CryptoJS.AES.encrypt(masterPrivateKey, key).toString();
}

function createJsonWallet(filename: string): void {
  const wallet = {
    masterPrivateKey: TEST_MASTER_KEY,
    chainCode: TEST_CHAIN_CODE,
    addresses: []
  };

  fs.writeFileSync(
    path.join(FIXTURES_DIR, filename),
    JSON.stringify(wallet, null, 2)
  );
  console.log('Created: ' + filename);
}

function createEncryptedJsonWallet(filename: string, password: string): void {
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const data = JSON.stringify({ masterPrivateKey: TEST_MASTER_KEY, chainCode: TEST_CHAIN_CODE });
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);

  const wallet = {
    encrypted: true,
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    algorithm: 'aes-256-cbc',
    kdf: 'pbkdf2',
    iterations: 100000
  };

  fs.writeFileSync(
    path.join(FIXTURES_DIR, filename),
    JSON.stringify(wallet, null, 2)
  );
  console.log('Created: ' + filename);
}

/**
 * Create encrypted TXT backup (matches wallet-text.ts format exactly)
 */
function createEncryptedTxtBackup(filename: string, password: string): void {
  // Use the same encryption as wallet-text.ts
  const encryptedKey = encryptForTextFormat(TEST_MASTER_KEY, password);

  const content = `UNICITY WALLET DETAILS
===========================

ENCRYPTED MASTER KEY (password protected):
${encryptedKey}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${TEST_CHAIN_CODE}

DESCRIPTOR PATH: 84'/1'/0'

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Encrypted with password
To use this key, you will need the password you set in the wallet.

YOUR ADDRESSES:
Address 1: ATestAddress1 (Path: m/84'/1'/0'/0/0)

Generated on: ${new Date().toLocaleString()}

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

  fs.writeFileSync(path.join(FIXTURES_DIR, filename), content);
  console.log('Created: ' + filename);
}

/**
 * Create unencrypted TXT backup (matches wallet-text.ts format exactly)
 */
function createUnencryptedTxtBackup(filename: string): void {
  const content = `UNICITY WALLET DETAILS
===========================

MASTER PRIVATE KEY (keep secret!):
${TEST_MASTER_KEY}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${TEST_CHAIN_CODE}

DESCRIPTOR PATH: 84'/1'/0'

WALLET TYPE: BIP32 hierarchical deterministic wallet

ENCRYPTION STATUS: Not encrypted
This key is in plaintext and not protected. Anyone with this file can access your wallet.

YOUR ADDRESSES:
Address 1: ATestAddress1 (Path: m/84'/1'/0'/0/0)

Generated on: ${new Date().toLocaleString()}

WARNING: Keep your master private key safe and secure.
Anyone with your master private key can access all your funds.`;

  fs.writeFileSync(path.join(FIXTURES_DIR, filename), content);
  console.log('Created: ' + filename);
}

// Generate all fixtures
console.log('Generating test fixtures for sphere-sdk...\n');

createJsonWallet('test.json');
createEncryptedJsonWallet('test_enc_' + TEST_PASSWORD + '.json', TEST_PASSWORD);
createEncryptedTxtBackup('test_enc_' + TEST_PASSWORD + '.txt', TEST_PASSWORD);
createUnencryptedTxtBackup('test_unencrypted.txt');

console.log('\nDone! Test password: ' + TEST_PASSWORD);
console.log('Expected master key prefix: ' + TEST_MASTER_KEY.slice(0, 16));
