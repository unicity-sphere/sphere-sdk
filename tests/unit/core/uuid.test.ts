/**
 * Tests for core/uuid.ts (browser-safe randomUUID).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from '../../../core/uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomUUID()', () => {
  it('returns a valid v4 UUID on the native fast-path', () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it('returns distinct values', () => {
    expect(randomUUID()).not.toBe(randomUUID());
  });

  // sphere-sdk#619: sub-15.4 / insecure-context (non-HTTPS) WebViews expose
  // `crypto` but not `crypto.randomUUID`. The bare call sites threw
  // "crypto.randomUUID is not a function"; the getRandomValues fallback fixes it.
  describe('fallback path (crypto.getRandomValues only)', () => {
    beforeEach(() => {
      // Shadow the prototype method so the helper sees randomUUID as absent.
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      // Remove the own shadow, restoring the prototype's randomUUID.
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    });

    it('derives a valid v4 UUID from getRandomValues when randomUUID is absent', () => {
      expect(typeof globalThis.crypto.randomUUID).not.toBe('function');
      expect(randomUUID()).toMatch(UUID_V4);
    });

    it('still returns distinct values via the fallback', () => {
      expect(randomUUID()).not.toBe(randomUUID());
    });
  });
});
