/**
 * SwapModule.transport-pubkey.test.ts
 *
 * Issue #457 — fail-fast when a resolved counterparty / escrow peer is
 * missing `transportPubkey`. The pre-fix code silently fell back to
 * `chainPubkey`, sealing NIP-17 DMs to a key the receiver's wallet does
 * NOT subscribe to. Now the three sites in `modules/swap/SwapModule.ts`
 * throw a typed `SWAP_PEER_NO_TRANSPORT` `SphereError`.
 *
 * Covers all three call sites:
 *   1. `proposeSwap` counterparty resolution (rejects the proposeSwap call)
 *   2. `proposeSwap` escrow peer resolution (rejects the proposeSwap call)
 *   3. `getSwapStatus` escrow status-DM send (fire-and-forget — the throw
 *      is caught and logged by the existing `.catch`, but the failing
 *      `sendDM` call is observably skipped)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapDeal,
  createTestSwapRef,
  injectSwapRef,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_PARTY_B_PUBKEY,
  DEFAULT_TEST_ESCROW_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  SphereError,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import type { PeerInfo } from '../../../transport/transport-provider.js';

describe('SwapModule — Issue #457 fail-fast on missing transportPubkey', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  afterEach(async () => {
    try {
      await module.destroy();
    } catch {
      // ignore double-destroy
    }
  });

  // ---------------------------------------------------------------------------
  // Site #1: proposeSwap — counterparty resolve
  // ---------------------------------------------------------------------------

  it('rejects proposeSwap with SWAP_PEER_NO_TRANSPORT when counterparty peer binding has no transportPubkey', async () => {
    // Mutate the resolve mock so partyB (the counterparty) resolves to a
    // PeerInfo whose `transportPubkey` is undefined. This simulates the
    // §457 partial-propagation scenario.
    const incompleteBinding: PeerInfo = {
      chainPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      directAddress: DEFAULT_TEST_PARTY_B_ADDRESS,
      transportPubkey: undefined as unknown as string, // partially propagated binding
      l1Address: 'alpha1partybbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      nametag: 'bob-demo06',
      timestamp: Date.now(),
    };
    mocks.resolve._peers.set(DEFAULT_TEST_PARTY_B_ADDRESS, incompleteBinding);
    mocks.resolve._peers.set(DEFAULT_TEST_PARTY_B_PUBKEY, incompleteBinding);
    mocks.resolve._peers.set('@bob-demo06', incompleteBinding);

    const deal = createTestSwapDeal({ partyB: '@bob-demo06' });

    await expect(module.proposeSwap(deal)).rejects.toMatchObject({
      code: 'SWAP_PEER_NO_TRANSPORT',
    });

    // No DM should have been sent — the throw fires before sendDM.
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();

    // The thrown error MUST be a SphereError with actionable text.
    let captured: unknown = null;
    try {
      await module.proposeSwap(deal);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SphereError);
    expect((captured as SphereError).code).toBe('SWAP_PEER_NO_TRANSPORT');
    // Message must mention the binding-propagation cause + remediation.
    expect((captured as Error).message).toMatch(/binding/i);
    expect((captured as Error).message).toMatch(/propagat/i);
    // Peer identification (nametag preferred) should appear so operators
    // can tell WHICH peer was incomplete.
    expect((captured as Error).message).toMatch(/@bob-demo06/);
  });

  // ---------------------------------------------------------------------------
  // Site #2: proposeSwap — escrow resolve
  // ---------------------------------------------------------------------------

  it('rejects proposeSwap with SWAP_PEER_NO_TRANSPORT when escrow peer binding has no transportPubkey', async () => {
    // Counterparty resolves fine; the escrow itself has incomplete binding.
    const escrowIncomplete: PeerInfo = {
      chainPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      directAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      transportPubkey: undefined as unknown as string,
      l1Address: 'alpha1escroweeeeeeeeeeeeeeeeeeeeeeeeeeee',
      nametag: 'escrow',
      timestamp: Date.now(),
    };
    mocks.resolve._peers.set(DEFAULT_TEST_ESCROW_ADDRESS, escrowIncomplete);
    mocks.resolve._peers.set(DEFAULT_TEST_ESCROW_PUBKEY, escrowIncomplete);
    mocks.resolve._peers.set('@escrow', escrowIncomplete);

    const deal = createTestSwapDeal();

    await expect(module.proposeSwap(deal)).rejects.toMatchObject({
      code: 'SWAP_PEER_NO_TRANSPORT',
    });

    // No counterparty DM should have escaped either — the proposeSwap
    // function builds the SwapRef AFTER counterparty resolve, and the
    // escrow throw fires before counterparty DM dispatch. (The fix order
    // is: counterparty.transportPubkey check, then SwapRef construction
    // which includes the escrow check.)
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();

    let captured: unknown = null;
    try {
      await module.proposeSwap(deal);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SphereError);
    expect((captured as SphereError).code).toBe('SWAP_PEER_NO_TRANSPORT');
    // Context label should identify this as the escrow site.
    expect((captured as Error).message).toMatch(/escrow/i);
  });

  // ---------------------------------------------------------------------------
  // Site #3: getSwapStatus — fire-and-forget status DM
  // ---------------------------------------------------------------------------

  it('skips (does not silently fall back) the status DM when escrow peer is missing transportPubkey in getSwapStatus', async () => {
    // Seed an active swap so getSwapStatus has something to query.
    const ref = createTestSwapRef({ progress: 'awaiting_counter' });
    injectSwapRef(module, ref);

    // Now mutate the escrow binding to be incomplete (after injection so
    // the SwapRef itself isn't affected).
    const escrowIncomplete: PeerInfo = {
      chainPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      directAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      transportPubkey: undefined as unknown as string,
      l1Address: 'alpha1escroweeeeeeeeeeeeeeeeeeeeeeeeeeee',
      nametag: 'escrow',
      timestamp: Date.now(),
    };
    mocks.resolve._peers.set(DEFAULT_TEST_ESCROW_ADDRESS, escrowIncomplete);
    mocks.resolve._peers.set(DEFAULT_TEST_ESCROW_PUBKEY, escrowIncomplete);
    mocks.resolve._peers.set('@escrow', escrowIncomplete);

    // getSwapStatus is fire-and-forget for the status DM; the call itself
    // must STILL return a SwapRef without throwing.
    const result = await module.getSwapStatus(ref.swapId, { queryEscrow: true });
    expect(result.swapId).toBe(ref.swapId);

    // Give the fire-and-forget promise a microtask flush to settle.
    await Promise.resolve();
    await Promise.resolve();

    // The pre-fix code would have called sendDM with the escrow's
    // chainPubkey (silent black-hole). With the fix, sendDM must NEVER
    // have been called.
    expect(mocks.communications.sendDM).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Regression check: happy path (transportPubkey present) still works.
  // ---------------------------------------------------------------------------

  it('proposeSwap continues to work when transportPubkey IS present on both peers', async () => {
    // Default mock peers already include transportPubkey, so this should
    // just succeed.
    const deal = createTestSwapDeal();
    const result = await module.proposeSwap(deal);
    expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.communications.sendDM).toHaveBeenCalled();
  });
});
