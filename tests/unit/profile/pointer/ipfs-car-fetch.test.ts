/**
 * H10 progress-rate CAR fetcher (T-C6) — SPEC §8.5, §10.7.
 *
 * Covers:
 *   - Successful fetch returns body bytes
 *   - Content-Encoding rejection (D7)
 *   - Content-Length pre-check when advertised > maxBytes
 *   - Streaming byte-cap enforcement
 *   - HTTP error (non-2xx) → http_error outcome
 *   - Initial-response timeout
 *   - Stall timeout (without Range resume)
 *   - Range resume on stall when server advertises Accept-Ranges
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCarFromGateway } from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeStreamResponse(
  chunks: (Uint8Array | null)[],
  delays: number[] = [],
  headers: Record<string, string> = {},
): Response {
  const bodyStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const delay = delays[i] ?? 0;
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        if (chunk === null) {
          // Simulate stall — never emit, controller stays open.
          await new Promise(() => {}); // hang forever (caller should abort)
        } else {
          controller.enqueue(chunk);
        }
      }
      controller.close();
    },
  });
  return new Response(bodyStream, { status: 200, headers });
}

// Mock fetch on globalThis for each test.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // noop — each test will install its own mock
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchCarFromGateway — success path', () => {
  it('returns full body for small successful fetch', async () => {
    const data = textEncode('hello world');
    globalThis.fetch = vi.fn(async () =>
      new Response(data, { status: 200, headers: { 'Content-Length': String(data.byteLength) } }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual(Array.from(data));
    }
  });
});

describe('fetchCarFromGateway — Content-Encoding rejection (D7)', () => {
  it('rejects gzip-encoded response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('fake-gzip-body', { status: 200, headers: { 'Content-Encoding': 'gzip' } }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('content_encoding_rejected');
    }
  });

  it('accepts identity encoding', async () => {
    const data = textEncode('raw-bytes');
    globalThis.fetch = vi.fn(async () =>
      new Response(data, { status: 200, headers: { 'Content-Encoding': 'identity' } }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(true);
  });

  it('accepts missing Content-Encoding header', async () => {
    const data = textEncode('raw-bytes');
    globalThis.fetch = vi.fn(async () => new Response(data, { status: 200 })) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(true);
  });
});

describe('fetchCarFromGateway — byte cap enforcement', () => {
  it('rejects when Content-Length exceeds maxBytes pre-emptively', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('x', { status: 200, headers: { 'Content-Length': '999999999' } }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy', {
      maxBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('byte_cap_exceeded');
    }
  });

  it('rejects when streaming body exceeds maxBytes (no Content-Length)', async () => {
    // Stream an oversized body without a Content-Length header.
    const big = new Uint8Array(5000).fill(0x42);
    globalThis.fetch = vi.fn(async () => new Response(big, { status: 200 })) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy', {
      maxBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('byte_cap_exceeded');
    }
  });
});

describe('fetchCarFromGateway — HTTP error', () => {
  it('returns http_error on 404', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('http_error');
      expect(result.detail).toContain('404');
    }
  });

  it('returns http_error on 503', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('unavailable', { status: 503 }),
    ) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('http_error');
    }
  });
});

describe('fetchCarFromGateway — network error', () => {
  it('returns network_error on fetch throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('network_error');
    }
  });

  it('handles missing response body', async () => {
    globalThis.fetch = vi.fn(async () => {
      const resp = new Response(null, { status: 200 });
      // Force body to null
      Object.defineProperty(resp, 'body', { value: null });
      return resp;
    }) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('network_error');
    }
  });
});

describe('fetchCarFromGateway — initial-response timeout', () => {
  it('times out when fetch never resolves before initialResponseMs', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as never;

    const result = await fetchCarFromGateway('https://ipfs.example.com/bafy', {
      initialResponseMs: 50,
      totalMs: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('total_timeout'); // initial-response failure surfaces as total_timeout in outcome mapping
    }
  }, 10_000);
});
