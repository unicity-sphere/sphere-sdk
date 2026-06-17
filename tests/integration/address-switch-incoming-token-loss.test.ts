/**
 * Regression (#583, finding #1 — RUNTIME RE-CONFIRMATION OF #579): silent
 * incoming-token LOSS on address switch.
 *
 * THIS TEST IS THE "re-confirm #579 at runtime" DELIVERABLE. #579 reported a
 * 0.51 UCT delivery that was stranded — never claimed, never visible — after an
 * address switch. The suspected root, confirmed here at runtime:
 *
 * The wallet-api preset composed ONE shared `WalletApiClient` + ONE delivery
 * provider, reused across every per-address `PaymentsModule`. `switchToAddress`
 * never quiesced the PREVIOUS address's module, so its 30s delivery poll pump
 * kept running. After the shared client/provider was re-bound (re-authed +
 * re-identified) to the NEW owner B, the PREVIOUS address A's still-live pump
 * pulled B's mailbox through that shared provider, found B's legit entry NOT
 * owned by A's engine, and `ack('rejected')` — which PERMANENTLY marks the entry
 * SEEN in the provider's persistent (tokenId, stateHash) seen-set (keyed by the
 * provider's CURRENT identity = B). B's own pump then skips the now-"seen" entry
 * forever: the token is silently lost (exactly #579's stranded value).
 *
 * THE FIX (#583): each HD address binds its OWN identity-bound delivery provider
 * (`createForAddress`). An orphaned previous-address pump runs against ITS OWN
 * owner's mailbox (A's, empty) and re-auths as A — it can never reach B's
 * mailbox, so it can never reject + mark-seen B's legit delivery. B claims and
 * stores it.
 *
 * FAILING-FIRST mechanism: both A's and B's modules build their delivery via
 * `template.createForAddress?.() ?? template`. On the PRE-FIX code
 * `createForAddress` does not exist on `WalletApiMailboxProvider`, so BOTH fall
 * back to the SHARED `template` — the orphaned A-pump poisons B's seen-set and
 * B's `receive()` yields NOTHING (RED: the strand). With the per-address fix
 * each gets its OWN isolated provider and B claims+stores the token (GREEN).
 *
 * Driven at the PaymentsModule + delivery-provider granularity with the
 * deterministic `FakeTokenEngine` against the in-process fake wallet-api — the
 * Sphere-level per-address modules build the REAL engine from the oracle trust
 * base (needs an aggregator), so a CLAIM (which needs the engine to verify +
 * derive delivery keys) is reproduced faithfully here instead of through
 * `Sphere.init` with a mock (no-engine) oracle. The wiring exercised
 * (`createForAddress`, the seen-set, reject-on-not-owned) is the exact product
 * code Sphere's switch path now drives. ONE scenario per file for fork isolation.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../types';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { StorageProvider } from '../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../unit/token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../token-engine/token-blob';
import { hexToBytes } from '../../core/crypto';

const UCT = '11'.repeat(32);
const OWNER_A = testIdentity(21);
const OWNER_B = testIdentity(22);
const SENDER = testIdentity(23);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

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

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
  delivery: WalletApiMailboxProvider;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * Build a wallet whose DELIVERY provider models how `Sphere.switchToAddress`
 * now isolates per address: from the composition `template`, take
 * `createForAddress()` when available (the #583 fix) or fall back to the SHARED
 * template instance (the pre-fix shared-client design). The fallback is what
 * lets ONE test be RED pre-fix and GREEN post-fix.
 */
function makeWallet(
  who: { privateKey: string; chainPubkey: string },
  template: WalletApiMailboxProvider,
  templateClient: WalletApiClient,
  kv: MemoryKeyValueStore,
): Wallet {
  const identity = fullIdentity(who);
  // Per-address isolation when supported (the #583 fix), else the SHARED
  // template instance + its client (the pre-fix shared-client design). The
  // fallback is what lets ONE test be RED pre-fix and GREEN post-fix WITHOUT
  // crashing on the missing method/getter.
  const isolated = template.createForAddress?.();
  const delivery = isolated ?? template;
  const client =
    (isolated as unknown as { walletApiClient?: WalletApiClient } | undefined)?.walletApiClient ??
    templateClient;
  delivery.setIdentity(identity);
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  // Each owner's token storage uses its OWN cloned client too (mirrors Sphere).
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: mockStorage(),
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, delivery };
}

function balanceOf(wallet: Wallet, coinId: string): bigint {
  return wallet.module
    .getTokens()
    .filter((t) => t.coinId === coinId)
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

describe('address-switch incoming-token loss — per-address client isolation (#583 finding #1 / #579 runtime re-confirmation)', () => {
  it('B claims its valid delivery even after A\'s orphaned pump runs — the #579 strand does not happen', { timeout: 30_000 }, async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());

    // ONE composition template + ONE shared persistence store — exactly the
    // wallet-api preset's single-client composition that A and B are derived
    // from (createForAddress clones the client; the shared kv is namespaced per
    // owner so per-owner seen-sets/cursors stay separate).
    const sharedKv = new MemoryKeyValueStore();
    const templateClient = new WalletApiClient({ baseUrl, network: fake.network, deviceId: 'tmpl', storage: sharedKv });
    const template = new WalletApiMailboxProvider({ client: templateClient, custody: 'inventory', stateStore: sharedKv });

    // Two HD addresses A (index 0) and B (index 1) of the SAME wallet.
    const a = makeWallet(OWNER_A, template, templateClient, sharedKv);
    await a.module.load();
    const b = makeWallet(OWNER_B, template, templateClient, sharedKv);
    await b.module.load();

    // A sender delivers a VALID token addressed to B (mint locked to B), 51 units
    // — echoing #579's stranded 0.51 UCT.
    const senderEngine = new FakeTokenEngine({ chainPubkey: hexToBytes(SENDER.chainPubkey) });
    const senderKv = new MemoryKeyValueStore();
    const senderClient = new WalletApiClient({ baseUrl, network: fake.network, deviceId: 'dev-s', storage: senderKv });
    const senderDelivery = new WalletApiMailboxProvider({ client: senderClient, custody: 'inventory', stateStore: senderKv });
    senderDelivery.setIdentity(fullIdentity(SENDER));
    senderDelivery.bindDeliveryKeys((bytes) => senderEngine.deliveryKeys(bytes));
    const forB = await senderEngine.mint({
      recipientPubkey: hexToBytes(OWNER_B.chainPubkey),
      value: { assets: [{ coinId: UCT, amount: 51n }] },
    });
    const bytesForB = encodeTokenBlob(senderEngine.encodeToken(forB));
    const { deliveryId } = await senderDelivery.deliver(OWNER_B.chainPubkey, bytesForB, { transferId: 'tf-579' });
    expect(fake.getMailboxEntry(OWNER_B.chainPubkey, deliveryId)).toMatchObject({ status: 'unclaimed' });

    // The switch A→B happens. On the SHARED-client design this re-binds the one
    // provider to B; A's still-running poll pump now points at B's mailbox.
    // Simulate that orphaned A-pump firing (the 30s poll tick) — it must NOT
    // strand B's delivery.
    await a.module.pumpIncomingDeliveries();

    // B receives: it MUST claim + store its 51-unit token. On the pre-fix shared
    // design A's pump already rejected + marked-seen this entry under B's
    // identity, so B's pull skips it and yields nothing — the #579 strand. With
    // per-address isolation A never touched B's mailbox, and B claims it.
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(balanceOf(b, UCT)).toBe(51n);

    // The entry was actually CLAIMED into B's inventory (the §6 handoff), not
    // left rejected/stranded.
    expect(fake.getMailboxEntry(OWNER_B.chainPubkey, deliveryId)).toMatchObject({
      status: 'claimed',
      intoInventory: true,
    });

    // And A — whose orphaned pump ran — holds NONE of B's value (no bleed).
    expect(balanceOf(a, UCT)).toBe(0n);
  });
});
