/**
 * Real fetch HTTP clients (Task 8.3, Deliverable 1) over a REAL `node:http` socket.
 *
 * Proves the fetch/JWT/error-mapping layer WITHOUT mongo: each client runs against
 * an actual listening socket fronting the in-memory fakes (`real-vault-socket`), so
 * real fetch, real Bearer headers and real status codes are exercised. The hard
 * cases the Phase-6 review flagged are covered explicitly:
 *  - **507 → body** on `PATCH /v1/entries` is PARSED and returned (never thrown).
 *  - **401 → ONE refresh + retry** drives `VaultApiClient.refresh()` exactly once.
 *  - JSON round-trips through challenge → verify → JWT → authed data + courier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, signMessage } from '../../../core/crypto';
import { VaultApiClient } from '../../../storage/remote/VaultApiClient';
import { HttpVaultAuthClient } from '../../../storage/remote/http/HttpVaultAuthClient';
import { HttpVaultClient } from '../../../storage/remote/http/HttpVaultClient';
import { HttpCourierClient } from '../../../transport/courier/http/HttpCourierClient';
import { VaultHttpError, createVaultHttpClients } from '../../../storage/remote/http/index';
import { courierAckTemplate } from '../../../transport/courier/ack-template';
import { startRealVaultSocket, type RealVaultSocket } from '../../helpers/real-vault-socket';
import type { VaultEntryPayload } from '../../../vault-aead/entry';

const NETWORK = 'testnet2';
const PRIV = '7c'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));

const RECIP_PRIV = '5a'.repeat(32);
const RECIP_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIP_PRIV), true));

const payload = (ct: string): VaultEntryPayload => ({ nonce: 'bg==', ct });

let socket: RealVaultSocket;

beforeEach(async () => {
  socket = await startRealVaultSocket(NETWORK);
});
afterEach(async () => {
  await socket.close();
});

/** Build + authenticate a `VaultApiClient` over the REAL fetch auth client. */
async function authedApi(priv = PRIV, pub = PUB): Promise<VaultApiClient> {
  const authClient = new HttpVaultAuthClient({ vaultUrl: socket.baseUrl });
  const api = new VaultApiClient({
    network: NETWORK,
    chainPubkey: pub,
    privateKey: priv,
    deviceId: 'device-1',
    authClient,
  });
  await api.authenticate();
  return api;
}

describe('HttpVaultAuthClient — real socket', () => {
  it('challenge → verify → JWT round-trips over real fetch', async () => {
    const api = await authedApi();
    expect(typeof api.token).toBe('string');
    expect(api.token!.length).toBeGreaterThan(0);
    expect(socket.vault.calls.verify).toHaveLength(1);
    expect(socket.vault.calls.verify[0].deviceId).toBe('device-1');
  });

  it('a refresh rotates the JWT (200 → new token)', async () => {
    const api = await authedApi();
    const before = api.token;
    const after = await api.refresh();
    expect(after).not.toBe(before);
    expect(socket.vault.calls.refresh).toHaveLength(1);
  });

  it('verify returns null on a 401 (bad signature)', async () => {
    const authClient = new HttpVaultAuthClient({ vaultUrl: socket.baseUrl });
    const ch = await authClient.challenge(PUB);
    const badSig = signMessage(RECIP_PRIV, ch.challenge); // wrong key → recovers to RECIP
    const tokens = await authClient.verify({ nonce: ch.nonce, signature: badSig, deviceId: 'd' });
    expect(tokens).toBeNull();
  });
});

describe('HttpVaultClient — real socket', () => {
  it('patchEntries + getState JSON round-trip (CAS create → readback)', async () => {
    const api = await authedApi();
    const vault = new HttpVaultClient({ vaultUrl: socket.baseUrl, auth: api });
    const res = await vault.patchEntries([{ key: 'k1', baseVersion: 0, payload: payload('YQ==') }]);
    expect(res.applied).toEqual(['k1']);
    expect(res.conflicts).toEqual([]);
    const state = await vault.getState(0);
    expect(state.entries.map((e) => e.key)).toContain('k1');
    expect(state.formatVersion).toBe('entries-v1');
    expect(state.epochSig.length).toBeGreaterThan(0);
  });

  it('507 → PatchResponse BODY is parsed and returned, NOT thrown', async () => {
    const api = await authedApi();
    const vault = new HttpVaultClient({ vaultUrl: socket.baseUrl, auth: api });
    socket.vault.setStorageFull(true); // whole batch blocked → 507 with a body
    const res = await vault.patchEntries([{ key: 'big', baseVersion: 0, payload: payload('YQ==') }]);
    expect(res.applied).toEqual([]);
    expect(res.rejected).toEqual([{ key: 'big', reason: 'insufficient_storage' }]);
    expect(res.conflicts).toEqual([]);
  });

  it('401 → ONE refresh + retry succeeds (drives VaultApiClient.refresh once)', async () => {
    const api = await authedApi();
    const vault = new HttpVaultClient({ vaultUrl: socket.baseUrl, auth: api });
    socket.expireNextToken(); // the next authed request 401s exactly once
    const res = await vault.patchEntries([{ key: 'k2', baseVersion: 0, payload: payload('YQ==') }]);
    expect(res.applied).toEqual(['k2']); // retried with a fresh JWT after the refresh
    expect(socket.vault.calls.refresh).toHaveLength(1); // exactly one rotation
  });

  it('a non-2xx (non-507) throws a typed VaultHttpError', async () => {
    const api = await authedApi();
    // Point at a path the socket does not serve so it 404s through authedJson.
    const vault = new HttpVaultClient({ vaultUrl: `${socket.baseUrl}/nope`, auth: api });
    await expect(vault.getState(0)).rejects.toBeInstanceOf(VaultHttpError);
  });

  it('history append + historySince round-trip', async () => {
    const api = await authedApi();
    const vault = new HttpVaultClient({ vaultUrl: socket.baseUrl, auth: api });
    const r = await vault.appendHistory([{ dedupKey: 'd1', payload: payload('aA==') }]);
    expect(r.accepted).toBe(1);
    const page = await vault.historySince(0);
    expect(page.records.map((x) => x.dedupKey)).toEqual(['d1']);
  });
});

describe('HttpCourierClient — real socket', () => {
  it('deposit → inbox → ack-nonce → ack → sent over real fetch', async () => {
    const senderApi = await authedApi();
    const recipApi = await authedApi(RECIP_PRIV, RECIP_PUB);
    const senderCourier = new HttpCourierClient({ vaultUrl: socket.baseUrl, auth: senderApi });
    const recipCourier = new HttpCourierClient({ vaultUrl: socket.baseUrl, auth: recipApi });

    const dep = await senderCourier.deposit({
      recipientPubkey: RECIP_PUB,
      entryId: 'e1',
      transferId: 't1',
      ciphertext: 'ZW52',
    });
    expect(dep.status).toBe('unclaimed');

    const inbox = await recipCourier.inbox(0);
    expect(inbox.items.map((i) => i.entryId)).toEqual(['e1']);

    const { serverNonce } = await recipCourier.ackNonce('e1');
    const tmpl = courierAckTemplate(NETWORK, PUB, 'e1', serverNonce);
    const ackSig = signMessage(RECIP_PRIV, tmpl);
    const ack = await recipCourier.ack({ entryId: 'e1', ackSig });
    expect(ack.result).toBe('claimed');

    // The sender sees the ack (with the consumed ackNonce) on /sent.
    const sent = await senderCourier.sent(0);
    const row = sent.items.find((i) => i.entryId === 'e1');
    expect(row?.status).toBe('claimed');
    expect(row?.ackSig).toBe(ackSig);
    expect(row?.ackNonce).toBe(serverNonce);
  });
});

describe('createVaultHttpClients — convenience factory', () => {
  it('builds vault + courier sharing one auth session', async () => {
    const api = await authedApi();
    const { vault, courier } = createVaultHttpClients({ vaultUrl: socket.baseUrl, auth: api });
    expect(vault).toBeInstanceOf(HttpVaultClient);
    expect(courier).toBeInstanceOf(HttpCourierClient);
    const res = await vault.patchEntries([{ key: 'kf', baseVersion: 0, payload: payload('YQ==') }]);
    expect(res.applied).toEqual(['kf']);
  });
});
