/**
 * Integration tests for swap lifecycle workflows.
 *
 * Uses TWO SwapModule instances (party A and party B) connected via a mock
 * DM relay, plus an escrow simulator that responds to announce DMs with
 * deposit invoices, detects coverage, and delivers payout invoices.
 *
 * @see docs/SWAP-TEST-SPEC.md — INT-SWAP-001 through INT-SWAP-006
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSwapModule } from '../../modules/swap/index.js';
import { buildManifest, computeSwapId } from '../../modules/swap/manifest.js';
import type { SwapModule } from '../../modules/swap/SwapModule.js';
import type {
  SwapModuleConfig,
  SwapModuleDependencies,
  SwapDeal,
  SwapRef,
  SwapManifest,
} from '../../modules/swap/types.js';
import type { FullIdentity, TrackedAddress, TransferResult, Token, SphereEventType, SphereEventMap } from '../../types/index.js';
import type { PeerInfo } from '../../transport/transport-provider.js';
import type { StorageProvider } from '../../storage/storage-provider.js';
import {
  createMockAccountingModule,
  createMockStorageProvider,
  createMockPaymentsModule,
  type MockAccountingModule,
  type MockStorageProvider,
  type MockPaymentsModule,
} from '../unit/modules/swap-test-helpers.js';

// =============================================================================
// Constants
// =============================================================================

const PARTY_A_PUBKEY = '02' + 'a'.repeat(64);
const PARTY_A_TRANSPORT_PUBKEY = 'a'.repeat(64);
const PARTY_A_ADDRESS = 'DIRECT://party_a_aaa111';
const PARTY_B_PUBKEY = '02' + 'b'.repeat(64);
const PARTY_B_TRANSPORT_PUBKEY = 'b'.repeat(64);
const PARTY_B_ADDRESS = 'DIRECT://party_b_bbb222';
const ESCROW_PUBKEY = '02' + 'e'.repeat(64);
const ESCROW_TRANSPORT_PUBKEY = 'e'.repeat(64);
const ESCROW_ADDRESS = 'DIRECT://escrow_eee333';

function randomHex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// =============================================================================
// MockDMRelay — Routes DMs between parties based on recipient pubkey
// =============================================================================

class MockDMRelay {
  private handlers = new Map<string, Array<(dm: { content: string; senderPubkey: string; senderNametag?: string; timestamp: number }) => void>>();

  register(pubkey: string, handler: (dm: { content: string; senderPubkey: string; senderNametag?: string; timestamp: number }) => void): () => void {
    if (!this.handlers.has(pubkey)) {
      this.handlers.set(pubkey, []);
    }
    this.handlers.get(pubkey)!.push(handler);
    return () => {
      const list = this.handlers.get(pubkey);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  send(senderPubkey: string, recipientPubkey: string, content: string, senderNametag?: string): void {
    const handlers = this.handlers.get(recipientPubkey);
    if (handlers) {
      for (const handler of handlers) {
        handler({ content, senderPubkey, senderNametag, timestamp: Date.now() });
      }
    }
  }
}

// =============================================================================
// EscrowSimulator — Responds to announce DMs with deposit/payout invoices
// =============================================================================

class EscrowSimulator {
  private relay: MockDMRelay;
  private escrowPubkey: string;
  private swapStates = new Map<string, {
    manifest: SwapManifest;
    depositInvoiceId: string;
    payoutInvoiceIdA: string;
    payoutInvoiceIdB: string;
    announcedParties: Set<string>;
    depositedParties: Set<string>;
    state: string;
  }>();

  constructor(relay: MockDMRelay, escrowPubkey: string) {
    this.relay = relay;
    this.escrowPubkey = escrowPubkey;

    // Register escrow as DM recipient
    this.relay.register(escrowPubkey, (dm) => {
      this.handleDM(dm);
    });
  }

  private handleDM(dm: { content: string; senderPubkey: string; timestamp: number }): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dm.content);
    } catch {
      return;
    }

    if (parsed.type === 'announce') {
      this.handleAnnounce(dm.senderPubkey, parsed.manifest as SwapManifest);
    }
  }

  private handleAnnounce(senderPubkey: string, manifest: SwapManifest): void {
    const swapId = manifest.swap_id;

    if (!this.swapStates.has(swapId)) {
      const depositInvoiceId = 'deposit-inv-' + randomHex(16);
      const payoutInvoiceIdA = 'payout-inv-a-' + randomHex(16);
      const payoutInvoiceIdB = 'payout-inv-b-' + randomHex(16);

      this.swapStates.set(swapId, {
        manifest,
        depositInvoiceId,
        payoutInvoiceIdA,
        payoutInvoiceIdB,
        announcedParties: new Set([senderPubkey]),
        depositedParties: new Set(),
        state: 'ANNOUNCED',
      });
    } else {
      this.swapStates.get(swapId)!.announcedParties.add(senderPubkey);
    }

    const swapState = this.swapStates.get(swapId)!;

    // Send announce_result
    const announceResult = JSON.stringify({
      type: 'announce_result',
      swap_id: swapId,
      state: 'ANNOUNCED',
      deposit_invoice_id: swapState.depositInvoiceId,
      is_new: swapState.announcedParties.size === 1,
      created_at: Date.now(),
    });
    this.relay.send(this.escrowPubkey, senderPubkey, announceResult);

    // Send deposit invoice_delivery
    const invoiceDelivery = JSON.stringify({
      type: 'invoice_delivery',
      swap_id: swapId,
      invoice_type: 'deposit',
      invoice_id: swapState.depositInvoiceId,
      invoice_token: this.createMockInvoiceToken(swapId, swapState),
      payment_instructions: {
        your_currency: manifest.party_a_currency_to_change,
        your_amount: manifest.party_a_value_to_change,
        memo: `swap:${swapId}`,
      },
    });
    this.relay.send(this.escrowPubkey, senderPubkey, invoiceDelivery);
  }

  /**
   * Simulate that a deposit was received for the given party.
   * When both deposits arrive, sends payment_confirmation + payout invoice_delivery.
   */
  simulateDeposit(swapId: string, partyPubkey: string): void {
    const swapState = this.swapStates.get(swapId);
    if (!swapState) return;

    swapState.depositedParties.add(partyPubkey);

    if (swapState.depositedParties.size >= 2) {
      swapState.state = 'CONCLUDING';

      // Send payment_confirmation + payout invoice_delivery to both parties
      for (const partyPk of swapState.announcedParties) {
        // payment_confirmation
        const confirmation = JSON.stringify({
          type: 'payment_confirmation',
          swap_id: swapId,
        });
        this.relay.send(this.escrowPubkey, partyPk, confirmation);

        // Determine which payout invoice to send
        const isPartyA = partyPk === PARTY_A_TRANSPORT_PUBKEY;
        const payoutInvoiceId = isPartyA
          ? swapState.payoutInvoiceIdA
          : swapState.payoutInvoiceIdB;
        const payoutAddress = isPartyA ? PARTY_A_ADDRESS : PARTY_B_ADDRESS;
        const payoutCurrency = isPartyA
          ? swapState.manifest.party_b_currency_to_change
          : swapState.manifest.party_a_currency_to_change;
        const payoutAmount = isPartyA
          ? swapState.manifest.party_b_value_to_change
          : swapState.manifest.party_a_value_to_change;

        const payoutDelivery = JSON.stringify({
          type: 'invoice_delivery',
          swap_id: swapId,
          invoice_type: 'payout',
          invoice_id: payoutInvoiceId,
          invoice_token: this.createMockPayoutInvoiceToken(payoutAddress, payoutCurrency, payoutAmount),
          payment_instructions: {
            your_currency: payoutCurrency,
            your_amount: payoutAmount,
            memo: `swap-payout:${swapId}`,
          },
        });
        this.relay.send(this.escrowPubkey, partyPk, payoutDelivery);
      }
    }
  }

  /**
   * Simulate escrow timeout cancellation — sends swap_cancelled to all parties.
   */
  simulateTimeout(swapId: string): void {
    const swapState = this.swapStates.get(swapId);
    if (!swapState) return;

    swapState.state = 'CANCELLED';

    for (const partyPk of swapState.announcedParties) {
      const cancelled = JSON.stringify({
        type: 'swap_cancelled',
        swap_id: swapId,
        reason: 'timeout',
        deposits_returned: true,
      });
      this.relay.send(this.escrowPubkey, partyPk, cancelled);
    }
  }

  getSwapState(swapId: string) {
    return this.swapStates.get(swapId);
  }

  /**
   * Find the swap state that owns a given deposit invoice ID.
   */
  findByDepositInvoice(depositInvoiceId: string) {
    for (const state of this.swapStates.values()) {
      if (state.depositInvoiceId === depositInvoiceId) {
        return state;
      }
    }
    return null;
  }

  private createMockInvoiceToken(swapId: string, swapState: { manifest: SwapManifest; depositInvoiceId: string }): unknown {
    return {
      version: '2.0',
      genesis: {
        data: {
          tokenId: randomHex(64),
          tokenType: '00',
          coinData: [],
          tokenData: '{}',
          salt: randomHex(64),
          recipient: ESCROW_ADDRESS,
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: {
            algorithm: 'secp256k1',
            publicKey: ESCROW_PUBKEY,
            signature: randomHex(128),
            stateHash: randomHex(64),
          },
          merkleTreePath: { root: randomHex(64), steps: [] },
          transactionHash: randomHex(64),
          unicityCertificate: randomHex(256),
        },
      },
      state: { data: randomHex(64), predicate: randomHex(64) },
      transactions: [],
    };
  }

  private createMockPayoutInvoiceToken(address: string, currency: string, amount: string): unknown {
    return {
      version: '2.0',
      genesis: {
        data: {
          tokenId: randomHex(64),
          tokenType: '00',
          coinData: [],
          tokenData: JSON.stringify({
            creator: ESCROW_PUBKEY,
            targets: [{ address, assets: [{ coin: [currency, amount] }] }],
          }),
          salt: randomHex(64),
          recipient: address,
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: {
            algorithm: 'secp256k1',
            publicKey: ESCROW_PUBKEY,
            signature: randomHex(128),
            stateHash: randomHex(64),
          },
          merkleTreePath: { root: randomHex(64), steps: [] },
          transactionHash: randomHex(64),
          unicityCertificate: randomHex(256),
        },
      },
      state: { data: randomHex(64), predicate: randomHex(64) },
      transactions: [],
    };
  }
}

// =============================================================================
// Integration party setup
// =============================================================================

interface IntegrationParty {
  module: SwapModule;
  identity: FullIdentity;
  accounting: MockAccountingModule;
  storage: MockStorageProvider;
  payments: MockPaymentsModule;
  events: Array<[string, unknown]>;
}

interface SwapTestContext {
  partyA: IntegrationParty;
  partyB: IntegrationParty;
  escrow: EscrowSimulator;
  relay: MockDMRelay;
}

function createPeerMap(): Map<string, PeerInfo> {
  const peers = new Map<string, PeerInfo>();

  const partyAPeer: PeerInfo = {
    chainPubkey: PARTY_A_PUBKEY,
    directAddress: PARTY_A_ADDRESS,
    transportPubkey: 'a'.repeat(64),
    l1Address: 'alpha1partyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nametag: 'alice',
    timestamp: Date.now(),
  };
  peers.set(PARTY_A_PUBKEY, partyAPeer);
  peers.set(PARTY_A_ADDRESS, partyAPeer);
  peers.set('@alice', partyAPeer);

  const partyBPeer: PeerInfo = {
    chainPubkey: PARTY_B_PUBKEY,
    directAddress: PARTY_B_ADDRESS,
    transportPubkey: 'b'.repeat(64),
    l1Address: 'alpha1partybbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nametag: 'bob',
    timestamp: Date.now(),
  };
  peers.set(PARTY_B_PUBKEY, partyBPeer);
  peers.set(PARTY_B_ADDRESS, partyBPeer);
  peers.set('@bob', partyBPeer);

  const escrowPeer: PeerInfo = {
    chainPubkey: ESCROW_PUBKEY,
    directAddress: ESCROW_ADDRESS,
    transportPubkey: 'e'.repeat(64),
    l1Address: 'alpha1escroweeeeeeeeeeeeeeeeeeeeeeeeeeee',
    nametag: 'escrow',
    timestamp: Date.now(),
  };
  peers.set(ESCROW_PUBKEY, escrowPeer);
  peers.set(ESCROW_ADDRESS, escrowPeer);
  peers.set('@escrow', escrowPeer);

  return peers;
}

function createParty(
  relay: MockDMRelay,
  identity: FullIdentity,
  peerMap: Map<string, PeerInfo>,
  transportPubkey: string,
): IntegrationParty {
  const accounting = createMockAccountingModule();
  const storage = createMockStorageProvider();
  const payments = createMockPaymentsModule();
  const events: Array<[string, unknown]> = [];

  const emitEvent = vi.fn().mockImplementation((type: string, data: unknown) => {
    events.push([type, data]);
  });

  const resolve = vi.fn().mockImplementation((identifier: string): Promise<PeerInfo | null> => {
    return Promise.resolve(peerMap.get(identifier) ?? null);
  });

  const trackedAddress: TrackedAddress = {
    index: 0,
    addressId: identity.directAddress!.replace('DIRECT://', 'DIRECT_'),
    l1Address: identity.l1Address,
    directAddress: identity.directAddress!,
    chainPubkey: identity.chainPubkey,
    nametag: identity.nametag,
    hidden: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Create a real communications mock that routes through the relay
  const dmHandlers: Array<(message: { senderPubkey: string; senderNametag?: string; content: string; timestamp: number }) => void> = [];

  const communications = {
    sendDM: vi.fn().mockImplementation((recipientPubkey: string, content: string) => {
      // Sender uses transport pubkey (matches real DM behavior)
      relay.send(transportPubkey, recipientPubkey, content, identity.nametag);
      return Promise.resolve({ eventId: 'evt-' + randomHex(8) });
    }),
    onDirectMessage: vi.fn().mockImplementation(
      (handler: (message: { senderPubkey: string; senderNametag?: string; content: string; timestamp: number }) => void) => {
        dmHandlers.push(handler);
        // Register this party on the relay to receive DMs by transport pubkey
        const unsub = relay.register(transportPubkey, handler);
        return () => {
          unsub();
          const idx = dmHandlers.indexOf(handler);
          if (idx !== -1) dmHandlers.splice(idx, 1);
        };
      },
    ),
  };

  const config: SwapModuleConfig = {
    debug: false,
    defaultEscrowAddress: ESCROW_ADDRESS,
    proposalTimeoutMs: 60_000,
    announceTimeoutMs: 30_000,
  };

  const module = createSwapModule(config);

  const deps: SwapModuleDependencies = {
    accounting,
    payments,
    communications,
    storage,
    identity,
    emitEvent: emitEvent as <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void,
    resolve: resolve as (identifier: string) => Promise<PeerInfo | null>,
    getActiveAddresses: () => [trackedAddress],
  };

  module.initialize(deps);

  return { module, identity, accounting, storage, payments, events };
}

function createSwapTestPair(): SwapTestContext {
  const relay = new MockDMRelay();
  const peerMap = createPeerMap();

  const identityA: FullIdentity = {
    chainPubkey: PARTY_A_PUBKEY,
    directAddress: PARTY_A_ADDRESS,
    l1Address: 'alpha1partyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nametag: 'alice',
    privateKey: 'a'.repeat(64),
  };

  const identityB: FullIdentity = {
    chainPubkey: PARTY_B_PUBKEY,
    directAddress: PARTY_B_ADDRESS,
    l1Address: 'alpha1partybbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nametag: 'bob',
    privateKey: 'b'.repeat(64),
  };

  const partyA = createParty(relay, identityA, peerMap, PARTY_A_TRANSPORT_PUBKEY);
  const partyB = createParty(relay, identityB, peerMap, PARTY_B_TRANSPORT_PUBKEY);
  const escrow = new EscrowSimulator(relay, ESCROW_TRANSPORT_PUBKEY);

  return { partyA, partyB, escrow, relay };
}

function createDeal(overrides?: Partial<SwapDeal>): SwapDeal {
  return {
    partyA: PARTY_A_ADDRESS,
    partyB: PARTY_B_ADDRESS,
    partyACurrency: 'UCT',
    partyAAmount: '1000000',
    partyBCurrency: 'USDU',
    partyBAmount: '500000',
    timeout: 300,
    escrowAddress: ESCROW_ADDRESS,
    ...overrides,
  };
}

/** Wait for async DM processing to settle. */
async function settle(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function findEvent(events: Array<[string, unknown]>, type: string): unknown | undefined {
  const entry = events.find(([t]) => t === type);
  return entry ? entry[1] : undefined;
}

function findEvents(events: Array<[string, unknown]>, type: string): unknown[] {
  return events.filter(([t]) => t === type).map(([, d]) => d);
}

// =============================================================================
// Configure mock accounting to return correct deposit invoice structure
// =============================================================================

/**
 * Configure accounting mock so that getInvoice returns a valid deposit
 * invoice structure for any deposit-invoice ID. This must be called BEFORE
 * the escrow simulator delivers the invoice_delivery DM, because the
 * SwapModule validates the invoice terms inline in the DM handler.
 *
 * Uses the EscrowSimulator to map deposit invoice IDs to their manifests
 * at call time.
 */
function configureAccountingForDeposit(
  party: IntegrationParty,
  escrow: EscrowSimulator,
): void {
  party.accounting.getInvoice.mockImplementation((invoiceId: string) => {
    // Search escrow swap states for a matching deposit invoice ID
    if (invoiceId.startsWith('deposit-inv-')) {
      // Find the swap that owns this deposit invoice
      const swapState = escrow.findByDepositInvoice(invoiceId);
      if (swapState) {
        const m = swapState.manifest;
        return {
          invoiceId,
          terms: {
            creator: ESCROW_PUBKEY,
            targets: [{
              address: ESCROW_ADDRESS,
              assets: [
                { coin: [m.party_a_currency_to_change, m.party_a_value_to_change] },
                { coin: [m.party_b_currency_to_change, m.party_b_value_to_change] },
              ],
            }],
          },
        };
      }
    }

    // Check payout invoice implementations (set by configureAccountingForPayout)
    const payoutImpl = (party.accounting as any)._payoutGetInvoice;
    if (payoutImpl) {
      const result = payoutImpl(invoiceId);
      if (result) return result;
    }

    return null;
  });
}

function configureAccountingForPayout(
  party: IntegrationParty,
  _swapId: string,
  payoutInvoiceId: string,
  targetAddress: string,
  currency: string,
  amount: string,
): void {
  // Store payout invoice lookup as a separate function so the deposit mock
  // can delegate to it without circular chaining issues.
  const payoutInvoices: Map<string, unknown> = (party.accounting as any)._payoutInvoices ?? new Map();
  payoutInvoices.set(payoutInvoiceId, {
    invoiceId: payoutInvoiceId,
    terms: {
      creator: ESCROW_PUBKEY,
      targets: [{
        address: targetAddress,
        assets: [{ coin: [currency, amount] }],
      }],
    },
  });
  (party.accounting as any)._payoutInvoices = payoutInvoices;

  // Store the payout lookup function for the deposit mock to call
  (party.accounting as any)._payoutGetInvoice = (id: string) => payoutInvoices.get(id) ?? null;

  const prevGetInvoice = party.accounting.getInvoice.getMockImplementation();
  party.accounting.getInvoice.mockImplementation((invoiceId: string) => {
    // Check payout invoices first
    const payoutResult = payoutInvoices.get(invoiceId);
    if (payoutResult) return payoutResult;
    // Delegate to previous impl (deposit mock)
    return prevGetInvoice ? prevGetInvoice(invoiceId) : null;
  });

  const prevGetStatus = party.accounting.getInvoiceStatus.getMockImplementation();
  party.accounting.getInvoiceStatus.mockImplementation((invoiceId: string) => {
    if (invoiceId === payoutInvoiceId) {
      return {
        invoiceId: payoutInvoiceId,
        state: 'COVERED',
        targets: [{
          coinAssets: [{
            coin: [currency, amount],
            netCoveredAmount: amount,
            isCovered: true,
          }],
        }],
        totalForward: { [currency]: amount },
        totalBack: {},
        allConfirmed: true,
        lastActivityAt: Date.now(),
      };
    }
    return prevGetStatus ? prevGetStatus(invoiceId) : {
      invoiceId,
      state: 'OPEN',
      targets: [],
      totalForward: {},
      totalBack: {},
      allConfirmed: false,
      lastActivityAt: Date.now(),
    };
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Swap Lifecycle Integration Tests', () => {
  let ctx: SwapTestContext;

  beforeEach(async () => {
    ctx = createSwapTestPair();
    await ctx.partyA.module.load();
    await ctx.partyB.module.load();
  });

  afterEach(async () => {
    await ctx.partyA.module.destroy();
    await ctx.partyB.module.destroy();
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-001: Happy path full lifecycle
  // ---------------------------------------------------------------------------
  it('INT-SWAP-001: happy path — propose, accept, announce, deposit, conclude, verify', async () => {
    const deal = createDeal();

    // Step 1: Party A proposes swap to party B
    const proposalResult = await ctx.partyA.module.proposeSwap(deal);
    const swapId = proposalResult.swapId;
    expect(swapId).toBeTruthy();
    expect(proposalResult.swap.progress).toBe('proposed');
    expect(proposalResult.swap.role).toBe('proposer');

    // Wait for party B to receive the proposal DM
    await settle();

    // Step 2: Party B should have received the proposal
    const partyBProposalEvent = findEvent(ctx.partyB.events, 'swap:proposal_received');
    expect(partyBProposalEvent).toBeDefined();
    expect((partyBProposalEvent as { swapId: string }).swapId).toBe(swapId);

    // Step 3: Party B accepts the proposal
    // Configure accounting for deposit invoice verification before accept
    // (accept triggers announce which triggers escrow response with invoice_delivery)
    const manifest = proposalResult.manifest;
    // Configure accounting BEFORE accept (escrow responds synchronously via relay)
    configureAccountingForDeposit(ctx.partyA, ctx.escrow);
    configureAccountingForDeposit(ctx.partyB, ctx.escrow);

    await ctx.partyB.module.acceptSwap(swapId);
    await settle(150);

    // After acceptance, both should transition through accepted -> announced
    // The escrow simulator responds to the announce with announce_result + invoice_delivery

    // Both parties should be in 'announced' state (escrow delivered deposit invoice)
    const partyAStatus = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    const partyBStatus = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(partyAStatus.progress).toBe('announced');
    expect(partyBStatus.progress).toBe('announced');

    await ctx.partyA.module.deposit(swapId);
    await ctx.partyB.module.deposit(swapId);

    // Step 5: Escrow detects both deposits
    ctx.escrow.simulateDeposit(swapId, PARTY_A_TRANSPORT_PUBKEY);
    ctx.escrow.simulateDeposit(swapId, PARTY_B_TRANSPORT_PUBKEY);
    await settle(100);

    // Both should receive payment_confirmation -> concluding -> payout invoice_delivery
    // Configure payout invoice verification
    const partyAAfterDeposit = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    const partyBAfterDeposit = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });

    // Parties should be in concluding or later
    expect(['concluding', 'completed']).toContain(partyAAfterDeposit.progress);
    expect(['concluding', 'completed']).toContain(partyBAfterDeposit.progress);

    // Configure accounting for payout verification
    if (partyAAfterDeposit.payoutInvoiceId) {
      configureAccountingForPayout(
        ctx.partyA, swapId, partyAAfterDeposit.payoutInvoiceId,
        PARTY_A_ADDRESS, manifest.party_b_currency_to_change, manifest.party_b_value_to_change,
      );
    }
    if (partyBAfterDeposit.payoutInvoiceId) {
      configureAccountingForPayout(
        ctx.partyB, swapId, partyBAfterDeposit.payoutInvoiceId,
        PARTY_B_ADDRESS, manifest.party_a_currency_to_change, manifest.party_a_value_to_change,
      );
    }

    // Step 6: Both parties verify payout
    if (partyAAfterDeposit.payoutInvoiceId) {
      const aVerified = await ctx.partyA.module.verifyPayout(swapId);
      expect(aVerified).toBe(true);
    }
    if (partyBAfterDeposit.payoutInvoiceId) {
      const bVerified = await ctx.partyB.module.verifyPayout(swapId);
      expect(bVerified).toBe(true);
    }

    // Step 7: Assert both in 'completed' state
    const finalA = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    const finalB = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(finalA.progress).toBe('completed');
    expect(finalB.progress).toBe('completed');

    // Verify events were emitted in correct order
    expect(findEvent(ctx.partyA.events, 'swap:proposed')).toBeDefined();
    expect(findEvent(ctx.partyB.events, 'swap:proposal_received')).toBeDefined();
    expect(findEvent(ctx.partyB.events, 'swap:accepted')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-002: Rejection flow
  // ---------------------------------------------------------------------------
  it('INT-SWAP-002: rejection flow — propose, reject', async () => {
    const deal = createDeal();

    // Step 1: Party A proposes
    const proposalResult = await ctx.partyA.module.proposeSwap(deal);
    const swapId = proposalResult.swapId;
    await settle();

    // Step 2: Party B receives proposal
    const proposalEvent = findEvent(ctx.partyB.events, 'swap:proposal_received');
    expect(proposalEvent).toBeDefined();

    // Step 3: Party B rejects
    await ctx.partyB.module.rejectSwap(swapId, 'Bad rate');
    await settle();

    // Step 4: Party A receives rejection DM -> transitions to 'cancelled'
    const partyAStatus = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(partyAStatus.progress).toBe('cancelled');

    // Party B's swap should also be 'cancelled' (rejected transitions to cancelled)
    const partyBStatus = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(partyBStatus.progress).toBe('cancelled');

    // Verify events
    const partyARejectedEvent = findEvent(ctx.partyA.events, 'swap:rejected') as { swapId: string; reason?: string } | undefined;
    expect(partyARejectedEvent).toBeDefined();
    expect(partyARejectedEvent!.reason).toBe('Bad rate');

    const partyACancelledEvent = findEvent(ctx.partyA.events, 'swap:cancelled') as { swapId: string; reason: string } | undefined;
    expect(partyACancelledEvent).toBeDefined();

    const partyBRejectedEvent = findEvent(ctx.partyB.events, 'swap:rejected') as { swapId: string; reason?: string } | undefined;
    expect(partyBRejectedEvent).toBeDefined();

    const partyBCancelledEvent = findEvent(ctx.partyB.events, 'swap:cancelled') as { swapId: string; reason: string } | undefined;
    expect(partyBCancelledEvent).toBeDefined();
    expect(partyBCancelledEvent!.reason).toBe('rejected');
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-003: Timeout cancellation flow
  // ---------------------------------------------------------------------------
  it('INT-SWAP-003: timeout cancellation — escrow sends swap_cancelled after timeout', async () => {
    const deal = createDeal();

    // Step 1: Party A proposes
    const proposalResult = await ctx.partyA.module.proposeSwap(deal);
    const swapId = proposalResult.swapId;
    const manifest = proposalResult.manifest;
    await settle();

    // Step 2: Party B accepts
    configureAccountingForDeposit(ctx.partyA, ctx.escrow);
    configureAccountingForDeposit(ctx.partyB, ctx.escrow);
    await ctx.partyB.module.acceptSwap(swapId);
    await settle(150);

    // Both should be announced
    const statusA = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    const statusB = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(statusA.progress).toBe('announced');
    expect(statusB.progress).toBe('announced');
    await ctx.partyA.module.deposit(swapId);

    // Step 4: Escrow times out and sends swap_cancelled
    ctx.escrow.simulateTimeout(swapId);
    await settle(100);

    // Step 5: Assert both parties in 'cancelled' state
    const finalA = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    const finalB = await ctx.partyB.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(finalA.progress).toBe('cancelled');
    expect(finalB.progress).toBe('cancelled');

    // Verify cancel events with reason 'timeout'
    const cancelEventsA = findEvents(ctx.partyA.events, 'swap:cancelled') as Array<{ reason: string; depositsReturned?: boolean }>;
    expect(cancelEventsA.length).toBeGreaterThan(0);
    const timeoutEventA = cancelEventsA.find(e => e.reason === 'timeout');
    expect(timeoutEventA).toBeDefined();
    expect(timeoutEventA!.depositsReturned).toBe(true);

    const cancelEventsB = findEvents(ctx.partyB.events, 'swap:cancelled') as Array<{ reason: string; depositsReturned?: boolean }>;
    expect(cancelEventsB.length).toBeGreaterThan(0);
    const timeoutEventB = cancelEventsB.find(e => e.reason === 'timeout');
    expect(timeoutEventB).toBeDefined();
    expect(timeoutEventB!.depositsReturned).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-004: Party A cancels before deposit
  // ---------------------------------------------------------------------------
  it('INT-SWAP-004: party A cancels before deposit', async () => {
    const deal = createDeal();

    // Step 1: Party A proposes, party B accepts
    const proposalResult = await ctx.partyA.module.proposeSwap(deal);
    const swapId = proposalResult.swapId;
    const manifest = proposalResult.manifest;
    await settle();

    configureAccountingForDeposit(ctx.partyA, ctx.escrow);
    configureAccountingForDeposit(ctx.partyB, ctx.escrow);
    await ctx.partyB.module.acceptSwap(swapId);
    await settle(150);

    // Both should be announced
    const statusA = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(statusA.progress).toBe('announced');

    // Step 2: Party A cancels before depositing
    await ctx.partyA.module.cancelSwap(swapId);

    // Step 3: Assert party A's swap is 'cancelled'
    const finalA = await ctx.partyA.module.getSwapStatus(swapId, { queryEscrow: false });
    expect(finalA.progress).toBe('cancelled');

    // Verify cancel event with reason 'explicit'
    const cancelEventsA = findEvents(ctx.partyA.events, 'swap:cancelled') as Array<{ reason: string }>;
    const explicitCancel = cancelEventsA.find(e => e.reason === 'explicit');
    expect(explicitCancel).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-005: Concurrent proposal — same deal from both sides
  // ---------------------------------------------------------------------------
  it('INT-SWAP-005: concurrent proposal — same deal produces different swap_ids (unique salt)', async () => {
    const dealAB = createDeal();
    const dealBA = createDeal();

    // Both parties propose the same deal simultaneously
    const [resultA, resultB] = await Promise.all([
      ctx.partyA.module.proposeSwap(dealAB),
      ctx.partyB.module.proposeSwap(dealBA),
    ]);

    // Each call generates a unique salt, so swap_ids differ
    expect(resultA.swapId).not.toBe(resultB.swapId);

    await settle(100);

    // Each party has their own proposal plus potentially received the other's via DM
    const swapsA = ctx.partyA.module.getSwaps();
    const swapsB = ctx.partyB.module.getSwaps();

    // Party A should have at least their own proposal
    const ownA = swapsA.filter(s => s.swapId === resultA.swapId);
    expect(ownA.length).toBe(1);

    // Party B should have at least their own proposal
    const ownB = swapsB.filter(s => s.swapId === resultB.swapId);
    expect(ownB.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // INT-SWAP-006: Multiple independent swaps in parallel
  // ---------------------------------------------------------------------------
  it('INT-SWAP-006: multiple independent swaps between same parties', async () => {
    const deal1 = createDeal({
      partyACurrency: 'UCT',
      partyAAmount: '1000000',
      partyBCurrency: 'USDU',
      partyBAmount: '500000',
    });
    const deal2 = createDeal({
      partyACurrency: 'UCT',
      partyAAmount: '2000000',
      partyBCurrency: 'EUR',
      partyBAmount: '800000',
    });
    const deal3 = createDeal({
      partyACurrency: 'BTC',
      partyAAmount: '100000',
      partyBCurrency: 'USDU',
      partyBAmount: '3000000',
    });

    // Step 1: Party A proposes all three swaps
    const [result1, result2, result3] = await Promise.all([
      ctx.partyA.module.proposeSwap(deal1),
      ctx.partyA.module.proposeSwap(deal2),
      ctx.partyA.module.proposeSwap(deal3),
    ]);

    // All three should have different swap IDs
    expect(new Set([result1.swapId, result2.swapId, result3.swapId]).size).toBe(3);

    await settle(100);

    // Step 2: Party B should have received all three proposals
    const proposalEvents = findEvents(ctx.partyB.events, 'swap:proposal_received') as Array<{ swapId: string }>;
    expect(proposalEvents.length).toBe(3);
    const receivedIds = new Set(proposalEvents.map(e => e.swapId));
    expect(receivedIds.has(result1.swapId)).toBe(true);
    expect(receivedIds.has(result2.swapId)).toBe(true);
    expect(receivedIds.has(result3.swapId)).toBe(true);

    // Configure accounting before accepts (escrow responds synchronously via relay)
    configureAccountingForDeposit(ctx.partyA, ctx.escrow);
    configureAccountingForDeposit(ctx.partyB, ctx.escrow);

    // Step 3: Party B accepts all three
    await ctx.partyB.module.acceptSwap(result1.swapId);
    await ctx.partyB.module.acceptSwap(result2.swapId);
    await ctx.partyB.module.acceptSwap(result3.swapId);
    await settle(200);

    // Step 4: All three should progress independently
    const swapsA = ctx.partyA.module.getSwaps({ excludeTerminal: true });
    const swapsB = ctx.partyB.module.getSwaps({ excludeTerminal: true });

    // Party A should have 3 active swaps
    expect(swapsA.length).toBe(3);

    // Party B should have 3 active swaps
    expect(swapsB.length).toBe(3);

    // Each swap should have different swap IDs
    const idsA = new Set(swapsA.map(s => s.swapId));
    const idsB = new Set(swapsB.map(s => s.swapId));
    expect(idsA.size).toBe(3);
    expect(idsB.size).toBe(3);
  });
});
