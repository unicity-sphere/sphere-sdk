/**
 * Courier receive (Task 5.2, §3/§6.4) against the in-process fake server.
 *
 * A deposited envelope, on `receive()`, is unpacked (first 24 bytes = nonce),
 * opened with `openCourierEnvelope`, decoded to a V2_TRANSFER payload, and fed to
 * the EXISTING `handleV2Transfer` path UNCHANGED. The test wires the provider's
 * `onV2Transfer` sink to a faithful mini-host that mirrors handleV2Transfer
 * (engine.verify → isOwnedBy → dedup `v2_<tokenId>` → store → RECEIVED history)
 * and asserts each step runs and the RECEIVED entry records the sender chainPubkey
 * with the nametag omitted (Nostr no-op over the courier).
 */

import { describe, it, expect, vi } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob, decodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import type { CourierJournalStore } from '../../../transport/courier/CourierDeliveryProvider';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

function memJournal(): CourierJournalStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

const sender: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1s', privateKey: SENDER_PRIV };
const recipient: FullIdentity = { chainPubkey: RECIPIENT_PUB, l1Address: 'alpha1r', privateKey: RECIPIENT_PRIV };

/**
 * A faithful mini-host mirroring PaymentsModule.handleV2Transfer. It is what the
 * provider's `onV2Transfer` sink feeds — the receive path is unchanged.
 */
function makeHandleV2Host() {
  const stored = new Set<string>(); // dedup by v2_<tokenId>
  const history: Array<Record<string, unknown>> = [];
  const engine = {
    verify: vi.fn(async () => ({ ok: true })),
    isOwnedBy: vi.fn(() => true),
    tokenId: vi.fn(() => TOKEN_ID),
  };
  const sink = async (payload: V2TransferPayload, senderPubkey: string): Promise<void> => {
    const blob = decodeTokenBlob(hexToBytes(payload.tokenBlob)); // decode like handleV2Transfer
    const verdict = await engine.verify(blob);
    if (!verdict.ok) return;
    if (!engine.isOwnedBy(blob, RECIPIENT_PUB)) return;
    const id = `v2_${engine.tokenId(blob)}`;
    if (stored.has(id)) return; // dedup
    stored.add(id);
    history.push({ type: 'RECEIVED', senderPubkey, tokenId: id }); // nametag omitted
  };
  return { sink, engine, stored, history };
}

function provider(id: FullIdentity, server: FakeCourierServer, sink: ReturnType<typeof makeHandleV2Host>['sink']) {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal: memJournal(),
    onV2Transfer: sink,
  });
  p.setIdentity(id);
  return p;
}

async function deposit(server: FakeCourierServer): Promise<void> {
  const sp = provider(sender, server, async () => {});
  await sp.deposit({
    recipientChainPubkey: RECIPIENT_PUB,
    senderChainPubkey: SENDER_PUB,
    transferId: 'tx-1',
    tokenBlobHex: BLOB_HEX,
    memo: 'hi',
  });
}

describe('courier receive', () => {
  it('opens the envelope and feeds handleV2Transfer (verify/isOwnedBy/dedup run)', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    const host = makeHandleV2Host();
    const rp = provider(recipient, server, host.sink);
    await rp.receive();

    expect(host.engine.verify).toHaveBeenCalledTimes(1);
    expect(host.engine.isOwnedBy).toHaveBeenCalledTimes(1);
    expect(host.engine.tokenId).toHaveBeenCalled();
    expect(host.stored.has(`v2_${TOKEN_ID}`)).toBe(true);
  });

  it('RECEIVED history records the sender chainPubkey, nametag omitted', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    const host = makeHandleV2Host();
    const rp = provider(recipient, server, host.sink);
    await rp.receive();

    expect(host.history).toHaveLength(1);
    expect(host.history[0].type).toBe('RECEIVED');
    expect(host.history[0].senderPubkey).toBe(SENDER_PUB);
    expect(host.history[0].senderNametag).toBeUndefined();
  });

  it('re-receiving a still-unclaimed item is harmless (dedup by v2_<tokenId>)', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    const host = makeHandleV2Host();
    const rp = provider(recipient, server, host.sink);
    await rp.receive();
    await rp.receive();

    // The sink ran twice but stored once (dedup) — exactly-once stored.
    expect(host.stored.size).toBe(1);
    expect(host.history).toHaveLength(1);
  });
});
