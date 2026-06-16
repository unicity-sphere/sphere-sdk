#!/usr/bin/env node
/**
 * manual-test-relay-fresh-pubkey-backlog.mjs — relay-side discriminator for
 * sphere-sdk#559 hypothesis (A): "every fresh CLI invocation sees 3–14 NIP-17
 * gift-wrap events arrive within 140–900 ms of subscribe, on a brand-new wallet
 * whose `#p` filter should match nothing in the relay's index."
 *
 * What it does:
 *   1. Generate a fresh secp256k1 keypair (never used anywhere before).
 *   2. Connect to a Nostr relay (default: nostr-relay.testnet.unicity.network).
 *      Handles NIP-42 AUTH transparently via @unicitylabs/nostr-js-sdk.
 *   3. Subscribe to `kind=1059` events with `#p:[fresh_pubkey]`.
 *      `since` is set generously (relay-supported floor) to catch anything in
 *      the index. Optionally accepts `--no-since` to omit the floor entirely.
 *   4. Count events received before EOSE (historical) and after EOSE
 *      (real-time) for the listen window.
 *   5. Report:
 *        - fresh pubkey (x-only hex)
 *        - count of events pre-EOSE / post-EOSE
 *        - time-to-first-event, time-to-EOSE
 *        - per-event metadata: relative arrival ms, sender pubkey prefix,
 *          created_at relative to subscribe time
 *
 * Discriminator semantics:
 *   - 0 events pre-EOSE  →  relay's `#p` index is clean for fresh pubkeys.
 *     Fix surface for #559 hypothesis (A) is then the soak's publish side —
 *     something in the trader-service spawn flow, host control plane, or
 *     sphere-cli is publishing kind-1059 events targeting the controller
 *     pubkey before the controller's first sendDM lands.
 *   - N>0 events pre-EOSE →  relay-side bug. Either the `#p` index is loose
 *     (matching unrelated events) or another pubkey on the relay has been
 *     reused under our derivation (cosmically improbable with 32-byte random).
 *     File against the relay operator with the captured event ids.
 *
 * Usage:
 *   node manual-test-relay-fresh-pubkey-backlog.mjs \
 *        [--relay <url>] [--duration <seconds>] [--no-since] [--quiet]
 *
 *   Defaults:
 *     --relay     wss://nostr-relay.testnet.unicity.network
 *     --duration  10 (seconds to listen after subscribe)
 *     --no-since  omit the `since` filter floor (subscribe with no time bound)
 *     --quiet     suppress per-event log lines (summary only)
 *
 * Exit code:
 *   0 on success (regardless of event count — caller interprets).
 *   1 on connection / subscribe failure.
 *
 * Related: sphere-sdk#555, sphere-sdk#559, PR #558.
 */

import { NostrClient, NostrKeyManager, EventKinds, Filter } from '@unicitylabs/nostr-js-sdk';

const DEFAULT_RELAY = 'wss://nostr-relay.testnet.unicity.network';
const DEFAULT_DURATION_SEC = 10;
// NIP-17 timestamp randomization: gift-wraps shift created_at ±2 days for
// privacy. To catch matching backlog, the `since` floor must extend at least
// that far. We extend further (7 days back) as a defensive floor.
const SINCE_FLOOR_SEC = 7 * 24 * 60 * 60;

function parseArgs(argv) {
  const args = {
    relay: DEFAULT_RELAY,
    duration: DEFAULT_DURATION_SEC,
    noSince: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay') args.relay = argv[++i];
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--no-since') args.noSince = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node ${argv[1]} [--relay <url>] [--duration <s>] [--no-since] [--quiet]`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.duration) || args.duration <= 0) {
    console.error(`Invalid --duration: ${args.duration}`);
    process.exit(1);
  }
  return args;
}

function nowMs() {
  return Date.now();
}

async function main() {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : (...m) => console.log(...m);

  // Fresh keypair — secp256k1 random key, derived x-only pubkey.
  const keyManager = NostrKeyManager.generate();
  const xOnlyHex = keyManager.getPublicKeyHex(); // 64-char x-only hex per BIP-340

  console.log(`[diag] fresh pubkey (x-only): ${xOnlyHex}`);
  console.log(`[diag] relay:                 ${args.relay}`);
  console.log(`[diag] listen window:         ${args.duration}s`);
  console.log(`[diag] since floor:           ${args.noSince ? 'none' : `${SINCE_FLOOR_SEC}s back`}`);
  console.log('');

  const client = new NostrClient(keyManager, {
    autoReconnect: false,
    queryTimeoutMs: 8000,
  });

  client.addConnectionListener({
    onConnect: (url) => log(`[diag] connected: ${url}`),
    onDisconnect: (url, reason) => log(`[diag] disconnected: ${url} (${reason})`),
  });

  const connectStart = nowMs();
  try {
    await client.connect(args.relay);
  } catch (err) {
    console.error(`[diag] FAILED to connect: ${err?.message ?? err}`);
    process.exit(1);
  }
  log(`[diag] connect latency: ${nowMs() - connectStart} ms`);

  const filter = new Filter();
  filter.kinds = [EventKinds.GIFT_WRAP];
  filter['#p'] = [xOnlyHex];
  if (!args.noSince) {
    filter.since = Math.floor(Date.now() / 1000) - SINCE_FLOOR_SEC;
  }

  // Per-event tracking
  const events = [];
  let eoseAt = null;
  let firstEventAt = null;
  const subscribeAt = nowMs();

  log(`[diag] subscribing... filter=${JSON.stringify(filter.toJSON())}`);

  let subId;
  try {
    subId = client.subscribe(filter, {
      onEvent: (event) => {
        const arrivedAtMs = nowMs();
        const relMs = arrivedAtMs - subscribeAt;
        if (firstEventAt === null) firstEventAt = arrivedAtMs;
        const phase = eoseAt === null ? 'PRE_EOSE' : 'POST_EOSE';
        const senderPrefix = (event.pubkey ?? '').slice(0, 16);
        const createdAt = event.created_at ?? 0;
        const createdRelSec = createdAt - Math.floor(subscribeAt / 1000);
        events.push({
          id: event.id,
          phase,
          arrivalRelMs: relMs,
          createdAtRelSec: createdRelSec,
          senderPubkey: event.pubkey,
          tags: event.tags,
        });
        log(
          `[diag] event #${events.length} [${phase}] t+${relMs}ms ` +
          `created_at_rel=${createdRelSec >= 0 ? '+' : ''}${createdRelSec}s ` +
          `sender=${senderPrefix}... id=${(event.id ?? '').slice(0, 12)}...`
        );
      },
      onEndOfStoredEvents: () => {
        eoseAt = nowMs();
        log(`[diag] EOSE at t+${eoseAt - subscribeAt}ms`);
      },
      onError: (_subId, error) => {
        console.error(`[diag] subscription error: ${error}`);
      },
    });
  } catch (err) {
    console.error(`[diag] FAILED to subscribe: ${err?.message ?? err}`);
    await client.close().catch(() => {});
    process.exit(1);
  }

  // Listen for the full duration even after EOSE — captures any post-EOSE
  // real-time publishes that target this fresh pubkey within the window.
  await new Promise((resolve) => setTimeout(resolve, args.duration * 1000));

  try { client.unsubscribe(subId); } catch { /* ignore */ }
  try { await client.close(); } catch { /* ignore */ }

  // Summary
  const preEose = events.filter((e) => e.phase === 'PRE_EOSE');
  const postEose = events.filter((e) => e.phase === 'POST_EOSE');

  console.log('');
  console.log('=== summary ===');
  console.log(`fresh pubkey:           ${xOnlyHex}`);
  console.log(`relay:                  ${args.relay}`);
  console.log(`listen window:          ${args.duration}s`);
  console.log(`since filter:           ${args.noSince ? 'none' : `${SINCE_FLOOR_SEC}s back`}`);
  console.log(`events pre-EOSE:        ${preEose.length}`);
  console.log(`events post-EOSE:       ${postEose.length}`);
  console.log(`time-to-first-event:    ${firstEventAt === null ? 'n/a' : `${firstEventAt - subscribeAt}ms`}`);
  console.log(`time-to-EOSE:           ${eoseAt === null ? 'n/a (no EOSE in window)' : `${eoseAt - subscribeAt}ms`}`);

  if (preEose.length > 0) {
    console.log('');
    console.log('=== verdict ===');
    console.log(
      `Relay returned ${preEose.length} kind-1059 events for a brand-new pubkey.`
    );
    console.log(
      `Expected: 0. This corroborates sphere-sdk#559 hypothesis (A.1) —`
    );
    console.log(
      `relay-side leakage on the #p filter. Inspect the captured event ids for`
    );
    console.log(
      `correlation patterns (sender concentration, time-of-day, content size).`
    );
  } else {
    console.log('');
    console.log('=== verdict ===');
    console.log(
      `Relay returned 0 kind-1059 events for the fresh pubkey within the`
    );
    console.log(
      `listen window. Hypothesis (A.1) ruled out — the relay's #p index is`
    );
    console.log(
      `clean. Remaining suspects for sphere-sdk#559's "fresh-wallet backlog":`
    );
    console.log(
      `  (A.2) Side-channel publishes — something in the trader-service spawn`
    );
    console.log(
      `        flow, host control plane, or sphere-cli is publishing kind-1059`
    );
    console.log(
      `        events targeting the controller pubkey before the controller's`
    );
    console.log(
      `        first sendDM resolves.`
    );
    console.log(
      `  (A.3) HD-derivation collision — sphere-cli's controller wallet is`
    );
    console.log(
      `        adding more pubkeys to the chat subscription's allPubkeys array`
    );
    console.log(
      `        than the single controller key. Inspect MultiAddressTransportMux`
    );
    console.log(
      `        addresses.size at controller startup.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[diag] unexpected error:', err);
    process.exit(1);
  });
