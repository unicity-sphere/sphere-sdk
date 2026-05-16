/**
 * In-process Sphere DM client for the local faucet.
 *
 * When `E2E_LOCAL_INFRA=1` and a local faucet has been booted (see
 * tests/e2e/local-infra/global-setup.ts), tests use this client
 * INSTEAD of the public HTTP faucet (`requestFaucet` in helpers.ts).
 *
 * The local js-faucet exposes its commands over encrypted Sphere DMs
 * (NIP-17 gift wraps, encrypted to its chainPubkey). To request a
 * mint+send we:
 *
 *   1. Bootstrap a fresh wallet in this process (one-shot, cached
 *      for the run so we don't burn nametag registrations on every
 *      faucet hit).
 *   2. Send an `acp.command FAUCET_REQUEST` envelope as JSON in a DM
 *      to the faucet's pubkey.
 *   3. Wait for an `acp.result` (success) or `acp.error` (failure)
 *      DM keyed by the same `command_id`.
 *
 * Mirrors trader-service/test/e2e-live/helpers/faucet-client.ts. The
 * envelope schema is js-faucet's ACP-0 contract — see
 * /home/vrogojin/js-faucet/src/acp-adapter/protocols/acp.ts.
 *
 * @module tests/e2e/local-infra/faucet-client
 */

import { Sphere } from '../../../core/Sphere.js';
import { createNodeProviders } from '../../../impl/nodejs/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TRUSTBASE_URL, DEFAULT_API_KEY } from '../helpers.js';

/**
 * ACP envelope version we encode for FAUCET_REQUEST. js-faucet's
 * receiver accepts any v0.x envelope; pin "0.1" to match the version
 * the faucet's outgoing acp.result envelopes carry, so a single
 * `acp_version` regex stays consistent across both sides.
 */
const ACP_VERSION = '0.1';

/**
 * Singleton handle. Bootstrapping a Sphere wallet costs ~5-10 s of
 * Nostr handshake + nametag registration; lazy-init it once per
 * process and reuse across requestFaucet calls.
 */
let cachedClient: FaucetClient | null = null;

export interface FaucetRequestParams {
  /** Recipient — `@nametag`, `DIRECT://hex`, or raw hex pubkey. */
  readonly recipient: string;
  /** Asset symbol (UCT, USDU) or 64-hex coinId. */
  readonly asset?: string;
  /** Amount in smallest unit (string). */
  readonly amount?: string;
  /** Optional memo. */
  readonly memo?: string;
  /** Multi-asset batch alternative to (asset, amount). */
  readonly items?: ReadonlyArray<{ asset: string; amount: string; memo?: string }>;
}

export interface FaucetDelivery {
  asset: string;
  coin_id: string;
  amount: string;
  token_id: string;
  transfer_id: string;
}

export interface FaucetClient {
  /** Sphere wallet bound to this client. Kept alive between calls. */
  readonly sphere: Sphere;
  /** chainPubkey of THIS client (recipient of faucet's reply DMs). */
  readonly clientPubkey: string;
  /**
   * Send FAUCET_REQUEST DM to `faucetPubkey` and await `acp.result`.
   * Throws on `acp.error` or timeout.
   */
  request(faucetPubkey: string, params: FaucetRequestParams, timeoutMs?: number): Promise<FaucetDelivery[]>;
  destroy(): Promise<void>;
}

/**
 * Lazy-initialize the singleton FaucetClient. Idempotent — repeated
 * calls return the same instance.
 */
export async function getOrCreateFaucetClient(): Promise<FaucetClient> {
  if (cachedClient) return cachedClient;
  cachedClient = await createFaucetClient();
  return cachedClient;
}

/**
 * Tear down the singleton (call from afterAll/teardown). Safe to call
 * when no client was ever created.
 */
export async function destroyFaucetClient(): Promise<void> {
  if (cachedClient) {
    try { await cachedClient.destroy(); }
    catch { /* best effort */ }
    cachedClient = null;
  }
}

/**
 * Bootstrap a fresh Sphere wallet bound to whatever Nostr relay is
 * configured (SPHERE_NOSTR_RELAYS env var or testnet default), and
 * subscribe to inbound DMs so we can match `acp.result` replies by
 * command_id. Returns a typed client.
 */
async function createFaucetClient(): Promise<FaucetClient> {
  const dataDir = mkdtempSync(join(tmpdir(), 'uxf-e2e-faucet-cli-'));
  const tokensDir = join(dataDir, 'tokens');

  // Trustbase: prefer the standard testnet trustbase since we still
  // talk to the public aggregator. Fetched once per client.
  const tbResp = await fetch(TRUSTBASE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!tbResp.ok) {
    throw new Error(`local-faucet client: failed to fetch trustbase: HTTP ${tbResp.status}`);
  }
  const trustBasePath = join(dataDir, 'trustbase.json');
  writeFileSync(trustBasePath, await tbResp.text());

  const providers = createNodeProviders({
    network: 'testnet',
    dataDir,
    tokensDir,
    oracle: { trustBasePath, apiKey: DEFAULT_API_KEY },
  });

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag: `fc-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    accounting: false,
    swap: false,
    market: false,
  });

  const identity = sphere.identity;
  if (!identity) throw new Error('local-faucet client: Sphere.init returned no identity');
  const clientPubkey = identity.chainPubkey;

  // Subscribe to inbound DMs and route acp.result/acp.error envelopes
  // to a per-command_id Map so request() can await them.
  interface IncomingResponse {
    type: string;
    payload: Record<string, unknown>;
  }
  const responses = new Map<string, IncomingResponse>();

  const unsubscribe = sphere.communications.onDirectMessage((msg) => {
    const acp = parseAcpJson(msg.content);
    if (acp === null) return;
    if (acp.type !== 'acp.result' && acp.type !== 'acp.error') return;
    const payload = acp.payload as Record<string, unknown>;
    const cmdId = typeof payload['command_id'] === 'string' ? payload['command_id'] : null;
    if (cmdId === null) return;
    responses.set(cmdId, { type: acp.type, payload });
  });

  async function request(
    faucetPubkey: string,
    params: FaucetRequestParams,
    timeoutMs = 180_000,
  ): Promise<FaucetDelivery[]> {
    const cmdId = randomUUID();
    const envelope = createAcpCommandEnvelope(cmdId, 'FAUCET_REQUEST', params as unknown as Record<string, unknown>);
    await sphere.communications.sendDM(`DIRECT://${faucetPubkey}`, JSON.stringify(envelope));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = responses.get(cmdId);
      if (r) {
        responses.delete(cmdId);
        if (r.type === 'acp.error') {
          const code = String(r.payload['error_code'] ?? 'UNKNOWN');
          const message = String(r.payload['message'] ?? '');
          throw new Error(`FAUCET_REQUEST failed: [${code}] ${message}`);
        }
        const result = r.payload['result'] as { deliveries?: FaucetDelivery[] } | undefined;
        const deliveries = result?.deliveries ?? [];
        if (!Array.isArray(deliveries)) {
          throw new Error(
            `FAUCET_REQUEST: result.deliveries not an array. payload=${JSON.stringify(r.payload)}`,
          );
        }
        return deliveries;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`FAUCET_REQUEST: no response for command_id=${cmdId} within ${timeoutMs}ms`);
  }

  async function destroy(): Promise<void> {
    try { unsubscribe(); } catch { /* ignore */ }
    try { await sphere.destroy(); } catch { /* ignore */ }
  }

  return { sphere, clientPubkey, request, destroy };
}

// ---------------------------------------------------------------------------
// Minimal ACP envelope helpers — duplicated from js-faucet's protocol
// module to avoid a cross-repo dependency. js-faucet's parser is
// permissive on `acp_version`/`msg_id`/`ts_ms` (validated for shape and
// freshness, not exact values), so a hand-rolled envelope here is
// sufficient.
// ---------------------------------------------------------------------------

function createAcpCommandEnvelope(
  cmdId: string,
  name: string,
  params: Record<string, unknown>,
): {
  acp_version: string;
  msg_id: string;
  ts_ms: number;
  instance_id: string;
  instance_name: string;
  type: string;
  payload: { command_id: string; name: string; params: Record<string, unknown> };
} {
  return {
    acp_version: ACP_VERSION,
    msg_id: randomUUID(),
    ts_ms: Date.now(),
    instance_id: 'controller',
    instance_name: 'controller',
    type: 'acp.command',
    payload: { command_id: cmdId, name, params },
  };
}

interface AcpEnvelope {
  type: string;
  payload: unknown;
}

function parseAcpJson(content: string): AcpEnvelope | null {
  if (content.length > 65_536) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Record<string, unknown>;
    if (typeof env['type'] !== 'string') return null;
    return { type: env['type'], payload: env['payload'] };
  } catch {
    return null;
  }
}
