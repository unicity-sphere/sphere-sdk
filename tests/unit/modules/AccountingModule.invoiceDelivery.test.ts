/**
 * AccountingModule — Invoice Delivery (#226)
 *
 * Tests the per-invoice UXF-bundle delivery mechanism end-to-end:
 *
 * - Sender side: `deliverInvoice(invoiceId, options?)` packages the
 *   locally-stored invoice token into a real UXF CARv1 bundle, ships it
 *   inside an `invoice_delivery:` DM (inline `uxf-car` or `uxf-cid` via
 *   `publishToIpfs`), and reports per-recipient outcome.
 * - Receiver side: `_handleIncomingDM` decodes the envelope, parses the
 *   UXF CAR, extracts the invoice via `pkg.assemble`, and calls
 *   `importInvoice` to land it in the local ledger.
 *
 * **Fixture strategy:** the invoice token used in these tests is a REAL
 * invoice produced by the actual `createInvoice()` flow — not a
 * hand-crafted TOKEN_A clone. SDK primitives are mocked at the import
 * level (same setup the createInvoice tests use) so the mint runs
 * without aggregator network round-trips. The mocked `Token.fromJSON`
 * returns a verifying handle that satisfies `importInvoice`'s crypto
 * checks.
 *
 * Decoupling guarantee: `createInvoice` is unchanged — no auto-delivery
 * side effect. The mint path mints; the deliver path delivers. The
 * UT-DELIVER-201 test asserts this contract.
 *
 * @see modules/accounting/AccountingModule.ts INVOICE_DELIVERY_DM_PREFIX
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  SphereError,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type {
  TestAccountingModuleMocks,
} from './accounting-test-helpers.js';
import type { DirectMessage, Token } from '../../../types/index.js';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants.js';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import { carBytesToBase64, extractCarRootCid } from '../../../uxf/transfer-payload.js';

// =============================================================================
// SDK dynamic-import mocks (mirror createInvoice.test.ts so createInvoice
// runs to completion without network IO). Token.fromJSON is mocked to
// return a verifying handle so importInvoice's crypto check passes when
// processing the delivered token.
// =============================================================================

const FIXED_INVOICE_TOKEN_ID = '0'.repeat(64);

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId', () => ({
  TokenId: class {
    constructor(public readonly imprint: Uint8Array) {}
    toJSON() { return FIXED_INVOICE_TOKEN_ID; }
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId.js', () => ({
  TokenId: class {
    constructor(public readonly imprint: Uint8Array) {}
    toJSON() { return FIXED_INVOICE_TOKEN_ID; }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType.js', () => ({
  TokenType: class { constructor(_buf?: unknown) {} },
}));

// Shared capture of the canonical tokenData bytes that flow through
// MintTransactionData.create — used by the Token.mint mock below to
// produce a `tokenData` field on the minted JSON that the receiver's
// `importInvoice` can hex-decode back into valid InvoiceTerms.
// vi.mock factories cannot reference outer-scope variables (hoisted),
// so the state lives on globalThis where every factory can reach it.
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: {
    create: vi.fn().mockImplementation(async (...args: unknown[]) => {
      const tokenData = args[2];
      if (tokenData instanceof Uint8Array) {
        (globalThis as any).__lastMintTokenData = tokenData;
      }
      return { toJSON: () => ({}) };
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js', () => ({
  MintTransactionData: {
    create: vi.fn().mockImplementation(async (...args: unknown[]) => {
      const tokenData = args[2];
      if (tokenData instanceof Uint8Array) {
        (globalThis as any).__lastMintTokenData = tokenData;
      }
      return { toJSON: () => ({}) };
    }),
  },
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

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class { constructor() {} toJSON() { return {}; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState.js', () => ({
  TokenState: class { constructor() {} toJSON() { return {}; } },
}));

// Build the minted-token JSON shape, threading the captured tokenData
// bytes (from MintTransactionData.create) so the genesis.data.tokenData
// field is the hex-encoded UTF-8 of the canonical terms. importInvoice
// hex-decodes that same field back to JSON to recover InvoiceTerms, and
// UxfPackage's `lowerHex(data.tokenData)` accepts hex without complaint.
// vi.mock factories run at module load and cannot reference outer-scope
// vars (hoisted) — globalThis serves as the cross-mock channel.
function _buildMintedJson(): Record<string, unknown> {
  const captured = (globalThis as any).__lastMintTokenData as Uint8Array | undefined;
  const tokenDataHex = captured
    ? Buffer.from(captured.buffer, captured.byteOffset, captured.byteLength).toString('hex')
    : '';
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: FIXED_INVOICE_TOKEN_ID,
        tokenType: INVOICE_TOKEN_TYPE_HEX,
        coinData: null,
        tokenData: tokenDataHex,
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
  };
}

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => {
  return {
    Token: {
      // .fromJSON / .verify is called by importInvoice on the receiver
      // side. Return a handle whose .id.toJSON() echoes the JSON's
      // claimed tokenId (importInvoice cross-checks the cryptographic
      // identity match) and whose .verify(trustBase) succeeds for the
      // mock-flow proof.
      fromJSON: vi.fn().mockImplementation(async (json: any) => ({
        id: { toJSON: () => json?.genesis?.data?.tokenId ?? FIXED_INVOICE_TOKEN_ID },
        verify: vi.fn().mockResolvedValue({ isSuccessful: true }),
        toJSON: () => json ?? _buildMintedJson(),
      })),
      mint: vi.fn().mockImplementation(async () => ({
        toJSON: () => _buildMintedJson(),
      })),
    },
  };
});
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => {
  return {
    Token: {
      fromJSON: vi.fn().mockImplementation(async (json: any) => ({
        id: { toJSON: () => json?.genesis?.data?.tokenId ?? FIXED_INVOICE_TOKEN_ID },
        verify: vi.fn().mockResolvedValue({ isSuccessful: true }),
        toJSON: () => json ?? _buildMintedJson(),
      })),
      mint: vi.fn().mockImplementation(async () => ({
        toJSON: () => _buildMintedJson(),
      })),
    },
  };
});

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

// `canonicalSerialize` is left UNMOCKED — the real implementation is
// straightforward (deterministic key ordering of InvoiceTerms) and we
// need its actual output so the captured tokenData round-trips through
// hex-encode → UxfPackage → hex-decode → JSON.parse → importInvoice
// validation. The createInvoice-only test suite mocks this to `'{}'`
// because it doesn't exercise the receive path.

// =============================================================================
// Test infrastructure
// =============================================================================

const SELF_DIRECT = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
const REMOTE_BOB = 'DIRECT://remote-bob-direct-address-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const REMOTE_CAROL = 'DIRECT://remote-carol-direct-address-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;

function setup(overrides?: Parameters<typeof createTestAccountingModule>[0]) {
  const result = createTestAccountingModule(overrides);
  module = result.module;
  mocks = result.mocks;
  (mocks.payments as any).addToken = vi.fn().mockImplementation((t: Token) => {
    mocks.payments._tokens.push(t);
    return Promise.resolve();
  });
  mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
    status: 'SUCCESS',
    requestId: 'test-request-id',
  });
}

afterEach(async () => {
  try {
    module.destroy();
  } catch {
    // ignore MODULE_DESTROYED
  }
  vi.clearAllMocks();
});

/**
 * Mint a REAL invoice via the actual `createInvoice()` flow (with mocked
 * SDK primitives). The result is the same shape production uses — the
 * token lands in `payments.getTokens()` via the mocked `addToken`, the
 * terms cache is populated, and the token will survive `importInvoice`'s
 * verify check (because Token.fromJSON is mocked to return a verifying
 * handle).
 */
async function mintRealInvoice(args?: {
  targets?: Array<{ address: string; assets: Array<{ coin: [string, string] }> }>;
}): Promise<{ invoiceId: string; tokenJson: Record<string, unknown> }> {
  const request = createTestInvoice({
    targets: args?.targets ?? [
      { address: REMOTE_BOB, assets: [{ coin: ['UCT', '1000000'] }] },
    ],
  });
  const result = await module.createInvoice(request);
  expect(result.success).toBe(true);
  // Pull the persisted token from the mock payments store. createInvoice
  // calls `payments.addToken(uiToken)` whose sdkData is the JSON we need.
  const stored = mocks.payments._tokens.find((t) => t.id === result.invoiceId);
  expect(stored).toBeDefined();
  expect(typeof stored!.sdkData).toBe('string');
  return {
    invoiceId: result.invoiceId,
    tokenJson: JSON.parse(stored!.sdkData!),
  };
}

function makeDM(content: string, overrides?: Partial<DirectMessage>): DirectMessage {
  return {
    id: 'dm-' + Math.random().toString(36).slice(2),
    senderPubkey: '02' + 'b'.repeat(64),
    recipientPubkey: '02' + 'a'.repeat(64),
    content,
    timestamp: Date.now(),
    isRead: false,
    ...overrides,
  };
}

/**
 * Build the same DM envelope the sender emits — used by receiver-side
 * tests to feed messages directly into `mocks.communications._emit`.
 */
async function buildDeliveryDM(
  tokenJson: Record<string, unknown>,
  invoiceId: string,
  overrides?: Partial<{ memo?: string; mutateEnvelope: (env: any) => void }>,
): Promise<DirectMessage> {
  const pkg = UxfPackage.create({ description: 'invoice-delivery' });
  pkg.ingest(tokenJson);
  const carBytes = await pkg.toCar();
  const carBase64 = carBytesToBase64(carBytes);
  const bundleCid = await extractCarRootCid(carBytes);
  const envelope: any = {
    type: 'invoice_delivery',
    version: 1,
    invoiceId,
    bundle: { kind: 'uxf-car', carBase64, bundleCid },
  };
  if (overrides?.memo !== undefined) envelope.memo = overrides.memo;
  if (overrides?.mutateEnvelope) overrides.mutateEnvelope(envelope);
  return makeDM('invoice_delivery:' + JSON.stringify(envelope));
}

// =============================================================================
// SENDER: deliverInvoice — happy path on real-flow invoices
// =============================================================================

describe('AccountingModule.deliverInvoice — happy path (real createInvoice fixture)', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('UT-DELIVER-001: delivers a real-flow invoice via uxf-car DM to a single non-self target', async () => {
    const { invoiceId } = await mintRealInvoice();
    expect(mocks.communications.sendDM).not.toHaveBeenCalled(); // mint must not deliver

    const result = await module.deliverInvoice(invoiceId);
    expect(result.invoiceId).toBe(invoiceId);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skippedSelf).toBe(0);
    expect(result.recipients[0]!.recipient).toBe(REMOTE_BOB);
    expect(result.recipients[0]!.success).toBe(true);
    expect(result.recipients[0]!.shape).toBe('inline');

    const [recipient, content] = mocks.communications.sendDM.mock.calls[0]!;
    expect(recipient).toBe(REMOTE_BOB);
    expect((content as string).startsWith('invoice_delivery:')).toBe(true);

    const env = JSON.parse((content as string).slice('invoice_delivery:'.length));
    expect(env.type).toBe('invoice_delivery');
    expect(env.version).toBe(1);
    expect(env.invoiceId).toBe(invoiceId);
    expect(env.bundle.kind).toBe('uxf-car');
    expect(typeof env.bundle.carBase64).toBe('string');
    expect(env.bundle.carBase64.length).toBeGreaterThan(0);
    expect(typeof env.bundle.bundleCid).toBe('string');
  });

  it('UT-DELIVER-002: round-trip — the emitted CAR decodes back to a UxfPackage containing the invoice', async () => {
    const { invoiceId } = await mintRealInvoice();
    await module.deliverInvoice(invoiceId);

    const [, content] = mocks.communications.sendDM.mock.calls[0]!;
    const env = JSON.parse((content as string).slice('invoice_delivery:'.length));
    const { carBase64ToBytes } = await import('../../../uxf/transfer-payload.js');
    const carBytes = carBase64ToBytes(env.bundle.carBase64);
    const pkg = await UxfPackage.fromCar(carBytes);
    expect(pkg.tokenIds()).toContain(invoiceId);
    const assembled = pkg.assemble(invoiceId) as any;
    expect(assembled?.genesis?.data?.tokenId).toBe(invoiceId);
    expect(assembled?.genesis?.data?.tokenType).toBe(INVOICE_TOKEN_TYPE_HEX);
  });

  it('UT-DELIVER-003: delivers to multiple targets and skips self-target', async () => {
    const { invoiceId } = await mintRealInvoice({
      targets: [
        { address: SELF_DIRECT, assets: [{ coin: ['UCT', '11000000'] }] },
        { address: REMOTE_BOB, assets: [{ coin: ['UCT', '22000000'] }] },
        { address: REMOTE_CAROL, assets: [{ coin: ['UCT', '33000000'] }] },
      ],
    });

    const result = await module.deliverInvoice(invoiceId);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skippedSelf).toBe(1);
    expect(result.recipients.map((r) => r.recipient).sort()).toEqual(
      [REMOTE_BOB, REMOTE_CAROL].sort(),
    );
    expect(mocks.communications.sendDM).toHaveBeenCalledTimes(2);
  });

  it('UT-DELIVER-004: caller-provided recipients override the terms.targets default', async () => {
    const { invoiceId } = await mintRealInvoice();
    const result = await module.deliverInvoice(invoiceId, {
      recipients: ['@arbitrary-recipient'],
    });
    expect(result.sent).toBe(1);
    expect(result.recipients[0]!.recipient).toBe('@arbitrary-recipient');
    expect(mocks.communications.sendDM).toHaveBeenCalledWith(
      '@arbitrary-recipient',
      expect.any(String),
    );
  });

  it('UT-DELIVER-005: empty effective recipient set returns sent=0 without throwing', async () => {
    const { invoiceId } = await mintRealInvoice({
      targets: [{ address: SELF_DIRECT, assets: [{ coin: ['UCT', '1000000'] }] }],
    });
    const result = await module.deliverInvoice(invoiceId);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skippedSelf).toBe(1);
    expect(result.recipients).toHaveLength(0);
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();
  });

  it('UT-DELIVER-006: caller-provided empty recipient array short-circuits', async () => {
    const { invoiceId } = await mintRealInvoice();
    const result = await module.deliverInvoice(invoiceId, { recipients: [] });
    expect(result.sent).toBe(0);
    expect(result.recipients).toHaveLength(0);
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();
  });

  it('UT-DELIVER-007: memo is included in the envelope when provided', async () => {
    const { invoiceId } = await mintRealInvoice();
    await module.deliverInvoice(invoiceId, { memo: 'hello bob' });
    const [, content] = mocks.communications.sendDM.mock.calls[0]!;
    const env = JSON.parse((content as string).slice('invoice_delivery:'.length));
    expect(env.memo).toBe('hello bob');
  });
});

// =============================================================================
// SENDER: deliverInvoice — failure modes
// =============================================================================

describe('AccountingModule.deliverInvoice — failure modes', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('UT-DELIVER-101: throws INVOICE_NOT_FOUND when invoice is unknown locally', async () => {
    await expect(
      module.deliverInvoice('a'.repeat(64)),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_FOUND',
    );
  });

  it('UT-DELIVER-102: throws COMMUNICATIONS_UNAVAILABLE when comms is absent', async () => {
    const { invoiceId } = await mintRealInvoice();
    (module as any).deps.communications = undefined;
    await expect(
      module.deliverInvoice(invoiceId),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError &&
        (e as SphereError).code === 'COMMUNICATIONS_UNAVAILABLE',
    );
  });

  it('UT-DELIVER-103: per-recipient sendDM failure does not block other recipients and does not throw', async () => {
    const { invoiceId } = await mintRealInvoice({
      targets: [
        { address: REMOTE_BOB, assets: [{ coin: ['UCT', '11000000'] }] },
        { address: REMOTE_CAROL, assets: [{ coin: ['UCT', '22000000'] }] },
      ],
    });
    mocks.communications.sendDM.mockImplementation((recipient: string, content: string) => {
      if (recipient === REMOTE_BOB) return Promise.reject(new Error('relay offline'));
      return Promise.resolve({
        id: 'mock-dm-' + Math.random().toString(36).slice(2),
        senderPubkey: '02' + 'a'.repeat(64),
        recipientPubkey: '02' + 'b'.repeat(64),
        content,
        timestamp: Date.now(),
        isRead: false,
      });
    });
    const result = await module.deliverInvoice(invoiceId);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const bobResult = result.recipients.find((r) => r.recipient === REMOTE_BOB)!;
    expect(bobResult.success).toBe(false);
    expect(bobResult.error).toContain('relay offline');
    const carolResult = result.recipients.find((r) => r.recipient === REMOTE_CAROL)!;
    expect(carolResult.success).toBe(true);
  });
});

// =============================================================================
// SENDER: createInvoice does NOT auto-deliver
// =============================================================================

describe('AccountingModule — createInvoice does not auto-deliver (#226)', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('UT-DELIVER-201: createInvoice with remote targets does NOT call sendDM', async () => {
    await mintRealInvoice();
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();
  });
});

// =============================================================================
// RECEIVER: _handleIncomingDM → importInvoice via UXF bundle (real fixture)
// =============================================================================

describe('AccountingModule — Invoice Delivery (receiver side, real fixture)', () => {
  let receivedInvoiceJson: Record<string, unknown>;
  let receivedInvoiceId: string;

  beforeEach(async () => {
    setup();
    await module.load();
    // Mint a real invoice on a "first" wallet, capture its JSON, then use
    // that as the DELIVERY PAYLOAD into a fresh receiver wallet so the
    // test exercises a true cross-wallet round-trip.
    const { invoiceId, tokenJson } = await mintRealInvoice();
    receivedInvoiceJson = tokenJson;
    receivedInvoiceId = invoiceId;
    // Reset the spy / cache from the minting step so the receiver-side
    // assertion only counts the import triggered by the inbound DM.
    mocks.payments._tokens.length = 0;
    (module as any).invoiceTermsCache.delete(invoiceId);
  });

  it('UT-DELIVER-301: invoice_delivery: DM with valid uxf-car triggers importInvoice and lands the token', async () => {
    const dm = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId);
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 50));

    // importInvoice persisted the token through addToken (which our mock
    // pushes into _tokens). Asserting on the stored side rather than a
    // spy keeps the test focused on observable end state.
    const persisted = mocks.payments._tokens.find((t) => t.id === receivedInvoiceId);
    expect(persisted).toBeDefined();
    expect(persisted!.coinId).toBe(INVOICE_TOKEN_TYPE_HEX);
    // Terms cache populated as part of importInvoice.
    expect((module as any).invoiceTermsCache.has(receivedInvoiceId)).toBe(true);
  });

  it('UT-DELIVER-302: replay of the same DM is benign (INVOICE_ALREADY_EXISTS handled)', async () => {
    const dm1 = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId);
    mocks.communications._emit('message:dm', dm1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.payments._tokens.find((t) => t.id === receivedInvoiceId)).toBeDefined();

    // Re-emit (relay replay). MUST NOT throw and MUST NOT corrupt cache.
    const dm2 = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId);
    expect(() => {
      mocks.communications._emit('message:dm', dm2);
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    // Still exactly one persisted token.
    expect(mocks.payments._tokens.filter((t) => t.id === receivedInvoiceId)).toHaveLength(1);
  });

  it('UT-DELIVER-303: malformed JSON after prefix is silently dropped', async () => {
    const dm = makeDM('invoice_delivery: {not json!!}');
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.find((t) => t.id === receivedInvoiceId)).toBeUndefined();
  });

  it('UT-DELIVER-304: wrong type discriminator silently dropped', async () => {
    const dm = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId, {
      mutateEnvelope: (env) => { env.type = 'something_else'; },
    });
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.find((t) => t.id === receivedInvoiceId)).toBeUndefined();
  });

  it('UT-DELIVER-305: future version silently dropped (forward compat)', async () => {
    const dm = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId, {
      mutateEnvelope: (env) => { env.version = 99; },
    });
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.find((t) => t.id === receivedInvoiceId)).toBeUndefined();
  });

  it('UT-DELIVER-306: invoiceId not present in bundle is silently dropped', async () => {
    const dm = await buildDeliveryDM(receivedInvoiceJson, receivedInvoiceId, {
      mutateEnvelope: (env) => { env.invoiceId = 'f'.repeat(64); },
    });
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.find((t) => t.id === 'f'.repeat(64))).toBeUndefined();
  });

  it('UT-DELIVER-307: oversized DM payload is silently dropped', async () => {
    const oversized = 'invoice_delivery:' + 'x'.repeat(131_073);
    const dm = makeDM(oversized);
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.length).toBe(0);
  });

  it('UT-DELIVER-308: uxf-cid bundle kind is logged and dropped (deferred follow-up)', async () => {
    const envelope = {
      type: 'invoice_delivery',
      version: 1,
      invoiceId: receivedInvoiceId,
      bundle: {
        kind: 'uxf-cid',
        bundleCid: 'bafybeibogusplaceholder1234567890abcdef',
        gateways: ['https://gw.example/'],
      },
    };
    const dm = makeDM('invoice_delivery:' + JSON.stringify(envelope));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.payments._tokens.find((t) => t.id === receivedInvoiceId)).toBeUndefined();
  });
});

// =============================================================================
// END-TO-END (sender + receiver in two modules, real-flow invoice)
// =============================================================================

describe('AccountingModule — Invoice Delivery (round-trip across two modules)', () => {
  it('UT-DELIVER-401: deliverInvoice on sender → captured DM → receiver imports successfully', async () => {
    // ---- Sender ----
    const sender = createTestAccountingModule();
    (sender.mocks.payments as any).addToken = vi.fn().mockImplementation((t: Token) => {
      sender.mocks.payments._tokens.push(t);
      return Promise.resolve();
    });
    sender.mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
      requestId: 'test-request-id',
    });
    await sender.module.load();

    const senderResult = await sender.module.createInvoice(
      createTestInvoice({
        targets: [{ address: REMOTE_BOB, assets: [{ coin: ['UCT', '1000000'] }] }],
      }),
    );
    expect(senderResult.success).toBe(true);
    const invoiceId = senderResult.invoiceId;

    let outbound: { recipient: string; content: string } | null = null;
    sender.mocks.communications.sendDM.mockImplementation((recipient: string, content: string) => {
      outbound = { recipient, content };
      return Promise.resolve({
        id: 'mock-dm-' + Math.random().toString(36).slice(2),
        senderPubkey: '02' + 'a'.repeat(64),
        recipientPubkey: '02' + 'b'.repeat(64),
        content,
        timestamp: Date.now(),
        isRead: false,
      });
    });
    const delivery = await sender.module.deliverInvoice(invoiceId);
    expect(delivery.sent).toBe(1);
    expect(outbound).not.toBeNull();

    // ---- Receiver ----
    const receiver = createTestAccountingModule();
    (receiver.mocks.payments as any).addToken = vi.fn().mockImplementation((t: Token) => {
      receiver.mocks.payments._tokens.push(t);
      return Promise.resolve();
    });
    receiver.mocks.oracle._stateTransitionClient.submitMintCommitment.mockResolvedValue({
      status: 'SUCCESS',
      requestId: 'test-request-id',
    });
    await receiver.module.load();
    const dm = makeDM(outbound!.content);
    receiver.mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 50));

    // Receiver landed the invoice via importInvoice + addToken.
    const persisted = receiver.mocks.payments._tokens.find((t) => t.id === invoiceId);
    expect(persisted).toBeDefined();
    expect(persisted!.coinId).toBe(INVOICE_TOKEN_TYPE_HEX);
    expect((receiver.module as any).invoiceTermsCache.has(invoiceId)).toBe(true);

    sender.module.destroy();
    receiver.module.destroy();
  });
});
