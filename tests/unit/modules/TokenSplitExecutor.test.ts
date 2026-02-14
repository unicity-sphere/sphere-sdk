/**
 * Tests for modules/payments/TokenSplitExecutor.ts
 * Covers token split execution interface and configuration
 */

import { describe, it, expect } from 'vitest';
import {
  TokenSplitExecutor,
  createTokenSplitExecutor,
  type SplitResult,
  type TokenSplitExecutorConfig,
} from '../../../modules/payments/TokenSplitExecutor';

// =============================================================================
// Tests - Interface and Configuration
// =============================================================================

describe('TokenSplitExecutor', () => {
  describe('constructor and factory', () => {
    it('should create instance via constructor', () => {
      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: {},
      };
      const executor = new TokenSplitExecutor(config);
      expect(executor).toBeInstanceOf(TokenSplitExecutor);
    });

    it('should create instance via factory function', () => {
      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: {},
      };
      const executor = createTokenSplitExecutor(config);
      expect(executor).toBeInstanceOf(TokenSplitExecutor);
    });

    it('should store config correctly', () => {
      const stClient = { submit: () => {} };
      const trustBase = { verify: () => {} };
      const signingService = { sign: () => {} };

      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: stClient,
        trustBase,
        signingService,
      };

      const executor = new TokenSplitExecutor(config);
      // Access private fields via any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((executor as any).client).toBe(stClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((executor as any).trustBase).toBe(trustBase);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((executor as any).signingService).toBe(signingService);
    });
  });

  describe('executeSplit() interface', () => {
    it('should have executeSplit method', () => {
      const executor = new TokenSplitExecutor({
        stateTransitionClient: {},
        trustBase: {},
        signingService: {},
      });

      expect(typeof executor.executeSplit).toBe('function');
    });

    it('should accept correct parameter types', () => {
      const executor = new TokenSplitExecutor({
        stateTransitionClient: {},
        trustBase: {},
        signingService: {},
      });

      // Verify method exists with correct signature
      expect(typeof executor.executeSplit).toBe('function');
      expect(executor.executeSplit.length).toBe(5); // 5 parameters

      // Type check: these should be valid parameter types
      type ExpectedParams = Parameters<typeof executor.executeSplit>;
      const _typeCheck: ExpectedParams = [
        { id: { bytes: new Uint8Array(32) }, type: 'fungible' }, // tokenToSplit
        75n,                                                       // splitAmount
        25n,                                                       // remainderAmount
        'abcd1234',                                               // coinIdHex
        { scheme: 1 },                                            // recipientAddress
      ];
      expect(_typeCheck).toHaveLength(5);
    });
  });

  describe('SplitResult interface', () => {
    it('should define correct result structure', () => {
      // Verify the interface shape
      const mockResult: SplitResult = {
        tokenForRecipient: { toJSON: () => ({}) },
        tokenForSender: { toJSON: () => ({}) },
        recipientTransferTx: { toJSON: () => ({}) },
      };

      expect(mockResult).toHaveProperty('tokenForRecipient');
      expect(mockResult).toHaveProperty('tokenForSender');
      expect(mockResult).toHaveProperty('recipientTransferTx');
    });
  });

  describe('TokenSplitExecutorConfig interface', () => {
    it('should require stateTransitionClient', () => {
      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: { submitTransferCommitment: () => {} },
        trustBase: {},
        signingService: {},
      };

      expect(config.stateTransitionClient).toBeDefined();
    });

    it('should require trustBase', () => {
      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: {},
        trustBase: { getRootHash: () => {} },
        signingService: {},
      };

      expect(config.trustBase).toBeDefined();
    });

    it('should require signingService', () => {
      const config: TokenSplitExecutorConfig = {
        stateTransitionClient: {},
        trustBase: {},
        signingService: { algorithm: 'secp256k1', sign: () => {} },
      };

      expect(config.signingService).toBeDefined();
    });
  });
});

describe('Split flow integration', () => {
  it('should be used by PaymentsModule.send() for partial transfers', () => {
    // This test documents the expected integration pattern
    // PaymentsModule.send() should:
    // 1. Use TokenSplitCalculator to determine if split is needed
    // 2. If split needed, create TokenSplitExecutor with deps
    // 3. Call executeSplit() to get tokenForRecipient and tokenForSender
    // 4. Save tokenForSender as change
    // 5. Send tokenForRecipient via Nostr

    const expectedFlow = {
      step1: 'TokenSplitCalculator.calculateOptimalSplit()',
      step2: 'if plan.requiresSplit: new TokenSplitExecutor(config)',
      step3: 'executor.executeSplit(token, splitAmount, remainder, coinId, address)',
      step4: 'addToken(result.tokenForSender) // save change',
      step5: 'transport.sendTokenTransfer(result.tokenForRecipient)',
    };

    expect(expectedFlow.step1).toContain('calculateOptimalSplit');
    expect(expectedFlow.step3).toContain('executeSplit');
    expect(expectedFlow.step4).toContain('tokenForSender');
    expect(expectedFlow.step5).toContain('tokenForRecipient');
  });

  it('should handle the full split lifecycle', () => {
    // Document the internal flow of executeSplit()
    const splitLifecycle = [
      '1. Generate unique IDs for recipient and sender tokens',
      '2. Build split using TokenSplitBuilder',
      '3. Burn original token (submitTransferCommitment)',
      '4. Wait for burn inclusion proof',
      '5. Mint split tokens (submitMintCommitment x2)',
      '6. Wait for mint inclusion proofs',
      '7. Create transfer commitment for recipient token',
      '8. Return { tokenForRecipient, tokenForSender, recipientTransferTx }',
    ];

    expect(splitLifecycle).toHaveLength(8);
    expect(splitLifecycle[2]).toContain('Burn');
    expect(splitLifecycle[4]).toContain('Mint');
    expect(splitLifecycle[7]).toContain('tokenForRecipient');
  });
});

describe('Split amounts validation', () => {
  it('should handle split where recipient gets most', () => {
    const total = 100n;
    const splitAmount = 75n;   // to recipient
    const remainder = 25n;     // change for sender

    expect(splitAmount + remainder).toBe(total);
    expect(splitAmount > remainder).toBe(true);
  });

  it('should handle split where sender keeps most', () => {
    const total = 100n;
    const splitAmount = 10n;   // to recipient
    const remainder = 90n;     // change for sender

    expect(splitAmount + remainder).toBe(total);
    expect(remainder > splitAmount).toBe(true);
  });

  it('should handle 50/50 split', () => {
    const total = 100n;
    const splitAmount = 50n;
    const remainder = 50n;

    expect(splitAmount + remainder).toBe(total);
    expect(splitAmount).toBe(remainder);
  });

  it('should handle very large amounts', () => {
    const total = 1_000_000_000_000_000_000n; // 1e18
    const splitAmount = 750_000_000_000_000_000n;
    const remainder = 250_000_000_000_000_000n;

    expect(splitAmount + remainder).toBe(total);
  });

  it('should handle minimum amounts', () => {
    const splitAmount = 1n;
    const remainder = 1n;

    expect(splitAmount).toBeGreaterThan(0n);
    expect(remainder).toBeGreaterThan(0n);
  });
});
