/**
 * Market Module
 *
 * Intent bulletin board — post and discover buy/sell intents
 * with secp256k1-signed requests tied to the wallet identity.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { DEFAULT_MARKET_API_URL } from '../../constants';
import type {
  MarketModuleConfig,
  MarketModuleDependencies,
  PostIntentRequest,
  PostIntentResult,
  MarketIntent,
  SearchIntentResult,
  SearchOptions,
  SearchResult,
  MarketAgentProfile,
  RegisterOptions,
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
      'x-signature': signature.toCompactHex(),
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

function mapProfile(raw: any): MarketAgentProfile {
  return {
    id: raw.id,
    name: raw.name ?? undefined,
    publicKey: raw.public_key,
    nostrPubkey: raw.nostr_pubkey ?? undefined,
    registeredAt: raw.registered_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// =============================================================================
// Implementation
// =============================================================================

export class MarketModule {
  private readonly apiUrl: string;
  private readonly timeout: number;
  private identity: FullIdentity | null = null;

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

  /** Register this agent with the market backend */
  async register(opts?: RegisterOptions): Promise<MarketAgentProfile> {
    this.ensureIdentity();
    const body: Record<string, unknown> = {
      public_key: this.identity!.chainPubkey,
    };
    if (opts?.name !== undefined) body.name = opts.name;
    if (opts?.nostrPubkey !== undefined) body.nostr_pubkey = opts.nostrPubkey;

    const data = await this.apiPost('/api/agents/register', body);
    return mapProfile(data.agent ?? data);
  }

  /** Get own agent profile */
  async getProfile(): Promise<MarketAgentProfile> {
    return this.withAutoRegister(async () => {
      const data = await this.apiGet('/api/agents/me');
      return mapProfile(data.agent ?? data);
    });
  }

  /** Post a new intent */
  async postIntent(intent: PostIntentRequest): Promise<PostIntentResult> {
    return this.withAutoRegister(async () => {
      const body = toSnakeCaseIntent(intent);
      const data = await this.apiPost('/api/intents', body);
      return {
        intentId: data.intent_id ?? data.intentId,
        message: data.message,
        expiresAt: data.expires_at ?? data.expiresAt,
      };
    });
  }

  /** Semantic search for intents (public — no auth required) */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      ...toSnakeCaseFilters(opts),
    };
    const data = await this.apiPublicPost('/api/intents/search', body);
    const results: SearchIntentResult[] = (data.results ?? []).map(mapSearchResult);
    return { intents: results, count: results.length };
  }

  /** List own intents */
  async getMyIntents(): Promise<MarketIntent[]> {
    return this.withAutoRegister(async () => {
      const data = await this.apiGet('/api/intents/my');
      return (data.intents ?? []).map(mapMyIntent);
    });
  }

  /** Close (delete) an intent */
  async closeIntent(intentId: string): Promise<void> {
    return this.withAutoRegister(async () => {
      await this.apiDelete(`/api/intents/${encodeURIComponent(intentId)}`);
    });
  }

  /** Get available categories */
  async getCategories(): Promise<string[]> {
    const data = await this.apiPublicGet('/api/categories');
    return data.categories ?? [];
  }

  // ---------------------------------------------------------------------------
  // Private: Auto-register wrapper
  // ---------------------------------------------------------------------------

  private async withAutoRegister<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Agent not registered') {
        await this.register();
        return await fn();
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: HTTP helpers
  // ---------------------------------------------------------------------------

  private ensureIdentity(): void {
    if (!this.identity) {
      throw new Error('MarketModule not initialized — call initialize() first');
    }
  }

  private async apiPost(path: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    const signed = signRequest(body, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  private async apiGet(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    const signed = signRequest({}, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: signed.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  private async apiDelete(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.ensureIdentity();
    const signed = signRequest({}, this.identity!.privateKey);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'DELETE',
      headers: signed.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  private async apiPublicPost(path: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  private async apiPublicGet(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createMarketModule(config?: MarketModuleConfig): MarketModule {
  return new MarketModule(config);
}
