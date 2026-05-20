/**
 * vitest globalSetup for local-infra mode.
 *
 * Two modes selected by env var (see also docker-compose.yml header):
 *
 * 1. RELAY-ONLY (`E2E_LOCAL_INFRA=1`) — Nostr relay (Docker) +
 *    faucet agent (js-faucet image). Aggregator + IPFS continue to
 *    point at the public Unicity testnet — they are reliable enough
 *    that a relay-only override was sufficient when the harness was
 *    introduced.
 *
 * 2. FULL-STACK (`E2E_FULL_LOCAL_STACK=1`) — adds local aggregator
 *    (BFT_ENABLED=false standalone with a sidecar MongoDB) and a
 *    local IPFS (kubo) daemon. Hermetic: no testnet dependencies at
 *    test time. Used when testnet is broken (e.g. aggregator 401
 *    outage) or when CI needs a self-contained run.
 *
 * Env vars exported into the test process:
 *
 *   SPHERE_NOSTR_RELAYS       — read by createNodeProviders to
 *                                override the network preset's
 *                                default relay set. Always set when
 *                                E2E_LOCAL_INFRA=1.
 *   E2E_LOCAL_FAUCET_PUBKEY   — the spawned faucet's secp256k1
 *                                chainPubkey. Always set when
 *                                E2E_LOCAL_INFRA=1 and the faucet
 *                                wasn't disabled.
 *   SPHERE_AGGREGATOR_URL     — http://127.0.0.1:3001 (local
 *                                aggregator). Set only in full-stack
 *                                mode.
 *   SPHERE_IPFS_GATEWAY       — http://127.0.0.1:8082 (local kubo
 *                                gateway). Set only in full-stack
 *                                mode.
 *
 * Teardown stops every container WE booted. Persistent state (relay
 * SQLite event log, mongo data, ipfs repo) is preserved unless the
 * developer sets `E2E_LOCAL_INFRA_WIPE=1`, which lets a triage
 * session re-run with a clean slate.
 *
 * Compatibility: when E2E_LOCAL_INFRA is unset, this module's
 * `setup()` is a no-op so the suite continues to run against the
 * public testnet. The infra-probe preflight
 * (tests/e2e/preflight.global-setup.ts) runs separately and gates
 * any real-testnet test on its own.
 *
 * @module tests/e2e/local-infra/global-setup
 */

import { bootLocalRelay, type RelayHandle } from './relay.js';
import { bootLocalFaucet, type FaucetHandle } from './faucet.js';
import { bootLocalAggregator, type AggregatorHandle } from './aggregator.js';
import { bootLocalIpfs, type IpfsHandle } from './ipfs.js';

let relay: RelayHandle | null = null;
let faucet: FaucetHandle | null = null;
let aggregator: AggregatorHandle | null = null;
let ipfs: IpfsHandle | null = null;

const PREFIX = '[e2e-local-infra] ';
const log = (msg: string): void => {
   
  console.log(`${PREFIX}${msg}`);
};

/**
 * Did a parent process (e.g., the bash smoke-test driver fanning out
 * per-test scripts, or a CI orchestrator) already boot the local
 * stack and export its env? When SPHERE_NOSTR_RELAYS and
 * E2E_LOCAL_FAUCET_PUBKEY are both set on entry, we trust the parent's
 * boot and skip our own — otherwise we'd race the parent's faucet
 * container (`docker rm -f` pre-clean would yank the running parent
 * faucet mid-test) and double-publish the relay's port.
 *
 * This DOES NOT prevent normal vitest runs from booting the stack —
 * those start with neither env var set, so this returns false.
 */
function parentAlreadyBootedStack(): boolean {
  return Boolean(
    process.env['SPHERE_NOSTR_RELAYS'] &&
    process.env['E2E_LOCAL_FAUCET_PUBKEY'],
  );
}

/**
 * Full-local-stack mode (E2E_FULL_LOCAL_STACK=1) — adds local
 * aggregator + IPFS on top of the relay + faucet. Implies
 * E2E_LOCAL_INFRA semantics; setting both is harmless (full implies
 * the relay-only set).
 */
function fullStackRequested(): boolean {
  return process.env['E2E_FULL_LOCAL_STACK'] === '1';
}

export async function setup(): Promise<void> {
  // Setting E2E_FULL_LOCAL_STACK=1 implies E2E_LOCAL_INFRA=1 — the
  // full-stack mode is the relay-only path plus the aggregator + IPFS
  // services. Normalize early so the remaining gates work.
  const fullStack = fullStackRequested();
  if (fullStack && process.env['E2E_LOCAL_INFRA'] !== '1') {
    process.env['E2E_LOCAL_INFRA'] = '1';
  }

  if (process.env['E2E_LOCAL_INFRA'] !== '1') {
    log('E2E_LOCAL_INFRA != 1 — skipping local infra; tests run against public testnet.');
    return;
  }

  if (parentAlreadyBootedStack()) {
    log(
      `parent already booted stack: relay=${process.env['SPHERE_NOSTR_RELAYS']} ` +
        `faucet=${process.env['E2E_LOCAL_FAUCET_PUBKEY']?.slice(0, 16)}… — reusing.`,
    );
    return;
  }

  if (fullStack) {
    log('E2E_FULL_LOCAL_STACK=1 — booting relay + faucet + aggregator + IPFS (hermetic e2e).');
  } else {
    log('booting local Nostr relay + faucet (aggregator + IPFS stay public)…');
  }

  // 1. Local Nostr relay.
  const wipe = process.env['E2E_LOCAL_INFRA_WIPE'] === '1';
  relay = await bootLocalRelay({ wipe, logPrefix: PREFIX });
  process.env['SPHERE_NOSTR_RELAYS'] = relay.url;
  log(`SPHERE_NOSTR_RELAYS=${relay.url}`);

  // 2. Full-stack only: aggregator (+ mongo) and IPFS. Booted BEFORE
  //    the faucet because the faucet will resolve nametags via the
  //    aggregator on startup; if a future faucet revision adds an
  //    aggregator dependency at boot, having it up first avoids a
  //    flaky race.
  if (fullStack) {
    try {
      // Aggregator: booted in parallel with IPFS to keep total boot
      // time bounded. Cold first-run is dominated by the Go build
      // (~30s); subsequent runs are <5s.
      const [aggHandle, ipfsHandle] = await Promise.all([
        bootLocalAggregator({ wipe, logPrefix: PREFIX }),
        bootLocalIpfs({ wipe, logPrefix: PREFIX }),
      ]);
      aggregator = aggHandle;
      ipfs = ipfsHandle;
      process.env['SPHERE_AGGREGATOR_URL'] = aggregator.url;
      process.env['SPHERE_IPFS_GATEWAY'] = ipfs.gatewayUrl;
      log(`SPHERE_AGGREGATOR_URL=${aggregator.url}`);
      log(`SPHERE_IPFS_GATEWAY=${ipfs.gatewayUrl}`);
    } catch (err) {
      // Aggregator OR IPFS failed — tear down anything we got up so
      // the next run starts clean.
      if (relay) {
        try { await relay.stop(); } catch { /* best effort */ }
      }
      if (aggregator) {
        try { await aggregator.stop(); } catch { /* best effort */ }
      }
      if (ipfs) {
        try { await ipfs.stop(); } catch { /* best effort */ }
      }
      throw err;
    }
  }

  // 3. Local faucet (auto-disable via env if a developer wants to
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
    if (aggregator) {
      try { await aggregator.stop(); } catch { /* best effort */ }
    }
    if (ipfs) {
      try { await ipfs.stop(); } catch { /* best effort */ }
    }
    throw err;
  }
}

export async function teardown(): Promise<void> {
  if (process.env['E2E_LOCAL_INFRA'] !== '1') return;

  // Symmetric with setup() — only tear down what WE booted. If a
  // parent process owns the stack lifecycle, leaving the containers
  // running is correct (the parent will tear them down at its own
  // exit). The module-scoped `relay` / `faucet` / `aggregator` /
  // `ipfs` handles are non-null ONLY when this module's setup()
  // actually booted them.
  if (!relay && !faucet && !aggregator && !ipfs) {
    log('parent owns stack lifecycle — skipping teardown.');
    return;
  }

  log('stopping local infra…');
  const wipe = process.env['E2E_LOCAL_INFRA_WIPE'] === '1';

  // Faucet first so it can shut down its DM subscription cleanly
  // before we kill the relay it talks to.
  if (faucet) {
    try { await faucet.stop(); }
    catch (err) { log(`faucet stop failed: ${err instanceof Error ? err.message : String(err)}`); }
    faucet = null;
  }
  // Aggregator + IPFS in parallel — independent containers, both
  // safe to stop concurrently. Mongo is torn down by aggregator.stop().
  if (aggregator || ipfs) {
    await Promise.all([
      aggregator
        ? aggregator.stop({ wipe }).catch((err) => {
            log(`aggregator stop failed: ${err instanceof Error ? err.message : String(err)}`);
          })
        : Promise.resolve(),
      ipfs
        ? ipfs.stop({ wipe }).catch((err) => {
            log(`ipfs stop failed: ${err instanceof Error ? err.message : String(err)}`);
          })
        : Promise.resolve(),
    ]);
    aggregator = null;
    ipfs = null;
  }
  if (relay) {
    try { await relay.stop({ wipe }); }
    catch (err) { log(`relay stop failed: ${err instanceof Error ? err.message : String(err)}`); }
    relay = null;
  }
  log('local infra stopped.');
}
