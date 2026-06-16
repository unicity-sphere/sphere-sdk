/**
 * S5 LIVE re-confirmation of #579 — the address-switch incoming-token STRAND,
 * proven RED→GREEN against the REAL testnet2 stack (real engine + real
 * aggregator gateway + real wallet-api backend), not just the provider-level
 * fake.
 *
 * WHAT #579 IS. The wallet-api preset composed ONE shared `WalletApiClient` +
 * ONE `WalletApiMailboxProvider`, reused across every per-address
 * `PaymentsModule`. On an address switch A→B the shared client/delivery is
 * re-bound (re-authed + re-identified) to B, but A's previous `PaymentsModule`
 * was never quiesced — its still-live 30s delivery poll pump keeps iterating
 * the now-B-bound provider, pulls B's legit incoming entry, finds it NOT owned
 * by A's engine and `ack('rejected')`s it. That reject (a) rejects the entry on
 * the REAL backend AND (b) adds it to the persistent seen-set keyed by the
 * provider's CURRENT identity (= B). B's own pump then skips the now-"seen"
 * (and backend-rejected) entry forever: the token is silently stranded — B's
 * `receive()` never sees it (exactly #579's 0.51 UCT stranded delivery).
 *
 * THE FIX (#583/#585). Each HD address binds its OWN identity-bound client via
 * `createForAddress` (the mailbox provider clones the client; the token storage
 * reuses that same per-address client). An orphaned previous-address pump runs
 * against ITS OWN owner's (empty) mailbox and re-auths as A — it can never
 * reach, reject, or mark-seen B's delivery, so B claims + stores its token.
 *
 * RED→GREEN IN ONE LIVE RUN. Both wirings are expressed here over the same real
 * stack, mirroring the fake-level regression
 * (tests/integration/address-switch-incoming-token-loss.test.ts) but with the
 * REAL `createSphereTokenEngine`, the REAL `WalletApiClient`, the REAL backend,
 * and a REAL split/mint state transition certified through the testnet2
 * gateway:
 *   - 'shared'   — the PRE-FIX shape: A and B derive from ONE shared provider
 *                  template (createForAddress is bypassed). A's orphaned pump
 *                  rejects + marks-seen B's delivery → B.receive() yields
 *                  NOTHING. RED (the strand).
 *   - 'isolated' — the #585 shape: each address gets its OWN createForAddress
 *                  client/provider. A's orphaned pump can't touch B's mailbox →
 *                  B claims + stores the real token. GREEN.
 *
 * GRANULARITY (stated plainly). Driven at the SAME granularity as the rest of
 * the live harness: two real `PaymentsModule`s + the real engine + real
 * wallet-api + real aggregator — NOT full `Sphere.switchToAddress`. The harness
 * deliberately drives `PaymentsModule` (+ `createSphereTokenEngine`) rather than
 * `Sphere.init`/`switchToAddress`, because the live engine is built per address
 * from the oracle trustbase; this file models the shared-vs-per-address delivery
 * wiring (`createForAddress` ?? shared template) that Sphere's switch path now
 * drives, faithfully and at the layer the strand actually occurs.
 *
 * LOCAL-ONLY (`npm run test:e2e:live`): needs Docker, the sibling wallet-api
 * checkout and network egress. §18 triage rule: infra failures block/retry —
 * they never license code changes or test weakening.
 */

import { describe, it, expect, afterEach } from 'vitest';

import type { FullIdentity } from '../../../types';
import { createSphereTokenEngine, type ITokenEngine, type TokenBlob } from '../../../token-engine';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import { fetchTrustbaseJson, HARNESS_COIN, randomIdentity } from '../support/stack';
import { liveStackFromEnv } from './support/live-stack';
import { fullIdentity } from '../support/harness-wallet';

const stack = liveStackFromEnv();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** In-memory KeyValueStore shared by a wallet's client/providers (namespaced per owner). */
function memoryKv(): { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<void>; remove: (k: string) => Promise<void> } {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    remove: async (k) => {
      map.delete(k);
    },
  };
}

/** The StorageProvider surface PaymentsModule needs for its outbox/journal. */
function moduleStorage(): PaymentsModuleDependencies['storage'] {
  const map = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local',
    connect: async () => {}, disconnect: () => {}, isConnected: () => true,
    getStatus: () => 'connected', setIdentity: () => {},
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
    remove: async (k: string) => {
      map.delete(k);
    },
    has: async (k: string) => map.has(k),
    keys: async () => [...map.keys()],
    clear: async () => {
      map.clear();
    },
  } as unknown as PaymentsModuleDependencies['storage'];
}

function stubTransport(): PaymentsModuleDependencies['transport'] {
  return {
    resolve: async (recipient: string) =>
      /^0[23][0-9a-f]{64}$/i.test(recipient)
        ? { chainPubkey: recipient.toLowerCase(), transportPubkey: recipient.slice(2).toLowerCase(), directAddress: `DIRECT://${recipient.slice(0, 12)}` }
        : null,
    resolveTransportPubkeyInfo: async () => null,
    sendTokenTransfer: async () => {
      throw new Error('harness: assets ride the wallet-api delivery port (S4)');
    },
    onTokenTransfer: () => () => {},
    onPaymentRequest: () => () => {},
    onPaymentRequestResponse: () => () => {},
    connect: async () => {}, disconnect: () => {}, isConnected: () => true,
  } as unknown as PaymentsModuleDependencies['transport'];
}

function stubOracle(): PaymentsModuleDependencies['oracle'] {
  return { validateToken: async () => ({ valid: true }), isDevMode: () => false } as unknown as PaymentsModuleDependencies['oracle'];
}

interface Wallet {
  module: PaymentsModule;
  client: WalletApiClient;
  engine: ITokenEngine;
  identity: FullIdentity;
  delivery: WalletApiMailboxProvider;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** An address's per-address provider binding, BEFORE its PaymentsModule pumps start. */
interface AddressBinding {
  identity: FullIdentity;
  engine: ITokenEngine;
  delivery: WalletApiMailboxProvider;
  tokenStorage: WalletApiTokenStorageProvider;
  client: WalletApiClient;
}

/**
 * Bind one HD address's DELIVERY + TOKEN STORAGE the way the per-address switch
 * wires them, and bind its engine's delivery-key derivation onto the provider
 * (PaymentsModule.initialize does this; we do it explicitly so an orphaned pump
 * can resolve + reject through the SAME re-bound provider before B's module even
 * exists). In 'isolated' mode the address gets its OWN `createForAddress`
 * client/provider (the #585 fix). In 'shared' mode createForAddress is BYPASSED
 * — A and B drive the ONE shared template provider + client (the pre-fix
 * shared-client design), which is what lets A's orphaned pump reach + strand B's
 * delivery. Binding here is exactly what a switch A→B does to the shared
 * provider (setIdentity + re-bind deliveryKeys) — WITHOUT starting B's pumps.
 */
async function bindAddress(
  who: { privateKey: string; chainPubkey: string },
  template: WalletApiMailboxProvider,
  templateClient: WalletApiClient,
  templateTokenStorage: WalletApiTokenStorageProvider,
  mode: 'shared' | 'isolated',
): Promise<AddressBinding> {
  const identity = fullIdentity(who);
  const engine = await createSphereTokenEngine({
    aggregatorUrl: stack.aggregatorUrl,
    trustBaseJson: await fetchTrustbaseJson(stack),
    privateKey: hexToBytes(who.privateKey),
    ...(stack.aggregatorApiKey ? { apiKey: stack.aggregatorApiKey } : {}),
  });

  // Per-address isolation (#585) vs the shared template (pre-fix). The mailbox
  // provider clones the client; the token storage reuses that SAME per-address
  // client (Sphere threads it so an address holds ONE client across delivery +
  // walletApi + inventory).
  const delivery = mode === 'isolated' ? template.createForAddress() : template;
  const client = mode === 'isolated' ? delivery.walletApiClient : templateClient;
  delivery.setIdentity(identity);
  delivery.bindDeliveryKeys((bytes) => engine.deliveryKeys(bytes));
  const tokenStorage = mode === 'isolated' ? templateTokenStorage.createForAddress(client) : templateTokenStorage;
  tokenStorage.setIdentity(identity);
  return { identity, engine, delivery, tokenStorage, client };
}

/** Start the PaymentsModule (and its background pumps) for an already-bound address. */
function startModule(binding: AddressBinding): Wallet {
  const deps: PaymentsModuleDependencies = {
    identity: binding.identity,
    storage: moduleStorage(),
    tokenStorageProviders: new Map([[binding.tokenStorage.id, binding.tokenStorage]]),
    transport: stubTransport(),
    oracle: stubOracle(),
    emitEvent: () => {},
    tokenEngine: binding.engine,
    delivery: binding.delivery,
    walletApi: binding.client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, client: binding.client, engine: binding.engine, identity: binding.identity, delivery: binding.delivery };
}

function balanceOf(wallet: Wallet, coinId = HARNESS_COIN): bigint {
  return wallet.module.getTokens().filter((t) => t.coinId === coinId).reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

/**
 * One real scenario, parameterised by the delivery wiring:
 *   A mints a REAL token on testnet2 and `send`s a VALID slice to B (a real
 *   split/mint certified by the live gateway, deposited into B's mailbox on the
 *   real backend). The address switch A→B re-binds the shared provider to B;
 *   A's orphaned pump fires (the 30s poll tick). B then `receive()`s.
 * Returns B's claimed balance — 0n on the strand, the slice amount when claimed.
 */
async function runScenario(mode: 'shared' | 'isolated'): Promise<{ bClaimed: bigint; minted: bigint; slice: bigint }> {
  const ownerA = randomIdentity();
  const ownerB = randomIdentity();

  // ONE composition template + ONE shared KV — exactly the wallet-api preset's
  // single-client composition A and B are derived from. createForAddress clones
  // the client; the shared KV is namespaced per (network, chainPubkey) so
  // per-owner seen-sets/cursors stay separate.
  const sharedKv = memoryKv();
  const verifyToken = (() => {
    let eng: ITokenEngine | null = null;
    return async (blob: TokenBlob): Promise<boolean> => {
      eng ??= await createSphereTokenEngine({
        aggregatorUrl: stack.aggregatorUrl,
        trustBaseJson: await fetchTrustbaseJson(stack),
        privateKey: hexToBytes(ownerB.privateKey),
        ...(stack.aggregatorApiKey ? { apiKey: stack.aggregatorApiKey } : {}),
      });
      return (await eng.verify(await eng.decodeToken(blob))).ok;
    };
  })();
  const templateClient = new WalletApiClient({ baseUrl: stack.baseUrl, network: stack.network, deviceId: `tmpl-${mode}`, storage: sharedKv });
  const template = new WalletApiMailboxProvider({ client: templateClient, custody: 'inventory', stateStore: sharedKv });
  const templateTokenStorage = new WalletApiTokenStorageProvider({ client: templateClient, stateStore: sharedKv, verifyToken });

  // Address A comes online first (shared provider bound to A) — full module.
  const aBinding = await bindAddress(ownerA, template, templateClient, templateTokenStorage, mode);
  const a = startModule(aBinding);
  await a.module.load();

  // REAL open mint on testnet2 → into A's server inventory (small testnet amount).
  const minted = 100n;
  const mint = await a.module.mintFungibleToken(HARNESS_COIN, minted);
  expect(mint.success).toBe(true);

  // A sends a VALID slice to B: a REAL split/mint certified by the gateway, the
  // 51-unit slice deposited into B's mailbox on the real backend (echoing #579's
  // stranded 0.51 UCT). This deposit rides A's delivery provider — bound to A now.
  const slice = 51n;
  const sent = await a.module.send({ recipient: ownerB.chainPubkey, amount: slice.toString(), coinId: HARNESS_COIN, memo: 'live #579 strand' });
  expect(sent.status).toBe('completed');

  // The address switch A→B. In 'shared' mode this RE-BINDS the one template
  // provider/client/token-storage to B (setIdentity(B) + re-bind B's
  // deliveryKeys) — exactly what the pre-fix switch did to the shared provider —
  // but WITHOUT yet starting B's module pumps. In 'isolated' mode B gets its OWN
  // createForAddress client/provider, untouched by A.
  const bBinding = await bindAddress(ownerB, template, templateClient, templateTokenStorage, mode);

  // The orphaned A-pump fires NOW — after the switch re-bound the shared provider
  // to B, but BEFORE B's module pulls (the real #579 race: switchToAddress never
  // quiesced A's still-live 30s poll pump). On the pre-fix shared design A's pump
  // pulls B's mailbox through the re-bound provider, A's engine finds B's token
  // not-owned and `ack('rejected')`s it — rejecting it on the REAL backend AND
  // marking it seen under B's identity. On the #585 isolated design A's pump runs
  // against A's OWN cloned client + (empty) mailbox and can never touch B's.
  // Driven deterministically before B pulls (the live backend's wake socket would
  // otherwise let B's catch-up pump claim first — masking the strand the SHARED
  // wiring really has).
  await a.module.pumpIncomingDeliveries();

  // Only now does B come online and receive. RED (shared): A already rejected +
  // marked-seen B's entry → B's pull skips it → B yields NOTHING. GREEN
  // (isolated): A never touched B's mailbox → B claims + stores its real
  // 51-unit token.
  const b = startModule(bBinding);
  await b.module.load();
  await b.module.receive();
  const bClaimed = balanceOf(b);
  return { bClaimed, minted, slice };
}

describe('S5 LIVE — #579 address-switch STRAND, red→green over the REAL testnet2 stack', () => {
  it('SHARED-client wiring (pre-fix): the orphaned A-pump strands B\'s real delivery — B.receive() yields NOTHING (RED)', async () => {
    const { bClaimed, slice } = await runScenario('shared');
    // The #579 strand: B's legit, gateway-certified delivery was rejected +
    // marked-seen by A's orphaned pump through the re-bound shared client. B
    // claims NONE of its value.
    expect(bClaimed).toBe(0n);
    expect(bClaimed).not.toBe(slice);
  });

  it('per-address createForAddress isolation (#585): A\'s orphaned pump can\'t reach B\'s mailbox — B claims its real token (GREEN)', async () => {
    const { bClaimed, slice } = await runScenario('isolated');
    // The fix: A's orphaned pump ran against A's OWN cloned client + (empty)
    // mailbox and never touched B's delivery. B claims + stores the real,
    // gateway-certified 51-unit token.
    expect(bClaimed).toBe(slice);
  });
});
