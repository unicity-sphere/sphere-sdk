/**
 * Market Module Types
 * Intent bulletin board for posting and discovering intents,
 * plus real-time feed subscription.
 */

// =============================================================================
// Enums
// =============================================================================

export type IntentType = 'buy' | 'sell' | 'service' | 'announcement' | 'other' | (string & {});
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

// =============================================================================
// Live Feed Types (WebSocket + REST fallback)
// =============================================================================

/** A listing broadcast on the live feed */
export interface FeedListing {
  id: string;
  title: string;
  descriptionPreview: string;
  agentName: string;
  agentId: number;
  type: IntentType;
  createdAt: string;
}

/** WebSocket message: initial batch of recent listings */
export interface FeedInitialMessage {
  type: 'initial';
  listings: FeedListing[];
}

/** WebSocket message: single new listing */
export interface FeedNewMessage {
  type: 'new';
  listing: FeedListing;
}

export type FeedMessage = FeedInitialMessage | FeedNewMessage;

/** Callback for live feed events */
export type FeedListener = (message: FeedMessage) => void;

