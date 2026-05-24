/**
 * Tests for RFC-251 Approach D / issue #255 Problem B —
 * `LifecycleManager.publishAggregatorPointerBestEffort` emits a typed
 * `storage:pointer-published` event carrying a signed win-broadcast
 * payload + per-wallet broadcast tag on every successful pointer
 * commit.
 *
 * Pins the publisher-side end-to-end:
 *   - Successful publish ⇒ event fired with both `signedPayloadJson`
 *     and `broadcastTag`.
 *   - The signed payload verifies cleanly against the wallet's
 *     pointer signingPubKey (proves end-to-end crypto correctness).
 *   - Transient / permanent failures DO NOT emit the event (only the
 *     success path is wired).
 *   - Pointer layer that does not implement `getSignerForWinBroadcast`
 *     (e.g. test stub) ⇒ best-effort skip with a log; the publish
 *     return value is still `ok: true` so the broadcast is purely
 *     additive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
  buildPointerSigner,
  derivePointerKeyMaterial,
  createMasterPrivateKey,
  type PointerSigner,
} from '../../../profile/aggregator-pointer';
import {
  buildWinBroadcastTag,
  verifyWinBroadcastPayload,
  type SignedWinBroadcastPayload,
} from '../../../profile/aggregator-pointer/win-broadcast';
import type { StorageEvent } from '../../../storage/storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const FAKE_CID = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';

// ── Fixtures (mirror lifecycle-manager-publish-retry.test.ts pattern) ─────

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) { store.set(key, value); },
    async get(key: string) { return store.get(key) ?? null; },
    async del(key: string) { store.delete(key); },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() { return () => {}; },
    isConnected() { return true; },
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

function createMockLocalCache() {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      async get(k: string) { return store.get(k) ?? null; },
      async set(k: string, v: string) { store.set(k, v); },
      async remove(k: string) { store.delete(k); },
      async clear() { store.clear(); },
    },
  };
}

/**
 * Build a stub ProfilePointerLayer with a REAL PointerSigner so the
 * win-broadcast sign path runs against actual secp256k1 crypto.
 */
async function buildStubPointer(opts: {
  readonly signer: PointerSigner;
  readonly publishImpl?: () => Promise<{ cid: Uint8Array; version: number; attemptsUsed: number }>;
}): Promise<ProfilePointerLayer> {
  const defaultPublish = async () => ({
    cid: new Uint8Array(0),
    version: 7,
    attemptsUsed: 1,
  });
  return {
    async recoverLatest() { return null; },
    async publish() {
      return (await (opts.publishImpl ?? defaultPublish)()) as never;
    },
    getSignerForWinBroadcast() {
      return {
        signer: opts.signer,
        signingPubKeyHex: opts.signer.signingPubKeyHex,
      };
    },
  } as unknown as ProfilePointerLayer;
}

async function buildRealSigner(): Promise<PointerSigner> {
  const seed = new Uint8Array(32).fill(0x42);
  const masterKey = createMasterPrivateKey(seed);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  return buildPointerSigner(keyMaterial.signingSeed);
}

interface Harness {
  readonly provider: ProfileTokenStorageProvider;
  readonly events: StorageEvent[];
  readonly publish: (cid: string) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
}

async function createHarness(pointer: ProfilePointerLayer): Promise<Harness> {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: { orbitDb: { privateKey: TEST_PRIVATE_KEY }, ipnsSnapshot: false },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: () => pointer,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const events: StorageEvent[] = [];
  if (typeof provider.onEvent === 'function') {
    provider.onEvent((event) => { events.push(event); });
  }
  const lifecycle = (provider as unknown as {
    lifecycleManager: {
      publishAggregatorPointerBestEffort(
        cid: string,
      ): Promise<{ ok: boolean; transient: boolean; code?: string }>;
    };
  }).lifecycleManager;
  return {
    provider,
    events,
    publish: (cid: string) => lifecycle.publishAggregatorPointerBestEffort(cid),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('LifecycleManager.publishAggregatorPointerBestEffort — pointer-win broadcast emission (#255 Problem B)', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits storage:pointer-published with signed payload + tag on a successful publish', async () => {
    const signer = await buildRealSigner();
    const pointer = await buildStubPointer({
      signer,
      publishImpl: async () => ({ cid: new Uint8Array(0), version: 42, attemptsUsed: 1 }),
    });
    const h = await createHarness(pointer);

    const result = await h.publish(FAKE_CID);
    expect(result.ok).toBe(true);

    const published = h.events.find((e) => e.type === 'storage:pointer-published');
    expect(published).toBeDefined();
    const data = published!.data as {
      cid?: string;
      version?: number;
      attemptsUsed?: number;
      signedPayloadJson?: string;
      broadcastTag?: string;
    };
    expect(data.cid).toBe(FAKE_CID);
    expect(data.version).toBe(42);
    expect(data.attemptsUsed).toBe(1);
    expect(typeof data.signedPayloadJson).toBe('string');
    expect(typeof data.broadcastTag).toBe('string');
    expect(data.broadcastTag).toBe(buildWinBroadcastTag(signer.signingPubKeyHex));

    // The signed payload MUST verify against the wallet's own signing
    // pubkey — proves the end-to-end sign path is wired correctly.
    const signed = JSON.parse(data.signedPayloadJson!) as SignedWinBroadcastPayload;
    expect(signed.version).toBe(42);
    expect(signed.cid).toBe(FAKE_CID);
    expect(signed.signingPubKey.toLowerCase()).toBe(signer.signingPubKeyHex.toLowerCase());
    const verifyOk = await verifyWinBroadcastPayload(signed, signer.signingPubKeyHex);
    expect(verifyOk).toBe(true);
  });

  it('does NOT emit storage:pointer-published on a transient publish failure', async () => {
    const signer = await buildRealSigner();
    const pointer = await buildStubPointer({
      signer,
      publishImpl: async () => {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.NETWORK_ERROR,
          'simulated transient',
        );
      },
    });
    const h = await createHarness(pointer);

    const result = await h.publish(FAKE_CID);
    expect(result.ok).toBe(false);
    expect(result.transient).toBe(true);

    expect(h.events.find((e) => e.type === 'storage:pointer-published')).toBeUndefined();
  });

  it('falls through gracefully when pointer lacks getSignerForWinBroadcast (legacy stub)', async () => {
    // Stub WITHOUT the win-broadcast accessor — simulates pre-Approach-D
    // pointer layer (e.g. a unit test that doesn't extend the helper).
    const pointer = {
      async recoverLatest() { return null; },
      async publish() {
        return { cid: new Uint8Array(0), version: 13, attemptsUsed: 1 } as never;
      },
      // No getSignerForWinBroadcast.
    } as unknown as ProfilePointerLayer;
    const h = await createHarness(pointer);

    const result = await h.publish(FAKE_CID);
    // Publish-success contract MUST be preserved — broadcast is purely
    // additive. The lifecycle manager's try/catch around the sign step
    // ensures a missing accessor doesn't taint the success return.
    expect(result.ok).toBe(true);
    expect(h.events.find((e) => e.type === 'storage:pointer-published')).toBeUndefined();
  });

  it('emits a fresh ts on each publish (no stale-broadcast amplification)', async () => {
    const signer = await buildRealSigner();
    let version = 1;
    const pointer = await buildStubPointer({
      signer,
      publishImpl: async () => ({
        cid: new Uint8Array(0),
        version: version++,
        attemptsUsed: 1,
      }),
    });
    const h = await createHarness(pointer);

    await h.publish(FAKE_CID);
    // Wait > 1ms so two successive publishes get distinct millisecond timestamps.
    await new Promise((r) => setTimeout(r, 5));
    await h.publish(FAKE_CID);

    const published = h.events.filter((e) => e.type === 'storage:pointer-published');
    expect(published.length).toBe(2);
    const p1 = JSON.parse((published[0].data as { signedPayloadJson: string }).signedPayloadJson) as SignedWinBroadcastPayload;
    const p2 = JSON.parse((published[1].data as { signedPayloadJson: string }).signedPayloadJson) as SignedWinBroadcastPayload;
    expect(p1.version).toBe(1);
    expect(p2.version).toBe(2);
    expect(p2.ts).toBeGreaterThan(p1.ts);
  });
});
