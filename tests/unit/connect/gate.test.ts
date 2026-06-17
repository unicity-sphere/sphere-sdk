import { describe, it, expect } from 'vitest';
import { ConnectClient, ConnectError } from '../../../connect/client/ConnectClient';
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
