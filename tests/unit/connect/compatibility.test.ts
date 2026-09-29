import { describe, it, expect } from 'vitest';
import { checkCompatibility } from '../../../connect/compatibility';
import { DEFAULT_MIN_CLIENT_SDK_VERSION } from '../../../connect/protocol';
import { ERROR_CODES, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';
import type { NetworkInfo } from '../../../connect/protocol';

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

  // The host uses this field, NOT error.code, to decide whether a refusal may be turned into
  // a "switch network?" prompt. It must therefore be impossible for any non-network failure to
  // carry it, and impossible for a network failure with nothing to offer to carry it either.
  describe('network mismatch discriminator', () => {
    it('is populated for a plain wrong-network refusal, carrying both sides', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 1, name: 'mainnet' }, walletNetworkId: NET });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mismatch).toEqual({
          kind: 'network',
          walletNetwork: { id: NET },
          clientNetwork: { id: 1, name: 'mainnet' },
        });
      }
    });

    it('is absent when the dApp declared no network — there is nothing to switch to', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: undefined, walletNetworkId: NET });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
        expect(r.mismatch).toBeUndefined();
      }
    });

    it('is absent when the wallet network is the -1 sentinel', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 4 }, walletNetworkId: -1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.mismatch).toBeUndefined();
    });

    it('is absent for every protocol/SDK failure, even when the network also differs', () => {
      const major = checkCompatibility({ clientProtocol: '1.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET });
      const minor = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET, minMinor: 9 });
      const sdk = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET, minSdkVersion: '9.9.9', clientSdkVersion: '0.1.0' });
      for (const r of [major, minor, sdk]) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
          expect(r.mismatch).toBeUndefined();
        }
      }
    });

    it('does not change the error payload one bit', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 1 }, walletNetworkId: NET });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // toStrictEqual, not toEqual: toEqual treats an undefined-valued property as absent,
        // so it would let a stray key on the error pass as "unchanged".
        expect(r.error).toStrictEqual({
          code: ERROR_CODES.INCOMPATIBLE_NETWORK,
          message: 'dApp targets a different network than the wallet',
          data: { reason: 'network_incompatible', walletNetwork: { id: NET }, clientNetwork: { id: 1 } },
        });
      }
    });

    it('does not change the payload on a branch that carries no mismatch either', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: undefined, walletNetworkId: NET });
      // The whole result, so a stray `mismatch` key (even an undefined-valued one) fails too.
      expect(r).toStrictEqual({
        ok: false,
        error: {
          code: ERROR_CODES.INCOMPATIBLE_NETWORK,
          message: 'dApp targets a different network than the wallet',
          data: { reason: 'network_incompatible', walletNetwork: { id: NET }, clientNetwork: null },
        },
      });
    });

    // `msg.network` is unvalidated wire data (isSphereConnectMessage never looks at it) and the
    // handshake runs before any user approval, so any origin can send any of these. The refusal
    // is the same one it has always been; what must not happen is the typed `mismatch` vouching
    // for a network that was never checked.
    describe('a malformed dApp network still refuses, but offers nothing', () => {
      const shapes: Array<[string, unknown]> = [
        ['an object with no id', {}],
        ['a NaN id', { id: NaN }],
        ['a string id', { id: '4' }],
        ['a fractional id', { id: 4.5 }],
        ['a negative id', { id: -1 }],
        ['a truthy non-object', 'mainnet'],
      ];

      it.each(shapes)('%s', (_label, raw) => {
        const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: raw as NetworkInfo, walletNetworkId: NET });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
          expect(r.mismatch).toBeUndefined();
          // The payload keeps echoing exactly what the dApp sent. Do not "fix" this along with the guard.
          expect((r.error.data as { clientNetwork: unknown }).clientNetwork).toBe(raw);
        }
      });

      it('leaves the whole refusal byte-identical, echoing the raw value', () => {
        const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: '4' } as unknown as NetworkInfo, walletNetworkId: NET });
        expect(r).toStrictEqual({
          ok: false,
          error: {
            code: ERROR_CODES.INCOMPATIBLE_NETWORK,
            message: 'dApp targets a different network than the wallet',
            data: { reason: 'network_incompatible', walletNetwork: { id: NET }, clientNetwork: { id: '4' } },
          },
        });
      });
    });

    // The guards are `< 0` and `>= 0`, never falsiness: 0 is a real network id on either side.
    describe('network id 0 is a real network', () => {
      it('on the wallet side (only the -1 sentinel is "unknown")', () => {
        const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 4 }, walletNetworkId: 0 });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.mismatch).toEqual({ kind: 'network', walletNetwork: { id: 0 }, clientNetwork: { id: 4 } });
        }
      });

      it('on the dApp side', () => {
        const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 0 }, walletNetworkId: NET });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.mismatch).toEqual({ kind: 'network', walletNetwork: { id: NET }, clientNetwork: { id: 0 } });
        }
      });
    });

    it('carries a well-formed id the wallet has never heard of; resolving it is the wallet\'s job', () => {
      const r = checkCompatibility({ clientProtocol: '2.0', walletProtocol: W, clientNetwork: { id: 999 }, walletNetworkId: NET });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mismatch).toEqual({ kind: 'network', walletNetwork: { id: NET }, clientNetwork: { id: 999 } });
      }
    });
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
