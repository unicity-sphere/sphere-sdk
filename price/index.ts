/**
 * Price Provider
 *
 * Token market price abstraction with CoinGecko implementation.
 */

export type {
  PriceProvider,
  PricePlatform,
  TokenPrice,
  PriceProviderConfig,
} from './price-provider';

export { CoinGeckoPriceProvider } from './CoinGeckoPriceProvider';

// =============================================================================
// Factory
// =============================================================================

import type { PriceProviderConfig, PriceProvider } from './price-provider';
import { CoinGeckoPriceProvider } from './CoinGeckoPriceProvider';

/**
 * Create a price provider based on platform configuration
 *
 * @example
 * ```ts
 * const provider = createPriceProvider({ platform: 'coingecko', apiKey: 'CG-xxx' });
 * ```
 */
export function createPriceProvider(config: PriceProviderConfig): PriceProvider {
  switch (config.platform) {
    case 'coingecko':
      return new CoinGeckoPriceProvider(config);
    default:
      throw new Error(`Unsupported price platform: ${String(config.platform)}`);
  }
}
