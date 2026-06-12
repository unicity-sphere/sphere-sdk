/**
 * In-process token-api boot for the cross-repo vault e2e (Task 8.3, finding #13).
 *
 * token-api is a SIBLING repo (`../token-api`, `@unicity-sphere/token-api`, ESM, no
 * package `exports`). It is already compiled to `dist/` and carries its own
 * `mongodb-memory-server` + `mongoose` + `fastify`. We boot the REAL server in the
 * SAME test process by:
 *  1. starting a `mongodb-memory-server` REPLICA SET (transactions need a replset),
 *     resolved through token-api's own module tree via `createRequire`;
 *  2. importing token-api's compiled `loadConfig` / `buildDeps` / `buildApp`
 *     (relative `dist/src/*.js` paths — Node resolves token-api's deps from its own
 *     `node_modules` because the imported files live under token-api/);
 *  3. `buildApp(deps)` + `app.listen({ port: 0 })`, returning the base URL.
 *
 * `SERVER_SIGN_PRIV = 'a'*64`, whose pubkey == `NETWORKS.testnet2.vaultServerKey`,
 * so the SDK-under-test verifies the server's signed epoch byte-for-byte.
 *
 * If `TOKEN_API_URL` is set, NO local server is booted — the e2e runs against that
 * remote deploy instead (the boot here is a no-op shell returning the override URL).
 *
 * The cross-repo import is dynamic + loosely typed on purpose (the sibling has no
 * published types we can import); the wire contract is asserted by the test itself.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic sibling-repo import */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Server signing key whose pubkey == `NETWORKS.testnet2.vaultServerKey`. */
export const TEST_SERVER_PRIV = 'a'.repeat(64);

/** Absolute path to the sibling token-api repo root. */
const TOKEN_API_ROOT = resolve(process.cwd(), '..', 'token-api');

/** A booted (or remote-override) token-api the e2e drives over HTTP. */
export interface BootedTokenApi {
  /** Base URL the SDK HTTP clients point at. */
  baseUrl: string;
  /** Network the server stamps (`testnet2`). */
  network: string;
  /** Tear down the app + mongod (no-op for a remote override). */
  stop(): Promise<void>;
}

/** Import a compiled token-api module by its `dist/src/*` path. */
async function importDist(rel: string): Promise<any> {
  const url = pathToFileURL(resolve(TOKEN_API_ROOT, 'dist', 'src', rel)).href;
  return import(url);
}

/** Resolve + import `mongodb-memory-server` from token-api's own module tree. */
async function importMms(): Promise<any> {
  const require = createRequire(pathToFileURL(resolve(TOKEN_API_ROOT, 'package.json')).href);
  const entry = require.resolve('mongodb-memory-server');
  return import(pathToFileURL(entry).href);
}

/**
 * Boot the REAL token-api in-process against a fresh mongodb-memory-server replica
 * set — UNLESS `TOKEN_API_URL` overrides it with a remote deploy. Returns the base
 * URL + a teardown.
 */
export async function bootTokenApi(network = 'testnet2'): Promise<BootedTokenApi> {
  const override = process.env.TOKEN_API_URL;
  if (override) {
    return { baseUrl: override.replace(/\/+$/, ''), network, stop: () => Promise.resolve() };
  }
  return bootInProcess(network);
}

/** Start mongod + buildApp + listen; returns the base URL and a full teardown. */
async function bootInProcess(network: string): Promise<BootedTokenApi> {
  const mms = await importMms();
  const { loadConfig } = await importDist('config.js');
  const { buildDeps } = await importDist('deps.js');
  const { buildApp } = await importDist('app.js');

  const replset = await mms.MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await replset.waitUntilRunning();
  try {
    const config = loadConfig({
      NETWORK: network,
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: 's'.repeat(32),
      SERVER_SIGN_PRIV: TEST_SERVER_PRIV,
    });
    const deps = await buildDeps(config);
    const app = await buildApp(deps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const stop = async (): Promise<void> => {
      await app.close();
      await deps.dispose();
      await replset.stop();
    };
    return { baseUrl: `http://127.0.0.1:${port}`, network, stop };
  } catch (err) {
    await replset.stop();
    throw err;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
