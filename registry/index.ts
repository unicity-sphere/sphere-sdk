/**
 * Token Registry Module
 *
 * Provides token metadata lookup functionality for the Unicity network.
 */

export {
  // Class
  TokenRegistry,
  // Types
  type TokenDefinition,
  type TokenIcon,
  type RegistryNetwork,
  type TokenRegistryConfig,
  // Convenience functions
} from './TokenRegistry';

// Singleton-bound convenience readers (see global-readers.ts).
export {
  getTokenDefinition,
  getTokenSymbol,
  getTokenName,
  getTokenDecimals,
  getTokenIconUrl,
  isKnownToken,
  getCoinIdBySymbol,
  getCoinIdByName,
  normalizeCoinId,
  coinIdsMatch,
} from './global-readers';
