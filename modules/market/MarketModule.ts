/**
 * Market Module
 *
 * Intent bulletin board — post and discover intents (buy, sell,
 * service, announcement, other) with secp256k1-signed requests
 * tied to the wallet identity. Includes real-time feed via WebSocket.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Default Market API URL (intent bulletin board) */
export const DEFAULT_MARKET_API_URL = 'https://market-api.unicity.network';
import type {
  MarketModuleConfig,
  MarketModuleDependencies,
  PostIntentRequest,
  PostIntentResult,
  MarketIntent,
  SearchIntentResult,
  SearchOptions,
  SearchResult,
  FeedListing,
  FeedMessage,
  FeedListener,
} from './types';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

function signRequest(body: unknown, privateKeyHex: string): SignedRequest {
  const timestamp = Date.now();
  const payload = JSON.stringify({ body, timestamp });
  const messageHash = sha256(new TextEncoder().encode(payload));
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const signature = secp256k1.sign(messageHash, privateKeyBytes);
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKeyBytes, true));

  return {
    body: JSON.stringify(body),
    headers: {
      'x-signature': bytesToHex(signature),
      'x-public-key': publicKey,
      'x-timestamp': String(timestamp),
      'content-type': 'application/json',
    },
  };
}

/** Convert camelCase PostIntentRequest to snake_case API body */
function toSnakeCaseIntent(req: PostIntentRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {
    description: req.description,
    intent_type: req.intentType,
  };
  if (req.category !== undefined) result.category = req.category;
  if (req.price !== undefined) result.price = req.price;
  if (req.currency !== undefined) result.currency = req.currency;
  if (req.location !== undefined) result.location = req.location;
  if (req.contactHandle !== undefined) result.contact_handle = req.contactHandle;
  if (req.expiresInDays !== undefined) result.expires_in_days = req.expiresInDays;
  return result;
}

/** Convert snake_case API search filters to snake_case body */
function toSnakeCaseFilters(opts?: SearchOptions): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (opts?.filters) {
    const f = opts.filters;
    if (f.intentType !== undefined) result.intent_type = f.intentType;
    if (f.category !== undefined) result.category = f.category;
    if (f.minPrice !== undefined) result.min_price = f.minPrice;
    if (f.maxPrice !== undefined) result.max_price = f.maxPrice;
    if (f.location !== undefined) result.location = f.location;
  }
  if (opts?.limit !== undefined) result.limit = opts.limit;
  return result;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapSearchResult(raw: any): SearchIntentResult {
  return {
    id: raw.id,
    score: raw.score,
    agentNametag: raw.agent_nametag ?? undefined,
    agentPublicKey: raw.agent_public_key,
    description: raw.description,
    intentType: raw.intent_type,
    category: raw.category ?? undefined,
    price: raw.price ?? undefined,
    currency: raw.currency,
    location: raw.location ?? undefined,
    contactMethod: raw.contact_method,
    contactHandle: raw.contact_handle ?? undefined,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
  };
}

function mapMyIntent(raw: any): MarketIntent {
  return {
    id: raw.id,
    intentType: raw.intent_type,
    category: raw.category ?? undefined,
    price: raw.price ?? undefined,
    currency: raw.currency,
    location: raw.location ?? undefined,
    status: raw.status,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
  };
}

function mapFeedListing(raw: any): FeedListing {
  return {
    id: raw.id,
    title: raw.title,
    descriptionPreview: raw.description_preview,
    agentName: raw.agent_name,
    agentId: raw.agent_id,
    type: raw.type,
    createdAt: raw.created_at,
  };
}

function mapFeedMessage(raw: any): FeedMessage {
  if (raw.type === 'initial') {
    return { type: 'initial', listings: (raw.listings ?? []).map(mapFeedListing) };
  }
  return { type: 'new', listing: mapFeedListing(raw.listing) };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// =============================================================================
// Implementation
// =============================================================================

export class MarketModule {
  private readonly apiUrl: string;
  private readonly timeout: number;
  private identity: FullIdentity | null = null;
  private registered = false;

  constructor(config?: MarketModuleConfig) {
    this.apiUrl = (config?.apiUrl ?? DEFAULT_MARKET_API_URL).replace(/\/+$/, '');
    this.timeout = config?.timeout ?? 30000;
  }

  /** Called by Sphere after construction */
  initialize(deps: MarketModuleDependencies): void {
    this.identity = deps.identity;
  }

  /** No-op — stateless module */
  async load(): Promise<void> {}

  /** No-op — stateless module */
  destroy(): void {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Post a new intent (agent is auto-registered on first post) */
  async postIntent(intent: PostIntentRequest): Promise<PostIntentResult> {
    const body = toSnakeCaseIntent(intent);
    const data = await this.apiPost('/api/intents', body);
    return {
      intentId: data.intent_id ?? data.intentId,
      message: data.message,
      expiresAt: data.expires_at ?? data.expiresAt,
    };
  }

  /** Semantic search for intents (public — no auth required) */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      ...toSnakeCaseFilters(opts),
    };
    const data = await this.apiPublicPost('/api/search', body);
    let results: SearchIntentResult[] = (data.intents ?? []).map(mapSearchResult);
    const minScore = opts?.filters?.minScore;
    if (minScore != null) {
      results = results.filter((r) => Math.round(r.score * 100) >= Math.round(minScore * 100));
    }
    return { intents: results, count: results.length };
  }

  /** List own intents (authenticated) */
  async getMyIntents(): Promise<MarketIntent[]> {
    const data = await this.apiGet('/api/intents');
    return (data.intents ?? []).map(mapMyIntent);
  }

  /** Close (delete) an intent */
  async closeIntent(intentId: string): Promise<void> {
    await this.apiDelete(`/api/intents/${encodeURIComponent(intentId)}`);
  }

  /** Fetch the most recent listings via REST (public — no auth required) */
  async getRecentListings(): Promise<FeedListing[]> {
    const res = await fetch(`${this.apiUrl}/api/feed/recent`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await this.parseResponse(res);
    return (data.listings ?? []).map(mapFeedListing);
  }

  /**
   * Subscribe to the live listing feed via WebSocket.
   * Returns an unsubscribe function that closes the connection.
   *
   * Requires a WebSocket implementation — works natively in browsers
   * and in Node.js 21+ (or with the `ws` package).
   */
  subscribeFeed(listener: FeedListener): () => void {
    const wsUrl = this.apiUrl.replace(/^http/, 'ws') + '/ws/feed';
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event: MessageEvent) => {
      try {
        const raw = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        listener(mapFeedMessage(raw));
      } catch {
        // Ignore malformed messages
      }
    };

    return () => {
      ws.close();
    };
  }

  // ---------------------------------------------------------------------------
  // Private: HTTP helpers
  // ---------------------------------------------------------------------------

  private ensureIdentity(): void {
    if (!this.identity) {
      throw new Error('MarketModule not initialized — call initialize() first');
    }
  }

  /** Register the agent's public key with the server (idempotent) */
  private async ensureRegistered(): Promise<void> {
    if (this.registered) return;
    this.ensureIdentity();

    const publicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(this.identity!.privateKey), true));
    const body: Record<string, string> = { public_key: publicKey };
    if (this.identity!.nametag) body.nametag = this.identity!.nametag;

    const res = await fetch(`${this.apiUrl}/api/agent/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    // 201 = created, 409 = already registered — both are fine
    if (res.ok || res.status === 409) {
      this.registered = true;
      return;
    }

    const text = await res.text();
    let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { data = JSON.parse(text); } catch { /* ignore */ }
    throw new Error(data?.error ?? `Agent registration failed: HTTP ${res.status}`);
  }

  private async parseResponse(res: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = await res.text();
    let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Market API error: HTTP ${res.status} — unexpected response (not JSON)`);
    }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  private async apiPost(path: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    await this.ensureRegistered();
    const signed = signRequest(body, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(this.timeout),
    });
    return this.parseResponse(res);
  }

  private async apiGet(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    await this.ensureRegistered();
    const signed = signRequest({}, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: signed.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    return this.parseResponse(res);
  }

  private async apiDelete(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    await this.ensureRegistered();
    const signed = signRequest({}, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'DELETE',
      headers: signed.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    return this.parseResponse(res);
  }

  private async apiPublicPost(path: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    return this.parseResponse(res);
  }

}

// =============================================================================
// Factory
// =============================================================================

export function createMarketModule(config?: MarketModuleConfig): MarketModule {
  return new MarketModule(config);
}
