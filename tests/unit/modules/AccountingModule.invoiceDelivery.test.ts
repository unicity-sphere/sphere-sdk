/**
 * AccountingModule — Invoice Delivery (#226 + #397 rework)
 *
 * Tests the per-invoice UXF-bundle delivery mechanism end-to-end after
 * the #397 refactor:
 *
 * - Sender side: `deliverInvoice(invoiceId, options?)` packages the
 *   locally-stored invoice token into a real UXF CARv1 bundle and ships
 *   it through the standard TOKEN_TRANSFER pipeline via
 *   `payments.publishUxfBundle`. Per-recipient outcome is reported via
 *   `DeliverInvoiceResult` and structured failures fire
 *   `invoice:deliver-failed`.
 * - Receiver side: an invoice token arriving via the standard
 *   TOKEN_TRANSFER ingest pipeline (PaymentsModule.addToken →
 *   onTokenChange) is routed by `_handleTokenChange`'s
 *   `INVOICE_TOKEN_TYPE_HEX` branch into `invoiceTermsCache` with an
 *   `invoice:created { confirmed: true }` event.
 *
 * Pre-#397 the path was a bespoke `invoice_delivery:` NIP-17 DM with a
 * separate sender/receiver decoder; that path has been removed.
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
import type { Token } from '../../../types/index.js';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants.js';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage.js';

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
        // Issue #295 rewrite #2: STS requires ≥1 step.
        merkleTreePath: { root: '0'.repeat(64), steps: [{ path: '0', data: '0'.repeat(64) }] },
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
    // Issue #295 rewrite #2: STS requires ≥1 step.
    merkleTreePath: { root: '0'.repeat(64), steps: [{ path: '0', data: '0'.repeat(64) }] },
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
    // Issue #295 rewrite #2: STS requires ≥1 step.
    merkleTreePath: { root: '0'.repeat(64), steps: [{ path: '0', data: '0'.repeat(64) }] },
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


// =============================================================================
// SENDER: deliverInvoice — happy path on real-flow invoices
//
// Issue #397 — invoice deliveries now ride the standard TOKEN_TRANSFER
// pipeline via `payments.publishUxfBundle` instead of the legacy
// `invoice_delivery:` NIP-17 DM. Assertions target the `publishUxfBundle`
// mock; the legacy DM path is gone.
// =============================================================================

describe('AccountingModule.deliverInvoice — happy path (real createInvoice fixture)', () => {
  beforeEach(async () => {
    setup();
    await module.load();
  });

  it('UT-DELIVER-001: delivers a real-flow invoice via publishUxfBundle to a single non-self target', async () => {
    const { invoiceId } = await mintRealInvoice();
    expect(mocks.payments.publishUxfBundle).not.toHaveBeenCalled(); // mint must not deliver

    const result = await module.deliverInvoice(invoiceId);
    expect(result.invoiceId).toBe(invoiceId);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skippedSelf).toBe(0);
    expect(result.recipients[0]!.recipient).toBe(REMOTE_BOB);
    expect(result.recipients[0]!.success).toBe(true);
    expect(result.recipients[0]!.shape).toBe('inline');

    expect(mocks.payments.publishUxfBundle).toHaveBeenCalledTimes(1);
    const params = mocks.payments.publishUxfBundle.mock.calls[0]![0] as {
      recipient: string;
      bundleCid: string;
      tokenIds: ReadonlyArray<string>;
      carBytes: Uint8Array;
      publishViaIpfsCid?: boolean;
    };
    expect(params.recipient).toBe(REMOTE_BOB);
    expect(params.tokenIds).toEqual([invoiceId]);
    expect(params.publishViaIpfsCid).toBe(false);
    expect(typeof params.bundleCid).toBe('string');
    expect(params.bundleCid.length).toBeGreaterThan(0);
    expect(params.carBytes).toBeInstanceOf(Uint8Array);
    expect(params.carBytes.byteLength).toBeGreaterThan(0);
  });

  it('UT-DELIVER-002: round-trip — the emitted CAR decodes back to a UxfPackage containing the invoice', async () => {
    const { invoiceId } = await mintRealInvoice();
    await module.deliverInvoice(invoiceId);

    const params = mocks.payments.publishUxfBundle.mock.calls[0]![0] as {
      carBytes: Uint8Array;
    };
    const pkg = await UxfPackage.fromCar(params.carBytes);
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
    expect(mocks.payments.publishUxfBundle).toHaveBeenCalledTimes(2);
  });

  it('UT-DELIVER-004: caller-provided recipients override the terms.targets default', async () => {
    const { invoiceId } = await mintRealInvoice();
    const result = await module.deliverInvoice(invoiceId, {
      recipients: ['@arbitrary-recipient'],
    });
    expect(result.sent).toBe(1);
    expect(result.recipients[0]!.recipient).toBe('@arbitrary-recipient');
    expect(mocks.payments.publishUxfBundle).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: '@arbitrary-recipient' }),
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
    expect(mocks.payments.publishUxfBundle).not.toHaveBeenCalled();
  });

  it('UT-DELIVER-006: caller-provided empty recipient array short-circuits', async () => {
    const { invoiceId } = await mintRealInvoice();
    const result = await module.deliverInvoice(invoiceId, { recipients: [] });
    expect(result.sent).toBe(0);
    expect(result.recipients).toHaveLength(0);
    expect(mocks.payments.publishUxfBundle).not.toHaveBeenCalled();
  });

  it('UT-DELIVER-007: memo is forwarded to publishUxfBundle when provided', async () => {
    const { invoiceId } = await mintRealInvoice();
    await module.deliverInvoice(invoiceId, { memo: 'hello bob' });
    expect(mocks.payments.publishUxfBundle).toHaveBeenCalledWith(
      expect.objectContaining({ memo: 'hello bob' }),
    );
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

  it('UT-DELIVER-103 (#397): per-recipient publishUxfBundle failure does not block other recipients and does not throw', async () => {
    const { invoiceId } = await mintRealInvoice({
      targets: [
        { address: REMOTE_BOB, assets: [{ coin: ['UCT', '11000000'] }] },
        { address: REMOTE_CAROL, assets: [{ coin: ['UCT', '22000000'] }] },
      ],
    });
    mocks.payments.publishUxfBundle.mockImplementation(
      (params: { recipient: string }) => {
        if (params.recipient === REMOTE_BOB) {
          return Promise.reject(new Error('relay offline'));
        }
        return Promise.resolve({
          nostrEventId: 'mock-event-' + Math.random().toString(36).slice(2),
          recipientTransportPubkey: params.recipient,
        });
      },
    );
    const result = await module.deliverInvoice(invoiceId);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const bobResult = result.recipients.find((r) => r.recipient === REMOTE_BOB)!;
    expect(bobResult.success).toBe(false);
    expect(bobResult.error).toContain('relay offline');
    const carolResult = result.recipients.find((r) => r.recipient === REMOTE_CAROL)!;
    expect(carolResult.success).toBe(true);
  });

  it('UT-DELIVER-104 (#397): emits invoice:deliver-failed with reason "transport-error" on publish failure', async () => {
    const { invoiceId } = await mintRealInvoice();
    mocks.payments.publishUxfBundle.mockRejectedValue(new Error('relay offline'));
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    const result = await module.deliverInvoice(invoiceId);
    expect(result.failed).toBe(1);
    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:deliver-failed',
      expect.objectContaining({
        invoiceId,
        recipient: REMOTE_BOB,
        reason: 'transport-error',
        errorMessage: expect.stringContaining('relay offline'),
      }),
    );
  });

  it('UT-DELIVER-105 (#401): re-emits invoice:deliver-failed with reason "non-durable" when SendingRecoveryWorker exhausts on a delivered invoice', async () => {
    // Mint and "deliver" an invoice so it lives in invoiceTermsCache —
    // this is the predicate AccountingModule uses to decide whether a
    // recovery-republish-exhausted event belongs to it.
    const { invoiceId } = await mintRealInvoice();
    await module.deliverInvoice(invoiceId);

    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();

    // Fire the new SendingRecoveryWorker exhaustion event through the
    // mock payments emit pipe (deps.on routes subscriptions to this).
    // tokenIds includes the invoice id so AccountingModule recognizes
    // it as one of its own and re-emits the focused failure.
    mocks.payments._emit('transfer:recovery-republish-exhausted', {
      outboxId: 'outbox-fake',
      bundleCid: 'bafy-fake',
      tokenIds: [invoiceId],
      mode: 'instant',
      recipient: REMOTE_BOB,
      lastError: 'relay down for 90s',
      exhaustedAt: Date.now(),
    });

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:deliver-failed',
      expect.objectContaining({
        invoiceId,
        recipient: REMOTE_BOB,
        reason: 'non-durable',
        errorMessage: expect.stringContaining('relay down'),
      }),
    );
  });

  it('UT-DELIVER-106 (#401): does NOT re-emit invoice:deliver-failed when exhausted entry is unrelated to any tracked invoice', async () => {
    await mintRealInvoice();

    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();

    // tokenIds carries an id that is NOT in invoiceTermsCache — the
    // exhaustion is for an ordinary token transfer, not an invoice.
    mocks.payments._emit('transfer:recovery-republish-exhausted', {
      outboxId: 'outbox-fake',
      bundleCid: 'bafy-fake',
      tokenIds: ['deadbeef'.repeat(8)],
      mode: 'instant',
      recipient: REMOTE_BOB,
      lastError: 'relay down',
      exhaustedAt: Date.now(),
    });

    expect(emitEvent).not.toHaveBeenCalledWith(
      'invoice:deliver-failed',
      expect.objectContaining({ reason: 'non-durable' }),
    );
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
// RECEIVER: _handleTokenChange → invoice registration via TOKEN_TRANSFER pipeline
//
// Issue #397 — invoice tokens arriving via the standard TOKEN_TRANSFER
// pipeline (handled by PaymentsModule's ingest pool) land in PaymentsModule
// via `addToken`, which fires the `onTokenChange` observer that
// AccountingModule subscribed to during load(). Detection is by token
// type (`INVOICE_TOKEN_TYPE_HEX`); the observer registers the invoice in
// `invoiceTermsCache` and emits `invoice:created`.
//
// These tests directly exercise that observer path via the helper
// `mocks.payments._notifyTokenChange(tokenId, sdkData)` — equivalent to
// what PaymentsModule.addToken does after a CAR decode lands an invoice
// token in storage.
// =============================================================================

describe('AccountingModule — Invoice Delivery (receiver side: TOKEN_TRANSFER routing)', () => {
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
    // assertion only counts the registration triggered by the inbound
    // TOKEN_TRANSFER routing.
    mocks.payments._tokens.length = 0;
    (module as any).invoiceTermsCache.delete(invoiceId);
  });

  it('UT-DELIVER-301: incoming INVOICE token via onTokenChange registers terms + emits invoice:created', async () => {
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();

    // Drive the observer the same way PaymentsModule's addToken does
    // after the standard ingest pool unpacks an incoming TOKEN_TRANSFER
    // bundle carrying the invoice token.
    mocks.payments._notifyTokenChange(
      receivedInvoiceId,
      JSON.stringify(receivedInvoiceJson),
    );

    expect((module as any).invoiceTermsCache.has(receivedInvoiceId)).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:created',
      { invoiceId: receivedInvoiceId, confirmed: true },
    );
  });

  it('UT-DELIVER-302: replayed onTokenChange for the same invoice is benign (idempotent cache)', async () => {
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    mocks.payments._notifyTokenChange(
      receivedInvoiceId,
      JSON.stringify(receivedInvoiceJson),
    );
    emitEvent.mockClear();

    // Re-fire — must NOT throw, must NOT emit a second invoice:created.
    expect(() => {
      mocks.payments._notifyTokenChange(
        receivedInvoiceId,
        JSON.stringify(receivedInvoiceJson),
      );
    }).not.toThrow();
    expect((module as any).invoiceTermsCache.size).toBe(1);
    expect(emitEvent).not.toHaveBeenCalledWith(
      'invoice:created',
      expect.objectContaining({ invoiceId: receivedInvoiceId }),
    );
  });

  it('UT-DELIVER-303: non-invoice token type does NOT register an invoice', async () => {
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();
    // Synthesize a fake "regular" token with a non-invoice tokenType.
    const fakeTxf = {
      genesis: {
        data: {
          tokenId: 'b'.repeat(64),
          tokenType: 'aa'.repeat(32), // not INVOICE
          tokenData: 'whatever',
        },
      },
      transactions: [],
    };
    mocks.payments._notifyTokenChange('b'.repeat(64), JSON.stringify(fakeTxf));
    expect((module as any).invoiceTermsCache.has('b'.repeat(64))).toBe(false);
    expect(emitEvent).not.toHaveBeenCalledWith(
      'invoice:created',
      expect.anything(),
    );
  });

  it('UT-DELIVER-304: malformed sdkData is silently dropped (no throw, no registration)', async () => {
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    expect(() => {
      mocks.payments._notifyTokenChange('c'.repeat(64), 'not json!!');
    }).not.toThrow();
    expect((module as any).invoiceTermsCache.has('c'.repeat(64))).toBe(false);
    expect(emitEvent).not.toHaveBeenCalledWith(
      'invoice:created',
      expect.objectContaining({ invoiceId: 'c'.repeat(64) }),
    );
  });
});

// =============================================================================
// END-TO-END (sender publishes via TOKEN_TRANSFER pipeline; receiver routes
// the unpacked invoice token through the new onTokenChange observer)
// =============================================================================

describe('AccountingModule — Invoice Delivery (round-trip via TOKEN_TRANSFER pipeline)', () => {
  it('UT-DELIVER-401: sender deliverInvoice → captured CAR → receiver routes via onTokenChange', async () => {
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

    // Capture the CAR that publishUxfBundle would have shipped.
    let outbound: { recipient: string; carBytes: Uint8Array; tokenIds: ReadonlyArray<string> } | null = null;
    sender.mocks.payments.publishUxfBundle.mockImplementation(
      (params: { recipient: string; carBytes: Uint8Array; tokenIds: ReadonlyArray<string> }) => {
        outbound = {
          recipient: params.recipient,
          carBytes: params.carBytes,
          tokenIds: params.tokenIds,
        };
        return Promise.resolve({
          nostrEventId: 'mock-event-id',
          recipientTransportPubkey: params.recipient,
        });
      },
    );
    const delivery = await sender.module.deliverInvoice(invoiceId);
    expect(delivery.sent).toBe(1);
    expect(outbound).not.toBeNull();
    expect(outbound!.tokenIds).toEqual([invoiceId]);

    // ---- Receiver ----
    // Simulate the receiver's standard TOKEN_TRANSFER decode pipeline:
    // unpack the CAR, extract the invoice token JSON, hand it to addToken
    // (which fires onTokenChange — exactly what `_handleTokenChange`
    // listens to). Verifies the invoice lands in invoiceTermsCache
    // without any DM-prefix handling.
    const pkg = await UxfPackage.fromCar(outbound!.carBytes);
    const assembledTokenJson = pkg.assemble(invoiceId);

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

    const emitEvent = (receiver.module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();
    receiver.mocks.payments._notifyTokenChange(
      invoiceId,
      JSON.stringify(assembledTokenJson),
    );

    expect((receiver.module as any).invoiceTermsCache.has(invoiceId)).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:created',
      { invoiceId, confirmed: true },
    );

    sender.module.destroy();
    receiver.module.destroy();
  });
});
