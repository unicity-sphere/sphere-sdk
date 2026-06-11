/**
 * Shared wallet-api providers (platform-neutral over the WalletApiClient).
 */

export {
  WalletApiTokenStorageProvider,
  createWalletApiTokenStorageProvider,
} from './WalletApiTokenStorageProvider';
export type { WalletApiTokenStorageConfig } from './WalletApiTokenStorageProvider';

export {
  WalletApiMailboxProvider,
  createWalletApiMailboxProvider,
} from './WalletApiMailboxProvider';
export type { WalletApiMailboxProviderConfig } from './WalletApiMailboxProvider';

export {
  createSphereProviders,
  createWalletApiProviders,
  createOwnStorageWalletApiProviders,
} from './composition';
export type {
  SphereBaseProviders,
  SphereProviderPorts,
  WalletApiCompositionConfig,
  WalletApiProviderExtras,
} from './composition';
