/**
 * S1 auth: challenge template verification (the spend key never signs
 * unverified text), rotating refresh + rotation-reuse revocation fallback,
 * credential hygiene (injected storage, https-only off loopback) — per
 * ARCHITECTURE §4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletApiClient, ChallengeTemplateError, WalletApiError, verifyChallengeTemplate, AUTH_CHALLENGE_PREFIX } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

describe('WalletApiClient — transport rule (§4)', () => {
  const base = {
    network: 'testnet2',
    deviceId: 'dev',
    storage: new MemoryKeyValueStore(),
  };

  it('refuses plain http on non-loopback hosts', () => {
    expect(() => new WalletApiClient({ ...base, baseUrl: 'http://wallet.example.com' })).toThrowError(
      /https/
    );
  });

  it('allows https anywhere and http on loopback only', () => {
    expect(() => new WalletApiClient({ ...base, baseUrl: 'https://wallet.example.com' })).not.toThrow();
    expect(() => new WalletApiClient({ ...base, baseUrl: 'http://127.0.0.1:8080' })).not.toThrow();
    expect(() => new WalletApiClient({ ...base, baseUrl: 'http://localhost:8080' })).not.toThrow();
  });
});

describe('WalletApiClient — auth (§4)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  let storage: MemoryKeyValueStore;
  let client: WalletApiClient;
  const identity = testIdentity(40);

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    storage = new MemoryKeyValueStore();
    client = new WalletApiClient({ baseUrl, network: fake.network, deviceId: 'dev-1', storage });
    client.setIdentity(identity);
  });

  afterEach(async () => {
    await fake.stop();
  });

  function storedRefreshToken(): string | null {
    for (const [key, value] of storage.map) {
      if (key.startsWith('wallet-api:refresh:')) return value;
    }
    return null;
  }

  it('signs in via challenge→verify and stores the refresh token in the injected storage', async () => {
    await client.signIn();
    const refresh = storedRefreshToken();
    // Refresh wire form v1.<sessionId>.<secretHex> (§4).
    expect(refresh).toMatch(/^v1\.[0-9a-f]+\.[0-9a-f]{64}$/);
    expect(fake.verifyRequests).toBe(1);
    // Authenticated request works.
    expect(await client.getBalances()).toEqual([]);
  });

  it('refuses to sign a challenge without the domain prefix (and never calls verify)', async () => {
    fake.tamperNextChallenge((c) => c.replace(AUTH_CHALLENGE_PREFIX, 'evil-prefix\n'));
    await expect(client.signIn()).rejects.toThrowError(ChallengeTemplateError);
    expect(fake.verifyRequests).toBe(0);
  });

  it('refuses a challenge embedding a foreign pubkey', async () => {
    const other = testIdentity(41);
    fake.tamperNextChallenge((c) => c.replace(identity.chainPubkey, other.chainPubkey));
    await expect(client.signIn()).rejects.toThrowError(/different pubkey/);
    expect(fake.verifyRequests).toBe(0);
  });

  it('signs a challenge whose (server) timestamps are far from the device clock (#662)', async () => {
    // A device clock skewed by decades vs the server-issued timestamps must NOT
    // block sign-in: the window is well-formed and the server is authoritative
    // on expiry. Previously this threw a client-side "expired" and locked the
    // user out of every send.
    fake.tamperNextChallenge((c) =>
      c
        .replace(/"issuedAt":"[^"]*"/, '"issuedAt":"1970-01-01T00:00:00.000Z"')
        .replace(/"expiresAt":"[^"]*"/, '"expiresAt":"1970-01-01T00:05:00.000Z"')
    );
    await expect(client.signIn()).resolves.toBeUndefined();
    expect(fake.verifyRequests).toBe(1); // proceeded to verify; server decides expiry
  });

  it('silently refreshes (with rotation) when the access token expires', async () => {
    await client.signIn();
    const firstRefresh = storedRefreshToken();
    fake.expireAccessTokens();

    await client.getBalances(); // 401 → refresh → retry, no user interaction
    expect(fake.refreshRequests).toBe(1);
    // §4 rotation: the stored refresh token changed.
    expect(storedRefreshToken()).not.toBe(firstRefresh);
    expect(fake.challengeRequests).toBe(1); // no second challenge cycle needed
  });

  it('rotation-reuse revocation falls back to a fresh challenge cycle (§4 reuse detection)', async () => {
    await client.signIn();
    const stale = storedRefreshToken()!;

    // Rotate once (so `stale` becomes a previously-rotated token).
    fake.expireAccessTokens();
    await client.getBalances();

    // Simulate a stale copy of the credential resurfacing on this device.
    for (const key of [...storage.map.keys()]) {
      if (key.startsWith('wallet-api:refresh:')) storage.map.set(key, stale);
    }
    fake.expireAccessTokens();
    const challengesBefore = fake.challengeRequests;

    // The refresh presents the rotated-away token → the fake revokes the whole
    // session (theft) → the client silently falls back to challenge→sign.
    await client.getBalances();
    expect(fake.challengeRequests).toBe(challengesBefore + 1);
    expect(storedRefreshToken()).not.toBe(stale);
    expect(await client.getBalances()).toEqual([]);
  });

  it('logout revokes the session and clears the stored credential', async () => {
    await client.signIn();
    await client.logout();
    expect(storedRefreshToken()).toBeNull();

    // The next call re-authenticates from scratch (challenge cycle).
    const before = fake.challengeRequests;
    await client.getBalances();
    expect(fake.challengeRequests).toBe(before + 1);
  });
});

describe('verifyChallengeTemplate — direct edge cases (S1)', () => {
  const identity = testIdentity(42);
  const now = Date.parse('2026-06-11T12:00:00.000Z');
  // The real backend grammar: prefix + single-line JSON (wallet-api src/auth/service.ts).
  const challengeJson = (overrides: Record<string, string | undefined> = {}): string => {
    const fields: Record<string, string | undefined> = {
      network: 'testnet2',
      pubkey: identity.chainPubkey,
      nonce: 'abc123',
      issuedAt: '2026-06-11T11:59:00.000Z',
      expiresAt: '2026-06-11T12:04:00.000Z',
      ...overrides,
    };
    const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    return AUTH_CHALLENGE_PREFIX + JSON.stringify(present);
  };
  const valid = challengeJson();
  const expect4 = { pubkey: identity.chainPubkey, nonce: 'abc123', network: 'testnet2', nowMs: now };

  it('accepts a well-formed challenge', () => {
    expect(() => verifyChallengeTemplate(valid, expect4)).not.toThrow();
  });

  it('rejects a nonce mismatch', () => {
    expect(() => verifyChallengeTemplate(valid, { ...expect4, nonce: 'other' })).toThrowError(/nonce/);
  });

  it('rejects a network mismatch', () => {
    expect(() => verifyChallengeTemplate(valid, { ...expect4, network: 'mainnet' })).toThrowError(/network/);
  });

  it('rejects missing fields', () => {
    const noExpiry = challengeJson({ expiresAt: undefined });
    expect(() => verifyChallengeTemplate(noExpiry, expect4)).toThrowError(/expiresAt/);
  });

  it('rejects an implausible validity window', () => {
    const longWindow = challengeJson({ expiresAt: '2026-06-13T12:00:00.000Z' });
    expect(() => verifyChallengeTemplate(longWindow, expect4)).toThrowError(/window/);
  });

  it('accepts server timestamps regardless of device clock skew (#662)', () => {
    // Device clock 10 min FAST (nowMs well past expiresAt): must NOT throw
    // "expired" — the server enforces expiry, not the device.
    const fast = { ...expect4, nowMs: Date.parse('2026-06-11T12:14:00.000Z') };
    expect(() => verifyChallengeTemplate(valid, fast)).not.toThrow();
    // Device clock 10 min SLOW (issuedAt appears "in the future"): must NOT throw.
    const slow = { ...expect4, nowMs: Date.parse('2026-06-11T11:49:00.000Z') };
    expect(() => verifyChallengeTemplate(valid, slow)).not.toThrow();
    // nowMs omitted entirely: still fine (field is deprecated/ignored).
    const noClock = { pubkey: identity.chainPubkey, nonce: 'abc123', network: 'testnet2' };
    expect(() => verifyChallengeTemplate(valid, noClock)).not.toThrow();
  });

  it('still rejects a non-positive validity window using server timestamps only', () => {
    const inverted = challengeJson({ issuedAt: '2026-06-11T12:04:00.000Z', expiresAt: '2026-06-11T12:00:00.000Z' });
    expect(() => verifyChallengeTemplate(inverted, expect4)).toThrowError(/window/);
  });

  it('throws the typed error', () => {
    try {
      verifyChallengeTemplate('garbage', expect4);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChallengeTemplateError);
      expect(err).toBeInstanceOf(WalletApiError);
      expect((err as WalletApiError).code).toBe('CHALLENGE_TEMPLATE');
    }
  });
});
