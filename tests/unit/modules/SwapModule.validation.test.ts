/**
 * SwapModule input validation unit tests.
 *
 * Test IDs: UT-SWAP-VAL-001 through UT-SWAP-VAL-020
 * @see docs/SWAP-TEST-SPEC.md section 3.14
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapDeal,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_A_PUBKEY,
  DEFAULT_TEST_PARTY_B_ADDRESS,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import type { PeerInfo } from '../../../transport/transport-provider.js';

describe('SwapModule input validation', () => {
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
      // ignore if already destroyed
    }
  });

  // =========================================================================
  // Address Format Validation
  // =========================================================================

  describe('Address format validation', () => {
    it('UT-SWAP-VAL-001: accepts DIRECT:// address for partyA', async () => {
      const deal = createTestSwapDeal({ partyA: DEFAULT_TEST_PARTY_A_ADDRESS });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-002: accepts @nametag for partyA (resolved)', async () => {
      const deal = createTestSwapDeal({ partyA: '@alice' });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-003: accepts chain pubkey for partyA', async () => {
      const pubkey = DEFAULT_TEST_PARTY_A_PUBKEY;
      // Ensure resolve mock handles the chain pubkey
      mocks.resolve._peers.set(pubkey, mocks.resolve._peers.get(DEFAULT_TEST_PARTY_A_ADDRESS)!);

      const deal = createTestSwapDeal({ partyA: pubkey });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-004: accepts L1 address for partyA', async () => {
      const l1Addr = 'alpha1partyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      // Register L1 address in resolve mock
      const peerA = mocks.resolve._peers.get(DEFAULT_TEST_PARTY_A_ADDRESS)!;
      mocks.resolve._peers.set(l1Addr, peerA);

      const deal = createTestSwapDeal({ partyA: l1Addr });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-005: rejects empty partyA', async () => {
      const deal = createTestSwapDeal({ partyA: '' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-006: rejects null partyA', async () => {
      const deal = createTestSwapDeal({ partyA: null as unknown as string });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });
  });

  // =========================================================================
  // Amount Format Validation
  // =========================================================================

  describe('Amount format validation', () => {
    it('UT-SWAP-VAL-007: accepts valid amount (1000000)', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '1000000' });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-008: accepts minimum amount (1)', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '1' });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-009: rejects zero amount', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '0' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-010: rejects negative amount', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '-100' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-011: rejects decimal amount', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '10.5' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-012: rejects empty amount string', async () => {
      const deal = createTestSwapDeal({ partyAAmount: '' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-013: rejects non-numeric amount', async () => {
      const deal = createTestSwapDeal({ partyAAmount: 'abc' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });
  });

  // =========================================================================
  // Currency Format Validation
  // =========================================================================

  describe('Currency format validation', () => {
    it('UT-SWAP-VAL-014: accepts valid currency UCT', async () => {
      const deal = createTestSwapDeal({ partyACurrency: 'UCT' });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-015: accepts valid currency USDU', async () => {
      const deal = createTestSwapDeal({ partyBCurrency: 'USDU' });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-016: rejects empty currency string', async () => {
      const deal = createTestSwapDeal({ partyACurrency: '' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });

    it('UT-SWAP-VAL-017: rejects currency with special characters (hyphen)', async () => {
      const deal = createTestSwapDeal({ partyACurrency: 'UC-T' });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });
  });

  // =========================================================================
  // Timeout Range Validation
  // =========================================================================

  describe('Timeout range validation', () => {
    it('UT-SWAP-VAL-018: accepts minimum timeout (60)', async () => {
      const deal = createTestSwapDeal({ timeout: 60 });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-019: accepts maximum timeout (86400)', async () => {
      const deal = createTestSwapDeal({ timeout: 86400 });
      const result = await module.proposeSwap(deal);
      expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('UT-SWAP-VAL-020: rejects zero timeout', async () => {
      const deal = createTestSwapDeal({ timeout: 0 });
      await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    });
  });
});
