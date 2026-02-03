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
import { BaseTrustBaseLoader } from '../../shared/trustbase-loader';
import type { NetworkType } from '../../../constants';

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
 * Node.js TrustBase loader - loads from file or uses embedded data
 */
export class NodeTrustBaseLoader extends BaseTrustBaseLoader {
  private filePath?: string;

  constructor(filePathOrNetwork?: string | NetworkType) {
    if (!filePathOrNetwork) {
      super('testnet');
    } else if (filePathOrNetwork.includes('/') || filePathOrNetwork.includes('.')) {
      super('testnet');
      this.filePath = filePathOrNetwork;
    } else {
      super(filePathOrNetwork as NetworkType);
    }
  }

  protected async loadFromExternal(): Promise<unknown | null> {
    if (!this.filePath) return null;

    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Fall through to embedded
    }
    return null;
  }
}

/**
 * Create Node.js TrustBase loader
 */
export function createNodeTrustBaseLoader(filePathOrNetwork?: string | NetworkType): TrustBaseLoader {
  return new NodeTrustBaseLoader(filePathOrNetwork);
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
    network?: NetworkType;
  }
): UnicityAggregatorProvider {
  const { trustBasePath, network, ...restConfig } = config;
  return new UnicityAggregatorProvider({
    ...restConfig,
    trustBaseLoader: createNodeTrustBaseLoader(trustBasePath ?? network ?? 'testnet'),
  });
}

/** @deprecated Use createUnicityAggregatorProvider instead */
export const createUnicityOracleProvider = createUnicityAggregatorProvider;
