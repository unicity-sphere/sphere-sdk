/**
 * §5.1 restore-protocol conformance through the REAL Sphere wiring
 * (docs/PAYMENTS-V2-DESIGN.md §5.1/§5.7/§6 + core/payments-v2-wiring.ts).
 *
 * THE invariant under test: after the server's syncEpoch changes, no stream
 * may resume from a pre-restore cursor, and the two non-rebuildable server
 * tables (intents, checkpoint progress) are re-seeded from the local §6
 * backstops BEFORE anything resumes.
 *
 * Drives fake.bumpEpoch() mid-session and asserts, end-to-end:
 *  - the open intent is re-PUT byte-identical (requiresSeedClose preserved);
 *  - the cached E.4 checkpoint ciphertext is re-POSTed byte-identical;
 *  - every stream cursor record is reset;
 *  - a delivery deposited AFTER the restore actually arrives — including the
 *    missed-wake case where the deposit's post-restore seq is LOWER than the
 *    stale cursor (the loss scenario), caught by the DeliveryPort's
 *    incomingEpoch() self-detection;
 *  - the production wiring holds no no-op stub for any deps field.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sphere, type SphereWalletApiSession } from '../../core/Sphere';
import {
  deriveKeyAtPath,
  getPublicKey,
  hexToBytes,
  identityFromMnemonicSync,
  signMessage,
  verifySignedMessage,
} from '../../core/crypto';
import { deriveFieldEncryptionKey, encryptField, encryptFieldBytes } from '../../core/field-encryption';
import { progressSignMessage } from '../../core/wallet-api-protocol';
import { DEFAULT_BASE_PATH } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { WalletApiDeliveryPort } from '../../impl/wallet-api-v2/mailbox';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import type { ITokenEngine } from '../../token-engine';
import type { PaymentsFacade } from '../../modules/payments-v2/PaymentsFacade';
import type {
  PaymentsV2Transport,
  PaymentsV2TransportArgs,
} from '../../core/payments-v2-wiring';
import { createScopedKV, STORE_KEYS, type IntentBackstopEntry } from '../../modules/payments-v2/stores';
import type { StreamCursor } from '../../modules/payments-v2/stores';
import { RealizationEngine, fakeDecodeBlobFor } from '../unit/payments-v2/machine-harness';
import { FakeSession, memoryKV } from '../unit/payments-v2/support';
import { FakeWalletApi, type FakeCaller } from '../unit/payments-v2/fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from '../unit/payments-v2/fakes/fake-client';

const MNEMONIC = 'test test test test test test test test test test test junk';
const NET = 'testnet2';
const COIN = 'aa'.repeat(32);
const PEER_PRIV = '22'.repeat(32);
const PEER_PUB = getPublicKey(PEER_PRIV);

// The SAME derivation Sphere.initializeIdentityFromMnemonic performs (address 0).
function deriveOwnIdentity(): { privateKey: string; chainPubkey: string } {
  const master = identityFromMnemonicSync(MNEMONIC);
  const derived = deriveKeyAtPath(master.privateKey, master.chainCode, `${DEFAULT_BASE_PATH}/0/0`);
  return { privateKey: derived.privateKey, chainPubkey: getPublicKey(derived.privateKey) };
}

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

function createEngineOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => TRUSTBASE_TESTNET2,
    getAggregatorUrl: () => 'https://gateway.testnet2.unicity.network',
    getApiKey: () => 'key-1',
  } as unknown as OracleProvider;
}

interface TransportRecord {
  session: FakeSession;
  client: FakeWalletApiV2Client;
  args: PaymentsV2TransportArgs;
}

function makeWorld() {
  const own = deriveOwnIdentity();
  const realization = new RealizationEngine({ chainPubkey: hexToBytes(own.chainPubkey) });
  const decodeBlob = fakeDecodeBlobFor(realization);
  const api = new FakeWalletApi({
    decodeBlob,
    // The wiring signs with the REAL chain key — verify for real (secp256k1).
    verifySeedSignature: (check) => verifySignedMessage(check.message, check.signature, check.chainPubkey),
  });
  const transports: TransportRecord[] = [];
  const walletApi = {
    network: NET,
    setIdentity: () => undefined,
    signIn: async () => undefined,
    logout: async () => undefined,
    paymentsV2Transport: (args: PaymentsV2TransportArgs): PaymentsV2Transport => {
      const session = new FakeSession();
      const caller: FakeCaller = { chainPubkey: args.identity.chainPubkey, network: args.network };
      const client = new FakeWalletApiV2Client(api, caller, { decodeBlob });
      transports.push({ session, client, args });
      return { session, client };
    },
  };
  const ownCaller: FakeCaller = { chainPubkey: own.chainPubkey, network: NET };
  const peerCaller: FakeCaller = { chainPubkey: PEER_PUB, network: NET };
  const peerPort = new WalletApiDeliveryPort({
    client: new FakeWalletApiV2Client(api, peerCaller, { decodeBlob }),
    kv: memoryKV(),
    identity: { privateKey: PEER_PRIV, chainPubkey: PEER_PUB },
    custody: 'inventory',
  });
  peerPort.bindDeliveryKeys((blob) => realization.deliveryKeys(blob));
  return {
    own,
    realization,
    api,
    transports,
    ownCaller,
    peerCaller,
    peerPort,
    walletApi: walletApi as unknown as SphereWalletApiSession,
  };
}

type World = ReturnType<typeof makeWorld>;

/** Mint via the realization engine and deposit to OWN through the peer's REAL port. */
async function peerDeposit(world: World, ownerPubkey: string, amount: bigint, transferId: string) {
  const token = await world.realization.mint({
    recipientPubkey: hexToBytes(ownerPubkey),
    value: { assets: [{ coinId: COIN, amount }] },
  });
  await world.peerPort.deliver(world.own.chainPubkey, token.blob.token, { transferId });
  return token;
}

async function seedInventory(world: World, record: TransportRecord, amount: bigint) {
  const token = await world.realization.mint({
    recipientPubkey: hexToBytes(world.own.chainPubkey),
    value: { assets: [{ coinId: COIN, amount }] },
  });
  const bytes = token.blob.token;
  const sha = (await import('../unit/payments-v2/fakes/FakeWalletApi')).sha256Hex(bytes);
  await record.client.uploadBlob(`fake://put/${sha}`, bytes);
  await record.client.apply({
    transferId: `seed-${token.blob.tokenId}`,
    spent: [],
    added: [{ tokenId: token.blob.tokenId, key: sha }],
  });
  return token;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
}, 30_000);

async function buildSphere(world: World) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-restore-'));
  const storage = new FileStorageProvider({ dataDir });
  const { sphere } = await Sphere.init({
    storage,
    transport: createMockTransport(),
    oracle: createEngineOracle(),
    mnemonic: MNEMONIC,
    network: 'testnet',
    walletApi: world.walletApi,
    paymentsV2: true,
  });
  cleanups.push(async () => {
    await sphere.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  // Receive decodes fake-world blobs — swap in the realization engine via the
  // documented public seam (the same one the api-key hot swap uses).
  (sphere.paymentsV2 as PaymentsFacade).setEngine(world.realization as unknown as ITokenEngine);
  const kv = createScopedKV(storage, NET, sphere.identity!.chainPubkey);
  return { sphere, storage, kv };
}

describe('Sphere paymentsV2 — §5.1 restore protocol conformance (FakeWalletApi bumpEpoch mid-session)', () => {
  it('epoch change → intents re-PUT byte-identical, checkpoint ciphertext re-POSTed, ALL stream cursors reset, and a post-restore deposit arrives', async () => {
    const world = makeWorld();
    const { sphere, kv } = await buildSphere(world);
    expect(sphere.identity!.chainPubkey).toBe(world.own.chainPubkey);
    const record = world.transports[0]!;
    await seedInventory(world, record, 40n);
    record.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.paymentsV2!.tokens().map((t) => t.amount)).toContain('40');
    });

    // ── pre-restore durable state ────────────────────────────────────────────
    // An OPEN split intent: server row + §6 local backstop (byte-identical envelope).
    const fieldKey = deriveFieldEncryptionKey(world.own.privateKey);
    const tid = 'restore-tid-1';
    const payload = {
      v: 2,
      recipient: PEER_PUB,
      coinId: COIN,
      amount: '100',
      direct: [],
      split: { tokenId: 'bb'.repeat(32), splitAmount: '100', remainderAmount: '50' },
      spentStates: { ['bb'.repeat(32)]: { local: 'cc'.repeat(32), protocol: 'cc'.repeat(32) } },
    };
    const envelope = encryptField(fieldKey, JSON.stringify(payload));
    await record.client.putIntent(tid, envelope, true);
    const backstop: IntentBackstopEntry = {
      transferId: tid,
      payloadEnvelope: envelope,
      requiresSeedClose: true,
      disposition: 'open',
      createdAt: Date.now(),
    };
    await kv.set(STORE_KEYS.intentBackstop, [backstop]);
    // The E.4 encrypt-once ciphertext cache (split op sits at direct.length = 0)
    // + the server-side slot it seeded pre-restore.
    const burnBytes = new TextEncoder().encode('checkpoint-bytes');
    const ciphertext = encryptFieldBytes(fieldKey, burnBytes, new TextEncoder().encode(`${tid}:0`));
    await kv.set(`${STORE_KEYS.checkpointCache}:${tid}:0`, ciphertext);
    await record.client.postProgress(
      tid,
      0,
      ciphertext,
      signMessage(world.own.privateKey, progressSignMessage(tid, 0, ciphertext))
    );
    // Stream cursors under epoch 1 (mailbox/payment_requests/history seeded; inventory was written by the pull).
    await kv.set(STORE_KEYS.streamCursor('mailbox'), { cursor: '9', syncEpoch: '1' });
    await kv.set(STORE_KEYS.streamCursor('payment_requests'), { cursor: 7, syncEpoch: '1' });
    await kv.set(STORE_KEYS.streamCursor('history'), { cursor: 'h5', syncEpoch: '1' });
    expect((await kv.get<StreamCursor>(STORE_KEYS.streamCursor('inventory')))?.syncEpoch).toBe('1');

    // ── the restore: DB lost server-side, wake frame carries the new epoch ──
    const nextEpoch = world.api.bumpEpoch();
    expect(world.api.inspectIntent(world.ownCaller, tid)).toBeUndefined(); // intent table gone
    await record.session.noteEpoch(String(nextEpoch));

    // Intent re-PUT byte-identical, requiresSeedClose preserved, still open.
    expect(world.api.inspectIntent(world.ownCaller, tid)).toEqual({
      status: 'open',
      requiresSeedClose: true,
      payload: envelope,
    });
    // Checkpoint ciphertext re-POSTed byte-identical into the fresh slot.
    expect(await record.client.getProgress(tid)).toEqual([
      expect.objectContaining({ opIndex: 0, payload: ciphertext }),
    ]);
    // Every stream cursor reset: no record pinned to epoch 1 survives. The
    // nudged drains re-establish mailbox/payment_requests under epoch 2 from
    // scratch (mailbox cursor '1' — the rebuilt entry — NOT the stale '9');
    // history has no writer, so its removal stays observable; inventory was
    // re-pulled by the reconciling full pull.
    await vi.waitFor(async () => {
      expect(await kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'))).toEqual({
        cursor: '1',
        syncEpoch: String(nextEpoch),
      });
    });
    await vi.waitFor(async () => {
      expect((await kv.get<StreamCursor>(STORE_KEYS.streamCursor('payment_requests')))?.syncEpoch).toBe(
        String(nextEpoch)
      );
    });
    expect(await kv.get(STORE_KEYS.streamCursor('history'))).toBeNull();
    expect((await kv.get<StreamCursor>(STORE_KEYS.streamCursor('inventory')))?.syncEpoch).toBe(String(nextEpoch));
    // The backstop survives (re-seeded, not consumed).
    expect(await kv.get(STORE_KEYS.intentBackstop)).toEqual([backstop]);
    // The seeded token survived the restore (rebuilt server-side, re-pulled).
    expect(sphere.paymentsV2!.tokens().map((t) => t.amount)).toContain('40');

    // ── the P1 arrival leg: a deposit made AFTER the restore reaches the app ─
    const fresh = await peerDeposit(world, world.own.chainPubkey, 5n, 'post-restore-transfer');
    const { transfers } = await sphere.paymentsV2!.receive();
    expect(transfers.map((t) => t.id)).toContain(fresh.blob.tokenId);
  }, 30_000);

  it('missed wake (lossy socket): a post-restore deposit whose seq is BELOW the stale cursor still arrives via the DeliveryPort incomingEpoch self-detection', async () => {
    const world = makeWorld();
    const { sphere, kv } = await buildSphere(world);

    // Five deposits of successive states of ONE own token (four already spent):
    // five acks advance OWN's mailbox cursor to 5 under epoch 1, while the five
    // blobs compress to a SINGLE tip entry when the server rebuilds.
    let hop = await world.realization.mint({
      recipientPubkey: hexToBytes(world.own.chainPubkey),
      value: { assets: [{ coinId: COIN, amount: 3n }] },
    });
    const states = [hop];
    for (let i = 0; i < 5; i++) {
      hop = await world.realization.transfer(
        { token: hop, recipientPubkey: hexToBytes(world.own.chainPubkey) },
        { transferId: `hop-${i}` }
      );
      states.push(hop);
    }
    for (let i = 0; i < 5; i++) {
      await world.peerPort.deliver(world.own.chainPubkey, states[i]!.blob.token, {
        transferId: `noise-${i}`,
      });
    }
    await sphere.paymentsV2!.receive();
    expect(await kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'))).toEqual({
      cursor: '5',
      syncEpoch: '1',
    });

    // Server restore the session never hears about (wakes are lossy): the five
    // entries rebuild to one tip, so OWN's mailbox seq restarts — the next
    // deposit lands at seq 2, BELOW the stale cursor 5. A resumed listing from
    // 5 sees NOTHING; only the page-epoch self-detection re-lists it.
    world.api.bumpEpoch();
    const fresh = await peerDeposit(world, world.own.chainPubkey, 9n, 'below-cursor-transfer');

    const { transfers } = await sphere.paymentsV2!.receive();
    expect(transfers.map((t) => t.id)).toContain(fresh.blob.tokenId);
    // The record was voided and re-established under the page-honest epoch.
    expect(await kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'))).toEqual({
      cursor: '2',
      syncEpoch: '2',
    });
  }, 30_000);

  it('the production wiring composes no no-op stub for any deps field (the unwired-restore regression)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'core', 'payments-v2-wiring.ts'),
      'utf8'
    );
    // The exact stub shapes that hid the unwired restore protocol before.
    expect(source).not.toMatch(/async \(\) => undefined/);
    expect(source).not.toMatch(/=> ''/);
    expect(source).not.toMatch(/onEpochChange/); // the bypassable hook is GONE, not defaulted
    // The epoch surfaces are wired from the session, the single authority.
    expect(source).toMatch(/syncEpoch: \(\) => transport\.session\.currentEpoch\(\)/);
  });
});
