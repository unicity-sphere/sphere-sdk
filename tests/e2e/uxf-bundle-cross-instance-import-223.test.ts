/**
 * Issue #223 — UXF processing isolation experiment.
 *
 * **Hypothesis to test:** the cross-process repro fails because the
 * UXF receive pipeline on a freshly-loaded Sphere drops the bundle —
 * NOT because of transport-layer (Nostr / Mux) weirdness.
 *
 * **Method:** get a TXF from the faucet, hand it to `payments.send`
 * (which converts TXF → UXF bundle for delivery), capture the wire
 * payload, then re-import that exact bundle into ANOTHER Sphere
 * instance of the SAME recipient profile — but with the recipient's
 * Nostr transport DISCONNECTED so the only possible delivery path is
 * our manual injection.
 *
 * This isolates UXF bundle processing on a freshly-loaded Sphere from
 * the entire transport layer. The capture-and-inject sequence:
 *
 *   1. Init Alice + Bob (live testnet). Both publish nametag bindings.
 *   2. Faucet Alice — alice now owns a TXF-format token.
 *   3. Destroy Bob #1 BEFORE Alice sends (mirrors the cross-process
 *      repro: receiver offline during send).
 *   4. Hook Alice's transport with `captureSentPayloads()` to grab
 *      the EXACT `TokenTransferPayload` (kind, bundleCid, carBase64,
 *      tokenIds, …) — this IS the UXF bundle that `payments.send`
 *      produced from alice's faucet-delivered TXF.
 *   5. Alice sends to @bob. The relay receives the event AND we
 *      have the payload in process memory.
 *   6. Reload Bob from the SAME profile (same storage, same mnemonic
 *      — "another instance of the same profile").
 *   7. **Disable Bob #2's Nostr subscription** by calling
 *      `bob2._transportMux.disconnect()`. The relay still has the
 *      event but Bob #2 cannot pull it down via the live sub or
 *      `fetchPendingEvents`. The Mux adapter (per-address) remains
 *      addressable in memory.
 *   8. **Bypass Nostr/Mux entirely**: build a synthetic
 *      `IncomingTokenTransfer` from the captured payload + Alice's
 *      transport pubkey, then call
 *      `bob2._transportMux.getAdapter(0).dispatchTokenTransfer(...)`.
 *      This drives the EXACT same `PaymentsModule.handleIncoming-
 *      Transfer` path that a real Nostr arrival would walk.
 *   9. Poll Bob #2's balance. If the token arrives → UXF processing
 *      on a freshly-loaded Sphere works for THIS wire shape; the
 *      cross-process bug must be in transport. If it doesn't → the
 *      bug is in UXF processing; the logged wire kind tells us
 *      whether the offending branch is `uxf-car` (inline) or
 *      `uxf-cid` (CID-by-reference).
 *
 * The captured payload's `kind` field is loud-logged so the test
 * output PROVES the inline-vs-CID branch without needing to rerun.
 *
 * Skip gates: NO_TESTNET=1 / RUN_UXF_E2E=1 / preflight.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

import { Sphere } from '../../core/Sphere';
import type {
  IncomingTokenTransfer,
  TokenTransferPayload,
} from '../../transport/transport-provider';
import type { MultiAddressTransportMux, AddressTransportAdapter } from '../../transport/MultiAddressTransportMux';
import {
  ensureTrustbase,
  getBalance,
  makeProviders,
  makeTempDirs,
  rand,
  requestFaucet,
  POLL_INTERVAL_MS,
} from './helpers';
import { preflightSkip } from './lib/preflight';

const SKIP =
  process.env.NO_TESTNET === '1' ||
  process.env.RUN_UXF_E2E !== '1' ||
  preflightSkip(
    ['nostr', 'aggregator', 'ipfs', 'faucet'],
    'uxf-bundle-cross-instance-import-223',
  );

// =============================================================================
// Constants
// =============================================================================

const FAUCET_TOPUP_MS = 240_000;
const FAUCET_HTTP_RETRIES = 3;
const FAUCET_RETRY_DELAY_MS = 5_000;
const PEER_RESOLVE_MS = 240_000;
const SEND_CONFIRM_MS = 120_000;
const RECEIVE_FINALIZE_MS = 180_000;
const POST_SEND_QUIET_MS = 5_000;

const SYMBOL = 'USDU' as const;
const FAUCET_NAME = 'unicity-usd' as const;
const SEND_AMOUNT_RAW = '500000';
const SEND_AMOUNT = BigInt(SEND_AMOUNT_RAW);

// =============================================================================
// Helpers
// =============================================================================

async function waitFor<T>(
  predicate: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (msg.startsWith('transfer:failed')) throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function waitForPeerResolvable(
  resolver: Sphere,
  peerNametag: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () =>
      (await resolver.resolve(`@${peerNametag}`)) !== null ? true : null,
    timeoutMs,
    `peer @${peerNametag} to be resolvable`,
  );
}

interface WalletHandle {
  sphere: Sphere;
  baseDir: string;
  dataDir: string;
  tokensDir: string;
  mnemonic: string;
  nametag: string;
}

async function initWallet(label: string, nametag: string): Promise<WalletHandle> {
  const dirs = makeTempDirs(`xinst-${label}`);
  await ensureTrustbase(dirs.dataDir);
  const providers = makeProviders(dirs);
  const { sphere, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
  });
  if (!generatedMnemonic) {
    throw new Error(`Wallet ${label} should be created with a fresh mnemonic`);
  }
  return {
    sphere,
    baseDir: dirs.base,
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    mnemonic: generatedMnemonic,
    nametag,
  };
}

async function reloadWallet(handle: WalletHandle): Promise<Sphere> {
  await ensureTrustbase(handle.dataDir);
  const providers = makeProviders({
    dataDir: handle.dataDir,
    tokensDir: handle.tokensDir,
  });
  const { sphere } = await Sphere.init({
    ...providers,
    mnemonic: handle.mnemonic,
  });
  return sphere;
}

async function topUp(
  handle: WalletHandle,
  minAmount: bigint,
  timeoutMs: number,
): Promise<bigint> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= FAUCET_HTTP_RETRIES; attempt++) {
    const faucet = await requestFaucet(handle.nametag, FAUCET_NAME, 1000);
    if (faucet.success) {
      lastErr = undefined;
      break;
    }
    lastErr = faucet.message;
    if (attempt < FAUCET_HTTP_RETRIES) {
      await new Promise((r) => setTimeout(r, FAUCET_RETRY_DELAY_MS));
    }
  }
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      await handle.sphere.payments.receive({ finalize: true });
    } catch {
      /* keep polling */
    }
    const bal = getBalance(handle.sphere, SYMBOL);
    if (bal.confirmed >= minAmount) return bal.confirmed;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Faucet top-up timed out (${(timeoutMs / 1000).toFixed(0)}s)` +
      (lastErr ? `: ${lastErr}` : ''),
  );
}

function resolveCoinId(sphere: Sphere, symbol: string): string {
  const assets = sphere.payments.getBalance();
  const a = assets.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`No asset for symbol ${symbol}`);
  return a.coinId;
}

/**
 * Wrap a Sphere's per-address transport adapter's `sendTokenTransfer` so
 * we capture the exact wire payload (kind, bundleCid, carBase64 OR cid,
 * sender, tokenIds, ...). Returns an unwrap closure to restore the
 * original send.
 */
function captureSentPayloads(sphere: Sphere): {
  captured: Array<{ recipient: string; payload: TokenTransferPayload }>;
  unwrap: () => void;
} {
  const sphereAny = sphere as unknown as {
    _transportMux: {
      getAdapter: (idx: number) => {
        sendTokenTransfer: (r: string, p: TokenTransferPayload) => Promise<string>;
      } | undefined;
    } | null;
    _currentAddressIndex: number;
    _transport: {
      sendTokenTransfer: (r: string, p: TokenTransferPayload) => Promise<string>;
    };
  };
  const addrIndex = sphereAny._currentAddressIndex ?? 0;
  const transport =
    sphereAny._transportMux?.getAdapter(addrIndex) ?? sphereAny._transport;
  const original = transport.sendTokenTransfer.bind(transport);
  const captured: Array<{ recipient: string; payload: TokenTransferPayload }> = [];
  transport.sendTokenTransfer = async (
    recipient: string,
    payload: TokenTransferPayload,
  ) => {
    const kind = (payload as unknown as Record<string, unknown>).kind;
    console.log(`[#223-iso] captured wire payload kind=${String(kind)}`);
    captured.push({ recipient, payload });
    return original(recipient, payload);
  };
  return {
    captured,
    unwrap: () => {
      transport.sendTokenTransfer = original;
    },
  };
}

/**
 * Reach into Bob's reloaded Sphere and call the per-address adapter's
 * `dispatchTokenTransfer` directly. This is the EXACT call site the Mux
 * uses on a real `EVENT` arrival (see `MultiAddressTransportMux.ts:1179`).
 * Injection bypasses Nostr decryption + relay subscription entirely
 * while still walking the production `handleIncomingTransfer` pipeline.
 */
function injectTokenTransfer(sphere: Sphere, transfer: IncomingTokenTransfer): void {
  const sphereAny = sphere as unknown as {
    _transportMux: MultiAddressTransportMux | null;
    _currentAddressIndex: number;
  };
  const idx = sphereAny._currentAddressIndex ?? 0;
  const adapter: AddressTransportAdapter | undefined =
    sphereAny._transportMux?.getAdapter(idx);
  if (!adapter) {
    throw new Error('Bob #2 has no Mux adapter — cannot inject token transfer');
  }
  adapter.dispatchTokenTransfer(transfer);
}

// =============================================================================
// Test
// =============================================================================

describe.skipIf(SKIP)(
  'Issue #223 isolation — export UXF bundle from one Sphere, import into another instance of same profile',
  () => {
    const cleanupDirs: string[] = [];
    const spheres: Sphere[] = [];

    afterAll(async () => {
      for (const s of spheres) {
        try {
          await s.destroy();
        } catch {
          /* cleanup */
        }
      }
      spheres.length = 0;
      for (const d of cleanupDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* cleanup */
        }
      }
      cleanupDirs.length = 0;
    });

    it.skipIf(SKIP)(
      'alice → bob: capture wire payload, destroy bob, reload bob (same profile), inject payload → assert token arrives',
      async () => {
        const tag = rand();
        // Nametags must be lowercase + no spaces (SDK normalizes via
        // toLowerCase before hashing; faucet computes ProxyAddress from
        // the raw string).
        const aliceTag = `xpiso a${tag}`.replace(/\s/g, '');
        const bobTag = `xpiso b${tag}`.replace(/\s/g, '');

        const alice = await initWallet('alice', aliceTag);
        const bob = await initWallet('bob', bobTag);
        cleanupDirs.push(alice.baseDir, bob.baseDir);
        spheres.push(alice.sphere);

        console.log(`\n[#223-iso] Alice=@${aliceTag} Bob=@${bobTag}`);

        const aBal = await topUp(alice, 1_000_000n, FAUCET_TOPUP_MS);
        console.log(`[#223-iso] Alice funded: ${aBal} ${SYMBOL}`);

        await waitForPeerResolvable(alice.sphere, bobTag, PEER_RESOLVE_MS);

        // Destroy Bob #1 BEFORE Alice sends. Bob's nametag binding stays
        // on the relay so Alice can still resolve @bob.
        await bob.sphere.destroy();
        console.log(`[#223-iso] bob #1 destroyed (offline for entire send)`);

        // Hook alice's wire-send so we grab the exact UXF payload.
        const aliceConfirmedSeen: string[] = [];
        const aliceFailedSeen: string[] = [];
        const offConfirm = alice.sphere.on('transfer:confirmed', (r) => {
          aliceConfirmedSeen.push(r.id);
        });
        const offFailed = alice.sphere.on('transfer:failed', (r) => {
          aliceFailedSeen.push(r.id);
        });

        const captureHook = captureSentPayloads(alice.sphere);

        // Conservative mode: alice submits the commitment to the
        // aggregator and waits for the inclusion proof BEFORE shipping
        // the bundle. The wire payload then carries a fully-finalized
        // last transaction (inclusionProof != null) so the receiver's
        // processToken enters the `2a` finalize-from-proof branch
        // (PaymentsModule.ts:2530) — token credited as `'confirmed'`
        // synchronously, NO recipient-side aggregator round-trip
        // needed. This isolates the test from any recipient-side
        // finalization-worker dependencies.
        const sendResult = await alice.sphere.payments.send({
          recipient: `@${bobTag}`,
          coinId: resolveCoinId(alice.sphere, SYMBOL),
          amount: SEND_AMOUNT_RAW,
          memo: 'issue-223 isolation test',
          transferMode: 'conservative',
        });
        console.log(
          `[#223-iso] alice.send() → status=${sendResult.status} id=${sendResult.id}`,
        );
        expect(sendResult.status).not.toBe('failed');

        await waitFor(
          () => {
            if (aliceFailedSeen.includes(sendResult.id)) {
              throw new Error(`transfer:failed for ${sendResult.id}`);
            }
            return aliceConfirmedSeen.includes(sendResult.id) ? true : null;
          },
          SEND_CONFIRM_MS,
          `transfer:confirmed for ${sendResult.id}`,
        );
        console.log(`[#223-iso] alice transfer:confirmed`);

        captureHook.unwrap();
        try { offConfirm(); } catch { /* ignore */ }
        try { offFailed(); } catch { /* ignore */ }

        expect(captureHook.captured.length).toBeGreaterThan(0);
        const wire = captureHook.captured[0]!;
        const wireKind = (wire.payload as unknown as { kind?: string }).kind;
        console.log(
          `[#223-iso] CAPTURED PAYLOAD: kind=${String(wireKind)}, ` +
          `tokenIds.length=${
            ((wire.payload as unknown as { tokenIds?: unknown[] }).tokenIds ?? []).length
          }`,
        );

        await new Promise((r) => setTimeout(r, POST_SEND_QUIET_MS));

        // Reload Bob from the SAME profile. This is "another instance"
        // of the same profile — same storage, same mnemonic, same
        // identity, fresh in-memory Sphere.
        const bobReloaded = await reloadWallet(bob);
        spheres.push(bobReloaded);
        console.log(`[#223-iso] bob #2 reloaded (same profile, fresh instance)`);

        // ---- Disconnect Bob #2's Mux subscription so the live Nostr
        //      subscription cannot deliver the event. The Mux instance
        //      stays accessible in memory (the per-address adapter map
        //      survives `disconnect()` — only the relay socket and the
        //      walletSubscriptionId are torn down). This guarantees the
        //      ONLY path that can deliver the bundle to Bob #2 is our
        //      manual injection below.
        const bobMux = (bobReloaded as unknown as {
          _transportMux: MultiAddressTransportMux | null;
        })._transportMux;
        if (bobMux !== null) {
          try {
            await bobMux.disconnect();
            console.log(`[#223-iso] bob #2 Mux disconnected (Nostr live sub disabled)`);
          } catch (err) {
            console.log(
              `[#223-iso] bob #2 Mux disconnect threw: ${(err as Error)?.message}`,
            );
          }
        }

        // Build a synthetic IncomingTokenTransfer from the captured wire
        // payload + Alice's transport pubkey. The Mux normally produces
        // this shape inside `handleTokenTransfer` after decrypting the
        // Nostr event (transport/MultiAddressTransportMux.ts:1172).
        // `senderTransportPubkey` = 32-byte x-only Nostr pubkey =
        // chain pubkey (33 bytes compressed) with the leading `02`/`03`
        // hex byte stripped (Sphere.ts:3333 shows this derivation).
        const aliceTransportPubkey = alice.sphere.identity!.chainPubkey.slice(2);
        const synthetic: IncomingTokenTransfer = {
          id: `synthetic-${tag}-${Date.now()}`,
          senderTransportPubkey: aliceTransportPubkey,
          payload: wire.payload,
          timestamp: Date.now(),
        };
        console.log(
          `[#223-iso] injecting synthetic event into bob #2 mux adapter — ` +
          `sender=${aliceTransportPubkey.slice(0, 16)}…`,
        );
        injectTokenTransfer(bobReloaded, synthetic);

        // Poll Bob #2 balance. `dispatchTokenTransfer` invokes the
        // registered handler (PaymentsModule.handleIncomingTransfer)
        // which routes to ingestPool.enqueue → worker processes the
        // bundle → tokens added to local storage + in-memory map. The
        // dispatch is fire-and-forget at the call site; we poll until
        // either the token shows up or we time out.
        //
        // We do NOT call `receive()` in the poll loop — that would
        // invoke `transport.fetchPendingEvents()` on the
        // now-disconnected Mux. The conservative-path bundle (proof
        // present at receive time) lands as `'confirmed'` directly via
        // ingestPool.processToken (see PaymentsModule.ts:2530), so no
        // finalize cycle is needed.
        const start = performance.now();
        let bal = { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
        while (performance.now() - start < RECEIVE_FINALIZE_MS) {
          bal = getBalance(bobReloaded, SYMBOL);
          console.log(
            `[#223-iso] bob #2 poll: confirmed=${bal.confirmed} ` +
            `unconfirmed=${bal.unconfirmed} total=${bal.total} ` +
            `tokens=${bal.tokens}`,
          );
          if (bal.total >= SEND_AMOUNT) break;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        console.log(
          `[#223-iso] bob #2 FINAL: confirmed=${bal.confirmed} ` +
          `unconfirmed=${bal.unconfirmed} total=${bal.total} ` +
          `tokens=${bal.tokens}, wire kind was ${String(wireKind)}`,
        );

        // The interesting bit is BOTH the assertion AND the printed kind.
        // If this fails, the kind tells us whether the gap is uxf-car or
        // uxf-cid; either is a real bug on the recipient side. If it
        // passes, the bug is in the transport layer (Nostr / Mux), not
        // in UXF processing on a freshly-loaded Sphere.
        expect(bal.total).toBeGreaterThanOrEqual(SEND_AMOUNT);
      },
      900_000,
    );
  },
);
