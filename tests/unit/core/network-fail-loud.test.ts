/**
 * Fail-loud network requirement tests.
 *
 * Production wallet code must NEVER silently default the network to a hardcoded
 * value: a dropped/missing network would silently load the wrong (testnet vs
 * mainnet) registry/trustbase/aggregator. Every such site must throw
 * SphereError('INVALID_CONFIG') instead.
 */

import { describe, it, expect } from 'vitest';
import { SphereError } from '../../../core/errors';
import { createBrowserProviders } from '../../../impl/browser';
import { createNodeProviders } from '../../../impl/nodejs';
import {
  createUnicityAggregatorProvider as createBrowserAggregator,
} from '../../../impl/browser/oracle';
import {
  createUnicityAggregatorProvider as createNodeAggregator,
} from '../../../impl/nodejs/oracle';
import { getEmbeddedTrustBase } from '../../../impl/shared/trustbase-loader';

describe('fail-loud: network required (no silent defaults)', () => {
  describe('createBrowserProviders', () => {
    it('throws when network is omitted', () => {
      // `network` is optional in the CONFIG TYPE (so `createBrowserProviders()`
      // compiles) — the requirement is enforced at runtime, which is what this
      // asserts.
      expect(() => createBrowserProviders({})).toThrow(/network/i);
      expect(() => createBrowserProviders({})).toThrow(SphereError);
    });

    it('throws when config is omitted entirely', () => {
      expect(() => createBrowserProviders()).toThrow(/network/i);
    });
  });

  describe('createNodeProviders', () => {
    it('throws when network is omitted', () => {
      // `network` is optional in the CONFIG TYPE (so `createNodeProviders()`
      // compiles) — the requirement is enforced at runtime, which is what this
      // asserts.
      expect(() => createNodeProviders({})).toThrow(/network/i);
      expect(() => createNodeProviders({})).toThrow(SphereError);
    });

    it('throws when config is omitted entirely', () => {
      expect(() => createNodeProviders()).toThrow(/network/i);
    });
  });

  describe('createUnicityAggregatorProvider (browser)', () => {
    it('throws when neither network nor trustBaseUrl is provided', () => {
      expect(() => createBrowserAggregator({ url: 'https://x' })).toThrow(/network|trustBaseUrl/i);
      expect(() => createBrowserAggregator({ url: 'https://x' })).toThrow(SphereError);
    });
  });

  describe('createUnicityAggregatorProvider (node)', () => {
    it('throws when neither network nor trustBasePath is provided', () => {
      expect(() => createNodeAggregator({ url: 'https://x' })).toThrow(/network|trustBaseUrl/i);
      expect(() => createNodeAggregator({ url: 'https://x' })).toThrow(SphereError);
    });
  });

  describe('getEmbeddedTrustBase', () => {
    it('throws on unknown network instead of silently returning testnet', () => {
      // @ts-expect-error intentionally passing an invalid network
      expect(() => getEmbeddedTrustBase('bogus')).toThrow(/unknown network/i);
      // @ts-expect-error intentionally passing an invalid network
      expect(() => getEmbeddedTrustBase('bogus')).toThrow(SphereError);
    });

    it('returns embedded data for a known network', () => {
      expect(getEmbeddedTrustBase('testnet2')).not.toBeNull();
    });
  });
});
