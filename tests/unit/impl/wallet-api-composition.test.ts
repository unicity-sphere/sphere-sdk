/**
 * S4 composition presets (sdk-changes S4/S7, covenant §3.1-6): each port is
 * selected independently; the presets bake custody in at composition time.
 */

import { describe, it, expect, vi } from 'vitest';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { DeliveryProvider, IncomingDelivery } from '../../../transport/delivery-provider';
import type { OracleProvider } from '../../../oracle';
import {
  createSphereProviders,
  createWalletApiProviders,
  createOwnStorageWalletApiProviders,
  WalletApiMailboxProvider,
  WalletApiTokenStorageProvider,
} from '../../../impl/shared/wallet-api';
import { WalletApiClient } from '../../../wallet-api';
import { MemoryKeyValueStore } from '../../support/wallet-api-test-helpers';

function base() {
  const storage = {
    id: 's', name: 's', type: 'local',
    get: vi.fn(async () => null), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  } as unknown as StorageProvider;
  const transport = { id: 't' } as unknown as TransportProvider;
  const oracle = { id: 'o' } as unknown as OracleProvider;
  const tokenStorage = { id: 'local-ts' } as unknown as TokenStorageProvider<TxfStorageDataBase>;
  return { storage, transport, oracle, tokenStorage };
}

const CONFIG = { baseUrl: 'http://127.0.0.1:1', network: 'testnet2', deviceId: 'dev-1' };

describe('createSphereProviders — independent port selection (S7)', () => {
  it('keeps base ports when nothing is selected', () => {
    const b = base();
    const out = createSphereProviders(b);
    expect(out.tokenStorage).toBe(b.tokenStorage);
    expect(out.oracle).toBe(b.oracle);
    expect(out.delivery).toBeUndefined();
  });

  it('swaps each port independently without touching the others', () => {
    const b = base();
    const storagePort = { id: 'other-ts' } as unknown as TokenStorageProvider<TxfStorageDataBase>;
    const enginePort = { id: 'other-oracle' } as unknown as OracleProvider;
    const deliveryPort: DeliveryProvider = {
      custody: 'external',
      deliver: async () => ({ deliveryId: 'x' }),
      // eslint-disable-next-line require-yield
      incoming: async function* (): AsyncGenerator<IncomingDelivery> { return; },
      ack: async () => undefined,
    };

    const out = createSphereProviders(b, { storage: storagePort, delivery: deliveryPort, engine: enginePort });
    expect(out.tokenStorage).toBe(storagePort);
    expect(out.oracle).toBe(enginePort);
    expect(out.delivery).toBe(deliveryPort);
    expect(out.transport).toBe(b.transport); // messaging stays on Nostr (S4)
  });
});

describe('wallet-api presets (S4)', () => {
  it('full preset: wallet-api storage + mailbox delivery with custody INVENTORY', () => {
    const out = createWalletApiProviders(base(), CONFIG);
    expect(out.tokenStorage).toBeInstanceOf(WalletApiTokenStorageProvider);
    expect(out.delivery).toBeInstanceOf(WalletApiMailboxProvider);
    expect(out.delivery.custody).toBe('inventory');
    expect(out.walletApi).toBeInstanceOf(WalletApiClient);
  });

  it("own-storage preset: base storage kept; delivery custody EXTERNAL baked in at construction", () => {
    const b = base();
    const out = createOwnStorageWalletApiProviders(b, CONFIG);
    expect(out.tokenStorage).toBe(b.tokenStorage); // custody stays in app storage
    expect(out.delivery).toBeInstanceOf(WalletApiMailboxProvider);
    expect(out.delivery.custody).toBe('external'); // never a per-call flag (S7)
    expect(out.walletApi).toBeInstanceOf(WalletApiClient);
  });

  it('an injected state store and client are honored (DI — no singletons)', () => {
    const kv = new MemoryKeyValueStore();
    const client = new WalletApiClient({ ...CONFIG, storage: kv });
    const out = createWalletApiProviders(base(), { ...CONFIG, client, stateStore: kv });
    expect(out.walletApi).toBe(client);
  });
});
