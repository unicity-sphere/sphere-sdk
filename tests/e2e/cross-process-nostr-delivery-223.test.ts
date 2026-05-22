/**
 * E2E test — Issue #223 (Cross-Process Nostr token transfer).
 *
 * Scenario B (bob OFFLINE during send, then start):
 *   1. Init alice + bob; both publish their nametag bindings.
 *   2. Faucet alice.
 *   3. Destroy bob BEFORE alice sends — bob is provably offline for
 *      the entire send. Bob's nametag binding stays on the relay so
 *      alice can still resolve `@bob`.
 *   4. Alice sends to @bob, waits for alice's `transfer:confirmed`
 *      event — proves the Nostr event is durably on the relay.
 *   5. Reload bob from the same storage + mnemonic. Bob's reload is
 *      the ONLY path for the event to reach the wallet.
 *   6. Assert bob's wallet shows the credited token.
 *
 * Pre-fix this fails because the mux subscribes BEFORE PaymentsModule
 * registers `onTokenTransfer`; the relay-pushed event hits the empty
 * handler Set on `AddressTransportAdapter` and is silently dropped.
 *
 * Skip gates: NO_TESTNET=1 / RUN_UXF_E2E=1 / preflight.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
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
  preflightSkip(['nostr', 'aggregator', 'ipfs', 'faucet'], 'cross-process-nostr-delivery-223');

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

async function waitForPeerResolvable(resolver: Sphere, peerNametag: string, timeoutMs: number): Promise<void> {
  await waitFor(
    async () => (await resolver.resolve(`@${peerNametag}`)) !== null ? true : null,
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
  const dirs = makeTempDirs(`xprocess-${label}`);
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
  const providers = makeProviders({ dataDir: handle.dataDir, tokensDir: handle.tokensDir });
  const { sphere } = await Sphere.init({
    ...providers,
    mnemonic: handle.mnemonic,
  });
  return sphere;
}

async function topUp(handle: WalletHandle, minAmount: bigint, timeoutMs: number): Promise<bigint> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= FAUCET_HTTP_RETRIES; attempt++) {
    const faucet = await requestFaucet(handle.nametag, FAUCET_NAME, 1000);
    if (faucet.success) { lastErr = undefined; break; }
    lastErr = faucet.message;
    if (attempt < FAUCET_HTTP_RETRIES) {
      await new Promise((r) => setTimeout(r, FAUCET_RETRY_DELAY_MS));
    }
  }
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try { await handle.sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
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

// =============================================================================
// Diagnostic: print alice's identity + nametag token + expected vs actual PROXY
// =============================================================================

async function dumpIdentityDiagnostic(label: string, sphere: Sphere, nametag: string): Promise<void> {
  try {
    const id = sphere.identity;
    console.log(`[#223-DIAG ${label}]   identity.nametag=${id?.nametag}`);
    console.log(`[#223-DIAG ${label}]   identity.chainPubkey=${id?.chainPubkey?.slice(0, 16)}…`);
    console.log(`[#223-DIAG ${label}]   identity.directAddress=${id?.directAddress}`);

    const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
    const { TokenId } = await import('@unicitylabs/state-transition-sdk/lib/token/TokenId');

    const expectedTokenId = await TokenId.fromNameTag(nametag);
    const expectedProxy = await ProxyAddress.fromNameTag(nametag);
    console.log(`[#223-DIAG ${label}]   expected TokenId.fromNameTag('${nametag}')=${expectedTokenId.toJSON()}`);
    console.log(`[#223-DIAG ${label}]   expected ProxyAddress.fromNameTag('${nametag}')=${expectedProxy.address}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payments = sphere.payments as any;
    const localNametag = payments.getNametag?.();
    console.log(`[#223-DIAG ${label}]   local payments.getNametag() name=${localNametag?.name}`);
    if (localNametag?.token) {
      const { Token: SdkToken } = await import('@unicitylabs/state-transition-sdk/lib/token/Token');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const localToken = await (SdkToken as any).fromJSON(localNametag.token);
      const localProxy = await ProxyAddress.fromTokenId(localToken.id);
      console.log(`[#223-DIAG ${label}]   local nametagToken.id=${localToken.id.toJSON()}`);
      console.log(`[#223-DIAG ${label}]   local ProxyAddress.fromTokenId(nametagToken.id)=${localProxy.address}`);
      console.log(`[#223-DIAG ${label}]   match? expected==local: ${expectedProxy.address === localProxy.address}`);
    } else {
      console.log(`[#223-DIAG ${label}]   local nametag token is NULL or missing!`);
    }
  } catch (err) {
    console.log(`[#223-DIAG ${label}]   diagnostic failed:`, (err as Error)?.message);
  }
}

// =============================================================================
// Test
// =============================================================================

describe.skipIf(SKIP)('Issue #223 — Cross-process Nostr token delivery (testnet)', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterAll(async () => {
    for (const s of spheres) {
      try { await s.destroy(); } catch { /* cleanup */ }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  });

  it.skipIf(SKIP)(
    'bob offline during send → restart → receive backfills the missed transfer',
    async () => {
      const tag = rand();
      // Nametags MUST be lowercase — the SDK normalizes via
      // `normalizeNametag(...).toLowerCase()` before hashing for both
      // TokenId.fromNameTag and the binding event's proxyAddress field.
      // Faucet computes its own ProxyAddress from the raw string passed
      // in, so any uppercase character produces a SHA-256 mismatch
      // between the two sides ⇒ PROXY address mismatch on finalize.
      const aliceTag = `xp223a${tag}`;
      const bobTag = `xp223b${tag}`;

      const alice = await initWallet('alice', aliceTag);
      const bob = await initWallet('bob', bobTag);
      cleanupDirs.push(alice.baseDir, bob.baseDir);
      spheres.push(alice.sphere);

      console.log(`\n[#223] Alice=@${aliceTag} Bob=@${bobTag}`);

      // Diagnostic BEFORE faucet — confirm alice's local nametag token
      // matches the deterministic ProxyAddress.fromNameTag derivation.
      await dumpIdentityDiagnostic('alice pre-faucet', alice.sphere, aliceTag);

      const aBal = await topUp(alice, 1_000_000n, FAUCET_TOPUP_MS);
      console.log(`[#223] Alice funded: ${aBal} ${SYMBOL}`);

      await waitForPeerResolvable(alice.sphere, bobTag, PEER_RESOLVE_MS);

      // Destroy bob FIRST — bob provably offline during send.
      await bob.sphere.destroy();
      console.log(`[#223] bob destroyed (offline for entire send)`);

      // Diagnostic on bob's identity from the local handle (don't touch
      // the destroyed sphere).
      console.log(`[#223] bob expected nametag=${bobTag}`);

      const aliceConfirmedSeen: string[] = [];
      const aliceFailedSeen: string[] = [];
      const offConfirm = alice.sphere.on('transfer:confirmed', (r) => { aliceConfirmedSeen.push(r.id); });
      const offFailed = alice.sphere.on('transfer:failed', (r) => { aliceFailedSeen.push(r.id); });

      const sendResult = await alice.sphere.payments.send({
        recipient: `@${bobTag}`,
        coinId: resolveCoinId(alice.sphere, SYMBOL),
        amount: SEND_AMOUNT_RAW,
        memo: 'issue-223 test',
      });
      console.log(`[#223] alice.send() → status=${sendResult.status} id=${sendResult.id}`);
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
      console.log(`[#223] alice transfer:confirmed — event is on the relay`);
      try { offConfirm(); } catch { /* ignore */ }
      try { offFailed(); } catch { /* ignore */ }

      await new Promise((r) => setTimeout(r, POST_SEND_QUIET_MS));

      // Reload bob — cross-process boundary.
      const bobReloaded = await reloadWallet(bob);
      spheres.push(bobReloaded);
      console.log(`[#223] bob re-opened (simulated new process)`);

      // Diagnostic AFTER bob reload — confirm bob's local nametag matches.
      await dumpIdentityDiagnostic('bob post-reload', bobReloaded, bobTag);

      const start = performance.now();
      let bal = { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
      while (performance.now() - start < RECEIVE_FINALIZE_MS) {
        try {
          await bobReloaded.payments.receive({ finalize: true });
        } catch (err) {
          console.log(`[#223] bob receive() threw: ${(err as Error)?.message}`);
        }
        bal = getBalance(bobReloaded, SYMBOL);
        console.log(
          `[#223] bob poll: confirmed=${bal.confirmed} unconfirmed=${bal.unconfirmed} total=${bal.total} tokens=${bal.tokens}`,
        );
        if (bal.total >= SEND_AMOUNT) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      console.log(`[#223] bob final: confirmed=${bal.confirmed} unconfirmed=${bal.unconfirmed} total=${bal.total} tokens=${bal.tokens}`);
      expect(bal.total).toBeGreaterThanOrEqual(SEND_AMOUNT);
    },
    900_000,
  );
});
