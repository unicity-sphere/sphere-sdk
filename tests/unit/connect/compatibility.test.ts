import { describe, it, expect } from 'vitest';
import { checkCompatibility } from '../../../connect/compatibility';
import { DEFAULT_MIN_CLIENT_SDK_VERSION } from '../../../connect/protocol';
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
  it('passes when the MINOR floor is met or exceeded', () => {
    expect(checkCompatibility({ clientProtocol: '2.1', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, minMinor: 1 }).ok).toBe(true);
    expect(checkCompatibility({ clientProtocol: '2.2', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, minMinor: 1 }).ok).toBe(true);
  });
  it('passes when the SDK floor is met', () => {
    expect(checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, clientSdkVersion: '0.10.0', minSdkVersion: '0.10.0' }).ok).toBe(true);
  });
  it('the P11 default floor 0.14.1-0 rejects every pre-flip client (0.13.x, 0.14.0) and unreported versions', () => {
    for (const v of ['0.13.3', '0.14.0', '0.14.0-dev.9', undefined]) {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, ...(v !== undefined ? { clientSdkVersion: v } : {}), minSdkVersion: DEFAULT_MIN_CLIENT_SDK_VERSION });
      expect(r.ok, `expected reject for ${v ?? 'unreported'}`).toBe(false);
    }
  });

  it('the P11 default floor admits the 0.14.1 prerelease track and everything newer', () => {
    for (const v of ['0.14.1-dev.0', '0.14.1-dev.1', '0.14.1', '0.14.2', '0.15.0-dev.2', '1.0.0']) {
      expect(
        checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, clientSdkVersion: v, minSdkVersion: DEFAULT_MIN_CLIENT_SDK_VERSION }).ok,
        `expected accept for ${v}`
      ).toBe(true);
    }
  });

  it('rejects when minSdkVersion is set but the client sends no sdkVersion', () => {
    const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET, minSdkVersion: '0.10.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  });
});

/**
 * The refusal a human actually sees.
 *
 * `error.data` has carried the versions all along, but every UI in the fleet renders
 * `error.message` and nothing else — so a version floor read as "SDK version below the
 * required minimum" with no hint of WHICH version to move to. The numbers belong in the
 * message; `data` stays authoritative for anything that wants to branch on them.
 */
describe('checkCompatibility — refusal messages name the versions', () => {
  const base = { walletProtocol: W, clientNetwork: { id: NET }, walletNetworkId: NET } as const;

  it('names both SDK versions on the sdk floor', () => {
    const r = checkCompatibility({ ...base, clientProtocol: '2.0', clientSdkVersion: '0.9.0', minSdkVersion: '0.10.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('SDK version 0.9.0 is below the required minimum 0.10.0');
      expect(r.error.data).toMatchObject({ requiredSdk: '0.10.0', actualSdk: '0.9.0' });
    }
  });

  it('still names the required SDK version when the client reported none', () => {
    const r = checkCompatibility({ ...base, clientProtocol: '2.0', minSdkVersion: '0.10.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('SDK version unknown (not reported) is below the required minimum 0.10.0');
      expect(r.error.data).toMatchObject({ requiredSdk: '0.10.0', actualSdk: null });
    }
  });

  it('names both protocol versions on the MINOR floor, and publishes requiredProtocol', () => {
    const r = checkCompatibility({ ...base, clientProtocol: '2.0', minMinor: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('Connect protocol 2.0 is below the required minimum 2.1');
      expect(r.error.data).toMatchObject({ clientProtocol: '2.0', requiredProtocol: '2.1' });
    }
  });

  it('names both protocol versions on a MAJOR mismatch', () => {
    const r = checkCompatibility({ ...base, clientProtocol: '1.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe(`Incompatible Connect protocol version: app speaks 1.0, wallet speaks ${W}`);
      expect(r.error.data).toMatchObject({ walletProtocol: W, clientProtocol: '1.0' });
    }
  });
});
