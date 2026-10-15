// #847 phase 1: ConnectHost refuses a DIRECT:// payment recipient on the `send`,
// `payment_request` and `send_nft` intents BEFORE the wallet's onIntent and before
// any auto-approve handler, so a dApp gets a typed error instead of an approval
// prompt that can only fail. `dm` is not a payment intent and is untouched.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectHost } from '../../../connect/host/ConnectHost';
import { ConnectClient } from '../../../connect/client/ConnectClient';
import { ConnectError } from '../../../connect';
import { PERMISSION_SCOPES } from '../../../connect/permissions';
import { ERROR_CODES, INTENT_ACTIONS } from '../../../connect/protocol';
import type { ConnectTransport, SphereConnectMessage } from '../../../connect/types';
import { DIRECT_RECIPIENT_REFUSED_MESSAGE } from '../../../modules/payments-v2/recipient';

function transportPair(): { host: ConnectTransport; client: ConnectTransport } {
  const toHost = new Set<(msg: SphereConnectMessage) => void>();
  const toClient = new Set<(msg: SphereConnectMessage) => void>();
  const side = (out: typeof toHost, inbox: typeof toHost): ConnectTransport => ({
    send: (msg) => out.forEach((h) => h(msg)),
    onMessage: (handler) => {
      inbox.add(handler);
      return () => inbox.delete(handler);
    },
    destroy: () => inbox.clear(),
  });
  return { host: side(toClient, toHost), client: side(toHost, toClient) };
}

function mockSphere(): Record<string, unknown> {
  return {
    identity: { chainPubkey: '02' + 'ab'.repeat(32), directAddress: 'DIRECT://own', nametag: 'alice' },
    networkId: 4,
    on: vi.fn(() => () => undefined),
    resolve: vi.fn(),
  };
}

const DIRECT = 'DIRECT://0000' + 'cd'.repeat(32) + '01020304';
const COIN = 'aa'.repeat(32);
const PAYMENT_INTENTS: readonly [string, Record<string, unknown>][] = [
  [INTENT_ACTIONS.SEND, { amount: '100', coinId: COIN }],
  [INTENT_ACTIONS.PAYMENT_REQUEST, { amount: '100', coinId: COIN }],
  [INTENT_ACTIONS.SEND_NFT, { tokenId: 'ef'.repeat(32) }],
];

let host: ConnectHost;
let client: ConnectClient;
let onIntent: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const transports = transportPair();
  onIntent = vi.fn().mockResolvedValue({ result: { success: true } });
  host = new ConnectHost({
    sphere: mockSphere(),
    transport: transports.host,
    onConnectionRequest: vi.fn().mockResolvedValue({
      approved: true,
      grantedPermissions: Object.values(PERMISSION_SCOPES),
    }),
    onIntent,
  });
  client = new ConnectClient({
    transport: transports.client,
    dapp: { name: 'Test dApp', url: 'https://test.app' },
    network: { id: 4 },
  });
  await client.connect();
});

async function intentError(action: string, params: Record<string, unknown>): Promise<ConnectError> {
  const err = await client.intent(action, params).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ConnectError);
  return err as ConnectError;
}

describe('#847 ConnectHost refuses a DIRECT:// payment recipient', () => {
  it.each(PAYMENT_INTENTS)('%s with a DIRECT:// `to` is refused before onIntent', async (action, params) => {
    const err = await intentError(action, { ...params, to: DIRECT });

    expect(err.code).toBe(ERROR_CODES.INVALID_PARAMS);
    expect(err.message).toBe(DIRECT_RECIPIENT_REFUSED_MESSAGE);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it.each(PAYMENT_INTENTS)('%s with a DIRECT:// `to` is refused before an auto-approve handler', async (action, params) => {
    const auto = vi.fn().mockResolvedValue({ result: { success: true } });
    host.setIntentAutoApprove(action, auto);

    const err = await intentError(action, { ...params, to: `@${DIRECT.toLowerCase()}` });

    expect(err.code).toBe(ERROR_CODES.INVALID_PARAMS);
    expect(err.message).toBe(DIRECT_RECIPIENT_REFUSED_MESSAGE);
    expect(auto).not.toHaveBeenCalled();
    expect(onIntent).not.toHaveBeenCalled();
  });

  it.each(PAYMENT_INTENTS)('ACCEPTANCE: %s with an @nametag `to` still reaches onIntent', async (action, params) => {
    await client.intent(action, { ...params, to: '@bob' });

    expect(onIntent).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTANCE: a dm to a DIRECT:// peer is not a payment and still reaches onIntent (phase 2)', async () => {
    await client.intent(INTENT_ACTIONS.DM, { to: DIRECT, message: 'hi' });

    expect(onIntent).toHaveBeenCalledTimes(1);
  });
});
