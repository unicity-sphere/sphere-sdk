/**
 * Cross-repo vault e2e (Task 8.3, Deliverable 2 / finding #13).
 *
 * Boots the REAL token-api in-process (sibling repo, compiled `dist/`, over a
 * mongodb-memory-server replica set) and drives the FULL SDK path through the REAL
 * fetch HTTP clients — no fakes:
 *  1. AUTH — `VaultApiClient` + `HttpVaultAuthClient`: challenge → verify → JWT.
 *  2. VAULT CAS — `RemoteTokenStorageProvider` over `HttpVaultClient`: flush a
 *     couple of token entries + the reserved meta-address, then RELOAD from a fresh
 *     provider and assert the CAS round-trip + the restored `_meta.address` (#17).
 *  3. COURIER — `CourierDeliveryProvider` over `HttpCourierClient`: deposit a sealed
 *     envelope to a second identity, `receive()` + ack it, and confirm the SENDER
 *     sees the valid ack on `/sent`.
 *
 * `TOKEN_API_URL` (optional) points the whole suite at a remote deploy instead of
 * the in-process app. Defaults to the in-process boot.
 *
 * HONESTY: this needs a real mongod (mongodb-memory-server). If the binary cannot
 * start in CI it will error here — the suite is gated to the e2e config so it never
 * blocks the unit run, and runs green wherever a mongod is available.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../core/crypto';
import { deriveDirectAddress } from '../../token-engine/identity';
import { VaultApiClient } from '../../storage/remote/VaultApiClient';
import { RemoteTokenStorageProvider } from '../../storage/remote/RemoteTokenStorageProvider';
import { CourierDeliveryProvider } from '../../transport/courier/CourierDeliveryProvider';
import { HttpVaultAuthClient } from '../../storage/remote/http/HttpVaultAuthClient';
import { HttpVaultClient } from '../../storage/remote/http/HttpVaultClient';
import { HttpCourierClient } from '../../transport/courier/http/HttpCourierClient';
import { encodeTokenBlob } from '../../token-engine/token-blob';
import { bootTokenApi, type BootedTokenApi } from './support/token-api-boot';
import type { FullIdentity } from '../../types';
import type { TxfStorageDataBase } from '../../storage';
import type { V2TransferPayload } from '../../types/v2-transfer';
import type { CourierJournalStore } from '../../transport/courier/CourierDeliveryProvider';
import type { LocalBaselineStore } from '../../storage/remote/load-delta';

const NETWORK = 'testnet2';

/** A VALID CBOR(TokenBlob) — `courierEntryId`/`courierStateHash` decode it. */
const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

/** Build a deterministic engine-shaped identity from a private key. */
async function makeIdentity(priv: string): Promise<FullIdentity> {
  const chainPubkey = bytesToHex(secp256k1.getPublicKey(hexToBytes(priv), true));
  const directAddress = await deriveDirectAddress(hexToBytes(chainPubkey));
  return { chainPubkey, privateKey: priv, l1Address: `alpha-${chainPubkey.slice(0, 8)}`, directAddress };
}

/** A trivial in-memory KV (satisfies both the baseline store and the courier journal). */
function memKv(): LocalBaselineStore & CourierJournalStore {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
  };
}

/**
 * Authenticate a standalone `VaultApiClient` over the real fetch auth client. The
 * `deviceId` is parameterised because the REAL server enforces a UNIQUE
 * `(ownerId, deviceId)` session — two providers for the same owner need distinct
 * device ids (the fake server does not enforce this).
 */
async function authedApi(baseUrl: string, id: FullIdentity, deviceId = 'e2e-device'): Promise<VaultApiClient> {
  const api = new VaultApiClient({
    network: NETWORK,
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    deviceId,
    authClient: new HttpVaultAuthClient({ vaultUrl: baseUrl }),
  });
  await api.authenticate();
  return api;
}

/**
 * Build a vault storage provider whose data client shares the provider's own auth
 * session. The factory closure resolves the provider's `authTokenSource()` LAZILY
 * (via a one-field holder), because the `httpClientFactory` must be supplied at
 * construction — before the provider instance exists.
 */
function makeVaultProvider(baseUrl: string, priv: string, deviceId: string): RemoteTokenStorageProvider {
  const holder: { provider?: RemoteTokenStorageProvider } = {};
  holder.provider = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: baseUrl,
    privateKey: priv,
    deviceId,
    authClient: new HttpVaultAuthClient({ vaultUrl: baseUrl }),
    httpClientFactory: () =>
      new HttpVaultClient({ vaultUrl: baseUrl, auth: holder.provider!.authTokenSource() }),
    localBaseline: memKv(),
  });
  return holder.provider;
}

let server: BootedTokenApi;

beforeAll(async () => {
  server = await bootTokenApi(NETWORK);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('vault e2e — in-process token-api', () => {
  it('auth: challenge → verify → JWT against the real server', async () => {
    const id = await makeIdentity('11'.repeat(32));
    const api = await authedApi(server.baseUrl, id);
    const first = api.token;
    expect(typeof first).toBe('string');
    expect(first!.length).toBeGreaterThan(0);
    // A refresh rotates the JWT (proves the real rotating-refresh wire).
    const rotated = await api.refresh();
    expect(rotated).not.toBe(first);
  });

  it('vault CAS round-trip: flush → reload restores entries + reserved address', async () => {
    const priv = '22'.repeat(32);
    const id = await makeIdentity(priv);
    const writer = makeVaultProvider(server.baseUrl, priv, 'writer-device');
    writer.setIdentity(id);
    await writer.initialize(); // authenticates + opens the flush gate via first load

    const snapshot: TxfStorageDataBase & Record<string, unknown> = {
      _meta: { version: 1, address: id.directAddress!, formatVersion: '2.0', updatedAt: Date.now() },
      _tokenA: { id: 'tokenA', amount: '100' },
      _tokenB: { id: 'tokenB', amount: '250' },
    };
    const synced = await writer.sync(snapshot);
    expect(synced.success).toBe(true);
    expect(writer.knownCount()).toBeGreaterThanOrEqual(2); // 2 tokens (+ reserved address)

    // A FRESH provider (cold local state) reloads purely from the server. It must
    // authenticate first (load() does not — only initialize() does); we drive the
    // provider's own auth session so its data client carries a live JWT.
    const reader = makeVaultProvider(server.baseUrl, priv, 'reader-device');
    reader.setIdentity(id);
    await reader.authTokenSource().authenticate();
    const loaded = await reader.load();
    expect(loaded.success).toBe(true);
    const data = loaded.data as TxfStorageDataBase;
    // The reserved meta-address entry was restored (#17 — XP-invariant address).
    expect(data._meta.address).toBe(id.directAddress);
    // The two token entries are back as known server rows (2 tokens + reserved slot).
    expect(reader.knownCount()).toBeGreaterThanOrEqual(3);
  });

  it('courier: deposit → receive → ack → sender sees the ack on /sent', async () => {
    const senderId = await makeIdentity('33'.repeat(32));
    const recipId = await makeIdentity('44'.repeat(32));
    const senderApi = await authedApi(server.baseUrl, senderId);
    const recipApi = await authedApi(server.baseUrl, recipId);

    const received: Array<{ payload: V2TransferPayload; sender: string }> = [];
    const sender = new CourierDeliveryProvider({
      vaultUrl: server.baseUrl,
      network: NETWORK,
      httpClientFactory: () => new HttpCourierClient({ vaultUrl: server.baseUrl, auth: senderApi }),
      journal: memKv(),
      onV2Transfer: () => Promise.resolve(),
    });
    const recipient = new CourierDeliveryProvider({
      vaultUrl: server.baseUrl,
      network: NETWORK,
      httpClientFactory: () => new HttpCourierClient({ vaultUrl: server.baseUrl, auth: recipApi }),
      journal: memKv(),
      onV2Transfer: (payload, s) => {
        received.push({ payload, sender: s });
        return Promise.resolve();
      },
    });
    sender.setIdentity(senderId);
    recipient.setIdentity(recipId);

    // Deposit a sealed envelope (a finished v2 token blob) to the recipient.
    const handle = await sender.deposit({
      recipientChainPubkey: recipId.chainPubkey,
      senderChainPubkey: senderId.chainPubkey,
      transferId: 'transfer-1',
      tokenBlobHex: BLOB_HEX,
      memo: 'gm',
    });
    expect(handle.recipientChainPubkey).toBe(recipId.chainPubkey);

    // Recipient pulls, decrypts, feeds handleV2Transfer, then acks.
    await recipient.receive();
    expect(received).toHaveLength(1);
    expect(received[0].payload.type).toBe('V2_TRANSFER');
    expect(received[0].sender).toBe(senderId.chainPubkey);

    // The SENDER's delivery gate verifies the recipient ackSig on /sent. This
    // requires the real `/sent` row to carry `ackNonce` (the consumed serverNonce)
    // so the sender can rebuild + verify the bound ack template (Part A WIRE-2).
    await sender.pollSent();
    const receipt = await sender.confirmReceipt(handle);
    expect(receipt).not.toBeNull();
    expect(receipt!.recipientChainPubkey).toBe(recipId.chainPubkey);
    expect(receipt!.entryId).toBe(handle.entryId);
  });
});
