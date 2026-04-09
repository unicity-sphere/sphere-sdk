/**
 * Shared IPFS client helpers for Profile storage operations.
 *
 * Provides pin, fetch, and verify operations against multiple IPFS gateways
 * with configurable timeouts, size limits, and multi-gateway fallback.
 *
 * Extracted from `ProfileTokenStorageProvider` and `ConsolidationEngine` to
 * eliminate ~120 lines of duplicated IPFS pin/fetch logic.
 *
 * @module profile/ipfs-client
 */

import { ProfileError } from './errors.js';

// =============================================================================
// Constants
// =============================================================================

/** Default IPFS gateway URL (used when no gateways are provided). */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

/** Default timeout for pin operations (ms). */
const DEFAULT_PIN_TIMEOUT_MS = 60_000;

/** Default timeout for fetch operations (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default timeout for verify (HEAD) operations (ms). */
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;

/** Default maximum response size for fetch operations (bytes). */
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// =============================================================================
// Public API
// =============================================================================

/**
 * Pin a CAR file (or any bytes) to an IPFS gateway.
 * Tries each gateway in order, returns the CID on first success.
 *
 * @param gateways  - Array of IPFS gateway base URLs
 * @param data      - Bytes to pin
 * @param timeoutMs - Timeout per gateway attempt (default: 60 000)
 * @returns The CID of the pinned content
 * @throws {ProfileError} `ORBITDB_WRITE_FAILED` if all gateways fail or
 *         the response does not contain a CID.
 */
export async function pinToIpfs(
  gateways: string[],
  data: Uint8Array,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
): Promise<string> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  let lastError: Error | null = null;

  for (const gateway of effectiveGateways) {
    try {
      const url = `${gateway.replace(/\/$/, '')}/api/v0/dag/put`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: data,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText} from ${gateway}`);
        continue;
      }

      const result = (await response.json()) as { Cid?: { '/': string }; Hash?: string };
      const cid = result.Cid?.['/'] ?? result.Hash;
      if (!cid) {
        lastError = new Error('IPFS pin response did not contain a CID');
        continue;
      }

      return cid;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new ProfileError(
    'ORBITDB_WRITE_FAILED',
    `IPFS pin failed on all gateways: ${lastError?.message ?? 'unknown error'}`,
    lastError,
  );
}

/**
 * Fetch content from IPFS by CID.
 * Tries each gateway in order, returns the bytes on first success.
 *
 * If the response includes a `Content-Length` header that exceeds
 * `maxSizeBytes`, the request is aborted immediately. Otherwise a
 * streaming reader enforces the size limit while reading the body.
 *
 * @param gateways     - Array of IPFS gateway base URLs
 * @param cid          - Content identifier to fetch
 * @param timeoutMs    - Timeout per gateway attempt (default: 30 000)
 * @param maxSizeBytes - Maximum response size (default: 50 MB)
 * @returns The fetched content as a `Uint8Array`
 * @throws {ProfileError} `BUNDLE_NOT_FOUND` if all gateways fail or
 *         the response exceeds the size limit.
 */
export async function fetchFromIpfs(
  gateways: string[],
  cid: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
): Promise<Uint8Array> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  let lastError: Error | null = null;

  for (const gateway of effectiveGateways) {
    try {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;

      const response = await fetch(url, {
        headers: { Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${gateway}`);
        continue;
      }

      // Check Content-Length header before reading body
      const contentLength = response.headers.get('Content-Length');
      if (contentLength != null) {
        const size = parseInt(contentLength, 10);
        if (!isNaN(size) && size > maxSizeBytes) {
          lastError = new Error(
            `Response size ${size} bytes exceeds limit of ${maxSizeBytes} bytes from ${gateway}`,
          );
          continue;
        }
      }

      // If Content-Length is absent, use a streaming reader with a byte counter
      if (contentLength == null && response.body != null) {
        return await readStreamWithLimit(response.body, maxSizeBytes, gateway);
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (err) {
      if (err instanceof ProfileError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new ProfileError(
    'BUNDLE_NOT_FOUND',
    `Failed to fetch CAR ${cid} from all gateways: ${lastError?.message ?? 'unknown error'}`,
    lastError,
  );
}

/**
 * Check if a CID is accessible on any gateway.
 *
 * Sends a HEAD request to each gateway in order and returns `true` on
 * the first successful response. Returns `false` if all gateways fail.
 *
 * @param gateways  - Array of IPFS gateway base URLs
 * @param cid       - Content identifier to verify
 * @param timeoutMs - Timeout per gateway attempt (default: 10 000)
 */
export async function verifyCidAccessible(
  gateways: string[],
  cid: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<boolean> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];

  for (const gateway of effectiveGateways) {
    try {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;

      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) return true;
    } catch {
      // Try next gateway
    }
  }

  return false;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Read a `ReadableStream<Uint8Array>` into a single `Uint8Array`, aborting
 * if the accumulated byte count exceeds `maxBytes`.
 */
async function readStreamWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  gatewayLabel: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `Response from ${gatewayLabel} exceeded size limit of ${maxBytes} bytes (read ${totalBytes} so far)`,
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks into a single Uint8Array
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}
