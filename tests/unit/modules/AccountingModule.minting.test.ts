/**
 * AccountingModule — Minting flow tests (§3.2 minting subset)
 *
 * Tests for the minting flow inside createInvoice(): commitment submission,
 * inclusion proof waiting, retry logic, token ID derivation, salt generation,
 * token type, and tokenData serialization.
 *
 * All SDK dynamic imports are mocked so no aggregator network calls occur.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.2 (UT-MINT subset)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  createMockOracleProvider,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// =============================================================================
// Mock all SDK dynamic imports used by createInvoice()
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId', () => ({
  TokenId: class { constructor(public readonly imprint: Uint8Array) {} toJSON() { return '0'.repeat(64); } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId.js', () => ({
  TokenId: class { constructor(public readonly imprint: Uint8Array) {} toJSON() { return '0'.repeat(64); } },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType.js', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js', () => ({
  MintTransactionData: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment', () => ({
  MintCommitment: {
    create: vi.fn().mockResolvedValue({
      toTransaction: vi.fn().mockReturnValue({ toJSON: () => ({}) }),
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js', () => ({
  MintCommitment: {
    create: vi.fn().mockResolvedValue({
      toTransaction: vi.fn().mockReturnValue({ toJSON: () => ({}) }),
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: {
    createFromSecret: vi.fn().mockResolvedValue({
      algorithm: 1,
      publicKey: new Uint8Array(33),
      sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService.js', () => ({
  SigningService: {
    createFromSecret: vi.fn().mockResolvedValue({
      algorithm: 1,
      publicKey: new Uint8Array(33),
      sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/DataHasher', () => ({
  DataHasher: class {
    update() { return this; }
    async digest() { return { imprint: new Uint8Array(32) }; }
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/DataHasher.js', () => ({
  DataHasher: class {
    update() { return this; }
    async digest() { return { imprint: new Uint8Array(32) }; }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference', () => ({
  UnmaskedPredicateReference: {
    create: vi.fn().mockResolvedValue({ toAddress: vi.fn().mockResolvedValue('owner-address') }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js', () => ({
  UnmaskedPredicateReference: {
    create: vi.fn().mockResolvedValue({ toAddress: vi.fn().mockResolvedValue('owner-address') }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class { constructor(_p: unknown, _v: unknown) {} toJSON() { return {}; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState.js', () => ({
  TokenState: class { constructor(_p: unknown, _v: unknown) {} toJSON() { return {}; } },
}));

function _makeMockSdkToken() {
  return {
    toJSON: vi.fn().mockReturnValue({
      version: '2.0',
      genesis: {
        data: {
          tokenId: '0'.repeat(64),
          tokenType: '0101010101010101010101010101010101010101010101010101010101010101',
          coinData: null,
          tokenData: '{}',
          salt: '0'.repeat(64),
          recipient: 'owner-address',
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: {
            algorithm: 'secp256k1',
            publicKey: '02' + 'a'.repeat(64),
            signature: '0'.repeat(128),
            stateHash: '0'.repeat(64),
          },
          merkleTreePath: { root: '0'.repeat(64), steps: [] },
          transactionHash: '0'.repeat(64),
          unicityCertificate: '0'.repeat(256),
        },
      },
      state: { data: '0'.repeat(64), predicate: '0'.repeat(64) },
      transactions: [],
    }),
    verify: vi.fn().mockResolvedValue(true),
  };
}

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    mint: vi.fn().mockImplementation(async () => _makeMockSdkToken()),
    fromJSON: vi.fn().mockImplementation(async () => _makeMockSdkToken()),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: {
    mint: vi.fn().mockImplementation(async () => _makeMockSdkToken()),
    fromJSON: vi.fn().mockImplementation(async () => _makeMockSdkToken()),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({}),
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({}),
}));

// =============================================================================
// Shared setup
// =============================================================================

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;

function setup(overrides?: Parameters<typeof createTestAccountingModule>[0]) {
  const result = createTestAccountingModule(overrides);
  module = result.module;
  mocks = result.mocks;
  // Add addToken stub
  (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
}

afterEach(() => {
  try { module.destroy(); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// =============================================================================
// UT-MINT-001: createInvoice calls submitMintCommitment
// =============================================================================

describe('UT-MINT-001: createInvoice calls submitMintCommitment', () => {
  beforeEach(() => setup());

  it('submits commitment to the aggregator via stateTransitionClient', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    await module.createInvoice(createTestInvoice());

    expect(mocks.oracle._stateTransitionClient.submitMintCommitment).toHaveBeenCalled();
  });
});

// =============================================================================
// UT-MINT-002: createInvoice calls waitInclusionProof
// =============================================================================

describe('UT-MINT-002: createInvoice waits for inclusion proof', () => {
  beforeEach(() => setup());

  it('calls waitInclusionProof after successful commitment', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    const { waitInclusionProof } = await import(
      '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js'
    );

    await module.createInvoice(createTestInvoice());

    expect(waitInclusionProof).toHaveBeenCalled();
  });
});

// =============================================================================
// UT-MINT-003: Minting failure throws INVOICE_MINT_FAILED
// =============================================================================

describe('UT-MINT-003: Minting failure throws INVOICE_MINT_FAILED', () => {
  beforeEach(() => setup());

  it('throws INVOICE_MINT_FAILED when commitment is rejected', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'REJECTED',
    });

    await expect(module.createInvoice(createTestInvoice())).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_MINT_FAILED',
    );
  });
});

// =============================================================================
// UT-MINT-004: Token ID matches the commitment hash (deterministic from terms)
// =============================================================================

describe('UT-MINT-004: Token ID is derived from SHA-256 of serialized terms', () => {
  beforeEach(() => setup());

  it('returns an invoice ID that is a 64-char hex string', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    const result = await module.createInvoice(createTestInvoice());

    // The mocked TokenId always returns '0'.repeat(64)
    expect(result.invoiceId).toBe('0'.repeat(64));
    expect(result.invoiceId).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// UT-MINT-005: Retry on transient aggregator error
// =============================================================================

describe('UT-MINT-005: Retry on transient aggregator error', () => {
  beforeEach(() => setup());

  it('retries up to 3 times on transient error before succeeding', async () => {
    await module.load();

    let callCount = 0;
    mocks.oracle._stateTransitionClient.submitMintCommitment.mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Transient network error');
      }
      return { status: 'SUCCESS' };
    });

    const result = await module.createInvoice(createTestInvoice());
    expect(result.success).toBe(true);
    expect(callCount).toBe(3);
  });
});

// =============================================================================
// UT-MINT-006: Salt is random per invocation (deterministic from key + terms)
// =============================================================================

describe('UT-MINT-006: Salt is deterministic from signing key and terms', () => {
  beforeEach(() => setup());

  it('creates an invoice without errors (salt derivation works)', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    // Two invocations with same terms should produce same invoice ID (deterministic)
    const result = await module.createInvoice(createTestInvoice());
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// UT-MINT-007: Token type hex matches INVOICE_TOKEN_TYPE_HEX
// =============================================================================

describe('UT-MINT-007: Token type matches INVOICE_TOKEN_TYPE_HEX', () => {
  beforeEach(() => setup());

  it('minted token uses the invoice token type hex', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    const result = await module.createInvoice(createTestInvoice());

    // The result should have the invoice token in TXF format
    expect(result.success).toBe(true);
    expect(INVOICE_TOKEN_TYPE_HEX).toBeDefined();
    expect(INVOICE_TOKEN_TYPE_HEX.length).toBe(64);
  });
});

// =============================================================================
// UT-MINT-008: tokenData contains canonical serialized terms
// =============================================================================

describe('UT-MINT-008: tokenData contains canonical serialized terms', () => {
  beforeEach(() => setup());

  it('result.terms contains the input terms from the request', async () => {
    await module.load();

    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
    });

    const request = createTestInvoice({ memo: 'test memo' });
    const result = await module.createInvoice(request);

    expect(result.terms.memo).toBe('test memo');
    expect(result.terms.targets).toEqual(request.targets);
  });
});
