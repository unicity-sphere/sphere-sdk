import { describe, expect, it } from 'vitest';

import { WalletApiV2Client } from '../../../impl/wallet-api-v2/client';
import { createWalletApiHttp, WalletApiHttpError, type HttpResponseLike } from '../../../impl/wallet-api-v2/http';

// #835: wallet-api answers an intent PUT and abort only with a bodyless 204. Any other 2xx
// came from something that may never have forwarded the request (a gateway's fixed response,
// a misroute), so it must not read as "stored" or "aborted".

function clientAnswering(status: number, body = ''): WalletApiV2Client {
  const fetchFn = async (): Promise<HttpResponseLike> => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  return new WalletApiV2Client(
    createWalletApiHttp({ baseUrl: 'https://wallet-api.example', fetchFn, getToken: () => 'jwt' })
  );
}

const WRITES: readonly (readonly [string, (client: WalletApiV2Client) => Promise<void>])[] = [
  ['PUT /v1/intents/:id', (client) => client.putIntent('tid-1', 'envelope')],
  ['POST /v1/intents/:id/abort', (client) => client.abortIntent('tid-1')],
];

const OTHER_SUCCESSES: readonly (readonly [number, string])[] = [
  [200, ''],
  [200, '{}'],
  [201, ''],
  [202, '{"ok":true}'],
];

describe('an intent PUT or abort counts only wallet-api\'s 204 (#835)', () => {
  it.each(WRITES)('%s resolves on a bodyless 204', async (_label, write) => {
    await expect(write(clientAnswering(204))).resolves.toBeUndefined();
  });

  it.each(WRITES.flatMap(([label, write]) => OTHER_SUCCESSES.map(([status, body]) => [label, status, body, write] as const)))(
    '%s answered %i %j proves nothing: PROTOCOL, carrying that status',
    async (_label, status, body, write) => {
      const err: unknown = await write(clientAnswering(status, body)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WalletApiHttpError);
      expect(err).toMatchObject({ status, code: 'PROTOCOL' });
    }
  );

  it.each(WRITES)('%s keeps a typed 4xx as it is: the rule binds only the success status', async (_label, write) => {
    const body = '{"error":{"code":"VALIDATION_FAILED","message":"payload refused"}}';
    const err: unknown = await write(clientAnswering(422, body)).catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('a read keeps accepting a JSON 200', async () => {
    await expect(clientAnswering(200, '{"intents":[]}').listIntents()).resolves.toEqual([]);
  });
});
