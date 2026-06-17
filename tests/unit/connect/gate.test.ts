import { describe, it, expect, vi } from 'vitest';
import { ConnectClient, ConnectError } from '../../../connect/client/ConnectClient';
import { ConnectHost } from '../../../connect/host/ConnectHost';
import type { ConnectTransport, SphereConnectMessage } from '../../../connect/types';
import { ERROR_CODES, SPHERE_CONNECT_NAMESPACE, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';

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
    const req = h.sent[0] as Record<string, unknown>;
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

function makeHostHarness(opts?: { minMinorVersion?: number }) {
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
  const host = new ConnectHost({ sphere, transport, onConnectionRequest, onConnectionRejected, onIntent: vi.fn(), ...opts });
  const send = (msg: Partial<SphereConnectMessage> & Record<string, unknown>) =>
    clientHandler?.({ ns: SPHERE_CONNECT_NAMESPACE, type: 'handshake', direction: 'request', permissions: [], ...msg } as SphereConnectMessage);
  return { host, sent, send, onConnectionRejected, onConnectionRequest };
}

const handshakeResponses = (sent: SphereConnectMessage[]) =>
  sent.filter((m) => m.type === 'handshake' && (m as { direction?: string }).direction === 'response') as Array<Record<string, unknown>>;

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

  it('rejects a wrong network with INCOMPATIBLE_NETWORK', async () => {
    const h = makeHostHarness();
    h.send({ v: SPHERE_CONNECT_VERSION, dapp: { name: 'd', url: 'https://d' }, network: { id: 1 } });
    await Promise.resolve();
    expect((handshakeResponses(h.sent)[0].error as { code: number }).code).toBe(ERROR_CODES.INCOMPATIBLE_NETWORK);
  });

  it('accepts a same-MAJOR newer MINOR client and includes wallet network/sdkVersion', async () => {
    const h = makeHostHarness();
    h.send({ v: '2.1', dapp: { name: 'd', url: 'https://d' }, network: { id: WALLET_NET } });
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
