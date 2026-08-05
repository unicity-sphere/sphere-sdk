// The wallet-api composition preset: a plain CONFIG (WalletApiTransportConfig)
// that Sphere.init consumes directly and fails closed without.

import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { WalletApiTransportConfig } from '../../../core/payments-v2-wiring';

export type { WalletApiTransportConfig } from '../../../core/payments-v2-wiring';

/** The minimum any platform base bundle provides (browser/node factories do). */
export interface SphereBaseProviders {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
}

export interface SphereProviderPorts {
  /** Engine/aggregator config port override */
  engine?: OracleProvider;
}

/** Compose a bundle with the engine port selected independently. */
export function createSphereProviders<B extends SphereBaseProviders>(
  base: B,
  ports: SphereProviderPorts = {}
): B {
  return {
    ...base,
    ...(ports.engine ? { oracle: ports.engine } : {}),
  };
}

export interface WalletApiCompositionConfig {
  baseUrl: string;
  network: string;
  deviceId?: string;
  fetchFn?: unknown;
  webSocketFactory?: unknown;
  paymentsV2Transport?: WalletApiTransportConfig['paymentsV2Transport'];
}

/** Attach the transport config the payments vertical is composed from; pass the result to `Sphere.init`. */
export function createWalletApiProviders<B extends SphereBaseProviders>(
  base: B,
  config: WalletApiCompositionConfig
): B & { walletApi: WalletApiTransportConfig } {
  const walletApi: WalletApiTransportConfig = {
    network: config.network,
    baseUrl: config.baseUrl,
    ...(config.deviceId !== undefined ? { deviceId: config.deviceId } : {}),
    ...(config.fetchFn !== undefined ? { fetchFn: config.fetchFn } : {}),
    ...(config.webSocketFactory !== undefined ? { webSocketFactory: config.webSocketFactory } : {}),
    ...(config.paymentsV2Transport !== undefined ? { paymentsV2Transport: config.paymentsV2Transport } : {}),
  };
  return { ...base, walletApi };
}
