import { describe, it, expect } from 'vitest';
import { checkCompatibility } from '../../../connect/compatibility';
import { ERROR_CODES, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';

const W = SPHERE_CONNECT_VERSION;     // '2.0'
const NET = 4;                        // testnet2

describe('checkCompatibility', () => {
  it('ok when same MAJOR and matching network', () => {
    expect(checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET }).ok).toBe(true);
  });
  it('ok for a newer MINOR (2.1 client, 2.0 wallet)', () => {
    expect(checkCompatibility({ clientProtocol: '2.1', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET }).ok).toBe(true);
  });
  it('rejects a different MAJOR with UNSUPPORTED_PROTOCOL_VERSION', () => {
    const r = checkCompatibility({ clientProtocol: '1.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
      expect((r.error.data as { reason: string }).reason).toBe('protocol_incompatible');
    }
  });
  it('rejects a wrong network with INCOMPATIBLE_NETWORK', () => {
    const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
      expect((r.error.data as { reason: string }).reason).toBe('network_incompatible');
    }
  });
  it('rejects a missing network (old client that sends none)', () => {
    const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: undefined, walletNetworkId: NET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
  });
  it('protocol is checked before network', () => {
    const r = checkCompatibility({ clientProtocol: '1.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  });
  it('enforces an optional MINOR floor', () => {
    const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, minMinor: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  });
  it('enforces an optional secondary sdk floor', () => {
    const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, clientSdkVersion: '0.9.0', minSdkVersion: '0.10.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  });
});
