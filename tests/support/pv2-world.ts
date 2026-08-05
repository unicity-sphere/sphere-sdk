/**
 * Shared post-flip Sphere test composition: every wallet needs a wallet-api
 * transport config (fail-closed init) and an engine-capable oracle. This is
 * the SAME FakeWalletApi world the payments-v2 suites prove the ports against,
 * exposed through the documented `paymentsV2Transport` DI seam.
 */

import { getPublicKey, hexToBytes } from '../../core/crypto';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import type {
  PaymentsV2Transport,
  PaymentsV2TransportArgs,
  WalletApiTransportConfig,
} from '../../core/payments-v2-wiring';
import { RealizationEngine, fakeDecodeBlobFor } from '../unit/payments-v2/machine-harness';
import { FakeSession } from '../unit/payments-v2/support';
import { FakeWalletApi, sha256Hex, type FakeCaller } from '../unit/payments-v2/fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from '../unit/payments-v2/fakes/fake-client';

export interface Pv2TransportRecord {
  session: FakeSession;
  client: FakeWalletApiV2Client;
  args: PaymentsV2TransportArgs;
}

export interface Pv2World {
  realization: RealizationEngine;
  api: FakeWalletApi;
  transports: Pv2TransportRecord[];
  walletApi: WalletApiTransportConfig;
}

/** One in-process wallet-api world reachable through the `paymentsV2Transport` seam. */
export function makePv2World(network = 'testnet2'): Pv2World {
  const realization = new RealizationEngine({ chainPubkey: hexToBytes(getPublicKey('11'.repeat(32))) });
  const decodeBlob = fakeDecodeBlobFor(realization);
  const api = new FakeWalletApi({ decodeBlob });
  const transports: Pv2TransportRecord[] = [];
  const walletApi: WalletApiTransportConfig = {
    network,
    paymentsV2Transport: (args: PaymentsV2TransportArgs): PaymentsV2Transport => {
      const session = new FakeSession();
      const caller: FakeCaller = { chainPubkey: args.identity.chainPubkey, network: args.network };
      const client = new FakeWalletApiV2Client(api, caller, { decodeBlob });
      transports.push({ session, client, args });
      return { session, client };
    },
  };
  return { realization, api, transports, walletApi };
}

/** Seed one minted token into a transport's server-side inventory; fire('inventory') to deliver. */
export async function seedPv2Inventory(
  world: Pv2World,
  record: Pv2TransportRecord,
  coinId: string,
  amount: bigint
): Promise<{ tokenId: string }> {
  const token = await world.realization.mint({
    recipientPubkey: hexToBytes(record.args.identity.chainPubkey),
    value: { assets: [{ coinId, amount }] },
  });
  const bytes = token.blob.token;
  const sha = sha256Hex(bytes);
  await record.client.uploadBlob(`fake://put/${sha}`, bytes);
  await record.client.apply({
    transferId: `seed-${token.blob.tokenId}`,
    spent: [],
    added: [{ tokenId: token.blob.tokenId, key: sha }],
  });
  return { tokenId: token.blob.tokenId };
}

/** Oracle stub with the REAL testnet2 trust base so Sphere builds a REAL engine offline. */
export function createEngineOracle(): OracleProvider & { setApiKey: (key: string) => void } {
  let apiKey = 'test-key';
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    description: 'Engine-capable oracle stub',
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => true,
    getStatus: (): ProviderStatus => 'connected',
    initialize: async () => undefined,
    getTrustBaseJson: () => TRUSTBASE_TESTNET2,
    getAggregatorUrl: () => 'https://gateway.testnet2.unicity.network',
    getApiKey: () => apiKey,
    setApiKey: (key: string) => {
      apiKey = key;
    },
  } as unknown as OracleProvider & { setApiKey: (key: string) => void };
}
