/**
 * Shared transport address resolver.
 *
 * Resolves any valid Unicity address (@nametag, DIRECT://, PROXY://, hex pubkey)
 * to a transport-level pubkey for messaging and token delivery.
 *
 * Used by both CommunicationsModule (DMs) and PaymentsModule (token transfers)
 * to ensure a single resolution path — no code duplication.
 *
 * Includes an in-memory cache (TTL-based) to avoid redundant network lookups.
 */

import { SphereError } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedTransport {
  /** Transport-level pubkey (e.g., 32-byte x-only hex for Nostr) */
  pubkey: string;
  /** Unicity ID (nametag) if known */
  nametag?: string;
}

/** Minimal transport interface for resolution — avoids importing the full TransportProvider */
export interface TransportResolveProvider {
  resolve?(identifier: string): Promise<{ transportPubkey: string; nametag?: string } | null>;
  resolveNametag?(nametag: string): Promise<string | null>;
  resolveAddressInfo?(address: string): Promise<{ transportPubkey: string; nametag?: string } | null>;
}

export interface TransportResolverConfig {
  /** Cache TTL in milliseconds. Default: 5 minutes. */
  cacheTtlMs?: number;
  /** Maximum cache entries. Default: 1000. */
  cacheMaxSize?: number;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface TransportAddressResolver {
  /**
   * Resolve any Unicity address to a transport pubkey.
   *
   * Accepts: @nametag, DIRECT://..., PROXY://..., compressed hex (66 chars),
   * x-only hex (64 chars).
   *
   * Results are cached to avoid redundant network round-trips.
   */
  resolve(address: string): Promise<ResolvedTransport>;

  /**
   * Warm the cache for one or more addresses without sending a message.
   * Useful before a batch of DM or token transfer operations.
   */
  preResolve(...addresses: string[]): Promise<void>;

  /**
   * Invalidate a specific cache entry or the entire cache.
   */
  invalidateCache(address?: string): void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes (address/pubkey)
const NAMETAG_TTL_MS = 60 * 1000;     // 1 minute (relay-dependent, higher risk)
const DEFAULT_MAX_SIZE = 1000;

export function createTransportAddressResolver(
  transport: TransportResolveProvider,
  config?: TransportResolverConfig,
): TransportAddressResolver {
  const ttlMs = config?.cacheTtlMs ?? DEFAULT_TTL_MS;
  const maxSize = config?.cacheMaxSize ?? DEFAULT_MAX_SIZE;
  const cache = new Map<string, { result: ResolvedTransport; expiresAt: number }>();
  const inflight = new Map<string, Promise<ResolvedTransport>>();

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  function getCached(key: string): ResolvedTransport | null {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.result;
    if (entry) cache.delete(key); // expired
    return null;
  }

  function setCache(key: string, result: ResolvedTransport): void {
    if (cache.size >= maxSize) {
      // Evict oldest (Map preserves insertion order)
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    const effectiveTtl = key.startsWith('@') ? NAMETAG_TTL_MS : ttlMs;
    cache.set(key, { result, expiresAt: Date.now() + effectiveTtl });
  }

  // ---------------------------------------------------------------------------
  // Resolution logic (uncached)
  // ---------------------------------------------------------------------------

  async function resolveUncached(address: string): Promise<ResolvedTransport> {
    // @nametag — resolve via nametag binding
    if (address.startsWith('@')) {
      const nametag = address.slice(1);
      const pubkey = await transport.resolveNametag?.(nametag);
      if (!pubkey) {
        throw new SphereError(`Unicity ID not found: ${address}`, 'INVALID_RECIPIENT');
      }
      return { pubkey, nametag };
    }

    // DIRECT:// or PROXY:// — resolve via transport address lookup
    if (address.startsWith('DIRECT://') || address.startsWith('PROXY://')) {
      // Primary: transport.resolve() handles all address formats
      if (transport.resolve) {
        const peerInfo = await transport.resolve(address);
        if (peerInfo?.transportPubkey) {
          return { pubkey: peerInfo.transportPubkey, nametag: peerInfo.nametag };
        }
      }
      // Fallback: resolveAddressInfo()
      if (transport.resolveAddressInfo) {
        const peerInfo = await transport.resolveAddressInfo(address);
        if (peerInfo?.transportPubkey) {
          return { pubkey: peerInfo.transportPubkey, nametag: peerInfo.nametag };
        }
      }
      // Last resort: strip prefix and try as raw pubkey
      const prefix = address.startsWith('DIRECT://') ? 'DIRECT://' : 'PROXY://';
      const raw = address.slice(prefix.length);
      if (raw.length === 0) {
        throw new SphereError(`Invalid ${prefix} address: empty value`, 'INVALID_RECIPIENT');
      }
      const converted = compressedToXOnly(raw);
      if (converted) return { pubkey: converted };

      throw new SphereError(
        `Cannot resolve ${prefix} address to transport pubkey. ` +
        `Ensure the recipient has a registered Unicity ID (nametag).`,
        'INVALID_RECIPIENT',
      );
    }

    // Bare hex pubkey — convert compressed→x-only if needed
    const converted = compressedToXOnly(address);
    if (converted) return { pubkey: converted };

    // Unknown format — try transport.resolve() as a last resort
    if (transport.resolve) {
      const peerInfo = await transport.resolve(address);
      if (peerInfo?.transportPubkey) {
        return { pubkey: peerInfo.transportPubkey, nametag: peerInfo.nametag };
      }
    }

    throw new SphereError(
      `Cannot resolve "${address.slice(0, 30)}..." to a transport address. ` +
      `Use @nametag, DIRECT://, PROXY://, or a hex pubkey.`,
      'INVALID_RECIPIENT',
    );
  }

  /**
   * Convert a hex string to a 64-char x-only pubkey if possible.
   * Returns null if the input is not a valid hex pubkey format.
   */
  function compressedToXOnly(hex: string): string | null {
    // 66-char compressed (02/03 prefix) → 64-char x-only
    if (hex.length === 66 && (hex.startsWith('02') || hex.startsWith('03'))) {
      if (/^[0-9a-f]+$/i.test(hex)) return hex.slice(2).toLowerCase();
    }
    // Already 64-char x-only
    if (hex.length === 64 && /^[0-9a-f]+$/i.test(hex)) {
      return hex.toLowerCase();
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  async function resolveWithDedup(address: string): Promise<ResolvedTransport> {
    const cached = getCached(address);
    if (cached) return cached;

    const existing = inflight.get(address);
    if (existing) return existing;

    const promise = resolveUncached(address).then((result) => {
      setCache(address, result);
      return result;
    }).finally(() => {
      inflight.delete(address);
    });
    inflight.set(address, promise);
    return promise;
  }

  return {
    resolve: resolveWithDedup,

    async preResolve(...addresses: string[]): Promise<void> {
      await Promise.all(addresses.map((addr) => resolveWithDedup(addr)));
    },

    invalidateCache(address?: string): void {
      if (address) {
        cache.delete(address);
      } else {
        cache.clear();
      }
    },
  };
}
