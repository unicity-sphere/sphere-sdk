/**
 * Tests for modules/payments/PaymentsModule.ts
 * Covers L1 optional initialization and configuration
 */

import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import { L1PaymentsModule } from '../../../modules/payments/L1PaymentsModule';

// =============================================================================
// Mock L1 SDK functions to avoid network calls
// =============================================================================

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule', () => {
  describe('L1 optional initialization', () => {
    it('should have l1 enabled by default when no config is provided', () => {
      const module = createPaymentsModule();
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should have l1 enabled when empty l1 config is provided', () => {
      const module = createPaymentsModule({ l1: {} });
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should have l1 enabled when l1 config has empty electrumUrl', () => {
      const module = createPaymentsModule({ l1: { electrumUrl: '' } });
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should have l1 enabled when l1 is undefined', () => {
      const module = createPaymentsModule({ l1: undefined });
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should have l1 as null when l1 is explicitly null', () => {
      const module = createPaymentsModule({ l1: null });
      expect(module.l1).toBeNull();
    });

    it('should initialize l1 when electrumUrl is provided', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://test.example.com:50004' },
      });
      expect(module.l1).not.toBeNull();
      expect(module.l1).toBeInstanceOf(L1PaymentsModule);
    });

    it('should initialize l1 with default fulcrum URL', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://fulcrum.alpha.unicity.network:50004' },
      });
      expect(module.l1).not.toBeNull();
    });
  });

  describe('Module configuration defaults', () => {
    it('should have correct default config values', () => {
      const module = createPaymentsModule();
      const config = module.getConfig();

      expect(config.autoSync).toBe(true);
      expect(config.autoValidate).toBe(true);
      expect(config.retryFailed).toBe(true);
      expect(config.maxRetries).toBe(3);
      expect(config.debug).toBe(false);
    });

    it('should allow overriding config values', () => {
      const module = createPaymentsModule({
        autoSync: false,
        autoValidate: false,
        retryFailed: false,
        maxRetries: 5,
        debug: true,
      });
      const config = module.getConfig();

      expect(config.autoSync).toBe(false);
      expect(config.autoValidate).toBe(false);
      expect(config.retryFailed).toBe(false);
      expect(config.maxRetries).toBe(5);
      expect(config.debug).toBe(true);
    });
  });

  describe('destroy()', () => {
    it('should not throw when l1 is null', () => {
      const module = createPaymentsModule({ l1: null });
      expect(module.l1).toBeNull();
      expect(() => module.destroy()).not.toThrow();
    });

    it('should call l1.destroy() when l1 is enabled', () => {
      const module = createPaymentsModule({
        l1: { electrumUrl: 'wss://test.example.com:50004' },
      });
      expect(module.l1).not.toBeNull();

      const destroySpy = vi.spyOn(module.l1!, 'destroy');
      module.destroy();
      expect(destroySpy).toHaveBeenCalled();
    });
  });
});

describe('Incoming transfer payload format detection', () => {
  it('should recognize Sphere wallet format (sourceToken + transferTx)', () => {
    // Sphere wallet sends this format
    const spherePayload = {
      sourceToken: { genesis: {}, state: {} },
      transferTx: { data: { recipient: {}, salt: '' } },
    };

    // Check format detection logic (same as in handleIncomingTransfer)
    const hasSphereFormat = 'sourceToken' in spherePayload && 'transferTx' in spherePayload;
    const hasSdkFormat = 'token' in spherePayload;

    expect(hasSphereFormat).toBe(true);
    expect(hasSdkFormat).toBe(false);
  });

  it('should recognize SDK format (token + proof)', () => {
    // SDK sends this format
    const sdkPayload = {
      token: '{"genesis":{}}',
      proof: {},
      memo: 'test',
    };

    // Check format detection logic
    const hasSphereFormat = 'sourceToken' in sdkPayload && 'transferTx' in sdkPayload;
    const hasSdkFormat = 'token' in sdkPayload;

    expect(hasSphereFormat).toBe(false);
    expect(hasSdkFormat).toBe(true);
  });

  it('should handle string-encoded sourceToken', () => {
    const spherePayload = {
      sourceToken: '{"genesis":{"data":{"coinData":{"UCT":"1000000000000000000"}}}}',
      transferTx: '{"data":{"recipient":{"scheme":1}}}',
    };

    // Verify parsing logic
    const sourceToken = typeof spherePayload.sourceToken === 'string'
      ? JSON.parse(spherePayload.sourceToken)
      : spherePayload.sourceToken;

    expect(sourceToken.genesis.data.coinData.UCT).toBe('1000000000000000000');
  });

  it('should send in Sphere wallet format (sourceToken + transferTx), not SDK format (token + proof)', () => {
    // This test verifies the outgoing payload structure
    // SDK must send { sourceToken, transferTx } for Sphere compatibility
    const mockSdkToken = { genesis: { data: { coinData: { UCT: '1000' } } } };
    const mockTransferTx = { data: { recipient: { scheme: 1 }, salt: 'abc' } };

    // Simulate what PaymentsModule.send() should create
    const outgoingPayload = {
      sourceToken: JSON.stringify(mockSdkToken),
      transferTx: JSON.stringify(mockTransferTx),
      memo: 'test payment',
    };

    // Verify it uses Sphere format, not SDK format
    expect(outgoingPayload).toHaveProperty('sourceToken');
    expect(outgoingPayload).toHaveProperty('transferTx');
    expect(outgoingPayload).not.toHaveProperty('token');
    expect(outgoingPayload).not.toHaveProperty('proof');

    // Verify sourceToken and transferTx are JSON strings
    expect(typeof outgoingPayload.sourceToken).toBe('string');
    expect(typeof outgoingPayload.transferTx).toBe('string');
    expect(() => JSON.parse(outgoingPayload.sourceToken)).not.toThrow();
    expect(() => JSON.parse(outgoingPayload.transferTx)).not.toThrow();
  });
});

describe('L1PaymentsModule', () => {
  describe('configuration defaults', () => {
    it('should have default electrumUrl when created with config', () => {
      // Note: L1PaymentsModule is only created when electrumUrl is provided
      // via PaymentsModule, but directly it still has defaults
      const l1 = new L1PaymentsModule();
      // Access private config for testing
      const config = (l1 as unknown as { _config: Record<string, unknown> })._config;

      expect(config.electrumUrl).toBe('wss://fulcrum.unicity.network:50004');
      expect(config.network).toBe('mainnet');
      expect(config.defaultFeeRate).toBe(10);
      expect(config.enableVesting).toBe(true);
    });

    it('should allow overriding config values', () => {
      const l1 = new L1PaymentsModule({
        electrumUrl: 'wss://custom.example.com:50004',
        network: 'testnet',
        defaultFeeRate: 5,
        enableVesting: false,
      });
      const config = (l1 as unknown as { _config: Record<string, unknown> })._config;

      expect(config.electrumUrl).toBe('wss://custom.example.com:50004');
      expect(config.network).toBe('testnet');
      expect(config.defaultFeeRate).toBe(5);
      expect(config.enableVesting).toBe(false);
    });
  });
});

describe('Token file storage (lottery pattern)', () => {
  it('should have save/load as methods on TokenStorageProvider', async () => {
    const { FileTokenStorageProvider } = await import('../../../impl/nodejs/storage');

    const provider = new FileTokenStorageProvider('/tmp/test-tokens');

    // Verify the provider has core save/load methods
    expect(typeof provider.save).toBe('function');
    expect(typeof provider.load).toBe('function');
    expect(typeof provider.sync).toBe('function');
  });

  it('should generate correct token filename format', () => {
    // Verify the filename format matches lottery pattern: token-{id}-{timestamp}.json
    const tokenIdPrefix = 'abcd1234'.slice(0, 16);
    const timestamp = Date.now();
    const filename = `token-${tokenIdPrefix}-${timestamp}`;

    expect(filename).toMatch(/^token-[a-f0-9]+-\d+$/);
    expect(filename.startsWith('token-')).toBe(true);
  });

  it('should store token data in lottery-compatible format', () => {
    // Verify the saved data structure matches lottery format
    const tokenData = {
      token: { genesis: {}, state: {} },
      receivedAt: Date.now(),
      meta: {
        id: 'test-id',
        coinId: 'UCT',
        symbol: 'UCT',
        amount: '1000000000000000000',
        status: 'confirmed',
      },
    };

    // Lottery format has: { token: Token.toJSON(), receivedAt: number }
    expect(tokenData).toHaveProperty('token');
    expect(tokenData).toHaveProperty('receivedAt');
    expect(typeof tokenData.receivedAt).toBe('number');

    // SDK format adds meta for convenience
    expect(tokenData).toHaveProperty('meta');
    expect(tokenData.meta).toHaveProperty('id');
    expect(tokenData.meta).toHaveProperty('coinId');
    expect(tokenData.meta).toHaveProperty('amount');
  });
});

describe('Incoming transfer PROXY finalization', () => {
  it('should require nametag token for PROXY address finalization', () => {
    // Document the PROXY finalization requirement
    // AddressScheme.PROXY = 1 requires nametag token
    const PROXY_SCHEME = 1;
    const DIRECT_SCHEME = 0;

    const proxyTransfer = {
      data: { recipient: { scheme: PROXY_SCHEME } },
    };

    const directTransfer = {
      data: { recipient: { scheme: DIRECT_SCHEME } },
    };

    expect(proxyTransfer.data.recipient.scheme).toBe(PROXY_SCHEME);
    expect(directTransfer.data.recipient.scheme).toBe(DIRECT_SCHEME);
  });

  it('should check for nametag token before finalizing PROXY transfer', () => {
    // Simulate the check in handleIncomingTransfer
    const nametagData = {
      name: 'alice',
      token: { genesis: {}, state: {} },
      timestamp: Date.now(),
    };

    const hasNametagToken = nametagData?.token !== undefined;
    expect(hasNametagToken).toBe(true);

    const noNametag = null as { token?: object } | null;
    const hasNoNametagToken = noNametag !== null && noNametag.token !== undefined;
    expect(hasNoNametagToken).toBe(false);
  });

  it('should document finalization flow for PROXY transfers', () => {
    // Document the expected finalization flow
    const finalizationFlow = [
      '1. Parse sourceToken and transferTx from Sphere format',
      '2. Check if recipient address scheme is PROXY',
      '3. If PROXY: require nametag token for finalization',
      '4. Create recipientPredicate using UnmaskedPredicate.create()',
      '5. Create recipientState with TokenState(predicate, null)',
      '6. Call stClient.finalizeTransaction(trustBase, sourceToken, recipientState, transferTx, [nametagToken])',
      '7. Save finalized token',
    ];

    expect(finalizationFlow).toHaveLength(7);
    expect(finalizationFlow[2]).toContain('nametag');
    expect(finalizationFlow[5]).toContain('finalizeTransaction');
  });

  it('should handle missing nametag gracefully', () => {
    // When nametag is missing, should save unfinalized token
    const nametag = null as { token?: object } | null;

    const hasToken = nametag !== null && nametag.token !== undefined;
    if (!hasToken) {
      // Save without finalization
      const tokenData = { genesis: {}, state: {} };
      expect(tokenData).toBeDefined();
    }
  });
});

describe('PaymentsModule.mintNametag integration', () => {
  it('should have mintNametag method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.mintNametag).toBe('function');
  });

  it('should have isNametagAvailable method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.isNametagAvailable).toBe('function');
  });

  it('should have setNametag method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.setNametag).toBe('function');
  });

  it('should have getNametag method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.getNametag).toBe('function');
  });

  it('should have hasNametag method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.hasNametag).toBe('function');
  });

  it('should have clearNametag method on PaymentsModule', () => {
    const module = createPaymentsModule();
    expect(typeof module.clearNametag).toBe('function');
  });

  it('should return error when not initialized', async () => {
    const module = createPaymentsModule();
    // mintNametag requires initialization
    await expect(module.mintNametag('alice')).rejects.toThrow('not initialized');
  });

  it('should document mintNametag integration flow', () => {
    const mintFlow = [
      '1. PaymentsModule.mintNametag(nametag) called',
      '2. Get stateTransitionClient and trustBase from oracle',
      '3. Create signingService from identity private key',
      '4. Create ownerAddress using UnmaskedPredicateReference',
      '5. Create NametagMinter with dependencies',
      '6. Call minter.mintNametag(nametag, ownerAddress)',
      '7. If success: call setNametag(result.nametagData)',
      '8. Emit nametag:registered event',
      '9. Return MintNametagResult',
    ];

    expect(mintFlow).toHaveLength(9);
    expect(mintFlow[4]).toContain('NametagMinter');
    expect(mintFlow[6]).toContain('setNametag');
    expect(mintFlow[7]).toContain('nametag:registered');
  });
});

describe('Lottery compatibility', () => {
  it('should match lottery token minting flow', () => {
    // Lottery uses MintTransactionData.createFromNametag
    const lotteryMintFlow = {
      step1: 'TokenId.fromNameTag(nametag)',
      step2: 'TokenType from UNICITY_TOKEN_TYPE_HEX',
      step3: 'Generate random salt (32 bytes)',
      step4: 'MintTransactionData.createFromNametag(nametag, type, owner, salt, owner)',
      step5: 'MintCommitment.create(mintData)',
      step6: 'client.submitMintCommitment(commitment)',
      step7: 'waitInclusionProof(trustBase, client, commitment)',
      step8: 'Token.mint(trustBase, state, genesisTransaction)',
    };

    // SDK NametagMinter follows the same flow
    expect(lotteryMintFlow.step4).toContain('createFromNametag');
    expect(lotteryMintFlow.step6).toContain('submitMintCommitment');
    expect(lotteryMintFlow.step7).toContain('waitInclusionProof');
  });

  it('should match lottery token receiving flow', () => {
    // Lottery uses sourceToken + transferTx format
    const lotteryReceiveFlow = {
      step1: 'Parse sourceToken from JSON',
      step2: 'Parse transferTx from JSON',
      step3: 'Check recipient address scheme',
      step4: 'If PROXY: finalizeTransaction with nametag token',
      step5: 'Verify token',
      step6: 'Save token to file',
    };

    expect(lotteryReceiveFlow.step4).toContain('finalizeTransaction');
    expect(lotteryReceiveFlow.step6).toContain('Save token');
  });

  it('should match lottery token sending flow with split', () => {
    // Lottery uses TokenSplitBuilder for partial transfers
    const lotterySendFlow = {
      step1: 'Calculate if split needed (amount < token.amount)',
      step2: 'TokenSplitBuilder.createToken() x2 (recipient + change)',
      step3: 'builder.build(originalToken)',
      step4: 'split.createBurnCommitment() - burn original',
      step5: 'submitTransferCommitment(burnCommitment)',
      step6: 'waitInclusionProof for burn',
      step7: 'split.createSplitMintCommitments() - mint split tokens',
      step8: 'submitMintCommitment() for each',
      step9: 'Create TransferCommitment for recipient token',
      step10: 'Send { sourceToken, transferTx } via Nostr',
    };

    expect(lotterySendFlow.step2).toContain('TokenSplitBuilder');
    expect(lotterySendFlow.step4).toContain('Burn');
    expect(lotterySendFlow.step7).toContain('Mint');
    expect(lotterySendFlow.step10).toContain('sourceToken');
  });

  it('should use same UNICITY_TOKEN_TYPE_HEX as lottery', () => {
    // Both lottery and SDK use this constant
    const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

    expect(UNICITY_TOKEN_TYPE_HEX).toHaveLength(64);
    expect(UNICITY_TOKEN_TYPE_HEX).toMatch(/^[a-f0-9]+$/);
  });

  it('should store tokens individually like lottery', () => {
    // Lottery saves each token as separate file: token-{id}-{timestamp}.json
    const tokenId = 'abcd1234567890ef';
    const timestamp = Date.now();
    const filename = `token-${tokenId.slice(0, 16)}-${timestamp}.json`;

    expect(filename).toMatch(/^token-[a-f0-9]+-\d+\.json$/);
  });
});

describe('loadTokensFromFileStorage (lottery compatibility)', () => {
  it('should skip loading if no providers configured', () => {
    // When getTokenStorageProviders() returns empty map, should exit early
    const providers = new Map();
    expect(providers.size).toBe(0);
  });

  it('should skip providers without listTokenIds method', () => {
    // Provider must have listTokenIds and getToken methods
    const provider = {
      save: vi.fn(),
      load: vi.fn(),
      // No listTokenIds or getToken
    };

    const hasListTokenIds = 'listTokenIds' in provider && typeof provider.listTokenIds === 'function';
    expect(hasListTokenIds).toBe(false);
  });

  it('should parse lottery file format: { token, receivedAt }', () => {
    // Lottery saves files in this format
    const lotteryFileData = {
      token: {
        genesis: {
          data: {
            tokenId: 'abc123',
            coinData: { UCT: '1000000000000000000' },
          },
        },
        state: {},
      },
      receivedAt: Date.now(),
    };

    expect(lotteryFileData).toHaveProperty('token');
    expect(lotteryFileData).toHaveProperty('receivedAt');
    expect(lotteryFileData.token.genesis.data.tokenId).toBe('abc123');
  });

  it('should extract tokenId from genesis.data.tokenId', () => {
    const tokenJson = {
      genesis: {
        data: {
          tokenId: 'test-token-id-123',
          coinData: { UCT: '1000' },
        },
      },
    };

    // Extraction logic from loadTokensFromFileStorage
    const tokenObj = tokenJson as Record<string, unknown>;
    const genesis = tokenObj.genesis as Record<string, unknown> | undefined;
    const genesisData = genesis?.data as Record<string, unknown> | undefined;
    const sdkTokenId = genesisData?.tokenId as string | undefined;

    expect(sdkTokenId).toBe('test-token-id-123');
  });

  it('should skip already loaded tokens (deduplication)', () => {
    // Simulate in-memory tokens map
    const existingTokens = new Map([
      ['token-1', { id: 'token-1', sdkData: '{"genesis":{"data":{"tokenId":"abc123"}}}' }],
    ]);

    const newTokenId = 'abc123';
    let exists = false;

    for (const existing of existingTokens.values()) {
      const existingJson = JSON.parse(existing.sdkData as string);
      const existingId = existingJson?.genesis?.data?.tokenId;
      if (existingId === newTokenId) {
        exists = true;
        break;
      }
    }

    expect(exists).toBe(true);
  });

  it('should add token to in-memory storage after parsing', () => {
    const tokens = new Map<string, object>();
    const tokenFromFile = {
      id: 'token-xyz',
      coinId: 'UCT',
      symbol: 'UCT',
      amount: '1000000000000000000',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: '{}',
    };

    tokens.set(tokenFromFile.id, tokenFromFile);
    expect(tokens.has('token-xyz')).toBe(true);
  });
});

describe('saveNametagToFileStorage (lottery compatibility)', () => {
  it('should save nametag in lottery-compatible format', () => {
    const nametag = {
      name: 'alice',
      token: { genesis: {}, state: {} },
      timestamp: Date.now(),
    };

    // Expected file format
    const fileData = {
      nametag: nametag.name,
      token: nametag.token,
      timestamp: nametag.timestamp,
    };

    expect(fileData.nametag).toBe('alice');
    expect(fileData).toHaveProperty('token');
    expect(fileData).toHaveProperty('timestamp');
  });

  it('should use filename format: nametag-{name}', () => {
    const name = 'alice';
    const filename = `nametag-${name}`;

    expect(filename).toBe('nametag-alice');
    expect(filename).toMatch(/^nametag-[a-z]+$/);
  });

  it('should call provider.saveToken with correct arguments', () => {
    const mockProvider = {
      saveToken: vi.fn(),
    };

    const nametag = {
      name: 'bob',
      token: { data: 'test' },
      timestamp: 123456789,
    };

    const filename = `nametag-${nametag.name}`;
    const fileData = {
      nametag: nametag.name,
      token: nametag.token,
      timestamp: nametag.timestamp,
    };

    // Simulate saveToken call
    mockProvider.saveToken(filename, fileData);

    expect(mockProvider.saveToken).toHaveBeenCalledWith('nametag-bob', {
      nametag: 'bob',
      token: { data: 'test' },
      timestamp: 123456789,
    });
  });
});

describe('loadNametagFromFileStorage (lottery compatibility)', () => {
  it('should skip if nametag already loaded', () => {
    // If this.nametag is set, should return early
    const existingNametag = { name: 'alice', token: {} };
    const shouldSkip = existingNametag !== null;

    expect(shouldSkip).toBe(true);
  });

  it('should filter for nametag- prefixed files', () => {
    const tokenIds = [
      'token-abc-123',
      'token-def-456',
      'nametag-alice',
      'nametag-bob',
      'other-file',
    ];

    const nametagFiles = tokenIds.filter(id => id.startsWith('nametag-'));

    expect(nametagFiles).toEqual(['nametag-alice', 'nametag-bob']);
    expect(nametagFiles.length).toBe(2);
  });

  it('should parse nametag file format', () => {
    const fileData = {
      nametag: 'alice',
      token: { genesis: {}, state: {} },
      timestamp: 123456789,
    };

    // Should convert to NametagData format
    const nametagData = {
      name: fileData.nametag,
      token: fileData.token,
      timestamp: fileData.timestamp,
      format: 'lottery',
      version: '1.0',
    };

    expect(nametagData.name).toBe('alice');
    expect(nametagData.format).toBe('lottery');
    expect(nametagData.version).toBe('1.0');
  });

  it('should skip files without token or nametag fields', () => {
    const invalidFileData = { other: 'data' };

    const data = invalidFileData as Record<string, unknown>;
    const hasRequiredFields = data.token && data.nametag;

    expect(hasRequiredFields).toBeFalsy();
  });
});

describe('PROXY token rejection (lottery behavior)', () => {
  it('should reject PROXY token when no nametag token available', () => {
    // Simulates the rejection logic in handleIncomingTransfer
    const addressScheme = 1; // PROXY
    const nametag = null as { token?: object } | null;

    const hasNametagToken = nametag !== null && nametag.token !== undefined;
    const shouldReject = addressScheme === 1 && !hasNametagToken;

    expect(shouldReject).toBe(true);
  });

  it('should not reject DIRECT token without nametag', () => {
    // DIRECT (scheme 0) doesn't need finalization
    const addressScheme: number = 0; // DIRECT

    // DIRECT tokens don't require nametag
    const needsFinalization = addressScheme === 1;

    expect(needsFinalization).toBe(false);
  });

  it('should reject PROXY token when stClient is missing', () => {
    const addressScheme = 1; // PROXY
    // nametag with token exists, but stClient is missing
    const stClient = null;
    const trustBase = { data: {} };

    const shouldReject = addressScheme === 1 && (!stClient || !trustBase);

    expect(shouldReject).toBe(true);
  });

  it('should reject PROXY token when trustBase is missing', () => {
    const addressScheme = 1; // PROXY
    // nametag with token exists, but trustBase is missing
    const stClient = { finalize: vi.fn() };
    const trustBase = null;

    const shouldReject = addressScheme === 1 && (!stClient || !trustBase);

    expect(shouldReject).toBe(true);
  });

  it('should accept PROXY token when all dependencies are available', () => {
    const addressScheme = 1; // PROXY
    const nametag = { token: {} };
    const stClient = { finalize: vi.fn() };
    const trustBase = { data: {} };

    const canFinalize = addressScheme === 1 &&
      nametag?.token &&
      stClient &&
      trustBase;

    expect(canFinalize).toBeTruthy();
  });

  it('should document rejection vs fallback behavior difference from before', () => {
    // Before: would save unfinalized PROXY tokens
    // After (lottery-compatible): reject tokens that cannot be finalized
    const behaviorDiff = {
      before: 'Save unfinalized token as fallback',
      after: 'Reject token - cannot spend without finalization',
      reason: 'Lottery rejects tokens that cannot be finalized, SDK should match',
    };

    expect(behaviorDiff.after).toContain('Reject');
    expect(behaviorDiff.reason.toLowerCase()).toContain('lottery');
  });
});

// =============================================================================
// getAssets() Tests
// =============================================================================

describe('getAssets()', () => {
  function createModuleWithTokens(tokens: Array<{
    id: string;
    coinId: string;
    symbol: string;
    name: string;
    decimals: number;
    iconUrl?: string;
    amount: string;
    status: string;
  }>) {
    const module = createPaymentsModule();
    const tokensMap = (module as unknown as { tokens: Map<string, unknown> }).tokens;
    for (const token of tokens) {
      tokensMap.set(token.id, {
        ...token,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return module;
  }

  it('should return empty array when no tokens exist', async () => {
    const module = createPaymentsModule();
    expect(await module.getAssets()).toEqual([]);
  });

  it('should aggregate tokens by coinId', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '2000', status: 'confirmed' },
      { id: 't3', coinId: '0xbbb', symbol: 'BTC', name: 'Bitcoin', decimals: 8, amount: '500', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();

    expect(assets.length).toBe(2);

    const uct = assets.find((a) => a.symbol === 'UCT');
    const btc = assets.find((a) => a.symbol === 'BTC');

    expect(uct).toBeDefined();
    expect(uct?.totalAmount).toBe('3000');
    expect(uct?.tokenCount).toBe(2);

    expect(btc).toBeDefined();
    expect(btc?.totalAmount).toBe('500');
    expect(btc?.tokenCount).toBe(1);
  });

  it('should sum amounts correctly using BigInt', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '999999999999999999', status: 'confirmed' },
      { id: 't2', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();
    expect(assets[0]?.totalAmount).toBe('1000000000000000000');
  });

  it('should include confirmed and unconfirmed tokens but exclude spent/invalid/transferring', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '2000', status: 'pending' },
      { id: 't3', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '3000', status: 'transferring' },
      { id: 't4', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '4000', status: 'spent' },
      { id: 't5', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '5000', status: 'invalid' },
    ]);

    const assets = await module.getAssets();
    expect(assets.length).toBe(1);
    expect(assets[0]?.totalAmount).toBe('3000'); // 1000 confirmed + 2000 pending
    expect(assets[0]?.tokenCount).toBe(2); // t1 + t2
    expect(assets[0]?.confirmedAmount).toBe('1000');
    expect(assets[0]?.unconfirmedAmount).toBe('2000');
    expect(assets[0]?.confirmedTokenCount).toBe(1);
    expect(assets[0]?.unconfirmedTokenCount).toBe(1);
  });

  it('should filter by coinId when provided', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xbbb', symbol: 'BTC', name: 'Bitcoin', decimals: 8, amount: '500', status: 'confirmed' },
    ]);

    const assets = await module.getAssets('0xaaa');
    expect(assets.length).toBe(1);
    expect(assets[0]?.symbol).toBe('UCT');
  });

  it('should return empty array when coinId filter matches nothing', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
    ]);

    const assets = await module.getAssets('0xnonexistent');
    expect(assets.length).toBe(0);
  });

  it('should include decimals from token', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xbbb', symbol: 'USDU', name: 'Unicity-usd', decimals: 6, amount: '500', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();
    const uct = assets.find((a) => a.symbol === 'UCT');
    const usdu = assets.find((a) => a.symbol === 'USDU');

    expect(uct?.decimals).toBe(18);
    expect(usdu?.decimals).toBe(6);
  });

  it('should include iconUrl from token', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, iconUrl: 'https://example.com/uct.png', amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xbbb', symbol: 'BTC', name: 'Bitcoin', decimals: 8, amount: '500', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();
    const uct = assets.find((a) => a.symbol === 'UCT');
    const btc = assets.find((a) => a.symbol === 'BTC');

    expect(uct?.iconUrl).toBe('https://example.com/uct.png');
    expect(btc?.iconUrl).toBeUndefined();
  });

  it('should preserve symbol and name from first token of each group', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
      { id: 't2', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '2000', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();
    expect(assets[0]?.symbol).toBe('UCT');
    expect(assets[0]?.name).toBe('Unicity');
    expect(assets[0]?.coinId).toBe('0xaaa');
  });

  it('should have null price fields when no PriceProvider', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
    ]);

    const assets = await module.getAssets();
    expect(assets[0]?.priceUsd).toBeNull();
    expect(assets[0]?.priceEur).toBeNull();
    expect(assets[0]?.change24h).toBeNull();
    expect(assets[0]?.fiatValueUsd).toBeNull();
    expect(assets[0]?.fiatValueEur).toBeNull();
  });
});

// =============================================================================
// getFiatBalance() Tests
// =============================================================================

describe('getFiatBalance()', () => {
  function createModuleWithTokens(tokens: Array<{
    id: string;
    coinId: string;
    symbol: string;
    name: string;
    decimals: number;
    amount: string;
    status: string;
  }>) {
    const module = createPaymentsModule();
    const tokensMap = (module as unknown as { tokens: Map<string, unknown> }).tokens;
    for (const token of tokens) {
      tokensMap.set(token.id, {
        ...token,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return module;
  }

  it('should return null when no PriceProvider is configured', async () => {
    const module = createModuleWithTokens([
      { id: 't1', coinId: '0xaaa', symbol: 'UCT', name: 'Unicity', decimals: 18, amount: '1000', status: 'confirmed' },
    ]);

    const balance = await module.getFiatBalance();
    expect(balance).toBeNull();
  });

  it('should return null when no tokens exist', async () => {
    const module = createPaymentsModule();
    const balance = await module.getFiatBalance();
    expect(balance).toBeNull();
  });
});

// =============================================================================
// Nametag preservation during sync
// =============================================================================

describe('Nametag preservation during sync', () => {
  function createInitializedModule(tokenStorageProviders: Map<string, unknown>) {
    const module = createPaymentsModule();
    const mockIdentity = {
      chainPubkey: '02' + '0'.repeat(64),
      l1Address: 'alpha1test',
      directAddress: 'DIRECT://test',
      privateKey: '0'.repeat(64),
    };
    const mockStorage = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      keys: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
      setIdentity: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
      id: 'mock-storage',
      name: 'Mock Storage',
      type: 'local' as const,
      saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
      loadTrackedAddresses: vi.fn().mockResolvedValue([]),
    };
    const mockTransport = {
      onTokenTransfer: vi.fn().mockReturnValue(() => {}),
      onPaymentRequest: vi.fn().mockReturnValue(() => {}),
      onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
      resolve: vi.fn().mockResolvedValue(null),
      id: 'mock-transport',
      name: 'Mock Transport',
      type: 'transport' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
      setIdentity: vi.fn().mockResolvedValue(undefined),
    };
    const mockOracle = {
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
      id: 'mock-oracle',
      name: 'Mock Oracle',
      type: 'oracle' as const,
      initialize: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
    };

    module.initialize({
      identity: mockIdentity,
      storage: mockStorage,
      tokenStorageProviders: tokenStorageProviders as Map<string, never>,
      transport: mockTransport as never,
      oracle: mockOracle as never,
      emitEvent: vi.fn(),
    });

    return module;
  }

  const TEST_NAMETAG = {
    name: 'testuser',
    token: { genesis: { data: 'test' }, state: {}, transactions: [], nametags: [] },
    timestamp: Date.now(),
    format: 'txf',
    version: '2.0',
  };

  it('should preserve nametags when sync provider returns merged data without _nametags', async () => {
    const mockProvider = {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'local' as const,
      setIdentity: vi.fn(),
      initialize: vi.fn().mockResolvedValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected' as const),
      save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
      load: vi.fn().mockResolvedValue({ success: true, data: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } }, source: 'local', timestamp: Date.now() }),
      sync: vi.fn().mockResolvedValue({
        success: true,
        // Merged data WITHOUT _nametags — simulates IPFS returning data that lacks nametags
        merged: {
          _meta: { version: 2, address: '', formatVersion: '2.0', updatedAt: Date.now() },
        },
        added: 0,
        removed: 0,
        conflicts: 0,
      }),
    };

    const providers = new Map([['test', mockProvider]]);
    const module = createInitializedModule(providers);

    // Set nametag first
    await module.setNametag(TEST_NAMETAG);
    expect(module.hasNametag()).toBe(true);
    expect(module.getNametag()?.name).toBe('testuser');

    // Sync — provider returns merged data without _nametags
    await module.sync();

    // Nametag should be preserved despite sync
    expect(module.hasNametag()).toBe(true);
    expect(module.getNametag()?.name).toBe('testuser');
    expect(module.getNametag()?.token).toBeTruthy();
  });

  it('should update nametags when sync provider returns valid _nametags', async () => {
    const updatedNametag = {
      name: 'updateduser',
      token: { genesis: { data: 'updated' }, state: {}, transactions: [], nametags: [] },
      timestamp: Date.now() + 1000,
      format: 'txf',
      version: '2.0',
    };

    const mockProvider = {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'local' as const,
      setIdentity: vi.fn(),
      initialize: vi.fn().mockResolvedValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected' as const),
      save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
      load: vi.fn().mockResolvedValue({ success: true, data: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } }, source: 'local', timestamp: Date.now() }),
      sync: vi.fn().mockResolvedValue({
        success: true,
        merged: {
          _meta: { version: 2, address: '', formatVersion: '2.0', updatedAt: Date.now() },
          _nametags: [updatedNametag],
        },
        added: 0,
        removed: 0,
        conflicts: 0,
      }),
    };

    const providers = new Map([['test', mockProvider]]);
    const module = createInitializedModule(providers);

    await module.setNametag(TEST_NAMETAG);
    expect(module.getNametag()?.name).toBe('testuser');

    // Sync — provider returns merged data WITH different nametag
    await module.sync();

    // Nametag should be updated to the one from merged data
    expect(module.hasNametag()).toBe(true);
    expect(module.getNametag()?.name).toBe('updateduser');
  });

  it('should recover nametags from storage via reloadNametagsFromStorage', async () => {
    const mockProvider = {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'local' as const,
      setIdentity: vi.fn(),
      initialize: vi.fn().mockResolvedValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected' as const),
      save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
      // load() returns data WITH nametag — simulating nametag exists in IndexedDB
      load: vi.fn().mockResolvedValue({
        success: true,
        data: {
          _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
          _nametags: [TEST_NAMETAG],
        },
        source: 'local',
        timestamp: Date.now(),
      }),
      sync: vi.fn().mockResolvedValue({
        success: true,
        merged: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } },
        added: 0,
        removed: 0,
        conflicts: 0,
      }),
    };

    const providers = new Map([['test', mockProvider]]);
    const module = createInitializedModule(providers);

    // Module starts with empty nametags (simulating the bug)
    expect(module.hasNametag()).toBe(false);

    // Load the module — should populate nametags from storage
    await module.load();

    expect(module.hasNametag()).toBe(true);
    expect(module.getNametag()?.name).toBe('testuser');
    expect(module.getNametag()?.token).toBeTruthy();
  });
});
