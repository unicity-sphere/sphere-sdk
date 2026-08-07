/**
 * Wallet-api composition preset: `createWalletApiProviders` attaches a plain
 * transport CONFIG (not a client); `resolvePaymentsV2Composition` accepts it —
 * the exact duck Sphere.init consumes (fail-closed without it).
 */

import { describe, it, expect, vi } from 'vitest';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import {
  createSphereProviders,
  createWalletApiProviders,
} from '../../../impl/shared/wallet-api';
import { resolvePaymentsV2Composition } from '../../../core/payments-v2-wiring';

function base() {
  const storage = {
    id: 's', name: 's', type: 'local',
    get: vi.fn(async () => null), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  } as unknown as StorageProvider;
  const transport = { id: 't' } as unknown as TransportProvider;
  const oracle = { id: 'o' } as unknown as OracleProvider;
  return { storage, transport, oracle };
}

const CONFIG = { baseUrl: 'http://127.0.0.1:1', network: 'testnet2', deviceId: 'dev-1' };

describe('createSphereProviders — independent port selection', () => {
  it('keeps base ports when nothing is selected', () => {
    const b = base();
    const out = createSphereProviders(b);
    expect(out.oracle).toBe(b.oracle);
    expect(out.storage).toBe(b.storage);
    expect(out.transport).toBe(b.transport);
  });

  it('swaps the engine port without touching the others', () => {
    const b = base();
    const enginePort = { id: 'other-oracle' } as unknown as OracleProvider;

    const out = createSphereProviders(b, { engine: enginePort });
    expect(out.oracle).toBe(enginePort);
    expect(out.transport).toBe(b.transport); // messaging stays on Nostr
    expect(out.storage).toBe(b.storage);
  });
});

describe('createWalletApiProviders — the transport CONFIG preset', () => {
  it('attaches the config verbatim as `walletApi` (base bundle untouched)', () => {
    const b = base();
    const out = createWalletApiProviders(b, CONFIG);
    expect(out.storage).toBe(b.storage);
    expect(out.transport).toBe(b.transport);
    expect(out.oracle).toBe(b.oracle);
    expect(out.walletApi).toEqual({
      network: 'testnet2',
      baseUrl: 'http://127.0.0.1:1',
      deviceId: 'dev-1',
    });
  });

  it('forwards the paymentsV2Transport DI seam when supplied', () => {
    const seam = vi.fn();
    const out = createWalletApiProviders(base(), { ...CONFIG, paymentsV2Transport: seam });
    expect(out.walletApi.paymentsV2Transport).toBe(seam);
  });

  it('resolvePaymentsV2Composition accepts the produced config (the Sphere.init duck)', () => {
    const out = createWalletApiProviders(base(), CONFIG);
    const composition = resolvePaymentsV2Composition(out.walletApi, 'testnet2');
    expect(composition.network).toBe('testnet2');
    expect(typeof composition.factory).toBe('function');
  });

  it('resolvePaymentsV2Composition rejects a config with neither baseUrl nor seam', () => {
    expect(() => resolvePaymentsV2Composition({ network: 'testnet2' }, 'testnet2')).toThrowError(
      /neither `baseUrl`.*nor the `paymentsV2Transport\(\)` seam/
    );
  });

  it('resolvePaymentsV2Composition fails closed on a missing config', () => {
    expect(() => resolvePaymentsV2Composition(undefined, 'testnet2')).toThrowError(
      /requires a wallet-api composition/
    );
  });
});
