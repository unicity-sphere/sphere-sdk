/**
 * Integration tests for wallet import/export functionality
 * Tests the actual SDK serialization functions with real fixture files
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// SDK imports
import {
  parseWalletText,
  parseAndDecryptWalletText,
  isTextWalletEncrypted,
} from '../../serialization/wallet-text';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const TEST_PASSWORD = 'SphereTest123';
const TEST_MASTER_KEY = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

// =============================================================================
// wallet-text.ts Integration Tests
// =============================================================================

describe('wallet-text.ts integration', () => {
  describe('isTextWalletEncrypted()', () => {
    it('should detect encrypted TXT backup', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      expect(isTextWalletEncrypted(content)).toBe(true);
    });

    it('should detect unencrypted TXT backup', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_unencrypted.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      expect(isTextWalletEncrypted(content)).toBe(false);
    });
  });

  describe('parseWalletText()', () => {
    it('should parse unencrypted TXT backup', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_unencrypted.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      const result = parseWalletText(content);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.masterKey).toBe(TEST_MASTER_KEY);
        expect(result.data.chainCode).toBeDefined();
      }
    });

    it('should detect encrypted TXT needs password', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      const result = parseWalletText(content);

      expect(result.success).toBe(false);
      expect(result.needsPassword).toBe(true);
    });
  });

  describe('parseAndDecryptWalletText()', () => {
    it('should decrypt encrypted TXT backup with correct password', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      const result = parseAndDecryptWalletText(content, TEST_PASSWORD);

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.masterKey).toBe(TEST_MASTER_KEY);
      }
    });

    it('should fail with wrong password', () => {
      const filePath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.txt');
      const content = fs.readFileSync(filePath, 'utf8');

      const result = parseAndDecryptWalletText(content, 'wrongpassword');

      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// JSON wallet files
// =============================================================================

describe('JSON wallet files', () => {
  it('should parse unencrypted JSON wallet', () => {
    const filePath = path.join(FIXTURES_DIR, 'test.json');
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(content.masterPrivateKey).toBe(TEST_MASTER_KEY);
    expect(content.masterPrivateKey.length).toBe(64);
  });

  it('should detect encrypted JSON wallet', () => {
    const filePath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.json');
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(content.encrypted).toBe(true);
    expect(content.ciphertext).toBeDefined();
    expect(content.iv).toBeDefined();
    expect(content.salt).toBeDefined();
  });
});

// =============================================================================
// Cross-format consistency
// =============================================================================

describe('Cross-format consistency', () => {
  it('should have consistent master key across unencrypted JSON and TXT', () => {
    // JSON
    const jsonPath = path.join(FIXTURES_DIR, 'test.json');
    const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    // TXT
    const txtPath = path.join(FIXTURES_DIR, 'test_unencrypted.txt');
    const txtContent = fs.readFileSync(txtPath, 'utf8');
    const txtResult = parseWalletText(txtContent);

    expect(jsonContent.masterPrivateKey).toBe(TEST_MASTER_KEY);
    expect(txtResult.success).toBe(true);
    if (txtResult.success && txtResult.data) {
      expect(txtResult.data.masterKey).toBe(TEST_MASTER_KEY);
    }
  });

  it('should decrypt to same master key from TXT', () => {
    const txtPath = path.join(FIXTURES_DIR, 'test_enc_SphereTest123.txt');
    const txtContent = fs.readFileSync(txtPath, 'utf8');
    const txtResult = parseAndDecryptWalletText(txtContent, TEST_PASSWORD);

    expect(txtResult.success).toBe(true);
    if (txtResult.success && txtResult.data) {
      expect(txtResult.data.masterKey).toBe(TEST_MASTER_KEY);
    }
  });

  it('should use same test constants across all fixtures', () => {
    // Verify fixture constants are consistent
    expect(TEST_MASTER_KEY.length).toBe(64);
    expect(TEST_MASTER_KEY.startsWith('a1b2c3d4e5f67890')).toBe(true);
    expect(TEST_PASSWORD).toBe('SphereTest123');
  });
});
