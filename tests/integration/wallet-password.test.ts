/**
 * Integration tests for wallet password encryption and custom file names.
 *
 * Covers:
 * 1. Create wallet without password — plaintext mnemonic in storage
 * 2. Create wallet with password — encrypted mnemonic in storage
 * 3. Load wallet encrypted with DEFAULT_ENCRYPTION_KEY (backwards compat)
 * 4. Wrong password on load — throws error
 * 5. Custom walletFileName via createNodeProviders
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Sphere } from '../../core/Sphere';
import { DEFAULT_ENCRYPTION_KEY, STORAGE_KEYS_GLOBAL } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { createNodeProviders } from '../../impl/nodejs';
import { encryptSimple } from '../../core/encryption';
import { validateMnemonic as validateBip39Mnemonic } from '../../core/crypto';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, '.test-wallet-password');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PASSWORD = 'my-secret-password';

// =============================================================================
// Mock providers
// =============================================================================

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    registerNametag: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    mintToken: vi.fn().mockResolvedValue({ success: true, token: { id: 'mock-token' } }),
  } as unknown as OracleProvider;
}

// =============================================================================
// Helpers
// =============================================================================

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function readWalletJson(dir: string, fileName = 'wallet.json'): Record<string, string> {
  const filePath = path.join(dir, fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeWalletJson(dir: string, data: Record<string, string>, fileName = 'wallet.json'): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2));
}

async function createAndDestroy(options: {
  password?: string;
  dataDir?: string;
  fileName?: string;
}): Promise<void> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const storage = new FileStorageProvider({ dataDir, fileName: options.fileName });
  const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

  const { sphere } = await Sphere.init({
    storage,
    tokenStorage,
    transport: createMockTransport(),
    oracle: createMockOracle(),
    mnemonic: TEST_MNEMONIC,
    password: options.password,
  });

  await sphere.destroy();
}

// =============================================================================
// Tests
// =============================================================================

describe('Wallet password encryption', () => {
  beforeEach(() => {
    cleanTestDir();
  });

  afterEach(() => {
    cleanTestDir();
  });

  describe('create without password', () => {
    it('should store mnemonic as plaintext', async () => {
      await createAndDestroy({});

      const data = readWalletJson(DATA_DIR);
      // Mnemonic should be plaintext (valid BIP39)
      expect(validateBip39Mnemonic(data[STORAGE_KEYS_GLOBAL.MNEMONIC])).toBe(true);
      expect(data[STORAGE_KEYS_GLOBAL.MNEMONIC]).toBe(TEST_MNEMONIC);
    });

    it('should load back without password', async () => {
      await createAndDestroy({});

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      expect(sphere.identity).toBeTruthy();
      await sphere.destroy();
    });
  });

  describe('create with password', () => {
    it('should store mnemonic encrypted', async () => {
      await createAndDestroy({ password: TEST_PASSWORD });

      const data = readWalletJson(DATA_DIR);
      // Mnemonic should NOT be plaintext
      expect(validateBip39Mnemonic(data[STORAGE_KEYS_GLOBAL.MNEMONIC])).toBe(false);
      expect(data[STORAGE_KEYS_GLOBAL.MNEMONIC]).not.toBe(TEST_MNEMONIC);
    });

    it('should load back with correct password', async () => {
      await createAndDestroy({ password: TEST_PASSWORD });

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        password: TEST_PASSWORD,
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });

    it('should fail with wrong password', async () => {
      await createAndDestroy({ password: TEST_PASSWORD });

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      await expect(
        Sphere.init({
          storage,
          tokenStorage,
          transport: createMockTransport(),
          oracle: createMockOracle(),
          password: 'wrong-password',
        })
      ).rejects.toThrow('Failed to decrypt mnemonic');
    });

    it('should fail without password when wallet is encrypted', async () => {
      await createAndDestroy({ password: TEST_PASSWORD });

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      // No password — decrypt tries plaintext (fails), then default key (fails)
      await expect(
        Sphere.init({
          storage,
          tokenStorage,
          transport: createMockTransport(),
          oracle: createMockOracle(),
        })
      ).rejects.toThrow('Failed to decrypt mnemonic');
    });
  });

  describe('backwards compatibility with DEFAULT_ENCRYPTION_KEY', () => {
    it('should load wallet encrypted with old default key without password', async () => {
      // Simulate old SDK behavior: encrypt with DEFAULT_ENCRYPTION_KEY
      const encrypted = encryptSimple(TEST_MNEMONIC, DEFAULT_ENCRYPTION_KEY);
      writeWalletJson(DATA_DIR, {
        [STORAGE_KEYS_GLOBAL.MNEMONIC]: encrypted,
        [STORAGE_KEYS_GLOBAL.WALLET_EXISTS]: 'true',
        [STORAGE_KEYS_GLOBAL.WALLET_SOURCE]: 'mnemonic',
      });

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        // No password — should fall back to DEFAULT_ENCRYPTION_KEY
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });
  });

  describe('plaintext mnemonic in wallet.json (external app)', () => {
    it('should load wallet with plaintext mnemonic', async () => {
      // External app just puts plaintext mnemonic in wallet.json
      writeWalletJson(DATA_DIR, {
        [STORAGE_KEYS_GLOBAL.MNEMONIC]: TEST_MNEMONIC,
      });

      const storage = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      expect(sphere.identity).toBeTruthy();
      await sphere.destroy();
    });
  });

  describe('custom wallet file name', () => {
    it('should create and load wallet with custom file name', async () => {
      const customFileName = 'my-wallet.json';
      await createAndDestroy({ fileName: customFileName });

      // File should exist with custom name
      expect(fs.existsSync(path.join(DATA_DIR, customFileName))).toBe(true);
      // Default name should NOT exist
      expect(fs.existsSync(path.join(DATA_DIR, 'wallet.json'))).toBe(false);

      // Load back with same custom name
      const storage = new FileStorageProvider({ dataDir: DATA_DIR, fileName: customFileName });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });

    it('should work via createNodeProviders walletFileName option', async () => {
      const customFileName = 'openclaw-wallet.json';
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
        walletFileName: customFileName,
      });

      const { sphere } = await Sphere.init({
        ...providers,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        mnemonic: TEST_MNEMONIC,
      });

      await sphere.destroy();

      // Verify custom file name was used
      expect(fs.existsSync(path.join(DATA_DIR, customFileName))).toBe(true);
      expect(fs.existsSync(path.join(DATA_DIR, 'wallet.json'))).toBe(false);
    });
  });

  describe('password + custom file name combined', () => {
    it('should create encrypted wallet in custom-named file and load it back', async () => {
      const customFileName = 'secure-wallet.json';

      // Create with password + custom file
      await createAndDestroy({ password: TEST_PASSWORD, fileName: customFileName });

      // Verify file contents are encrypted
      const data = readWalletJson(DATA_DIR, customFileName);
      expect(validateBip39Mnemonic(data[STORAGE_KEYS_GLOBAL.MNEMONIC])).toBe(false);

      // Load back with password + custom file
      const storage = new FileStorageProvider({ dataDir: DATA_DIR, fileName: customFileName });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        password: TEST_PASSWORD,
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });
  });

  describe('.txt file support', () => {
    it('should load plaintext mnemonic from .txt file', async () => {
      // External app writes mnemonic to a .txt file
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'mnemonic.txt'), TEST_MNEMONIC);

      const storage = new FileStorageProvider({ dataDir: DATA_DIR, fileName: 'mnemonic.txt' });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });

    it('should load encrypted mnemonic from .txt file with password', async () => {
      // Write encrypted mnemonic to .txt
      const encrypted = encryptSimple(TEST_MNEMONIC, TEST_PASSWORD);
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'wallet.txt'), encrypted);

      const storage = new FileStorageProvider({ dataDir: DATA_DIR, fileName: 'wallet.txt' });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        password: TEST_PASSWORD,
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });

    it('should create wallet and persist mnemonic to .txt file', async () => {
      await createAndDestroy({ fileName: 'new-wallet.txt' });

      // .txt should contain only the mnemonic (plaintext, no JSON)
      const content = fs.readFileSync(path.join(DATA_DIR, 'new-wallet.txt'), 'utf-8');
      expect(content).toBe(TEST_MNEMONIC);
    });

    it('should create encrypted wallet in .txt file', async () => {
      await createAndDestroy({ fileName: 'encrypted.txt', password: TEST_PASSWORD });

      const content = fs.readFileSync(path.join(DATA_DIR, 'encrypted.txt'), 'utf-8');
      // Should NOT be plaintext mnemonic
      expect(content).not.toBe(TEST_MNEMONIC);
      expect(validateBip39Mnemonic(content)).toBe(false);

      // Should load back with password
      const storage = new FileStorageProvider({ dataDir: DATA_DIR, fileName: 'encrypted.txt' });
      const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere } = await Sphere.init({
        storage,
        tokenStorage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        password: TEST_PASSWORD,
      });

      expect(sphere.getMnemonic()).toBe(TEST_MNEMONIC);
      await sphere.destroy();
    });
  });
});
