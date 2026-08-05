/**
 * P11 twins of the two address-switch bleed invariants the old-stack suites
 * enforced (address-switch-inventory-bleed / address-switch-payment-request-bleed),
 * ported to the facade level: after a switch, the NEW address's facade serves
 * ONLY its own inventory and its own payment requests — nothing bleeds across
 * the per-(network, address) scoped KV or the per-owner server state, and a
 * switch-back still serves the original address's records.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import { makePv2World, seedPv2Inventory, type Pv2World } from '../support/pv2-world';
import { FakeWalletApiV2Client } from '../unit/payments-v2/fakes/fake-client';

const MNEMONIC = 'test test test test test test test test test test test junk';
const COIN = 'bb'.repeat(32);

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
    getApiKey: () => 'key',
  } as unknown as OracleProvider;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
}, 30_000);

async function buildSphere(world: Pv2World): Promise<Sphere> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-bleed-'));
  const storage = new FileStorageProvider({ dataDir });
  const { sphere } = await Sphere.init({
    storage,
    transport: createMockTransport(),
    oracle: createEngineOracle(),
    mnemonic: MNEMONIC,
    network: 'testnet',
    walletApi: world.walletApi,
  });
  cleanups.push(async () => {
    await sphere.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return sphere;
}

describe('address-switch bleed invariants (facade twins of the old-stack suites)', () => {
  it('inventory never bleeds across an address switch, and a switch-back still serves it', async () => {
    const world = makePv2World();
    const sphere = await buildSphere(world);

    // Address 0 owns one token, visible through its facade.
    const seeded = await seedPv2Inventory(world, world.transports[0]!, COIN, 40n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.payments.tokens().map((t) => t.id)).toContain(seeded.tokenId);
    });

    // Switch: the fresh vertical serves address 1's (empty) inventory — the
    // previous owner's token never appears, not even transiently after a wake.
    await sphere.switchToAddress(1);
    expect(world.transports).toHaveLength(2);
    expect(sphere.payments.tokens()).toEqual([]);
    world.transports[1]!.session.fire('inventory');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sphere.payments.tokens()).toEqual([]);
    expect(await sphere.payments.assets(COIN)).toEqual([]);

    // Switch back: address 0's fresh vertical re-serves ITS token.
    await sphere.switchToAddress(0);
    world.transports[2]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.payments.tokens().map((t) => t.id)).toContain(seeded.tokenId);
    });
  }, 30_000);

  it('payment requests never bleed across an address switch, and a switch-back still serves them', async () => {
    const world = makePv2World();
    const sphere = await buildSphere(world);
    const addr0Pubkey = sphere.identity!.chainPubkey;

    // A third-party requester addresses a payment request to ADDRESS 0.
    const requester = new FakeWalletApiV2Client(
      world.api,
      { chainPubkey: '02' + 'e'.repeat(64), network: 'testnet2' },
      {}
    );
    await requester.createPaymentRequest({
      toPubkey: addr0Pubkey,
      assets: [{ coinId: COIN, amount: '5' }],
      memo: 'pay me',
    });
    world.transports[0]!.session.fire('payment_requests');
    await vi.waitFor(() => {
      expect(sphere.payments.requests.list()).toHaveLength(1);
    });

    // Switch: address 1's facade lists NO requests — the request stays keyed
    // to address 0's owner, and a wake on the new session surfaces nothing.
    await sphere.switchToAddress(1);
    expect(sphere.payments.requests.list()).toEqual([]);
    world.transports[1]!.session.fire('payment_requests');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sphere.payments.requests.list()).toEqual([]);

    // Switch back: address 0's request is served again.
    await sphere.switchToAddress(0);
    world.transports[2]!.session.fire('payment_requests');
    await vi.waitFor(() => {
      expect(sphere.payments.requests.list()).toHaveLength(1);
    });
  }, 30_000);
});
