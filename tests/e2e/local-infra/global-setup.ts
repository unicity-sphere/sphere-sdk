/**
 * vitest globalSetup for local-infra mode.
 *
 * Activated when `E2E_LOCAL_INFRA=1`. Boots a local Nostr relay (Docker)
 * and a local faucet agent (js-faucet image), then exports two env
 * vars that the test helpers and SDK pick up:
 *
 *   SPHERE_NOSTR_RELAYS       — read by createNodeProviders to override
 *                                the network preset's default relay
 *                                set. ws://127.0.0.1:7777 here.
 *   E2E_LOCAL_FAUCET_PUBKEY   — the spawned faucet's secp256k1
 *                                chainPubkey (compressed, 66 hex chars).
 *                                Test helpers use this to send
 *                                FAUCET_REQUEST DMs in lieu of the
 *                                public HTTP faucet.
 *
 * Aggregator + IPFS continue to point at the public Unicity testnet —
 * those services are reliable and have no local Docker substitute we
 * trust to round-trip real inclusion proofs.
 *
 * Teardown stops both containers. Persistent state (relay SQLite event
 * log) is preserved unless the developer sets `E2E_LOCAL_INFRA_WIPE=1`,
 * which lets a triage session re-run with a clean slate.
 *
 * Compatibility: when E2E_LOCAL_INFRA is unset, this module's
 * `setup()` is a no-op so the suite continues to run against the public
 * testnet. The infra-probe preflight (tests/e2e/preflight.global-setup.ts)
 * runs separately and gates any real-testnet test on its own.
 *
 * @module tests/e2e/local-infra/global-setup
 */

import { bootLocalRelay, type RelayHandle } from './relay.js';
import { bootLocalFaucet, type FaucetHandle } from './faucet.js';

let relay: RelayHandle | null = null;
let faucet: FaucetHandle | null = null;

const PREFIX = '[e2e-local-infra] ';
const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`${PREFIX}${msg}`);
};

export async function setup(): Promise<void> {
  if (process.env['E2E_LOCAL_INFRA'] !== '1') {
    log('E2E_LOCAL_INFRA != 1 — skipping local infra; tests run against public testnet.');
    return;
  }

  log('booting local Nostr relay + faucet (aggregator + IPFS stay public)…');

  // 1. Local Nostr relay.
  const wipe = process.env['E2E_LOCAL_INFRA_WIPE'] === '1';
  relay = await bootLocalRelay({ wipe, logPrefix: PREFIX });
  process.env['SPHERE_NOSTR_RELAYS'] = relay.url;
  log(`SPHERE_NOSTR_RELAYS=${relay.url}`);

  // 2. Local faucet (auto-disable via env if a developer wants to
  //    stand up the faucet by hand for debugging).
  if (process.env['E2E_LOCAL_INFRA_NO_FAUCET'] === '1') {
    log('E2E_LOCAL_INFRA_NO_FAUCET=1 — skipping faucet boot. Tests using the faucet must be opted out.');
    return;
  }

  try {
    faucet = await bootLocalFaucet({
      relayUrl: relay.url,
      logPrefix: PREFIX,
    });
    process.env['E2E_LOCAL_FAUCET_PUBKEY'] = faucet.chainPubkey;
    log(`E2E_LOCAL_FAUCET_PUBKEY=${faucet.chainPubkey}`);
  } catch (err) {
    // If the faucet image isn't built (the most common cause of failure
    // here), tear down the relay we just brought up so a CI run isn't
    // left with a stray container holding the port. Re-throw so vitest
    // aborts the suite — running with no faucet would silently fail
    // every faucet-using test 240s deep.
    if (relay) {
      try { await relay.stop(); } catch { /* best effort */ }
    }
    throw err;
  }
}

export async function teardown(): Promise<void> {
  if (process.env['E2E_LOCAL_INFRA'] !== '1') return;

  log('stopping local infra…');
  // Faucet first so it can shut down its DM subscription cleanly
  // before we kill the relay it talks to.
  if (faucet) {
    try { await faucet.stop(); }
    catch (err) { log(`faucet stop failed: ${err instanceof Error ? err.message : String(err)}`); }
    faucet = null;
  }
  if (relay) {
    try { await relay.stop({ wipe: process.env['E2E_LOCAL_INFRA_WIPE'] === '1' }); }
    catch (err) { log(`relay stop failed: ${err instanceof Error ? err.message : String(err)}`); }
    relay = null;
  }
  log('local infra stopped.');
}
