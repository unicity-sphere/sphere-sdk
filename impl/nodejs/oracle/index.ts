/**
 * Node.js Oracle Exports
 * Re-exports shared oracle with Node.js-specific TrustBaseLoader
 */

import * as fs from 'fs';
import {
  UnicityAggregatorProvider,
  type UnicityAggregatorProviderConfig,
} from '../../../oracle/UnicityAggregatorProvider';
import type { TrustBaseLoader } from '../../../oracle/oracle-provider';

// Re-export shared types and classes
export {
  UnicityAggregatorProvider,
  type UnicityAggregatorProviderConfig,
  UnicityOracleProvider,
  type UnicityOracleProviderConfig,
} from '../../../oracle/UnicityAggregatorProvider';

export type { TrustBaseLoader } from '../../../oracle/oracle-provider';

// =============================================================================
// Node.js TrustBase Loader
// =============================================================================

/**
 * Node.js TrustBase loader using fs
 */
export class NodeTrustBaseLoader implements TrustBaseLoader {
  private filePath: string;

  constructor(filePath: string = './trustbase-testnet.json') {
    this.filePath = filePath;
  }

  async load(): Promise<unknown | null> {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore file errors
    }
    return null;
  }
}

/**
 * Create Node.js TrustBase loader
 */
export function createNodeTrustBaseLoader(filePath?: string): TrustBaseLoader {
  return new NodeTrustBaseLoader(filePath);
}

// =============================================================================
// Node.js Factory
// =============================================================================

/**
 * Create UnicityAggregatorProvider with Node.js TrustBase loader
 */
export function createUnicityAggregatorProvider(
  config: Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'> & {
    trustBasePath?: string;
  }
): UnicityAggregatorProvider {
  const { trustBasePath, ...restConfig } = config;
  return new UnicityAggregatorProvider({
    ...restConfig,
    trustBaseLoader: createNodeTrustBaseLoader(trustBasePath),
  });
}

/** @deprecated Use createUnicityAggregatorProvider instead */
export const createUnicityOracleProvider = createUnicityAggregatorProvider;
