/**
 * The wallet-binding FSM and the single total gate decision.
 *
 * Pure module: if any test here needs a timer, a transport or a Sphere, the gate has
 * grown a dependency it must not have.
 */

import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../../../connect/version';
import { ERROR_CODES, RPC_METHODS, INTENT_ACTIONS } from '../../../connect/protocol';
import type { WalletState } from '../../../connect/types';
import {
  VALID_WALLET_TRANSITIONS,
  isValidWalletTransition,
  assertWalletTransition,
  LOCKED_ALLOWLIST,
  gate,
  WALLET_LOCKED_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  INTERNAL_ERROR_MESSAGE,
} from '../../../connect/host/host-state';

const ALL: WalletState[] = ['live', 'locked', 'unavailable'];

describe('wallet state transitions', () => {
  it('declares no self-transitions — idempotency is enforced by an early return', () => {
    for (const s of ALL) {
      expect(VALID_WALLET_TRANSITIONS[s], `self-edge on ${s}`).not.toContain(s);
      expect(isValidWalletTransition(s, s)).toBe(false);
    }
  });

  it('allows every cross edge', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;
        expect(isValidWalletTransition(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('assertWalletTransition throws a typed SphereError on a self-transition', () => {
    expect(() => assertWalletTransition('locked', 'locked')).toThrow(
      'Invalid wallet state transition: locked -> locked',
    );
    try {
      assertWalletTransition('live', 'live');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('assertWalletTransition is silent on a legal edge', () => {
    expect(() => assertWalletTransition('live', 'locked')).not.toThrow();
    expect(() => assertWalletTransition('locked', 'live')).not.toThrow();
    expect(() => assertWalletTransition('unavailable', 'live')).not.toThrow();
  });
});

describe('LOCKED_ALLOWLIST', () => {
  it('holds exactly the four methods answerable from host state', () => {
    expect([...LOCKED_ALLOWLIST].sort()).toEqual([
      RPC_METHODS.DISCONNECT,
      RPC_METHODS.GET_IDENTITY,
      RPC_METHODS.SUBSCRIBE,
      RPC_METHODS.UNSUBSCRIBE,
    ].sort());
  });

  it('never contains money state', () => {
    for (const m of [
      RPC_METHODS.GET_BALANCE, RPC_METHODS.GET_ASSETS, RPC_METHODS.GET_FIAT_BALANCE,
      RPC_METHODS.GET_TOKENS, RPC_METHODS.GET_HISTORY,
    ]) {
      expect(LOCKED_ALLOWLIST.has(m), `${m} must never be served while locked`).toBe(false);
    }
  });
});

describe('gate() — live', () => {
  it('serves everything with an active session', () => {
    expect(gate('live', true, 'query', RPC_METHODS.GET_BALANCE)).toEqual({ kind: 'serve' });
    expect(gate('live', true, 'query', RPC_METHODS.GET_IDENTITY)).toEqual({ kind: 'serve' });
    expect(gate('live', true, 'intent', INTENT_ACTIONS.SEND)).toEqual({ kind: 'serve' });
  });

  it('refuses 4001 without a session, but still serves a handshake', () => {
    const refused = gate('live', false, 'query', RPC_METHODS.GET_BALANCE);
    expect(refused).toEqual({
      kind: 'refuse',
      error: { code: ERROR_CODES.NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE },
    });
    expect(gate('live', false, 'intent', INTENT_ACTIONS.SEND)).toEqual(refused);
    expect(gate('live', false, 'handshake', 'handshake')).toEqual({ kind: 'serve' });
  });
});

describe('gate() — locked', () => {
  it('serves sphere_getIdentity FROM THE SNAPSHOT', () => {
    expect(gate('locked', true, 'query', RPC_METHODS.GET_IDENTITY))
      .toEqual({ kind: 'serve-from-snapshot' });
  });

  it('serves subscribe / unsubscribe / disconnect from host state', () => {
    for (const m of [RPC_METHODS.SUBSCRIBE, RPC_METHODS.UNSUBSCRIBE, RPC_METHODS.DISCONNECT]) {
      expect(gate('locked', true, 'query', m), m).toEqual({ kind: 'serve' });
    }
  });

  it('refuses every other query with 4009 and data.reason', () => {
    for (const m of [
      RPC_METHODS.GET_BALANCE, RPC_METHODS.GET_TOKENS, RPC_METHODS.GET_HISTORY,
      RPC_METHODS.GET_FIAT_BALANCE, RPC_METHODS.RESOLVE, RPC_METHODS.GET_CONVERSATIONS,
    ]) {
      expect(gate('locked', true, 'query', m), m).toEqual({
        kind: 'refuse',
        error: {
          code: ERROR_CODES.WALLET_LOCKED,
          message: WALLET_LOCKED_MESSAGE,
          data: { reason: 'locked' },
        },
      });
    }
  });

  it('refuses an UNKNOWN method with 4009 — the gate sits before the permission check', () => {
    const d = gate('locked', true, 'query', 'sphere_notAMethod');
    expect(d.kind).toBe('refuse');
    // 4002 here would tell the dApp its permissions are wrong, which is un-retryable.
    expect((d as { error: { code: number } }).error.code).toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('refuses every intent with 4009 — there is no intent allow-list', () => {
    for (const a of Object.values(INTENT_ACTIONS)) {
      const d = gate('locked', true, 'intent', a);
      expect((d as { error: { code: number } }).error.code, a).toBe(ERROR_CODES.WALLET_LOCKED);
    }
  });

  it('serves a handshake from the snapshot, with or without a session', () => {
    expect(gate('locked', true, 'handshake', 'handshake')).toEqual({ kind: 'serve-from-snapshot' });
    expect(gate('locked', false, 'handshake', 'handshake')).toEqual({ kind: 'serve-from-snapshot' });
  });

  it('refuses 4001 rather than 4009 when there is no session at all', () => {
    // The lock is observable ONLY to an origin that already holds an approval.
    const d = gate('locked', false, 'query', RPC_METHODS.GET_IDENTITY);
    expect((d as { error: { code: number } }).error.code).toBe(ERROR_CODES.NOT_CONNECTED);
  });
});

describe('gate() — unavailable', () => {
  it('refuses everything with 4001, including the handshake', () => {
    for (const kind of ['query', 'intent', 'handshake'] as const) {
      for (const hasSession of [true, false]) {
        const d = gate('unavailable', hasSession, kind, 'anything');
        expect(d, `${kind}/${hasSession}`).toEqual({
          kind: 'refuse',
          error: { code: ERROR_CODES.NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE },
        });
      }
    }
  });

  it('never promises an unlock — no 4009 anywhere in the unavailable row', () => {
    const d = gate('unavailable', true, 'intent', INTENT_ACTIONS.SEND);
    expect((d as { error: { code: number } }).error.code).not.toBe(ERROR_CODES.WALLET_LOCKED);
  });
});

describe('gate() is total', () => {
  it('returns a decision for every WalletState x RequestKind x session combination', () => {
    for (const s of ALL) {
      for (const kind of ['query', 'intent', 'handshake'] as const) {
        for (const hasSession of [true, false]) {
          const d = gate(s, hasSession, kind, RPC_METHODS.GET_BALANCE);
          expect(['serve', 'serve-from-snapshot', 'refuse']).toContain(d.kind);
        }
      }
    }
  });
});

describe('message constants', () => {
  it('are the exact strings the host puts on the wire', () => {
    expect(WALLET_LOCKED_MESSAGE).toBe('Wallet is locked');
    expect(NOT_CONNECTED_MESSAGE).toBe('Not connected');
    expect(INTERNAL_ERROR_MESSAGE).toBe('Internal wallet error');
  });

  it('WALLET_LOCKED_MESSAGE does not match the reference dApp teardown regex', () => {
    // A courtesy guard, not a contract: dApps discriminate on .code === 4009.
    expect(WALLET_LOCKED_MESSAGE).not.toMatch(/not.connected|timeout|transport|closed|session/i);
  });
});
