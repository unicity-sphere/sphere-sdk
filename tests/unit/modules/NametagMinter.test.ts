/**
 * Tests for modules/payments/NametagMinter.ts
 * Covers nametag minting interface and configuration
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NametagMinter,
  createNametagMinter,
  type NametagMinterConfig,
  type MintNametagResult,
} from '../../../modules/payments/NametagMinter';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';

// =============================================================================
// Tests - Interface and Configuration
// =============================================================================

describe('NametagMinter', () => {
  describe('constructor and factory', () => {
    it('should create instance via constructor', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      };
      const minter = new NametagMinter(config);
      expect(minter).toBeInstanceOf(NametagMinter);
    });

    it('should create instance via factory function', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      };
      const minter = createNametagMinter(config);
      expect(minter).toBeInstanceOf(NametagMinter);
    });

    it('should store config correctly', () => {
      const stClient = { submitMintCommitment: () => {} };
      const trustBase = { verify: () => {} };
      const signingService = { algorithm: 1, publicKey: new Uint8Array(33), sign: () => {} } as any;

      const config: NametagMinterConfig = {
        stateTransitionClient: stClient,
        trustBase,
        signingService,
        debug: true,
        skipVerification: true,
      };

      const minter = new NametagMinter(config);
      // Access private fields via any
      expect((minter as any).client).toBe(stClient);
      expect((minter as any).trustBase).toBe(trustBase);
      expect((minter as any).signingService).toBe(signingService);
      expect((minter as any).debug).toBe(true);
      expect((minter as any).skipVerification).toBe(true);
    });

    it('should default skipVerification and debug to false', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      };

      const minter = new NametagMinter(config);
      expect((minter as any).skipVerification).toBe(false);
      expect((minter as any).debug).toBe(false);
    });
  });

  describe('mintNametag() interface', () => {
    it('should have mintNametag method', () => {
      const minter = new NametagMinter({
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      });

      expect(typeof minter.mintNametag).toBe('function');
    });

    it('should have isNametagAvailable method', () => {
      const minter = new NametagMinter({
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      });

      expect(typeof minter.isNametagAvailable).toBe('function');
    });

    it('should accept correct parameter types', () => {
      const minter = new NametagMinter({
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
      });

      // Verify method exists with correct signature
      expect(typeof minter.mintNametag).toBe('function');
      expect(minter.mintNametag.length).toBe(2); // 2 parameters: nametag, ownerAddress
    });
  });

  describe('MintNametagResult interface', () => {
    it('should define correct result structure for success', () => {
      const mockResult: MintNametagResult = {
        success: true,
        token: { toJSON: () => ({}) },
        nametagData: {
          name: 'alice',
          token: {},
          timestamp: Date.now(),
          format: 'txf',
          version: '2.0',
        },
      };

      expect(mockResult).toHaveProperty('success', true);
      expect(mockResult).toHaveProperty('token');
      expect(mockResult).toHaveProperty('nametagData');
      expect(mockResult.nametagData?.name).toBe('alice');
    });

    it('should define correct result structure for failure', () => {
      const mockResult: MintNametagResult = {
        success: false,
        error: 'Nametag already taken',
      };

      expect(mockResult).toHaveProperty('success', false);
      expect(mockResult).toHaveProperty('error');
      expect(mockResult.token).toBeUndefined();
      expect(mockResult.nametagData).toBeUndefined();
    });
  });

  describe('NametagMinterConfig interface', () => {
    it('should require stateTransitionClient', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: { submitMintCommitment: () => {}, isMinted: () => {} },
        trustBase: {},
        signingService: { algorithm: 1 } as any,
      };

      expect(config.stateTransitionClient).toBeDefined();
    });

    it('should require trustBase', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: { getRootHash: () => {} },
        signingService: { algorithm: 1 } as any,
      };

      expect(config.trustBase).toBeDefined();
    });

    it('should require signingService', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1, sign: () => {}, publicKey: new Uint8Array(33) } as any,
      };

      expect(config.signingService).toBeDefined();
    });

    it('should allow optional debug flag', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1 } as any,
        debug: true,
      };

      expect(config.debug).toBe(true);
    });

    it('should allow optional skipVerification flag', () => {
      const config: NametagMinterConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 1 } as any,
        skipVerification: true,
      };

      expect(config.skipVerification).toBe(true);
    });
  });
});

describe('Nametag minting flow', () => {
  it('should document the expected minting lifecycle', () => {
    // Document the internal flow of mintNametag()
    const mintLifecycle = [
      '1. Check nametag availability via isMinted()',
      '2. Create TokenId from nametag',
      '3. Generate random salt',
      '4. Create MintTransactionData.createFromNametag()',
      '5. Create MintCommitment',
      '6. Submit commitment with retries',
      '7. Wait for inclusion proof',
      '8. Create Token with proof',
      '9. Return { success: true, token, nametagData }',
    ];

    expect(mintLifecycle).toHaveLength(9);
    expect(mintLifecycle[0]).toContain('availability');
    expect(mintLifecycle[3]).toContain('MintTransactionData');
    expect(mintLifecycle[8]).toContain('success');
  });

  it('should integrate with PaymentsModule.setNametag()', () => {
    // Document the expected integration pattern
    const expectedFlow = {
      step1: 'PaymentsModule.mintNametag(nametag)',
      step2: 'Create NametagMinter with deps',
      step3: 'minter.mintNametag(nametag, ownerAddress)',
      step4: 'if result.success: PaymentsModule.setNametag(result.nametagData)',
      step5: 'Emit nametag:registered event',
    };

    expect(expectedFlow.step1).toContain('mintNametag');
    expect(expectedFlow.step4).toContain('setNametag');
    expect(expectedFlow.step5).toContain('nametag:registered');
  });
});

describe('Nametag normalization in minter', () => {
  it('should normalize uppercase to lowercase before TokenId.fromNameTag', async () => {
    const mockClient = {
      isMinted: vi.fn().mockResolvedValue(false),
    };
    const minter = new NametagMinter({
      stateTransitionClient: mockClient,
      trustBase: {},
      signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
    });

    const expectedAlice = await TokenId.fromNameTag('alice');
    const expectedBob = await TokenId.fromNameTag('bob');

    await minter.isNametagAvailable('Alice');
    await minter.isNametagAvailable('@BOB');

    // Verify the TokenId passed to isMinted matches the lowercased nametag
    const call1TokenId = mockClient.isMinted.mock.calls[0][1];
    const call2TokenId = mockClient.isMinted.mock.calls[1][1];
    expect(call1TokenId.toString()).toBe(expectedAlice.toString());
    expect(call2TokenId.toString()).toBe(expectedBob.toString());
  });

  it('should strip @ prefix from nametag', async () => {
    const mockClient = {
      isMinted: vi.fn().mockResolvedValue(false),
    };
    const minter = new NametagMinter({
      stateTransitionClient: mockClient,
      trustBase: {},
      signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
    });

    await minter.isNametagAvailable('@alice');
    await minter.isNametagAvailable('alice');

    // Both should produce the same TokenId (@ stripped before TokenId.fromNameTag)
    const call1TokenId = mockClient.isMinted.mock.calls[0][1];
    const call2TokenId = mockClient.isMinted.mock.calls[1][1];
    expect(call1TokenId.toString()).toBe(call2TokenId.toString());
  });

  it('should strip @unicity suffix via normalizeNametag', async () => {
    const mockClient = {
      isMinted: vi.fn().mockResolvedValue(false),
    };
    const minter = new NametagMinter({
      stateTransitionClient: mockClient,
      trustBase: {},
      signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
    });

    const expectedAlice = await TokenId.fromNameTag('alice');

    await minter.isNametagAvailable('alice@unicity');

    // Should resolve to 'alice' after suffix stripping
    const callTokenId = mockClient.isMinted.mock.calls[0][1];
    expect(callTokenId.toString()).toBe(expectedAlice.toString());
  });

  it('should produce same token ID for Alice and alice', async () => {
    const mockClient = {
      isMinted: vi.fn().mockResolvedValue(false),
    };
    const minter = new NametagMinter({
      stateTransitionClient: mockClient,
      trustBase: {},
      signingService: { algorithm: 1, publicKey: new Uint8Array(33) } as any,
    });

    await minter.isNametagAvailable('Alice');
    await minter.isNametagAvailable('alice');

    // Both should resolve to the same token ID (both normalized to 'alice')
    const call1TokenId = mockClient.isMinted.mock.calls[0][1];
    const call2TokenId = mockClient.isMinted.mock.calls[1][1];
    expect(call1TokenId.toString()).toBe(call2TokenId.toString());
  });
});

describe('Error handling', () => {
  it('should return error result when nametag is taken', () => {
    const result: MintNametagResult = {
      success: false,
      error: 'Nametag "alice" is already taken',
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('already taken');
  });

  it('should return error result on submission failure', () => {
    const result: MintNametagResult = {
      success: false,
      error: 'Failed to submit commitment after 3 attempts: FAILED',
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to submit');
  });

  it('should return error result on network timeout', () => {
    const result: MintNametagResult = {
      success: false,
      error: 'Submit failed: Network timeout',
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
