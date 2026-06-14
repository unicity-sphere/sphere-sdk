/**
 * createCourierDeliveryTransport factory (wallet-courier wiring, concern 2).
 *
 * The wallet cannot construct a CourierDeliveryProvider itself — it holds only the
 * PUBLIC identity, but the provider reads the raw spend key (`me.privateKey`) on
 * deposit/receive/ack. This factory is the SDK-internal seam that builds the provider
 * from a FullIdentity (key in scope), resolving the vault URL from NETWORKS, wiring a
 * real fetch+JWT courier client over an auth session, and a durable journal store.
 *
 * Two auth modes (both exercised here over a REAL node:http socket fronting the fake
 * courier, so the full handshake + courier path runs through real fetch):
 *  - SHARED: when the vault is enabled, the courier reuses the vault provider's
 *    `authTokenSource()` — ONE JWT for vault + courier.
 *  - OWN: when the vault is off, the courier builds its own VaultApiClient session.
 *
 * The PaymentsModule sinks (`onV2Transfer` / `onDelivered`) are bound AFTER
 * construction via `setSinks`; the factory leaves them as no-ops.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { createCourierDeliveryTransport } from '../../../transport/courier/factory';
import { createVaultTokenStorage } from '../../../storage/remote/factory';
import { startRealVaultSocket, type RealVaultSocket } from '../../helpers/real-vault-socket';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const NETWORK = 'testnet2';
const SENDER_PRIV = '9d'.repeat(32);
const RECIP_PRIV = '7c'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIP_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIP_PRIV), true));

const senderId: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1sender', privateKey: SENDER_PRIV };
const recipId: FullIdentity = { chainPubkey: RECIP_PUB, l1Address: 'alpha1recip', privateKey: RECIP_PRIV };

const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

/** A minimal in-memory StorageProvider slice (the factory only needs get/set). */
function memStorage(): Pick<StorageProvider, 'get' | 'set'> {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => Promise.resolve(void m.set(k, v)),
  };
}

let socket: RealVaultSocket;
beforeEach(async () => {
  socket = await startRealVaultSocket(NETWORK);
});
afterEach(async () => {
  await socket.close();
});

describe('createCourierDeliveryTransport', () => {
  it('builds a courier that deposits over real fetch on its OWN auth session (vault off)', async () => {
    const courier = createCourierDeliveryTransport({
      identity: senderId,
      network: NETWORK,
      storage: memStorage(),
      vaultUrl: socket.baseUrl, // override NETWORKS url for the test socket
    });

    const handle = await courier.deposit({
      recipientChainPubkey: RECIP_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-own',
      tokenBlobHex: BLOB_HEX,
    });

    expect(handle.transferId).toBe('tx-own');
    // The deposit authenticated + reached the fake courier through real fetch + JWT.
    expect(socket.courier.deliveryCount).toBe(1);
  });

  it('shares the vault provider auth session when authTokenSource is supplied (one JWT)', async () => {
    // Build the vault provider; the courier reuses its authTokenSource() — one JWT.
    const vault = createVaultTokenStorage({
      identity: senderId,
      network: NETWORK,
      storage: memStorage() as unknown as StorageProvider,
      vaultUrl: socket.baseUrl,
    });
    vault.setIdentity(senderId);
    await vault.initialize(); // authenticates the shared session

    const courier = createCourierDeliveryTransport({
      identity: senderId,
      network: NETWORK,
      storage: memStorage(),
      vaultUrl: socket.baseUrl,
      authTokenSource: vault.authTokenSource(),
    });

    await courier.deposit({
      recipientChainPubkey: RECIP_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-shared',
      tokenBlobHex: BLOB_HEX,
    });
    expect(socket.courier.deliveryCount).toBe(1);
  });

  it('round-trips a transfer end-to-end: sender deposits, recipient receives into the bound sink', async () => {
    const sender = createCourierDeliveryTransport({
      identity: senderId,
      network: NETWORK,
      storage: memStorage(),
      vaultUrl: socket.baseUrl,
    });
    const recipient = createCourierDeliveryTransport({
      identity: recipId,
      network: NETWORK,
      storage: memStorage(),
      vaultUrl: socket.baseUrl,
    });

    const received: Array<{ payload: V2TransferPayload; sender: string }> = [];
    recipient.setSinks({
      onV2Transfer: async (payload, senderPubkey) => {
        received.push({ payload, sender: senderPubkey });
      },
    });

    await sender.deposit({
      recipientChainPubkey: RECIP_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-e2e',
      tokenBlobHex: BLOB_HEX,
      memo: 'gm',
    });
    await recipient.receive();

    expect(received).toHaveLength(1);
    expect(received[0].payload.type).toBe('V2_TRANSFER');
    expect(received[0].payload.tokenBlob).toBe(BLOB_HEX);
    expect(received[0].payload.memo).toBe('gm');
    expect(received[0].sender).toBe(SENDER_PUB);
  });

  it('resolves vaultUrl from NETWORKS when not overridden (constructs without throwing)', () => {
    expect(() =>
      createCourierDeliveryTransport({
        identity: senderId,
        network: NETWORK,
        storage: memStorage(),
      }),
    ).not.toThrow();
  });
});
