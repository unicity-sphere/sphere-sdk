/**
 * #583 — auth-generation guard (Copilot review on PR #585).
 *
 * `setIdentity()` (and `logout()`) bump a monotonic `authGeneration`. An
 * in-flight challenge→sign / refresh attempt captures the generation at its
 * START and bails — WITHOUT touching `this.jwt` or the refresh token — once the
 * identity has moved on. This kills the cross-owner contamination class where a
 * sign-in begun for owner A resolves AFTER a switch to owner B and (a) caches
 * A's JWT for B's client and/or (b) writes/clears A's refresh token under B's
 * storage key (`refreshTokenKey()` is derived from the CURRENT identity).
 *
 * The seam is the injected `fetchFn`: a controllable fake that lets a test hold
 * `/v1/auth/verify` in flight, switch identity, then release the stale response
 * and observe — purely through behaviour (the Bearer token on the next
 * authenticated request, and the persisted refresh token) — that it was
 * discarded.
 */

import { describe, it, expect } from 'vitest';
import { WalletApiClient, AUTH_CHALLENGE_PREFIX } from '../../../wallet-api';
import type { FetchLike, FetchResponseLike } from '../../../wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

const NETWORK = 'testnet2';
const BASE_URL = 'http://127.0.0.1:9/'; // loopback — never dialed (fetch is injected)

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

function challengeBody(pubkey: string): { nonce: string; challenge: string } {
  const nonce = 'nonce-' + pubkey.slice(0, 8);
  const now = Date.now();
  const challenge =
    AUTH_CHALLENGE_PREFIX +
    JSON.stringify({
      network: NETWORK,
      pubkey,
      nonce,
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
  return { nonce, challenge };
}

/** A deferred-resolution gate for one fetch response. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function defer(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A scripted fetch over the §4 auth + a probe GET. `/v1/auth/challenge` answers
 * immediately for the requested pubkey; `/v1/auth/verify` is GATED on a per-call
 * deferred the test releases, so a sign-in can be held in-flight across a
 * `setIdentity()`. `/v1/balances` records the Bearer token it was called with —
 * the behavioural proof of which JWT the client believes is current.
 */
class ScriptedAuthFetch {
  readonly verifyGates: Deferred[] = [];
  private readonly verifyTokens: Array<{ jwt: string; refreshToken: string }> = [];
  /** Bearer tokens seen on authenticated probe requests, in order. */
  readonly bearerSeen: string[] = [];

  queueVerifyTokens(jwt: string, refreshToken: string): void {
    this.verifyTokens.push({ jwt, refreshToken });
  }

  readonly fetchFn: FetchLike = (url, init) => {
    const path = url.replace(BASE_URL.replace(/\/$/, ''), '');
    if (path === '/v1/auth/challenge') {
      const pubkey = JSON.parse(String(init?.body)).pubkey as string;
      return Promise.resolve(jsonResponse(200, challengeBody(pubkey)));
    }
    if (path === '/v1/auth/verify') {
      const idx = this.verifyGates.length;
      const gate = defer();
      this.verifyGates.push(gate);
      return gate.promise.then(() => jsonResponse(200, this.verifyTokens[idx]));
    }
    if (path === '/v1/balances') {
      const auth = init?.headers?.['authorization'] ?? '';
      this.bearerSeen.push(auth.replace(/^Bearer /, ''));
      return Promise.resolve(jsonResponse(200, { balances: [] }));
    }
    throw new Error(`unexpected fetch to ${path}`);
  };

  releaseVerify(index: number): void {
    this.verifyGates[index].resolve();
  }
}

function refreshKeyFor(pubkey: string, deviceId: string): string {
  return `wallet-api:refresh:${NETWORK}:${pubkey}:${deviceId}`;
}

/** Flush enough microtask turns for the parked challenge round-trip to settle. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('WalletApiClient — auth-generation guard on identity switch (#583)', () => {
  it('a sign-in for the previous owner does NOT cache its jwt or persist its refresh token after setIdentity()', async () => {
    const ownerA = testIdentity(70);
    const ownerB = testIdentity(71);
    const storage = new MemoryKeyValueStore();
    const script = new ScriptedAuthFetch();
    const client = new WalletApiClient({
      baseUrl: BASE_URL,
      network: NETWORK,
      deviceId: 'dev-1',
      storage,
      fetchFn: script.fetchFn,
    });

    // Owner A begins a sign-in; its verify is held in flight (gate 0).
    client.setIdentity(ownerA);
    script.queueVerifyTokens('JWT-A', 'REFRESH-A');
    const signInA = client.signIn();
    await settleMicrotasks();
    expect(script.verifyGates.length).toBe(1);

    // Identity switches to owner B mid-sign-in (the bug trigger).
    client.setIdentity(ownerB);

    // The held A sign-in now completes — it MUST discard its result.
    script.releaseVerify(0);
    await signInA;

    // (b) A's refresh token landed under NEITHER owner's storage key.
    expect(storage.map.get(refreshKeyFor(ownerB.chainPubkey, 'dev-1'))).toBeUndefined();
    expect(storage.map.get(refreshKeyFor(ownerA.chainPubkey, 'dev-1'))).toBeUndefined();

    // (a) An authenticated request as B re-signs-in fresh and uses B's JWT —
    //     never the abandoned A JWT.
    script.queueVerifyTokens('JWT-B', 'REFRESH-B');
    const balances = client.getBalances();
    await settleMicrotasks();
    script.releaseVerify(1); // the fresh B sign-in's verify
    await balances;

    expect(script.bearerSeen).toEqual(['JWT-B']);
    expect(script.bearerSeen).not.toContain('JWT-A');
    expect(storage.map.get(refreshKeyFor(ownerB.chainPubkey, 'dev-1'))).toBe('REFRESH-B');
    expect(storage.map.get(refreshKeyFor(ownerA.chainPubkey, 'dev-1'))).toBeUndefined();
  });

  it('the happy path (no identity change) caches the jwt and persists the refresh token', async () => {
    const owner = testIdentity(72);
    const storage = new MemoryKeyValueStore();
    const script = new ScriptedAuthFetch();
    const client = new WalletApiClient({
      baseUrl: BASE_URL,
      network: NETWORK,
      deviceId: 'dev-2',
      storage,
      fetchFn: script.fetchFn,
    });

    client.setIdentity(owner);
    script.queueVerifyTokens('JWT', 'REFRESH');
    const signIn = client.signIn();
    await settleMicrotasks();
    script.releaseVerify(0);
    await signIn;

    expect(storage.map.get(refreshKeyFor(owner.chainPubkey, 'dev-2'))).toBe('REFRESH');

    // The cached JWT is the one used by the next authenticated request.
    await client.getBalances();
    expect(script.bearerSeen).toEqual(['JWT']);
  });
});
