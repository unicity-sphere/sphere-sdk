/**
 * Contract test: ConnectHost emits a `schemaVersion` field on the
 * `onIntent` callback (T.7.C.5).
 *
 * Acceptance:
 *   - The 4th argument to `onIntent` is `'uxf-1'` when the payload
 *     carries any UXF-1 signal (explicit field, additionalAssets[],
 *     or top-level bundle).
 *   - The 4th argument is `'legacy'` for any other shape — the default
 *     for backward compatibility.
 *   - The same argument is forwarded to auto-approve handlers.
 *   - Detection is pure: `params` is never mutated.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ConnectHost,
  detectIntentSchemaVersion,
} from '../../../connect/host/ConnectHost';
import type {
  ConnectTransport,
  ConnectSession,
  IntentSchemaVersion,
  SphereConnectMessage,
} from '../../../connect/types';
import {
  PERMISSION_SCOPES,
  ALL_PERMISSIONS,
} from '../../../connect/permissions';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  INTENT_ACTIONS,
  createRequestId,
} from '../../../connect/protocol';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface CapturedTransport extends ConnectTransport {
  inject(msg: SphereConnectMessage): void;
  sent: SphereConnectMessage[];
}

function createCapturedTransport(): CapturedTransport {
  const handlers = new Set<(msg: SphereConnectMessage) => void>();
  const sent: SphereConnectMessage[] = [];
  return {
    sent,
    send(msg) {
      sent.push(msg);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    destroy() {
      handlers.clear();
    },
    inject(msg) {
      for (const h of handlers) h(msg);
    },
  };
}

function createMinimalSphere() {
  return {
    identity: {
      chainPubkey: '02abc',
      l1Address: 'alpha1test',
      directAddress: 'DIRECT://test',
      nametag: 'alice',
    },
    payments: {
      getBalance: vi.fn().mockReturnValue([]),
      getAssets: vi.fn().mockResolvedValue([]),
      getFiatBalance: vi.fn().mockResolvedValue(0),
      getTokens: vi.fn().mockReturnValue([]),
      getHistory: vi.fn().mockReturnValue([]),
    },
    resolve: vi.fn().mockResolvedValue(null),
    on: vi.fn(() => () => {}),
  };
}

async function performHandshake(
  host: ConnectHost,
  transport: CapturedTransport,
): Promise<string> {
  transport.inject({
    ns: SPHERE_CONNECT_NAMESPACE,
    v: SPHERE_CONNECT_VERSION,
    type: 'handshake',
    direction: 'request',
    permissions: [...ALL_PERMISSIONS],
    dapp: { name: 'Test', url: 'https://test.app' },
  });
  // Drain microtasks so the host has had a chance to send a response.
  await Promise.resolve();
  await Promise.resolve();
  const handshakeResponse = transport.sent.find(
    (m) => m.type === 'handshake' && m.direction === 'response',
  );
  if (!handshakeResponse || handshakeResponse.type !== 'handshake') {
    throw new Error('handshake did not complete');
  }
  void host; // keep parameter typed-used
  return handshakeResponse.sessionId ?? '';
}

function buildIntent(
  action: string,
  params: Record<string, unknown>,
): SphereConnectMessage {
  return {
    ns: SPHERE_CONNECT_NAMESPACE,
    v: SPHERE_CONNECT_VERSION,
    type: 'intent',
    id: createRequestId(),
    action,
    params,
  };
}

interface OnIntentCall {
  action: string;
  params: Record<string, unknown>;
  session: ConnectSession;
  schemaVersion: IntentSchemaVersion | undefined;
}

function makeHost(): {
  host: ConnectHost;
  transport: CapturedTransport;
  onIntentCalls: OnIntentCall[];
} {
  const transport = createCapturedTransport();
  const onIntentCalls: OnIntentCall[] = [];
  const onIntent = vi.fn(
    async (
      action: string,
      params: Record<string, unknown>,
      session: ConnectSession,
      schemaVersion?: IntentSchemaVersion,
    ) => {
      onIntentCalls.push({ action, params, session, schemaVersion });
      return { result: { ok: true } };
    },
  );
  const host = new ConnectHost({
    sphere: createMinimalSphere(),
    transport,
    onConnectionRequest: vi.fn().mockResolvedValue({
      approved: true,
      grantedPermissions: [...ALL_PERMISSIONS],
    }),
    onIntent,
  });
  return { host, transport, onIntentCalls };
}

async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// detectIntentSchemaVersion — unit
// ---------------------------------------------------------------------------

describe('detectIntentSchemaVersion (T.7.C.5)', () => {
  it('returns "legacy" for empty / undefined / null params', () => {
    expect(detectIntentSchemaVersion(undefined)).toBe('legacy');
    expect(detectIntentSchemaVersion(null)).toBe('legacy');
    expect(detectIntentSchemaVersion({})).toBe('legacy');
  });

  it('returns "legacy" for a classic single-coin send payload', () => {
    expect(
      detectIntentSchemaVersion({
        recipient: '@bob',
        amount: '1000',
        coinId: 'UCT',
      }),
    ).toBe('legacy');
  });

  it('returns "uxf-1" when params.schemaVersion is explicitly set', () => {
    expect(
      detectIntentSchemaVersion({
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        schemaVersion: 'uxf-1',
      }),
    ).toBe('uxf-1');
  });

  it('returns "uxf-1" when additionalAssets[] is non-empty', () => {
    expect(
      detectIntentSchemaVersion({
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '500' }],
      }),
    ).toBe('uxf-1');
  });

  it('returns "legacy" when additionalAssets[] is present but empty', () => {
    // Empty array carries no UXF-1 signal — treat as legacy.
    expect(
      detectIntentSchemaVersion({
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        additionalAssets: [],
      }),
    ).toBe('legacy');
  });

  it('returns "uxf-1" when bundle / uxfBundle / uxf envelope is present', () => {
    expect(detectIntentSchemaVersion({ bundle: { manifest: {} } })).toBe('uxf-1');
    expect(detectIntentSchemaVersion({ uxfBundle: { v: 1 } })).toBe('uxf-1');
    expect(detectIntentSchemaVersion({ uxf: 'cid:bafy...' })).toBe('uxf-1');
  });

  it('does not mutate the input params object', () => {
    const params = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: '0xdead' }],
    };
    const snapshot = JSON.stringify(params);
    detectIntentSchemaVersion(params);
    expect(JSON.stringify(params)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// ConnectHost.handleIntentRequest — wiring
// ---------------------------------------------------------------------------

describe('ConnectHost.onIntent — schemaVersion field (T.7.C.5)', () => {
  it('passes "legacy" as the 4th argument for legacy single-coin send', async () => {
    const { host, transport, onIntentCalls } = makeHost();
    await performHandshake(host, transport);

    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
      }),
    );
    await flushMicrotasks();

    expect(onIntentCalls).toHaveLength(1);
    expect(onIntentCalls[0].schemaVersion).toBe('legacy');
    host.destroy();
  });

  it('passes "uxf-1" when params declare schemaVersion explicitly', async () => {
    const { host, transport, onIntentCalls } = makeHost();
    await performHandshake(host, transport);

    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        schemaVersion: 'uxf-1',
      }),
    );
    await flushMicrotasks();

    expect(onIntentCalls[0].schemaVersion).toBe('uxf-1');
    host.destroy();
  });

  it('passes "uxf-1" when params include a non-empty additionalAssets[]', async () => {
    const { host, transport, onIntentCalls } = makeHost();
    await performHandshake(host, transport);

    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '500' }],
      }),
    );
    await flushMicrotasks();

    expect(onIntentCalls[0].schemaVersion).toBe('uxf-1');
    host.destroy();
  });

  it('passes "uxf-1" when params include a bundle envelope', async () => {
    const { host, transport, onIntentCalls } = makeHost();
    await performHandshake(host, transport);

    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        bundle: { manifest: { v: 1 } },
      }),
    );
    await flushMicrotasks();

    expect(onIntentCalls[0].schemaVersion).toBe('uxf-1');
    host.destroy();
  });

  it('forwards schemaVersion to auto-approve handlers as well', async () => {
    const { host, transport } = makeHost();
    await performHandshake(host, transport);

    const seen: Array<IntentSchemaVersion | undefined> = [];
    host.setIntentAutoApprove(
      INTENT_ACTIONS.SEND,
      async (
        _action: string,
        _params: Record<string, unknown>,
        _session: ConnectSession,
        schemaVersion?: IntentSchemaVersion,
      ) => {
        seen.push(schemaVersion);
        return { result: { auto: true } };
      },
    );

    // Legacy payload first.
    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
      }),
    );
    await flushMicrotasks();

    // UXF-1 payload (multi-asset).
    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
        additionalAssets: [{ kind: 'nft', tokenId: '0xabc' }],
      }),
    );
    await flushMicrotasks();

    expect(seen).toEqual(['legacy', 'uxf-1']);
    host.destroy();
  });

  it('does not break existing 3-parameter onIntent callbacks', async () => {
    // Backward-compatibility safety net: callers that ignore the 4th arg
    // must continue to function. We exercise this by registering an
    // onIntent that explicitly only declares 3 parameters.
    const transport = createCapturedTransport();
    type Legacy3ArgOnIntent = (
      action: string,
      params: Record<string, unknown>,
      session: ConnectSession,
    ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
    const legacyOnIntent: Legacy3ArgOnIntent = async (action, params) => {
      // Sanity check: dApp params land here unmodified.
      expect(action).toBe(INTENT_ACTIONS.SEND);
      expect(params.recipient).toBe('@bob');
      return { result: { ok: true } };
    };
    const host = new ConnectHost({
      sphere: createMinimalSphere(),
      transport,
      onConnectionRequest: vi.fn().mockResolvedValue({
        approved: true,
        grantedPermissions: [...ALL_PERMISSIONS],
      }),
      // Cast here mirrors what an unupdated external integrator does
      // when the SDK begins emitting an extra positional argument.
      onIntent: legacyOnIntent as unknown as never,
    });
    await performHandshake(host, transport);
    transport.inject(
      buildIntent(INTENT_ACTIONS.SEND, {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000',
      }),
    );
    await flushMicrotasks();
    // The host must have responded — no exceptions from the extra arg.
    expect(
      transport.sent.some(
        (m) => m.type === 'intent_result' && m.result !== undefined,
      ),
    ).toBe(true);
    expect(PERMISSION_SCOPES.TRANSFER_REQUEST).toBe('transfer:request'); // sanity
    host.destroy();
  });
});
