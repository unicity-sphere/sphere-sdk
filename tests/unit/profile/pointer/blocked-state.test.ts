/**
 * BLOCKED state (T-B5) — wallet-wide persistence + categorical classifier.
 *
 * SPEC §10.2.1–§10.2.5.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isBlocked,
  setBlocked,
  clearBlocked,
  maybeSetBlocked,
  classifyBlockedReason,
  DURABLE_STORAGE,
  FlagStore,
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/index.js';

function makeDurableStore() {
  const kv = new Map<string, string>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => { kv.set(k, v); },
    remove: async (k: string) => { kv.delete(k); },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => { kv.clear(); },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
}

const PUBKEY = '01'.repeat(33);

function makeFlagStore(pubkey = PUBKEY) {
  return FlagStore.create(makeDurableStore() as never, pubkey);
}

describe('isBlocked / setBlocked / clearBlocked (T-B5)', () => {
  let fs: FlagStore;
  beforeEach(() => { fs = makeFlagStore(); });

  it('initially not blocked', async () => {
    const state = await isBlocked(fs);
    expect(state.blocked).toBe(false);
  });

  it('setBlocked marks as blocked with reason + timestamp', async () => {
    await setBlocked(fs, 'retry_exhausted');
    const state = await isBlocked(fs);
    expect(state.blocked).toBe(true);
    expect(state.reason).toBe('retry_exhausted');
    expect(typeof state.setAt).toBe('number');
    expect(state.setAt).toBeGreaterThan(0);
  });

  it('setBlocked is idempotent (second call preserves original setAt)', async () => {
    await setBlocked(fs, 'retry_exhausted');
    const first = await isBlocked(fs);
    await new Promise((r) => setTimeout(r, 10));
    await setBlocked(fs, 'dns_failure');
    const second = await isBlocked(fs);
    expect(second.setAt).toBe(first.setAt); // original timestamp preserved
    expect(second.reason).toBe('retry_exhausted'); // original reason preserved
  });

  it('clearBlocked removes the flag', async () => {
    await setBlocked(fs, 'tls_failure');
    await clearBlocked(fs);
    const state = await isBlocked(fs);
    expect(state.blocked).toBe(false);
  });

  it('wallet-wide: same signingPubKey → same BLOCKED state across separate FlagStore instances', async () => {
    // Two FlagStore instances sharing the same underlying storage (same pubkey).
    const sharedStorage = makeDurableStore();
    const fsA = FlagStore.create(sharedStorage as never, PUBKEY);
    const fsB = FlagStore.create(sharedStorage as never, PUBKEY);

    await setBlocked(fsA, 'aggregator_rejected');
    const stateB = await isBlocked(fsB);
    expect(stateB.blocked).toBe(true);
    expect(stateB.reason).toBe('aggregator_rejected');
  });

  it('different signingPubKey → isolated BLOCKED states', async () => {
    const sharedStorage = makeDurableStore();
    const fsA = FlagStore.create(sharedStorage as never, 'aa'.repeat(33));
    const fsB = FlagStore.create(sharedStorage as never, 'bb'.repeat(33));

    await setBlocked(fsA, 'retry_exhausted');
    const stateB = await isBlocked(fsB);
    expect(stateB.blocked).toBe(false);
  });

  it('isBlocked throws CORRUPT for invalid JSON (fail-closed)', async () => {
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set('blocked', 'bad-json');
    await expect(isBlocked(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.CORRUPT,
    });
  });

  it('isBlocked throws CORRUPT for valid JSON with wrong shape', async () => {
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set('blocked', '{}');
    await expect(isBlocked(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.CORRUPT,
    });
  });

  it('isBlocked throws CORRUPT for valid JSON with unknown reason', async () => {
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'blocked',
      JSON.stringify({ blocked: true, reason: 'future_reason', setAt: Date.now() }),
    );
    await expect(isBlocked(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.CORRUPT,
    });
  });
});

describe('classifyBlockedReason', () => {
  it('RETRY_EXHAUSTED → retry_exhausted', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.RETRY_EXHAUSTED, 'exhausted');
    expect(classifyBlockedReason(err)).toBe('retry_exhausted');
  });

  it('AGGREGATOR_REJECTED → aggregator_rejected', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.AGGREGATOR_REJECTED, 'rejected');
    expect(classifyBlockedReason(err)).toBe('aggregator_rejected');
  });

  it('PROTOCOL_ERROR → protocol_error', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.PROTOCOL_ERROR, 'bad proto');
    expect(classifyBlockedReason(err)).toBe('protocol_error');
  });

  it('NETWORK_ERROR with timeout message → network_timeout', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.NETWORK_ERROR, 'request timed out');
    expect(classifyBlockedReason(err)).toBe('network_timeout');
  });

  it('NETWORK_ERROR with DNS message → dns_failure', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.NETWORK_ERROR, 'getaddrinfo ENOTFOUND host');
    expect(classifyBlockedReason(err)).toBe('dns_failure');
  });

  it('NETWORK_ERROR with TLS message → tls_failure', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.NETWORK_ERROR, 'TLS handshake failed');
    expect(classifyBlockedReason(err)).toBe('tls_failure');
  });

  it('NETWORK_ERROR without categorical sub-type → null (transient)', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.NETWORK_ERROR, 'connection refused');
    expect(classifyBlockedReason(err)).toBeNull();
  });

  it('raw Error with timeout → network_timeout', () => {
    const err = new Error('Timeout exceeded');
    expect(classifyBlockedReason(err)).toBe('network_timeout');
  });

  it('raw Error with getaddrinfo → dns_failure', () => {
    const err = new Error('getaddrinfo ENOTFOUND example.com');
    expect(classifyBlockedReason(err)).toBe('dns_failure');
  });

  it('ECONNRESET → null (transient)', () => {
    const err = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
    expect(classifyBlockedReason(err)).toBeNull();
  });

  it('non-blocking error codes → null', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.STALE, 'stale');
    expect(classifyBlockedReason(err)).toBeNull();
  });

  it('null input → null', () => {
    expect(classifyBlockedReason(null)).toBeNull();
  });

  it('string input → null', () => {
    expect(classifyBlockedReason('some error string')).toBeNull();
  });
});

describe('maybeSetBlocked', () => {
  let fs: FlagStore;
  beforeEach(() => { fs = makeFlagStore(); });

  it('sets BLOCKED for a classifiable error and returns the reason', async () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.RETRY_EXHAUSTED, 'x');
    const reason = await maybeSetBlocked(fs, err);
    expect(reason).toBe('retry_exhausted');
    expect((await isBlocked(fs)).blocked).toBe(true);
  });

  it('does NOT set BLOCKED for a non-classifiable error and returns null', async () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.STALE, 'y');
    const reason = await maybeSetBlocked(fs, err);
    expect(reason).toBeNull();
    expect((await isBlocked(fs)).blocked).toBe(false);
  });
});
