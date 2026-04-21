/**
 * Constants sanity checks (T-A1) — byte-exact SPEC §3 v3.5 invariants.
 */

import { describe, it, expect } from 'vitest';
import {
  PROFILE_POINTER_HKDF_INFO,
  SIGNING_SEED_INFO,
  XOR_SEED_INFO,
  PAD_SEED_INFO,
  SIDE_A,
  SIDE_B,
  PAYLOAD_LEN_BYTES,
  CID_MAX_BYTES,
  VERSION_MIN,
  VERSION_MAX,
  DISCOVERY_INITIAL_VERSION,
  DISCOVERY_HARD_CEILING,
  PUBLISH_RETRY_BUDGET,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_MAX_MS,
  AGGREGATOR_ALG_TAG_SHA256,
  MARKER_MAX_JUMP,
  MAX_CT_RESIDENT_MS,
  MAX_CAR_BYTES,
  CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS,
  CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
  POINTER_PEER_DISCOVERY_MS,
  DISCOVERY_CORRUPT_WALKBACK,
  PUBLISH_REQUEST_TIMEOUT_MS,
  PROBE_REQUEST_TIMEOUT_MS,
  mutexKey,
  pendingVersionKey,
  blockedFlagKey,
  SPHERE_ALLOW_OVERRIDES_VALUE,
} from '../../../../profile/aggregator-pointer/index.js';

describe('SPEC §3 constants (T-A1)', () => {
  it('PROFILE_POINTER_HKDF_INFO is exactly 33 bytes (H12)', () => {
    expect(PROFILE_POINTER_HKDF_INFO.length).toBe(33);
    expect(new TextDecoder().decode(PROFILE_POINTER_HKDF_INFO)).toBe(
      'uxf-profile-aggregator-pointer-v1',
    );
  });

  it('subkey info strings are 26 bytes each', () => {
    expect(SIGNING_SEED_INFO.length).toBe(26);
    expect(XOR_SEED_INFO.length).toBe(26);
    expect(PAD_SEED_INFO.length).toBe(26);
  });

  it('subkey info strings are pairwise distinct', () => {
    const a = new TextDecoder().decode(SIGNING_SEED_INFO);
    const b = new TextDecoder().decode(XOR_SEED_INFO);
    const c = new TextDecoder().decode(PAD_SEED_INFO);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('side markers', () => {
    expect(SIDE_A).toBe(0x00);
    expect(SIDE_B).toBe(0x01);
  });

  it('payload layout', () => {
    expect(PAYLOAD_LEN_BYTES).toBe(32);
    expect(CID_MAX_BYTES).toBe(63);
    expect(CID_MAX_BYTES).toBe(2 * PAYLOAD_LEN_BYTES - 1);
  });

  it('version bounds', () => {
    expect(VERSION_MIN).toBe(1);
    expect(VERSION_MAX).toBe(2 ** 31 - 1);
  });

  it('discovery', () => {
    expect(DISCOVERY_INITIAL_VERSION).toBe(1024);
    expect(DISCOVERY_HARD_CEILING).toBe(4_194_304);
    expect(DISCOVERY_CORRUPT_WALKBACK).toBe(64);
  });

  it('publish retry + backoff', () => {
    expect(PUBLISH_RETRY_BUDGET).toBe(5);
    expect(PUBLISH_BACKOFF_BASE_MS).toBe(250);
    expect(PUBLISH_BACKOFF_MAX_MS).toBe(4000);
  });

  it('algorithm tag is [0x00, 0x00]', () => {
    expect(Array.from(AGGREGATOR_ALG_TAG_SHA256)).toEqual([0x00, 0x00]);
  });

  it('marker + ciphertext hygiene', () => {
    expect(MARKER_MAX_JUMP).toBe(1024);
    expect(MAX_CT_RESIDENT_MS).toBe(500);
  });

  it('CAR fetch limits', () => {
    expect(MAX_CAR_BYTES).toBe(100 * 1024 * 1024);
    expect(CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS).toBe(12);
    expect(CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS).toBe(86_400_000);
    expect(POINTER_PEER_DISCOVERY_MS).toBe(600_000);
  });

  it('RPC timeouts', () => {
    expect(PUBLISH_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(PROBE_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('per-wallet storage keys template correctly', () => {
    const pk = 'deadbeef';
    expect(mutexKey(pk)).toBe('profile.pointer.publish.lock.deadbeef');
    expect(pendingVersionKey(pk)).toBe('profile.pointer.pending_version.deadbeef');
    expect(blockedFlagKey(pk)).toBe('profile.pointer.blocked.deadbeef');
  });

  it('capability protocol env-var value (§13.4 v3.5)', () => {
    expect(SPHERE_ALLOW_OVERRIDES_VALUE).toBe('1');
  });
});
