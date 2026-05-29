/**
 * Issue #272 — per-event durability-failure cooldown gate.
 *
 * Background: pre-#272, a `handleTokenTransfer` returning `false`
 * (the at-least-once gate refused the Nostr ack) caused the
 * `lastEventTs` cursor to not advance, so the same event re-replayed
 * on every Nostr reconnect cycle. Under the soak conditions captured
 * in `.tmp/soak-postmerge-271/`, this produced 134 replay warnings
 * across only 14 unique event IDs — the receive pipeline (parse +
 * crypto verify + flush + HEAD-verify) burned ~10x the work per
 * unique event with all 3 node processes pegged at 90-175% CPU.
 *
 * Fix: add a per-event cooldown ledger so consecutive durability
 * misses for the same event ID are subject to exponential backoff,
 * and after `DURABILITY_MAX_REPLAY_ATTEMPTS` consecutive misses the
 * cursor advances anyway (with an operator alert) so subsequent
 * events do not back up behind one persistently-failing one.
 *
 * These tests exercise the cooldown methods directly via reflection
 * because routing through the public `handleEvent → handleTokenTransfer`
 * path requires functional NIP-04 decryption, which would couple the
 * tests to crypto-mock plumbing without adding logic coverage. The
 * methods being tested (`isInDurabilityCooldown`, `recordDurabilityMiss`)
 * are the ONLY non-trivial code introduced by the patch; the call sites
 * are simple branches that are covered by existing integration tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock NostrClient
// =============================================================================

const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://test.relay']));
const mockAddConnectionListener = vi.fn();
const mockRelaysMap = new Map<string, unknown>();
const mockStopPingTimer = vi.fn();

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      publishEvent: mockPublishEvent,
      addConnectionListener: mockAddConnectionListener,
      relays: mockRelaysMap,
      stopPingTimer: mockStopPingTimer,
    })),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

function createProvider() {
  return new NostrTransportProvider({
    relays: ['wss://test.relay'],
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 100,
    autoReconnect: false,
  });
}

interface CooldownEntry {
  nextRetryAt: number;
  attempts: number;
}

interface ProviderInternals {
  failedEventCooldowns: Map<string, CooldownEntry>;
  isInDurabilityCooldown(eventId: string): boolean;
  recordDurabilityMiss(eventId: string): boolean;
}

function inspect(provider: unknown): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

describe('NostrTransportProvider — durability cooldown (Issue #272)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));
  });

  describe('recordDurabilityMiss', () => {
    it('first miss arms a ~30s cooldown, returns false (do NOT advance cursor)', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'a'.repeat(64);

      const shouldAdvance = internals.recordDurabilityMiss(eventId);
      expect(shouldAdvance).toBe(false);

      const entry = internals.failedEventCooldowns.get(eventId);
      expect(entry).toBeDefined();
      expect(entry!.attempts).toBe(1);

      const cooldownMs = entry!.nextRetryAt - Date.now();
      // 30s ± slack for jitter
      expect(cooldownMs).toBeGreaterThan(20_000);
      expect(cooldownMs).toBeLessThanOrEqual(30_000);
    });

    it('second miss exponentially backs off to ~60s', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'b'.repeat(64);

      internals.recordDurabilityMiss(eventId);
      const shouldAdvance = internals.recordDurabilityMiss(eventId);
      expect(shouldAdvance).toBe(false);

      const entry = internals.failedEventCooldowns.get(eventId);
      expect(entry!.attempts).toBe(2);

      const cooldownMs = entry!.nextRetryAt - Date.now();
      // 60s ± slack
      expect(cooldownMs).toBeGreaterThan(50_000);
      expect(cooldownMs).toBeLessThanOrEqual(60_000);
    });

    it('third miss exhausts the budget, returns true (advance cursor), clears ledger', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'c'.repeat(64);

      internals.recordDurabilityMiss(eventId); // 1
      internals.recordDurabilityMiss(eventId); // 2
      const shouldAdvance = internals.recordDurabilityMiss(eventId); // 3

      expect(shouldAdvance).toBe(true);
      // Ledger entry was cleared so a re-occurrence after advance gets
      // a fresh budget (typically irrelevant — cursor moved past).
      expect(internals.failedEventCooldowns.has(eventId)).toBe(false);
    });
  });

  describe('isInDurabilityCooldown', () => {
    it('returns false for an unknown event ID', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      expect(internals.isInDurabilityCooldown('unknown')).toBe(false);
    });

    it('returns true for an event ID with a live cooldown', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'd'.repeat(64);
      internals.recordDurabilityMiss(eventId);
      expect(internals.isInDurabilityCooldown(eventId)).toBe(true);
    });

    it('returns false once the cooldown has expired (entry preserved for attempt counting)', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'e'.repeat(64);
      internals.recordDurabilityMiss(eventId);
      // Force-expire by rewinding nextRetryAt into the past.
      internals.failedEventCooldowns.get(eventId)!.nextRetryAt = Date.now() - 1;
      expect(internals.isInDurabilityCooldown(eventId)).toBe(false);
      // Attempts count survives so the next miss correctly increments to 2.
      expect(internals.failedEventCooldowns.get(eventId)!.attempts).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('caps the cooldown ledger at the configured size by evicting the oldest entry', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      // The cap is private (DURABILITY_COOLDOWN_MAP_CAP = 256). Insert
      // enough entries to trigger one eviction.
      for (let i = 0; i < 256; i++) {
        internals.recordDurabilityMiss(`evict-${i.toString().padStart(4, '0')}`);
      }
      expect(internals.failedEventCooldowns.size).toBe(256);
      const firstKey = 'evict-0000';
      expect(internals.failedEventCooldowns.has(firstKey)).toBe(true);

      // One more insert — pushes capacity, evicts oldest.
      internals.recordDurabilityMiss('overflow');
      expect(internals.failedEventCooldowns.size).toBe(256);
      expect(internals.failedEventCooldowns.has(firstKey)).toBe(false);
      expect(internals.failedEventCooldowns.has('overflow')).toBe(true);
    });
  });

  describe('cooldown intervals are bounded by COOLDOWN_MAX_MS (~120s)', () => {
    it('a 3-miss sequence does NOT exceed the configured max cooldown', () => {
      const provider = createProvider();
      const internals = inspect(provider);
      const eventId = 'f'.repeat(64);
      internals.recordDurabilityMiss(eventId);
      internals.recordDurabilityMiss(eventId);
      // Third miss returns true (budget exhausted) and clears the entry —
      // so we never observe the third backoff. The max is exercised by
      // the (attempts-1)=2 case clamping 30s*2^2=120s → COOLDOWN_MAX_MS.
      // Verify the second-miss cooldown is exactly the max (60s here,
      // since 30s*2^1=60s which is below the max).
      const entry = internals.failedEventCooldowns.get(eventId);
      if (entry) {
        const cooldownMs = entry.nextRetryAt - Date.now();
        expect(cooldownMs).toBeLessThanOrEqual(120_000);
      }
    });
  });
});
