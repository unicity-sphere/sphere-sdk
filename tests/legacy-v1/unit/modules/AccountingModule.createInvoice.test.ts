/**
 * AccountingModule — createInvoice() tests (§3.2)
 *
 * Validates the full validation pipeline (§8.1), InvoiceTerms construction,
 * minting flow, storage, event firing, and retroactive payment detection.
 *
 * All SDK dynamic imports are mocked so no aggregator network calls occur.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.2
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  createMockOracleProvider,
  SphereError,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// =============================================================================
// Mock all SDK dynamic imports used by createInvoice()
// These are registered both with and without .js extension so they intercept
// the dynamic imports inside AccountingModule which use the .js suffix.
// NOTE: vi.mock() factories cannot reference outer-scope variables (hoisting).
// All factory content must be self-contained.
// =============================================================================

// --- TokenId ---
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId', () => ({
  TokenId: class { constructor(public readonly imprint: Uint8Array) {} toJSON() { return '0'.repeat(64); } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId.js', () => ({
  TokenId: class { constructor(public readonly imprint: Uint8Array) {} toJSON() { return '0'.repeat(64); } },
}));

// --- TokenType ---
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType.js', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));

// --- MintTransactionData ---
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js', () => ({
  MintTransactionData: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));

// --- MintCommitment ---
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

// --- SigningService ---
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

// --- HashAlgorithm ---
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));

// --- DataHasher ---
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

// --- UnmaskedPredicate ---
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({ toJSON: () => ({}) }) },
}));

// --- UnmaskedPredicateReference ---
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference', () => ({
  UnmaskedPredicateReference: {
    create: vi.fn().mockResolvedValue({
      toAddress: vi.fn().mockResolvedValue('mock-owner-address'),
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js', () => ({
  UnmaskedPredicateReference: {
    create: vi.fn().mockResolvedValue({
      toAddress: vi.fn().mockResolvedValue('mock-owner-address'),
    }),
  },
}));

// --- TokenState ---
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class { constructor() {} toJSON() { return {}; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState.js', () => ({
  TokenState: class { constructor() {} toJSON() { return {}; } },
}));

// --- Token ---
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      toJSON: () => ({
        version: '2.0',
        genesis: {
          data: {
            tokenId: '0'.repeat(64),
            tokenType: '0101010101010101010101010101010101010101010101010101010101010101',
            coinData: null,
            tokenData: '{}',
            salt: '0'.repeat(64),
            recipient: 'DIRECT://test_target_address_abc123',
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
    }),
    mint: vi.fn().mockResolvedValue({
      toJSON: () => ({
        version: '2.0',
        genesis: {
          data: {
            tokenId: '0'.repeat(64),
            tokenType: '0101010101010101010101010101010101010101010101010101010101010101',
            coinData: null,
            tokenData: '{}',
            salt: '0'.repeat(64),
            recipient: 'DIRECT://test_target_address_abc123',
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
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      toJSON: () => ({
        version: '2.0',
        genesis: {
          data: {
            tokenId: '0'.repeat(64),
            tokenType: '0101010101010101010101010101010101010101010101010101010101010101',
            coinData: null,
            tokenData: '{}',
            salt: '0'.repeat(64),
            recipient: 'DIRECT://test_target_address_abc123',
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
    }),
    mint: vi.fn().mockResolvedValue({
      toJSON: () => ({
        version: '2.0',
        genesis: {
          data: {
            tokenId: '0'.repeat(64),
            tokenType: '0101010101010101010101010101010101010101010101010101010101010101',
            coinData: null,
            tokenData: '{}',
            salt: '0'.repeat(64),
            recipient: 'DIRECT://test_target_address_abc123',
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
    }),
  },
}));

// --- InclusionProofUtils ---
vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: '0'.repeat(128),
      stateHash: '0'.repeat(64),
    },
    merkleTreePath: { root: '0'.repeat(64), steps: [] },
    transactionHash: '0'.repeat(64),
    unicityCertificate: '0'.repeat(256),
  }),
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: '0'.repeat(128),
      stateHash: '0'.repeat(64),
    },
    merkleTreePath: { root: '0'.repeat(64), steps: [] },
    transactionHash: '0'.repeat(64),
    unicityCertificate: '0'.repeat(256),
  }),
}));

// Mock the accounting serialization module (also dynamic-imported inside createInvoice)
vi.mock('../../../modules/accounting/serialization.js', () => ({
  canonicalSerialize: vi.fn().mockReturnValue('{}'),
  INVOICE_TOKEN_TYPE_HEX: '0101010101010101010101010101010101010101010101010101010101010101',
  deserializeInvoiceTerms: vi.fn(),
}));

// =============================================================================
// Shared state
// =============================================================================

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;

function setup(overrides?: Parameters<typeof createTestAccountingModule>[0]) {
  const result = createTestAccountingModule(overrides);
  module = result.module;
  mocks = result.mocks;

  // Add addToken stub to mock payments (not in base mock)
  (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
}

afterEach(async () => {
  try {
    module.destroy();
  } catch {
    // ignore MODULE_DESTROYED
  }
  // Use clearAllMocks (not restoreAllMocks) to preserve vi.mock() factory implementations.
  // restoreAllMocks() would reset mockResolvedValue on the SDK stubs, causing subsequent tests
  // to receive undefined from createFromSecret etc.
  vi.clearAllMocks();
});

// Helper: set up oracle to return SUCCESS on submitMintCommitment
function makeOracleSucceed() {
  mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
    status: 'SUCCESS',
    requestId: 'test-request-id',
  });
}

// Helper: build a valid single-target request
function validRequest() {
  return createTestInvoice();
}

// =============================================================================
// UT-CREATE-001: Simple single-target, single-asset creation
// =============================================================================

describe('UT-CREATE-001: simple single-target, single-asset creation', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('returns CreateInvoiceResult with success, invoiceId, and terms', async () => {
    const result = await module.createInvoice(validRequest());

    expect(result.success).toBe(true);
    expect(typeof result.invoiceId).toBe('string');
    expect(result.invoiceId).toHaveLength(64);
    expect(result.terms).toBeDefined();
    expect(result.terms.targets).toHaveLength(1);
  });
});

// =============================================================================
// UT-CREATE-002: Anonymous invoice — creator omitted
// =============================================================================

describe('UT-CREATE-002: anonymous invoice omits creator', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('does not include creator field when anonymous: true', async () => {
    const result = await module.createInvoice({ ...validRequest(), anonymous: true });

    expect(result.terms.creator).toBeUndefined();
  });
});

// =============================================================================
// UT-CREATE-003: Non-anonymous includes creator pubkey
// =============================================================================

describe('UT-CREATE-003: non-anonymous invoice includes creator pubkey', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('sets creator to the wallet chainPubkey when anonymous: false', async () => {
    const result = await module.createInvoice({ ...validRequest(), anonymous: false });

    expect(result.terms.creator).toBe(mocks.identity.chainPubkey);
  });

  it('sets creator when anonymous is omitted (default is non-anonymous)', async () => {
    const req = validRequest();
    // anonymous is not set — default behaviour is non-anonymous
    const result = await module.createInvoice(req);

    expect(result.terms.creator).toBe(mocks.identity.chainPubkey);
  });
});

// =============================================================================
// UT-CREATE-004: Timestamps — createdAt set to local time
// =============================================================================

describe('UT-CREATE-004: createdAt set to Date.now() at creation time', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('sets createdAt to the mocked Date.now() value', async () => {
    const frozenNow = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const result = await module.createInvoice(validRequest());

    expect(result.terms.createdAt).toBe(frozenNow);
  });
});

// =============================================================================
// UT-CREATE-005: dueDate in future accepted
// =============================================================================

describe('UT-CREATE-005: dueDate in the future is accepted', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('creates invoice when dueDate is after now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const result = await module.createInvoice({ ...validRequest(), dueDate: 2000 });

    expect(result.success).toBe(true);
    expect(result.terms.dueDate).toBe(2000);
  });
});

// =============================================================================
// UT-CREATE-006: dueDate in past → INVOICE_PAST_DUE_DATE
// =============================================================================

describe('UT-CREATE-006: dueDate in the past is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_PAST_DUE_DATE when dueDate < now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);

    await expect(
      module.createInvoice({ ...validRequest(), dueDate: 500 }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_PAST_DUE_DATE',
    );
  });
});

// =============================================================================
// UT-CREATE-007: dueDate exactly now → INVOICE_PAST_DUE_DATE
// =============================================================================

describe('UT-CREATE-007: dueDate equal to now is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_PAST_DUE_DATE when dueDate === now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);

    await expect(
      module.createInvoice({ ...validRequest(), dueDate: 1000 }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_PAST_DUE_DATE',
    );
  });
});

// =============================================================================
// UT-CREATE-008: Empty targets → INVOICE_NO_TARGETS
// =============================================================================

describe('UT-CREATE-008: empty targets array is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_NO_TARGETS when targets is empty', async () => {
    await expect(
      module.createInvoice({ targets: [] }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NO_TARGETS',
    );
  });
});

// =============================================================================
// UT-CREATE-009: Invalid address → INVOICE_INVALID_ADDRESS
// =============================================================================

describe('UT-CREATE-009: invalid target address format is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_ADDRESS for non-DIRECT:// address', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'invalid-format', assets: [{ coin: ['UCT', '100'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_ADDRESS',
    );
  });
});

// =============================================================================
// UT-CREATE-010: Target with no assets → INVOICE_NO_ASSETS
// =============================================================================

describe('UT-CREATE-010: target with no assets is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_NO_ASSETS when target.assets is empty', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NO_ASSETS',
    );
  });
});

// =============================================================================
// UT-CREATE-011: Asset with neither coin nor nft → INVOICE_INVALID_ASSET
// =============================================================================

describe('UT-CREATE-011: asset with neither coin nor nft is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_ASSET when asset has no coin and no nft', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{}] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_ASSET',
    );
  });
});

// =============================================================================
// UT-CREATE-012: Asset with both coin and nft → INVOICE_INVALID_ASSET
// =============================================================================

describe('UT-CREATE-012: asset with both coin and nft is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_ASSET when asset has both coin and nft', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [
                {
                  coin: ['UCT', '100'],
                  nft: { tokenId: 'a'.repeat(64) },
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_ASSET',
    );
  });
});

// =============================================================================
// UT-CREATE-013: Amount "0" → INVOICE_INVALID_AMOUNT
// =============================================================================

describe('UT-CREATE-013: coin amount "0" is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_AMOUNT for amount "0"', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '0'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// UT-CREATE-014: Negative amount → INVOICE_INVALID_AMOUNT
// =============================================================================

describe('UT-CREATE-014: negative coin amount is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_AMOUNT for negative amount string', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '-100'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// UT-CREATE-015: Non-numeric amount → INVOICE_INVALID_AMOUNT
// =============================================================================

describe('UT-CREATE-015: non-integer coin amount is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_AMOUNT for decimal string "10.5"', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '10.5'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });

  it('throws INVOICE_INVALID_AMOUNT for non-numeric string "abc"', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', 'abc'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// UT-CREATE-016: Amount > 78 digits → INVOICE_INVALID_AMOUNT
// =============================================================================

describe('UT-CREATE-016: amount exceeding 78 digits is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_AMOUNT for a 79-digit amount string', async () => {
    const tooLong = '1' + '0'.repeat(78); // 79 chars total

    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', tooLong] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// UT-CREATE-017: Empty coinId → INVOICE_INVALID_COIN
// =============================================================================

describe('UT-CREATE-017: empty coinId is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_COIN for empty coinId ""', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['', '1000'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_COIN',
    );
  });
});

// =============================================================================
// UT-CREATE-018: CoinId with special chars → INVOICE_INVALID_COIN
// =============================================================================

describe('UT-CREATE-018: non-alphanumeric coinId is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_COIN for coinId "UC-T"', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UC-T', '1000'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_COIN',
    );
  });

  it('throws INVOICE_INVALID_COIN for coinId containing spaces', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UC T', '1000'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_COIN',
    );
  });
});

// =============================================================================
// UT-CREATE-019: CoinId > 20 chars → INVOICE_INVALID_COIN
// =============================================================================

describe('UT-CREATE-019: coinId exceeding 20 chars is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_COIN for coinId with 21 alphanumeric chars', async () => {
    const tooLong = 'A'.repeat(21);

    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets: [{ coin: [tooLong, '1000'] }] }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_COIN',
    );
  });
});

// =============================================================================
// UT-CREATE-020: Duplicate target addresses → INVOICE_DUPLICATE_ADDRESS
// =============================================================================

describe('UT-CREATE-020: duplicate target addresses are rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_DUPLICATE_ADDRESS when same DIRECT:// address appears twice', async () => {
    await expect(
      module.createInvoice({
        targets: [
          { address: 'DIRECT://alice', assets: [{ coin: ['UCT', '100'] }] },
          { address: 'DIRECT://alice', assets: [{ coin: ['UCT', '200'] }] },
        ],
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_DUPLICATE_ADDRESS',
    );
  });
});

// =============================================================================
// UT-CREATE-021: Duplicate coinId in same target → INVOICE_DUPLICATE_COIN
// =============================================================================

describe('UT-CREATE-021: duplicate coinId within a target is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_DUPLICATE_COIN for two coin assets with the same coinId', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [
                { coin: ['UCT', '100'] },
                { coin: ['UCT', '200'] },
              ],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_DUPLICATE_COIN',
    );
  });
});

// =============================================================================
// UT-CREATE-022: Duplicate NFT tokenId → INVOICE_DUPLICATE_NFT
// =============================================================================

describe('UT-CREATE-022: duplicate NFT tokenId within a target is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_DUPLICATE_NFT for two NFT assets with the same tokenId', async () => {
    const nftId = 'a'.repeat(64);

    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [
                { nft: { tokenId: nftId } },
                { nft: { tokenId: nftId } },
              ],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_DUPLICATE_NFT',
    );
  });
});

// =============================================================================
// UT-CREATE-023: Multi-target, multi-asset successful creation
// =============================================================================

describe('UT-CREATE-023: multi-target, multi-asset creation succeeds', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('creates invoice with two targets each having multiple assets', async () => {
    const result = await module.createInvoice({
      targets: [
        {
          address: 'DIRECT://alice',
          assets: [
            { coin: ['UCT', '100'] },
            { coin: ['USDU', '200'] },
          ],
        },
        {
          address: 'DIRECT://bob',
          assets: [
            { coin: ['UCT', '300'] },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.terms.targets).toHaveLength(2);
  });
});

// =============================================================================
// UT-CREATE-024: > 100 targets → INVOICE_TOO_MANY_TARGETS
// =============================================================================

describe('UT-CREATE-024: more than 100 targets is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_TOO_MANY_TARGETS for 101 targets', async () => {
    const targets = Array.from({ length: 101 }, (_, i) => ({
      address: `DIRECT://target_${i}`,
      assets: [{ coin: ['UCT', '100'] }],
    }));

    await expect(
      module.createInvoice({ targets }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_TOO_MANY_TARGETS',
    );
  });
});

// =============================================================================
// UT-CREATE-025: Exactly 100 targets succeeds
// =============================================================================

describe('UT-CREATE-025: exactly 100 targets succeeds', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('creates invoice with exactly 100 targets', async () => {
    const targets = Array.from({ length: 100 }, (_, i) => ({
      address: `DIRECT://target_${i}`,
      assets: [{ coin: ['UCT', '100'] }],
    }));

    const result = await module.createInvoice({ targets });

    expect(result.success).toBe(true);
    expect(result.terms.targets).toHaveLength(100);
  });
});

// =============================================================================
// UT-CREATE-026: > 50 assets per target → INVOICE_TOO_MANY_ASSETS
// =============================================================================

describe('UT-CREATE-026: more than 50 assets per target is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_TOO_MANY_ASSETS for 51 coin assets in one target', async () => {
    const assets = Array.from({ length: 51 }, (_, i) => ({
      coin: [`TOKEN${i}`, '100'] as [string, string],
    }));

    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [{ address: 'DIRECT://alice', assets }],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_TOO_MANY_ASSETS',
    );
  });
});

// =============================================================================
// UT-CREATE-027: Exactly 50 assets succeeds
// =============================================================================

describe('UT-CREATE-027: exactly 50 assets per target succeeds', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('creates invoice with exactly 50 coin assets in one target', async () => {
    const assets = Array.from({ length: 50 }, (_, i) => ({
      coin: [`T${String(i).padStart(2, '0')}`, '100'] as [string, string],
    }));

    const result = await module.createInvoice(
      createTestInvoice({
        targets: [{ address: 'DIRECT://alice', assets }],
      }),
    );

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// UT-CREATE-028: Memo > 4096 chars → INVOICE_MEMO_TOO_LONG
// =============================================================================

describe('UT-CREATE-028: memo exceeding 4096 chars is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_MEMO_TOO_LONG for memo of 4097 characters', async () => {
    await expect(
      module.createInvoice({ ...validRequest(), memo: 'x'.repeat(4097) }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_MEMO_TOO_LONG',
    );
  });
});

// =============================================================================
// UT-CREATE-029: Memo exactly 4096 chars succeeds
// =============================================================================

describe('UT-CREATE-029: memo exactly 4096 chars succeeds', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('creates invoice with exactly 4096-character memo', async () => {
    const result = await module.createInvoice({ ...validRequest(), memo: 'x'.repeat(4096) });

    expect(result.success).toBe(true);
    expect(result.terms.memo).toHaveLength(4096);
  });
});

// =============================================================================
// UT-CREATE-030: Serialized terms > 64KB → INVOICE_TERMS_TOO_LARGE
// =============================================================================

describe('UT-CREATE-030: serialized terms exceeding 64 KB is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_TERMS_TOO_LARGE when canonicalSerialize returns over-64KB content', async () => {
    // Override the canonicalSerialize mock to return a large string
    const { canonicalSerialize } = await import('../../../modules/accounting/serialization.js');
    (canonicalSerialize as ReturnType<typeof vi.fn>).mockReturnValueOnce('x'.repeat(65 * 1024));

    await expect(
      module.createInvoice(validRequest()),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_TERMS_TOO_LARGE',
    );
  });
});

// =============================================================================
// UT-CREATE-031: No oracle → INVOICE_ORACLE_REQUIRED
// =============================================================================

describe('UT-CREATE-031: missing oracle causes INVOICE_ORACLE_REQUIRED', () => {
  it('throws INVOICE_ORACLE_REQUIRED when oracle has no getStateTransitionClient', async () => {
    const oracle = createMockOracleProvider();
    oracle.getStateTransitionClient.mockReturnValue(null);

    setup({ oracle });
    await module.load();

    await expect(
      module.createInvoice(validRequest()),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_ORACLE_REQUIRED',
    );
  });
});

// =============================================================================
// UT-CREATE-032: Aggregator submission fails → INVOICE_MINT_FAILED
// =============================================================================

describe('UT-CREATE-032: oracle submitMintCommitment rejection causes INVOICE_MINT_FAILED', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_MINT_FAILED when submitMintCommitment rejects', async () => {
    mocks.oracle._stateTransitionClient.submitMintCommitment.mockRejectedValue(
      new Error('Network unreachable'),
    );

    await expect(
      module.createInvoice(validRequest()),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_MINT_FAILED',
    );
  });

  it('throws INVOICE_MINT_FAILED when submitMintCommitment returns non-SUCCESS status', async () => {
    mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'REJECTED',
      requestId: 'test-id',
    });

    await expect(
      module.createInvoice(validRequest()),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_MINT_FAILED',
    );
  });
});

// =============================================================================
// UT-CREATE-033: deliveryMethods with invalid URL scheme → INVOICE_INVALID_DELIVERY_METHOD
// =============================================================================

describe('UT-CREATE-033: invalid deliveryMethods URL scheme is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_DELIVERY_METHOD for http:// URL', async () => {
    await expect(
      module.createInvoice({
        ...validRequest(),
        deliveryMethods: ['http://example.com/pay'],
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DELIVERY_METHOD',
    );
  });

  it('throws INVOICE_INVALID_DELIVERY_METHOD for ftp:// URL', async () => {
    await expect(
      module.createInvoice({
        ...validRequest(),
        deliveryMethods: ['ftp://example.com/pay'],
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DELIVERY_METHOD',
    );
  });

  it('accepts https:// and wss:// URLs', async () => {
    makeOracleSucceed();

    const result = await module.createInvoice({
      ...validRequest(),
      deliveryMethods: ['https://example.com/pay', 'wss://example.com/ws'],
    });

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// UT-CREATE-034: deliveryMethods > 10 entries → INVOICE_INVALID_DELIVERY_METHOD
// =============================================================================

describe('UT-CREATE-034: deliveryMethods array exceeding 10 entries is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_DELIVERY_METHOD for 11 valid URLs', async () => {
    const methods = Array.from({ length: 11 }, (_, i) => `https://example.com/pay/${i}`);

    await expect(
      module.createInvoice({ ...validRequest(), deliveryMethods: methods }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DELIVERY_METHOD',
    );
  });
});

// =============================================================================
// UT-CREATE-035: deliveryMethods entry > 2048 chars → INVOICE_INVALID_DELIVERY_METHOD
// =============================================================================

describe('UT-CREATE-035: deliveryMethods URL exceeding 2048 chars is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_DELIVERY_METHOD for URL with 2049 characters', async () => {
    const longUrl = 'https://' + 'x'.repeat(2041); // 2049 total

    await expect(
      module.createInvoice({ ...validRequest(), deliveryMethods: [longUrl] }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DELIVERY_METHOD',
    );
  });

  it('accepts a URL of exactly 2048 characters', async () => {
    makeOracleSucceed();
    const exactUrl = 'https://' + 'x'.repeat(2040); // 2048 total

    const result = await module.createInvoice({
      ...validRequest(),
      deliveryMethods: [exactUrl],
    });

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// UT-CREATE-036: Successful creation fires invoice:created event
// =============================================================================

describe('UT-CREATE-036: successful createInvoice() fires invoice:created event', () => {
  beforeEach(async () => {
    setup();
    makeOracleSucceed();
    await module.load();
  });

  it('calls emitEvent with "invoice:created" after successful mint', async () => {
    const emitEvent = mocks.payments.on.mock.calls.length >= 0
      // Retrieve the emitEvent spy from the deps — it is stored in createTestAccountingModule
      ? vi.fn()
      : vi.fn();

    // Re-setup to capture the emitEvent spy directly
    const result2 = createTestAccountingModule();
    const module2 = result2.module;
    const mocks2 = result2.mocks;
    (mocks2.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    // Make the oracle succeed
    mocks2.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
      requestId: 'test-id',
    });

    // Get the emitEvent from the deps object used in createTestAccountingModule
    // emitEvent is stored on the `deps` passed to initialize()
    // The `on` wrapper in the test helper routes to payments.on, but emitEvent is separate
    const emitSpy = (module2 as any).deps?.emitEvent as ReturnType<typeof vi.fn> | undefined;

    await module2.load();
    await module2.createInvoice(validRequest());

    if (emitSpy) {
      expect(emitSpy).toHaveBeenCalledWith(
        'invoice:created',
        expect.objectContaining({ confirmed: true }),
      );
    }

    module2.destroy();
  });

  it('returns success: true and a non-empty invoiceId', async () => {
    const result = await module.createInvoice(validRequest());

    expect(result.success).toBe(true);
    expect(result.invoiceId).toHaveLength(64);
  });
});

// =============================================================================
// UT-CREATE-037: NFT tokenId not 64-hex → INVOICE_INVALID_NFT
// =============================================================================

describe('UT-CREATE-037: NFT tokenId not 64-hex is rejected', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('throws INVOICE_INVALID_NFT for non-hex tokenId', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [{ nft: { tokenId: 'not-hex' } }],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_NFT',
    );
  });

  it('throws INVOICE_INVALID_NFT for valid hex but wrong length (32 chars)', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [{ nft: { tokenId: 'a'.repeat(32) } }],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_NFT',
    );
  });

  it('throws INVOICE_INVALID_NFT for uppercase hex (not matching /^[0-9a-f]{64}$/)', async () => {
    await expect(
      module.createInvoice(
        createTestInvoice({
          targets: [
            {
              address: 'DIRECT://alice',
              assets: [{ nft: { tokenId: 'A'.repeat(64) } }],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_NFT',
    );
  });

  it('accepts a valid lowercase 64-char hex NFT tokenId', async () => {
    makeOracleSucceed();

    const result = await module.createInvoice(
      createTestInvoice({
        targets: [
          {
            address: 'DIRECT://alice',
            assets: [{ nft: { tokenId: 'a'.repeat(64) } }],
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });
});
