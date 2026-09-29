import { describe, it, expect, vi } from 'vitest';
import { ConnectClient, ConnectError } from '../../../connect/client/ConnectClient';
import { ConnectHost } from '../../../connect/host/ConnectHost';
import type { ConnectTransport, ConnectHostConfig, NetworkMismatchContext, SphereConnectMessage } from '../../../connect/types';
import { SDK_VERSION } from '../../../connect/version';
import { ERROR_CODES, SPHERE_CONNECT_NAMESPACE, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';
import { logger } from '../../../core/logger';

const WALLET_NET = 4;

// ---- Client-side gate tests --------------------------------------------------

function makeClientHarness() {
  const sent: SphereConnectMessage[] = [];
  let hostHandler: ((m: SphereConnectMessage) => void) | undefined;
  const transport: ConnectTransport = {
    send: (m) => { sent.push(m); },
    onMessage: (h) => { hostHandler = h; return () => { hostHandler = undefined; }; },
    destroy: () => {},
  };
  const client = new ConnectClient({
    transport, dapp: { name: 'd', url: 'https://d' },
    permissions: [PERMISSION_SCOPES.IDENTITY_READ], network: { id: WALLET_NET },
  });
  const reply = (msg: Record<string, unknown>) =>
    hostHandler?.({ ns: SPHERE_CONNECT_NAMESPACE, v: SPHERE_CONNECT_VERSION, type: 'handshake', direction: 'response', permissions: [], ...msg } as SphereConnectMessage);
  return { client, sent, reply };
}

describe('ConnectClient gate', () => {
  it('sends network + sdkVersion in the handshake request', async () => {
    const h = makeClientHarness();
    void h.client.connect();
    await Promise.resolve();
    const req = h.sent[0] as unknown as Record<string, unknown>;
    expect((req.network as { id: number }).id).toBe(WALLET_NET);
    expect(typeof req.sdkVersion).toBe('string');
    expect(req.v).toBe(SPHERE_CONNECT_VERSION);
  });

  it('rejects with a typed ConnectError on an error response', async () => {
    const h = makeClientHarness();
    const p = h.client.connect();
    await Promise.resolve();
    h.reply({ v: '1.0', error: { code: ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, message: 'nope', data: { reason: 'protocol_incompatible' } } });
    await expect(p).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION });
    await p.catch((e) => { expect(e).toBeInstanceOf(ConnectError); });
  });

  it('keeps the generic message on a plain (no-error) rejection', async () => {
    const h = makeClientHarness();
    const p = h.client.connect();
    await Promise.resolve();
    h.reply({}); // no sessionId, no identity, no error
    await expect(p).rejects.toThrow('Connection rejected by wallet');
  });

  it('exposes the wallet network after a successful handshake', async () => {
    const h = makeClientHarness();
    const p = h.client.connect();
    await Promise.resolve();
    h.reply({
      sessionId: 's1',
      permissions: [PERMISSION_SCOPES.IDENTITY_READ],
      identity: { chainPubkey: '02', l1Address: 'alpha1', directAddress: 'DIRECT://x' },
      network: { id: WALLET_NET },
    });
    await p;
    expect(h.client.walletNetwork?.id).toBe(WALLET_NET);
  });
});

// ---- Host-side gate tests ----

function makeHostHarness(opts?: {
  minMinorVersion?: number;
  onNetworkMismatch?: ConnectHostConfig['onNetworkMismatch'];
  handshakeDeadlineMs?: number;
  origin?: string;
}) {
  const sent: SphereConnectMessage[] = [];
  let clientHandler: ((m: SphereConnectMessage) => void) | undefined;
  const transport: ConnectTransport = {
    send: (m) => { sent.push(m); },
    onMessage: (h) => { clientHandler = h; return () => { clientHandler = undefined; }; },
    destroy: () => {},
  };
  const sphere = {
    identity: { chainPubkey: '02abc', l1Address: 'alpha1', directAddress: 'DIRECT://x', nametag: 'a' },
    networkId: WALLET_NET,
    payments: { getBalance: vi.fn(), getAssets: vi.fn(), getFiatBalance: vi.fn(), getTokens: vi.fn(), getHistory: vi.fn() },
    signMessage: vi.fn(),
    resolve: vi.fn(),
    on: vi.fn(() => () => {}),
  };
  const onConnectionRejected = vi.fn();
  const onConnectionRequest = vi.fn(async () => ({ approved: true, grantedPermissions: [PERMISSION_SCOPES.IDENTITY_READ] }));
  const host = new ConnectHost({
    sphere, transport, onConnectionRequest, onConnectionRejected, onIntent: vi.fn(),
    ...opts,
  });
  // Deliberately UNTYPED wire input: these tests hand the host off-version handshakes
  // (v: '1.0'), which `SphereConnectMessage` cannot express by construction.
  const send = (msg: Record<string, unknown>) =>
    clientHandler?.({ ns: SPHERE_CONNECT_NAMESPACE, type: 'handshake', direction: 'request', permissions: [], ...msg } as unknown as SphereConnectMessage);
  return { host, sent, send, onConnectionRejected, onConnectionRequest, sphere };
}

const handshakeResponses = (sent: SphereConnectMessage[]) =>
  sent.filter((m) => m.type === 'handshake' && (m as { direction?: string }).direction === 'response') as unknown as Array<Record<string, unknown>>;

describe('ConnectHost gate', () => {
  it('rejects a v1 client with UNSUPPORTED_PROTOCOL_VERSION and does not call onConnectionRequest', async () => {
    const h = makeHostHarness();
    h.send({ v: '1.0', dapp: { name: 'old', url: 'https://old' }, network: { id: WALLET_NET } });
    await Promise.resolve();
    const resp = handshakeResponses(h.sent)[0];
    expect((resp.error as { code: number }).code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
    expect(resp.sessionId).toBeUndefined();
    expect(h.onConnectionRequest).not.toHaveBeenCalled();
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('echoes the requester v on a rejection response', async () => {
    const h = makeHostHarness();
    h.send({ v: '1.0', dapp: { name: 'old', url: 'https://old' }, network: { id: WALLET_NET } });
    await Promise.resolve();
    expect(handshakeResponses(h.sent)[0].v).toBe('1.0');
  });

  it('P11 floor is the DEFAULT: a hello with no sdkVersion (any pre-0.14.1 client) is rejected naming the minimum', async () => {
    const h = makeHostHarness();
    h.send({ v: SPHERE_CONNECT_VERSION, dapp: { name: 'old-app', url: 'https://old-app' }, network: { id: WALLET_NET } });
    await Promise.resolve();
    const resp = handshakeResponses(h.sent)[0];
    const err = resp.error as { code: number; message: string };
    expect(err.code).toBe(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
    expect(err.message).toContain('0.14.1-0');
    expect(err.message).toContain('unknown (not reported)');
    expect(h.onConnectionRequest).not.toHaveBeenCalled();
  });

  it('rejects a wrong network with INCOMPATIBLE_NETWORK', async () => {
    const h = makeHostHarness();
    h.send({ v: SPHERE_CONNECT_VERSION, sdkVersion: SDK_VERSION, dapp: { name: 'd', url: 'https://d' }, network: { id: 1 } });
    await Promise.resolve();
    expect((handshakeResponses(h.sent)[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
  });

  it('accepts a same-MAJOR newer MINOR client and includes wallet network/sdkVersion', async () => {
    const h = makeHostHarness();
    h.send({ v: '2.1', sdkVersion: SDK_VERSION, dapp: { name: 'd', url: 'https://d' }, network: { id: WALLET_NET } });
    // onConnectionRequest is async, so the success path settles on a macrotask — flush it.
    // (The rejection tests above are synchronous and only need a microtask.)
    await new Promise((r) => setTimeout(r, 0));
    const resp = handshakeResponses(h.sent)[0];
    expect(resp.sessionId).toBeTypeOf('string');
    expect(resp.error).toBeUndefined();
    expect((resp.network as { id: number }).id).toBe(WALLET_NET);
    expect(resp.v).toBe(SPHERE_CONNECT_VERSION);
  });
});

describe('ConnectHost network-mismatch hook', () => {
  const MISMATCH = { v: SPHERE_CONNECT_VERSION, sdkVersion: SDK_VERSION, dapp: { name: 'd', url: 'https://d' }, network: { id: 1 } };

  it('is not called for a protocol refusal — only the network check may prompt', async () => {
    const onNetworkMismatch = vi.fn(async () => ({ action: 'refuse' as const }));
    const h = makeHostHarness({ onNetworkMismatch });
    h.send({ v: '1.0', dapp: { name: 'old', url: 'https://old' }, network: { id: WALLET_NET } });
    await Promise.resolve();
    expect(onNetworkMismatch).not.toHaveBeenCalled();
  });

  it('is called before any frame is sent, with both networks and the client protocol', async () => {
    let sentWhenAsked = -1;
    const onNetworkMismatch = vi.fn(async (_dapp: unknown, _ctx: NetworkMismatchContext) => {
      sentWhenAsked = harness.sent.length;              // harness is assigned before any send
      return { action: 'refuse' as const };
    });
    const harness: ReturnType<typeof makeHostHarness> = makeHostHarness({ onNetworkMismatch });
    const before = Date.now();
    harness.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    const after = Date.now();
    expect(sentWhenAsked).toBe(0);                       // nothing had been sent yet
    const ctx = onNetworkMismatch.mock.calls[0][1];
    expect(ctx.walletNetwork).toStrictEqual({ id: WALLET_NET });
    expect(ctx.clientNetwork).toStrictEqual({ id: 1 });
    expect(ctx.clientProtocol).toBe(SPHERE_CONNECT_VERSION);
    // The moment the host gives up: the hook was asked between `before` and `after`, and the
    // default handshake deadline is 120 s (documented as such), so the window is exact to the ms.
    expect(ctx.expiresAt).toBeGreaterThanOrEqual(before + 120000);
    expect(ctx.expiresAt).toBeLessThanOrEqual(after + 120000);
  });

  it('an absent hook reproduces today’s refusal exactly', async () => {
    const h = makeHostHarness();
    h.send(MISMATCH);
    await Promise.resolve();
    const resp = handshakeResponses(h.sent)[0];
    expect((resp.error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('on ‘switch’ sends the SAME frame and skips onConnectionRejected', async () => {
    const withHook = makeHostHarness({ onNetworkMismatch: async () => ({ action: 'switch', to: { id: 1 } }) });
    withHook.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(handshakeResponses(withHook.sent)).toHaveLength(1);
    const switched = handshakeResponses(withHook.sent)[0];

    const plain = makeHostHarness();
    plain.send(MISMATCH);
    await Promise.resolve();
    const refused = handshakeResponses(plain.sent)[0];

    expect(switched).toEqual(refused);                    // byte-identical answer to the dApp
    expect(withHook.onConnectionRejected).not.toHaveBeenCalled();
    expect(plain.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('acts on ONE reading of the wallet’s answer: a getter that changes its mind cannot split the outcome', async () => {
    // The host must not hand the wallet's own object on to be read again. A first reading of
    // 'switch' followed by 'refuse' would skip onConnectionRejected on the strength of the first
    // and paint the rejection on the strength of the second.
    let reads = 0;
    const flaky = { get action() { return reads++ === 0 ? 'switch' : 'refuse'; }, to: { id: 1 } };
    const h = makeHostHarness({ onNetworkMismatch: async () => flaky as unknown as { action: 'switch'; to: { id: number } } });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(handshakeResponses(h.sent)).toHaveLength(1);
    expect(reads).toBe(1);
    expect(h.onConnectionRejected).not.toHaveBeenCalled();   // it read 'switch', once, and acted on that
  });

  it('refuses when the hook offers a network the dApp did not ask for', async () => {
    const h = makeHostHarness({ onNetworkMismatch: async () => ({ action: 'switch', to: { id: 99 } }) });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);   // downgraded to a refusal
  });

  it('refuses when the hook throws', async () => {
    const h = makeHostHarness({ onNetworkMismatch: async () => { throw new Error('boom'); } });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(handshakeResponses(h.sent)).toHaveLength(1);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('is never called for a silent attempt', async () => {
    const onNetworkMismatch = vi.fn(async () => ({ action: 'refuse' as const }));
    const h = makeHostHarness({ onNetworkMismatch });
    h.send({ ...MISMATCH, silent: true });
    await Promise.resolve();
    expect(onNetworkMismatch).not.toHaveBeenCalled();
    expect(handshakeResponses(h.sent)).toHaveLength(1);
  });

  it('refuses when the hook throws synchronously', async () => {
    const h = makeHostHarness({ onNetworkMismatch: () => { throw new Error('boom'); } });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    const resp = handshakeResponses(h.sent);
    expect(resp).toHaveLength(1);
    expect((resp[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('refuses when the thrown value cannot even be turned into a string', async () => {
    const hostile = { toString(): string { throw new Error('no string for you'); } };
    const h = makeHostHarness({ onNetworkMismatch: async () => { throw hostile; } });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    const resp = handshakeResponses(h.sent);
    expect(resp).toHaveLength(1);
    expect((resp[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('refuses when the hook answers with nothing at all', async () => {
    const answersNothing = (async () => undefined) as unknown as ConnectHostConfig['onNetworkMismatch'];
    const h = makeHostHarness({ onNetworkMismatch: answersNothing });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    const resp = handshakeResponses(h.sent);
    expect(resp).toHaveLength(1);
    expect((resp[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('refuses when the prompt outlives handshakeDeadlineMs', async () => {
    const h = makeHostHarness({ handshakeDeadlineMs: 20, onNetworkMismatch: () => new Promise(() => {}) });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 80));
    expect(handshakeResponses(h.sent)).toHaveLength(1);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
  });

  it('still answers when the timeout fallback itself throws: a log sink that chokes on the timeout line', async () => {
    // The fallback logs first, and logger.warn is always live. Its throw used to escape a timer
    // callback, so nothing settled and the dApp got no frame at all.
    const h = makeHostHarness({ handshakeDeadlineMs: 20, onNetworkMismatch: () => new Promise(() => {}) });
    logger.configure({
      handler: (_level, _tag, message) => { if (message.includes('timed out')) throw new Error('log sink is down'); },
    });
    try {
      h.send(MISMATCH);
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      logger.configure({ debug: false, handler: null });
    }
    // The throw rejects the race, and handleMessage answers a handshake that threw with the empty refusal.
    expect(handshakeResponses(h.sent)).toHaveLength(1);
  });

  it('refuses a switch when the wallet locked while the prompt was open', async () => {
    const harness: ReturnType<typeof makeHostHarness> = makeHostHarness({
      onNetworkMismatch: async () => {
        harness.host.setLocked();
        return { action: 'switch', to: { id: 1 } };
      },
    });
    harness.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(handshakeResponses(harness.sent)).toHaveLength(1);
    expect(harness.onConnectionRejected).toHaveBeenCalledTimes(1);
    expect(harness.onConnectionRejected.mock.calls[0][2]).toBe(true);   // told silent, as the wallet is locked now
  });

  it('tells onConnectionRejected silent: true when the wallet locked while the prompt was open', async () => {
    const harness: ReturnType<typeof makeHostHarness> = makeHostHarness({
      onNetworkMismatch: async () => {
        harness.host.setLocked();
        return { action: 'refuse' };
      },
    });
    harness.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));

    const plain = makeHostHarness();
    plain.send(MISMATCH);
    await Promise.resolve();

    const resp = handshakeResponses(harness.sent);
    expect(resp).toHaveLength(1);
    expect((resp[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
    expect(resp[0]).toEqual(handshakeResponses(plain.sent)[0]);   // the frame is untouched
    expect(harness.onConnectionRejected).toHaveBeenCalledTimes(1);
    expect(harness.onConnectionRejected.mock.calls[0][2]).toBe(true);
  });

  it('still tells onConnectionRejected silent: false when the wallet stays live and refuses', async () => {
    const h = makeHostHarness({ onNetworkMismatch: async () => ({ action: 'refuse' }) });
    h.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    expect(handshakeResponses(h.sent)).toHaveLength(1);
    expect(h.onConnectionRejected).toHaveBeenCalledTimes(1);
    expect(h.onConnectionRejected.mock.calls[0][2]).toBe(false);
  });

  // Every way the wallet's network id can change under an open prompt: a rebind to another
  // network, and the two verbs that empty the snapshot (docs/CONNECT.md's outcome table and the
  // askNetworkMismatch JSDoc both put them on this row). A lock is NOT one of them.
  type MismatchHarness = ReturnType<typeof makeHostHarness>;
  const networkMoves: Array<[string, (h: MismatchHarness) => void]> = [
    ['updateSphere to another network id', (h) => h.host.updateSphere({ ...h.sphere, networkId: 1 })],
    ['setUnavailable()', (h) => h.host.setUnavailable()],
    ['destroy()', (h) => h.host.destroy()],
  ];
  const stale = networkMoves.flatMap(([move, act]) =>
    (['switch', 'refuse'] as const).map((answer) => [move, answer, act] as const));

  it.each(stale)(
    'sends only the empty refusal when the wallet network moved under the prompt by %s, whatever the hook answers (%s)',
    async (_move, answer, act) => {
      const harness: MismatchHarness = makeHostHarness({
        onNetworkMismatch: async () => {
          act(harness);                                  // the wallet's network moves while the prompt is open
          return answer === 'switch' ? { action: 'switch', to: { id: 1 } } : { action: 'refuse' };
        },
      });
      harness.send(MISMATCH);
      await new Promise((r) => setTimeout(r, 0));
      const resp = handshakeResponses(harness.sent);
      expect(resp).toHaveLength(1);
      expect(resp[0].error).toBeUndefined();             // no 4008 describing a comparison that is no longer true
      expect(resp[0].sessionId).toBeUndefined();
      expect(harness.onConnectionRejected).not.toHaveBeenCalled();
    },
  );

  it('answers a handshake retried after the rebind against the wallet’s new network', async () => {
    const harness: ReturnType<typeof makeHostHarness> = makeHostHarness({
      onNetworkMismatch: async () => {
        harness.host.updateSphere({ ...harness.sphere, networkId: 1 });
        return { action: 'switch', to: { id: 1 } };
      },
    });
    harness.send(MISMATCH);
    await new Promise((r) => setTimeout(r, 0));
    harness.send(MISMATCH);                              // the dApp reads the empty refusal as "not ready"
    await new Promise((r) => setTimeout(r, 0));
    const [first, second] = handshakeResponses(harness.sent);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.sessionId).toBeTypeOf('string');
    expect((second.network as { id: number }).id).toBe(1);
  });

  it('is never called while the wallet is locked', async () => {
    const onNetworkMismatch = vi.fn(async () => ({ action: 'refuse' as const }));
    const h = makeHostHarness({ onNetworkMismatch });
    h.host.setLocked();
    h.send(MISMATCH);
    await Promise.resolve();
    expect(onNetworkMismatch).not.toHaveBeenCalled();
    expect(handshakeResponses(h.sent)).toHaveLength(1);
    expect(h.onConnectionRejected).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  it('hands the wallet its own origin and only the checked parts of the dApp network', async () => {
    const onNetworkMismatch = vi.fn(async (_dapp: unknown, _ctx: NetworkMismatchContext) => ({ action: 'refuse' as const }));
    const h = makeHostHarness({ origin: 'https://wallet.example', onNetworkMismatch });
    h.send({ ...MISMATCH, network: { id: 1, name: 'Mainnet', extra: 'x'.repeat(10) } });
    await new Promise((r) => setTimeout(r, 0));
    const [dapp, ctx] = onNetworkMismatch.mock.calls[0];
    expect((dapp as { url: string }).url).toBe('https://d');
    expect(ctx.origin).toBe('https://wallet.example');
    expect(ctx.clientSdkVersion).toBe(SDK_VERSION);
    expect(ctx.clientNetwork).toStrictEqual({ id: 1, name: 'Mainnet' });   // `extra` never reaches the wallet
  });
});
