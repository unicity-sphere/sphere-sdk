import { describe, it, expect } from 'vitest';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  INTENT_ACTIONS,
  ERROR_CODES,
  isSphereConnectMessage,
  createRequestId,
} from '../../../connect/protocol';

describe('Protocol', () => {
  describe('isSphereConnectMessage', () => {
    it('returns true for valid messages', () => {
      expect(isSphereConnectMessage({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'request',
        id: '1',
        method: 'sphere_getBalance',
      })).toBe(true);
    });

    it('returns false for null/undefined', () => {
      expect(isSphereConnectMessage(null)).toBe(false);
      expect(isSphereConnectMessage(undefined)).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(isSphereConnectMessage('string')).toBe(false);
      expect(isSphereConnectMessage(42)).toBe(false);
    });

    it('returns false for wrong namespace', () => {
      expect(isSphereConnectMessage({
        ns: 'wrong',
        v: SPHERE_CONNECT_VERSION,
        type: 'request',
      })).toBe(false);
    });

    it('returns false for wrong version', () => {
      expect(isSphereConnectMessage({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: '99.0',
        type: 'request',
      })).toBe(false);
    });

    it('returns false for missing ns/v', () => {
      expect(isSphereConnectMessage({ type: 'request' })).toBe(false);
    });
  });

  describe('createRequestId', () => {
    it('returns unique strings', () => {
      const ids = new Set(Array.from({ length: 100 }, () => createRequestId()));
      expect(ids.size).toBe(100);
    });

    it('returns non-empty strings', () => {
      expect(createRequestId().length).toBeGreaterThan(0);
    });
  });

  describe('constants', () => {
    it('defines RPC methods', () => {
      expect(RPC_METHODS.GET_IDENTITY).toBe('sphere_getIdentity');
      expect(RPC_METHODS.GET_BALANCE).toBe('sphere_getBalance');
      expect(RPC_METHODS.SEND).toBeUndefined();
    });

    it('defines intent actions', () => {
      expect(INTENT_ACTIONS.SEND).toBe('send');
      expect(INTENT_ACTIONS.DM).toBe('dm');
      expect(INTENT_ACTIONS.PAYMENT_REQUEST).toBe('payment_request');
    });

    it('defines error codes', () => {
      expect(ERROR_CODES.NOT_CONNECTED).toBe(4001);
      expect(ERROR_CODES.USER_REJECTED).toBe(4003);
      expect(ERROR_CODES.INTENT_CANCELLED).toBe(4200);
    });
  });
});

describe('protocol v2 gate surface', () => {
  it('Connect version is bumped to 2.0', () => {
    expect(SPHERE_CONNECT_VERSION).toBe('2.0');
  });
  it('has the new error codes', () => {
    expect(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION).toBe(4007);
    expect(ERROR_CODES.INCOMPATIBLE_NETWORK).toBe(4008);
  });
  it('filter accepts same-MAJOR session traffic, drops other-MAJOR', () => {
    const base = { ns: SPHERE_CONNECT_NAMESPACE };
    expect(isSphereConnectMessage({ ...base, v: '2.0', type: 'request' })).toBe(true);
    expect(isSphereConnectMessage({ ...base, v: '2.1', type: 'request' })).toBe(true);
    expect(isSphereConnectMessage({ ...base, v: '1.0', type: 'request' })).toBe(false);
  });
  it('filter lets ANY-version handshake through (decided in the handler, not dropped)', () => {
    const base = { ns: SPHERE_CONNECT_NAMESPACE };
    expect(isSphereConnectMessage({ ...base, v: '1.0', type: 'handshake', direction: 'request', permissions: [] })).toBe(true);
    expect(isSphereConnectMessage({ ...base, v: '3.0', type: 'handshake', direction: 'request', permissions: [] })).toBe(true);
  });
  it('still rejects non-namespace / non-objects', () => {
    expect(isSphereConnectMessage({ ns: 'other', v: '2.0', type: 'request' })).toBe(false);
    expect(isSphereConnectMessage(null)).toBe(false);
  });
});
