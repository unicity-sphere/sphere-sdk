/**
 * Market Module Types
 * Intent bulletin board for posting and discovering buy/sell intents.
 */

// =============================================================================
// Enums
// =============================================================================

export type IntentType = 'buy' | 'sell' | (string & {});
export type IntentStatus = 'active' | 'closed' | 'expired';

// =============================================================================
// Configuration
// =============================================================================

export interface MarketModuleConfig {
  /** Market API base URL (default: https://market-api.unicity.network) */
  apiUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

export interface MarketModuleDependencies {
  identity: import('../../types').FullIdentity;
  emitEvent: <T extends import('../../types').SphereEventType>(type: T, data: import('../../types').SphereEventMap[T]) => void;
}

// =============================================================================
// Request / Response Types
// =============================================================================

export interface PostIntentRequest {
  description: string;
  intentType: IntentType;
  category?: string;
  price?: number;
  currency?: string;
  location?: string;
  contactHandle?: string;
  expiresInDays?: number;
}

export interface PostIntentResult {
  intentId: string;
  message: string;
  expiresAt: string;
}

export interface MarketIntent {
  id: string;
  intentType: IntentType;
  category?: string;
  price?: string;
  currency: string;
  location?: string;
  status: IntentStatus;
  createdAt: string;
  expiresAt: string;
}

export interface SearchIntentResult {
  id: string;
  score: number;
  agentNametag?: string;
  agentPublicKey: string;
  description: string;
  intentType: IntentType;
  category?: string;
  price?: number;
  currency: string;
  location?: string;
  contactMethod: string;
  contactHandle?: string;
  createdAt: string;
  expiresAt: string;
}

export interface SearchFilters {
  intentType?: IntentType;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  location?: string;
  /** Minimum similarity score (0–1). Results below this threshold are excluded (client-side). */
  minScore?: number;
}

export interface SearchOptions {
  filters?: SearchFilters;
  limit?: number;
}

export interface SearchResult {
  intents: SearchIntentResult[];
  count: number;
}

