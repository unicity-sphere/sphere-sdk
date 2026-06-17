/**
 * Σ-verify — live testnet2 e2e for the WALLET payment path (PaymentsModule + real engine).
 *
 * Goes beyond the engine-only e2e: it drives PaymentsModule.send's v2 branch with a
 * REAL engine against the live testnet2 aggregator, and confirms the recipient gets a
 * valid, spendable finished token. Skipped unless TESTNET2_API_KEY is set.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsModule, type PaymentsModuleDependencies } from '../../modules/payments/PaymentsModule';
import { createSphereTokenEngine } from '../../token-engine/factory';
import { SigningService } from '../../token-engine/sdk';
import { decodeTokenBlob, encodeTokenBlob } from '../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../core/crypto';
import type { ITokenEngine } from '../../token-engine';
import type { FullIdentity } from '../../types';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../storage';
import type { V2TransferPayload } from '../../types/v2-transfer';

const GATEWAY = process.env.TESTNET2_GATEWAY ?? 'https://gateway.testnet2.unicity.network';
const API_KEY = process.env.TESTNET2_API_KEY;
const TRUSTBASE_URL =
  process.env.TESTNET2_TRUSTBASE_URL ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';
const UCT = '11'.repeat(32);

async function makeEngine(privateKey: Uint8Array): Promise<ITokenEngine> {
  const trustBaseJson = await (await fetch(TRUSTBASE_URL)).json();
  return createSphereTokenEngine({ aggregatorUrl: GATEWAY, apiKey: API_KEY, privateKey, trustBaseJson });
}

// ── minimal in-memory module deps ────────────────────────────────────────────
function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  const hist = new Map<string, HistoryRecord>();
  return {
    id: 'ts', name: 'ts', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: 0 }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local', timestamp: 0 }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { hist.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...hist.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => hist.has(k)),
    clearHistory: vi.fn(async () => hist.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function mockTransport(recipientChainPubkey: string): TransportProvider & { captured: V2TransferPayload[] } {
  const captured: V2TransferPayload[] = [];
  return {
    captured,
    sendTokenTransfer: vi.fn(async (_pk: string, payload: V2TransferPayload) => { captured.push(payload); }),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: recipientChainPubkey, transportPubkey: 'bob-transport',
      // A valid DIRECT:// address (parsed/validated upfront; the v2 path transfers by chainPubkey).
      directAddress: 'DIRECT://00001386dc2547e656f7041444e3ef3772f374305551724ef9fe86cf004a118d917dd4192a29',
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider & { captured: V2TransferPayload[] };
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue({ submitTransferCommitment: vi.fn() }),
    getTrustBase: vi.fn().mockReturnValue({}),
    isDevMode: () => false,
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

function buildModule(engine: ITokenEngine, recipientChainPubkey: string) {
  const identity: FullIdentity = {
    chainPubkey: bytesToHex(engine.getIdentity().chainPubkey),
    directAddress: 'DIRECT://x',
    privateKey: '00', transportPubkey: 'dd'.repeat(32),
  };
  const tsp = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tsp.set('local', mockTokenStorage());
  const transport = mockTransport(recipientChainPubkey);
  const deps: PaymentsModuleDependencies = {
    identity, storage: mockStorage(), tokenStorageProviders: tsp,
    transport, oracle: mockOracle(), emitEvent: vi.fn(), tokenEngine: engine,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, transport };
}

// Hand a freshly-minted token (owned by `engine`) to its module via the v2 receiver.
async function fundModule(
  module: ReturnType<typeof buildModule>['module'], engine: ITokenEngine, amount: bigint,
): Promise<void> {
  const minted = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const payload: V2TransferPayload = {
    type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(minted))),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (module as any).handleIncomingTransfer({ id: 'fund', senderTransportPubkey: 'cc'.repeat(32), payload, timestamp: 0 });
}

describe.runIf(!!API_KEY)('PaymentsModule v2 payment path — live testnet2', () => {
  it('Alice sends a whole token to Bob; Bob receives a valid, spendable token', async () => {
    const aliceEngine = await makeEngine(SigningService.generatePrivateKey());
    const bobEngine = await makeEngine(SigningService.generatePrivateKey());
    const bobChainPubkey = bytesToHex(bobEngine.getIdentity().chainPubkey);

    const { module: alice, transport } = buildModule(aliceEngine, bobChainPubkey);
    await fundModule(alice, aliceEngine, 100n);
    expect(alice.getTokens()).toHaveLength(1);

    const result = await alice.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'gm' });
    expect(result.status).toBe('completed');
    expect(alice.getTokens()).toHaveLength(0); // source consumed

    // Bob decodes the handed-over blob and confirms it's a valid, his-owned, unspent token.
    expect(transport.captured).toHaveLength(1);
    const blob = decodeTokenBlob(hexToBytes(transport.captured[0].tokenBlob));
    const bobToken = await bobEngine.decodeToken(blob);
    expect(bobEngine.balanceOf(bobToken, UCT)).toBe(100n);
    expect((await bobEngine.verify(bobToken)).ok).toBe(true);
    expect(await bobEngine.isSpent(bobToken)).toBe(false);
    expect(bobEngine.readMemo(bobToken)).toBeNull(); // plain memo stays transport-only
  });

  it('Alice splits: sends 60 to Bob, keeps 40 change', async () => {
    const aliceEngine = await makeEngine(SigningService.generatePrivateKey());
    const bobEngine = await makeEngine(SigningService.generatePrivateKey());

    const { module: alice, transport } = buildModule(aliceEngine, bytesToHex(bobEngine.getIdentity().chainPubkey));
    await fundModule(alice, aliceEngine, 100n);

    const result = await alice.send({ recipient: '@bob', amount: '60', coinId: UCT });
    expect(result.status).toBe('completed');

    // Bob's 60.
    const bobToken = await bobEngine.decodeToken(decodeTokenBlob(hexToBytes(transport.captured[0].tokenBlob)));
    expect(bobEngine.balanceOf(bobToken, UCT)).toBe(60n);
    expect((await bobEngine.verify(bobToken)).ok).toBe(true);

    // Alice keeps 40 change (a real, confirmed token in her wallet).
    const change = alice.getTokens();
    expect(change).toHaveLength(1);
    expect(change[0].amount).toBe('40');
    expect(change[0].status).toBe('confirmed');
  });
});
