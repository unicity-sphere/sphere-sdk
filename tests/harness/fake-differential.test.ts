/**
 * Phase-2 harness — the FAKE-DRIFT DIFFERENTIAL GUARD.
 *
 * The whole point of this harness is to detect drift between the in-process
 * fake backend (tests/support/fake-wallet-api.ts) and the real wallet-api: a
 * suite that would pass against the fake proves nothing about the real
 * system. This file pins a REAL-BACKEND-ONLY behavior:
 *
 *   §5.2 presigned blob URLs are credentials for a REAL S3 object store —
 *   served OFF the API origin (MinIO at 127.0.0.1:9000, not the API at
 *   :3000), stamped with S3 request ids (`x-amz-request-id`), and round-
 *   tripping the exact uploaded bytes.
 *
 * The fake CANNOT satisfy this: it serves blobs from its own HTTP origin
 * (`/v1/_blob/...`) with no S3 semantics. The guard is SELF-VERIFYING — the
 * second test runs the identical assertion against the fake and REQUIRES it
 * to reject. If someone ever points the harness at the fake (or the fake
 * grows close enough to fool the rest of the suite), this file fails.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from './support/harness-wallet';
import { HARNESS_COIN, randomIdentity, stackFromEnv } from './support/stack';
import { deriveDeliveryKeys } from '../../token-engine/blob-keys';
import { WalletApiClient } from '../../wallet-api';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { makeTestToken, MemoryKeyValueStore, testIdentity } from '../support/wallet-api-test-helpers';

const stack = stackFromEnv();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** The real-backend-only property. Throws when served by anything but a real object store. */
async function assertServedByRealObjectStore(
  apiBaseUrl: string,
  getUrl: string,
  expectedTokenId: string
): Promise<void> {
  if (new URL(getUrl).origin === new URL(apiBaseUrl).origin) {
    throw new Error(
      `blob URL is served from the API origin (${getUrl}) — an in-process fake, not a real object store`
    );
  }
  const res = await fetch(getUrl);
  if (!res.ok) throw new Error(`presigned GET failed: HTTP ${res.status}`);
  if (!res.headers.get('x-amz-request-id')) {
    throw new Error('presigned GET response carries no x-amz-request-id — not S3/MinIO');
  }
  // §5.2/§8.2: the wire serves RAW SDK token CBOR — decode it as the real
  // token it must be and match the genesis-stable id.
  const keys = await deriveDeliveryKeys(new Uint8Array(await res.arrayBuffer()));
  if (keys.tokenId !== expectedTokenId) {
    throw new Error(`presigned GET returned the wrong blob: ${keys.tokenId} != ${expectedTokenId}`);
  }
}

describe('fake-drift differential guard', () => {
  it('presigned blob URLs are served by the REAL S3 store and round-trip the bytes', async () => {
    const a: HarnessWallet = await createHarnessWallet({
      stack,
      identity: randomIdentity(),
      deviceId: 'diff-real',
      custody: 'inventory',
    });
    cleanups.push(() => a.destroy());
    await a.module.load();

    const mint = await a.module.mintFungibleToken(HARNESS_COIN, 42n);
    if (!mint.success) throw new Error(mint.error);

    const urls = await a.client.getBlobUrls([mint.tokenId]);
    expect(urls).toHaveLength(1);
    await assertServedByRealObjectStore(stack.baseUrl, urls[0].getUrl, mint.tokenId);
  });

  it('the guard DISCRIMINATES: the identical assertion rejects against the in-process fake', async () => {
    const fake = new FakeWalletApi();
    const fakeBase = await fake.start();
    cleanups.push(() => fake.stop());

    const who = testIdentity(91);
    const client = new WalletApiClient({
      baseUrl: fakeBase,
      network: fake.network,
      deviceId: 'diff-fake',
      storage: new MemoryKeyValueStore(),
    });
    client.setIdentity(who);
    const token = makeTestToken();
    fake.seedInventory(who.chainPubkey, [
      { tokenId: token.tokenId, assets: [{ coinId: token.coinId, amount: token.amount }], blob: token.bytes },
    ]);

    const urls = await client.getBlobUrls([token.tokenId]);
    expect(urls).toHaveLength(1);
    await expect(assertServedByRealObjectStore(fakeBase, urls[0].getUrl, token.tokenId)).rejects.toThrow(
      /API origin/
    );
  });
});
