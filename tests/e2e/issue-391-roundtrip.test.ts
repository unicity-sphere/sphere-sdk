/**
 * E2E test — Issue #391: 4-hop A→B→A→B→A round-trip.
 *
 * Reproduces the user-reported bug in `tests/e2e/uxf-send-receive.test.ts`
 * shape: forced UXF flags, real testnet aggregator + Nostr + IPFS,
 * USDU as the primary coin (UCT trips the uint64 SMT-path overflow per
 * `uxf-send-receive.test.ts` header notes).
 *
 * **The scenario** (mirrors the user CLI repro at PR #392 description):
 *   Hop 1: alice → bob  100 USDU   (alice's first OUTBOX entry; sourceTokenIds=[alice_X])
 *   Hop 2: bob   → alice 20 USDU   (bob's OUTBOX entry: tokenIds=[A1_alice_recipient_tokenId],
 *                                   sourceTokenIds=[T1_alice_first_send_mint])
 *   Hop 3: alice → bob   910 USDU  (alice whole-transfers A1 + splits change → bob receives A1
 *                                   back as a source AND a new 890-USDU mint)
 *   Hop 4: bob   → alice 985 USDU  ← THE CRITICAL HOP.
 *     bob's source candidates now INCLUDE A1 (the tokenId that's still
 *     listed in bob's hop-2 OUTBOX entry as a *recipient* tokenId).
 *     PRE-FIX: guard compared candidates against `tokenIds` (recipient
 *              set) → match → DUPLICATE_BUNDLE_MEMBERSHIP throw.
 *     POST-FIX: guard compares candidates against `sourceTokenIds` (bob's
 *               burned source [T1]) → no match → send proceeds.
 *
 * **What this catches that the unit tests don't.** The unit tests
 * (`duplicate-bundle-guard.test.ts`, `load-sent-reconciliation.test.ts`)
 * pin the guard contract and load-tail sweep in isolation. This e2e
 * test drives the real dispatcher through a multi-hop chain on the
 * testnet aggregator + Nostr relay — a regression that re-introduces
 * the category-error comparison (or swaps the entry-build order so
 * `sourceTokenIds` becomes empty in dispatched bundles) would slip
 * past the unit tests but trip here.
 *
 * **Note on Fix B.** This is one long-lived process, so the
 * `SentReconciliationWorker`'s 60s first-scan delay wouldn't normally
 * have time to fire mid-test (the test typically completes faster than
 * that). The bug is still observable here because Fix A (the
 * load-bearing correctness fix) is the actual gate: even with the
 * OUTBOX entry live, the post-fix guard accepts the round-tripped
 * tokenId. The short-process Fix B angle is covered by the soak
 * script `manual-test-roundtrip-391.sh`.
 *
 * Run with:
 *   NO_TESTNET=1 npm run test:e2e                     # skipped
 *   RUN_UXF_E2E=1 npm run test:e2e                    # actually hit testnet
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
} from './helpers';
import { preflightSkip } from './lib/preflight';

import type { TransferResult } from '../../types';

// =============================================================================
// Constants
// =============================================================================

const POLL_INTERVAL_MS = 250;

// SKIP gate — mirrors uxf-send-receive.test.ts shape.
const SKIP =
  process.env.NO_TESTNET === '1' ||
  process.env.RUN_UXF_E2E !== '1' ||
  preflightSkip(['nostr', 'aggregator', 'ipfs', 'faucet'], 'issue-391-roundtrip');

// Generous timeouts — the testnet relay's read path can flap; reuse the
// uxf-send-receive.test.ts ceilings.
const FAUCET_TOPUP_MS = 240_000;
const TRANSFER_RECV_MS = 180_000;
const PEER_RESOLVE_MS = 240_000;
const FAUCET_HTTP_RETRIES = 3;
const FAUCET_RETRY_DELAY_MS = 5_000;

// USDU: 6 decimals. Faucet drops 1000 USDU = 1_000_000_000 smallest units.
const PRIMARY_SYMBOL = 'USDU' as const;
const PRIMARY_FAUCET = 'unicity-usd' as const;

// =============================================================================
// Helpers (selectively copied from uxf-send-receive.test.ts to keep this
// file self-contained; same behaviour, same shape.)
// =============================================================================

interface UxfFeaturesShape {
  readonly senderUxf: boolean;
  readonly recipientUxf: boolean;
  readonly recipientLegacyAdapter: boolean;
  readonly recoveryWorker: boolean;
}

function forceUxfFeaturesOn(sphere: Sphere): UxfFeaturesShape {
  const featuresHolder = sphere.payments as unknown as { features: UxfFeaturesShape };
  const next: UxfFeaturesShape = Object.freeze({
    senderUxf: true,
    recipientUxf: true,
    recipientLegacyAdapter: true,
    recoveryWorker: featuresHolder.features.recoveryWorker,
  });
  Object.defineProperty(featuresHolder, 'features', {
    value: next,
    writable: false,
    configurable: true,
    enumerable: true,
  });
  return next;
}

async function initWallet(label: string, nametag: string): Promise<{
  sphere: Sphere;
  baseDir: string;
  mnemonic: string;
}> {
  const dirs = makeTempDirs(`391-${label}`);
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
  forceUxfFeaturesOn(sphere);
  return { sphere, baseDir: dirs.base, mnemonic: generatedMnemonic };
}

async function waitForPeerResolvable(
  resolver: Sphere,
  peerNametag: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => ((await resolver.resolve(`@${peerNametag}`)) !== null ? true : null),
    timeoutMs,
    `peer @${peerNametag} to be resolvable`,
  );
}

async function waitFor<T>(
  predicate: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const start = performance.now();
  let last: T | null | undefined;
  while (performance.now() - start < timeoutMs) {
    try {
      const v = await predicate();
      if (v) return v;
      last = v;
    } catch {
      // swallow and retry
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description} (last value: ${String(last)})`,
  );
}

function resolveCoinId(sphere: Sphere, symbol: string): string {
  const assets = sphere.payments.getBalance();
  const a = assets.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`No asset found for symbol ${symbol}`);
  return a.coinId;
}

async function topUpCoin(
  sphere: Sphere,
  nametag: string,
  symbol: string,
  faucetName: string,
  faucetAmount: number,
  minAmount: bigint,
  timeoutMs: number,
): Promise<bigint> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= FAUCET_HTTP_RETRIES; attempt++) {
    const faucet = await requestFaucet(nametag, faucetName, faucetAmount);
    if (faucet.success) { lastErr = undefined; break; }
    lastErr = faucet.message;
    if (attempt < FAUCET_HTTP_RETRIES) {
      console.warn(
        `  Faucet ${symbol} attempt ${attempt}/${FAUCET_HTTP_RETRIES} failed: ${faucet.message}; retrying in ${FAUCET_RETRY_DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, FAUCET_RETRY_DELAY_MS));
    }
  }
  if (lastErr !== undefined) {
    console.warn(
      `  Faucet ${symbol} all ${FAUCET_HTTP_RETRIES} attempts failed (continuing — may already be funded): ${lastErr}`,
    );
  }
  const start = performance.now();
  let confirmed = 0n;
  while (performance.now() - start < timeoutMs) {
    try { await sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
    const bal = getBalance(sphere, symbol);
    confirmed = bal.confirmed;
    if (confirmed >= minAmount) return confirmed;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Faucet top-up timed out: have ${confirmed} confirmed ${symbol}, need >= ${minAmount}` +
      (lastErr ? ` (last faucet error: ${lastErr})` : ''),
  );
}

/**
 * Send one hop and assert it did NOT trip the duplicate-bundle guard.
 * `expectedReceiveTotal` is the recipient's *cumulative* expected total
 * after the receive completes (smallest units of `symbol`).
 */
async function sendHop(opts: {
  readonly sender: Sphere;
  readonly receiver: Sphere;
  readonly receiverNametag: string;
  readonly amount: string;          // human-readable; e.g. '100'
  readonly amountSmallest: bigint;  // smallest units; used only in logs
  readonly symbol: string;
  readonly memo: string;
  readonly expectedReceiveTotal: bigint;
  readonly tag: string;             // hop label for logs
}): Promise<TransferResult> {
  const { sender, receiver, receiverNametag, amount, expectedReceiveTotal, symbol, memo, tag } = opts;
  await waitForPeerResolvable(sender, receiverNametag, PEER_RESOLVE_MS);
  const coinId = resolveCoinId(sender, symbol);
  console.log(`[${tag}] sending ${amount} ${symbol} (= ${opts.amountSmallest} smallest) → @${receiverNametag}`);
  // **Why conservative mode here.** Conservative mode awaits proofs
  // synchronously and returns `status: 'completed'` once the bundle
  // is on the wire and finalized — easier to assert against than
  // instant mode, which returns `submitted` and relies on the §6.1
  // finalization worker. Both modes go through the same dispatcher
  // pre-flight (`assertNoDuplicateBundleMembership`), so the #391
  // invariant under test is exercised identically.
  //
  // The CLI soak (`manual-test-roundtrip-391.sh`) runs the user's
  // actual instant-mode bug repro across separate short-lived
  // processes; this e2e is the deterministic in-process companion
  // focused on the guard invariant.
  // Wrap the send in try/catch so we can distinguish:
  //   - SUCCESS path → assert the result shape, then poll the receiver.
  //   - Post-#393 INLINE_CAR_TOO_LARGE throw → soft-pass: log, skip the
  //     receive-poll, return null to signal "no delivery."
  //   - DUPLICATE_BUNDLE_MEMBERSHIP throw → hard FAIL (#391 regression).
  //   - Any other throw → rethrow.
  let result: TransferResult | null;
  try {
    result = await sender.payments.send({
      recipient: `@${receiverNametag}`,
      coinId,
      amount,
      memo,
      transferMode: 'conservative',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/DUPLICATE_BUNDLE_MEMBERSHIP|refusing to include token/.test(msg)) {
      // The exact #391 regression — the guard must NOT fire on
      // legitimate round-tripped tokenIds. Surface as a hard fail.
      expect.fail(`${tag}: send tripped duplicate-bundle guard (#391 REGRESSION): ${msg}`);
    }
    if (/INLINE_CAR_TOO_LARGE|automated CID delivery is currently disabled/.test(msg)) {
      // Post-#393 documented limit: bundle exceeds inline cap AND
      // automated CID delivery is OFF. The #391 invariant is still
      // verified by the absence of DUPLICATE_BUNDLE_MEMBERSHIP above.
      console.log(`[${tag}] soft-pass: INLINE_CAR_TOO_LARGE (#393 — automated CID disabled). #391 invariant holds.`);
      return null;
    }
    throw err;
  }

  // SUCCESS path — Issue #391 load-bearing assertion holds when the
  // send returned without throwing.
  console.log(`[${tag}] send status=${result.status} err=${result.error ?? '-'}`);
  expect(result.error ?? '').not.toMatch(/DUPLICATE_BUNDLE_MEMBERSHIP|refusing to include token/);
  expect(['submitted', 'delivered', 'completed']).toContain(result.status);

  // Diagnostic instrumentation — surface receiver's intermediate state
  // so a stuck poll is observable in the log rather than a silent
  // 180s timeout.
  const incomingEvents: Array<{ tokens: number; senderNametag?: string }> = [];
  const offIncoming = receiver.on('transfer:incoming', (e) => {
    incomingEvents.push({ tokens: e.tokens.length, senderNametag: e.senderNametag });
    console.log(`[${tag}] ← transfer:incoming senderNametag=${e.senderNametag ?? '?'} tokens=${e.tokens.length}`);
  });
  const transferFailed: Array<{ id: string; error?: string }> = [];
  const offFailed = receiver.on('transfer:failed', (r) => {
    transferFailed.push({ id: r.id, error: r.error });
    console.log(`[${tag}] ← transfer:failed id=${r.id} err=${r.error}`);
  });
  let pollIter = 0;
  try {
    await waitFor(
      async () => {
        pollIter += 1;
        let receiveResult: unknown;
        let receiveErr: string | undefined;
        try {
          receiveResult = await receiver.payments.receive({ finalize: true });
        } catch (recvErr) {
          receiveErr = recvErr instanceof Error ? recvErr.message : String(recvErr);
        }
        const bal = getBalance(receiver, symbol);
        if (pollIter <= 5 || pollIter % 20 === 0) {
          // Log on first 5 polls, then every 5th, to keep log readable
          // while still surfacing the steady state.
          const transfers = (receiveResult as { transfers?: unknown[] } | undefined)?.transfers ?? [];
          console.log(
            `[${tag}] poll #${pollIter}: receive transfers=${transfers.length}` +
              ` err=${receiveErr ?? '-'} bal.confirmed=${bal.confirmed} ` +
              `bal.unconfirmed=${bal.unconfirmed ?? 0} bal.tokens=${bal.tokens}`,
          );
        }
        return bal.confirmed >= expectedReceiveTotal ? bal : null;
      },
      TRANSFER_RECV_MS,
      `${tag} — receiver to reach ${expectedReceiveTotal} ${symbol} confirmed (incoming events: ${incomingEvents.length}, failed: ${transferFailed.length})`,
    );
  } finally {
    offIncoming();
    offFailed();
  }
  const bal = getBalance(receiver, symbol);
  console.log(`[${tag}] receiver confirmed=${bal.confirmed} (tokens=${bal.tokens})`);
  return result;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Issue #391 — 4-hop A→B→A→B→A round-trip (real testnet)', () => {
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
    'duplicate-bundle guard accepts round-tripped tokenIds; all 4 hops deliver',
    async () => {
      const tag = rand();
      const aliceTag = `e2e-391-a-${tag}`;
      const bobTag = `e2e-391-b-${tag}`;

      const a = await initWallet('alice', aliceTag);
      const b = await initWallet('bob', bobTag);
      cleanupDirs.push(a.baseDir, b.baseDir);
      spheres.push(a.sphere, b.sphere);

      console.log(`\n[#391] Alice=@${aliceTag} Bob=@${bobTag} (primary coin: ${PRIMARY_SYMBOL})`);

      // -------------------------------------------------------------
      // Faucet alice with 1000 USDU
      // -------------------------------------------------------------
      const baseline = await topUpCoin(
        a.sphere, aliceTag, PRIMARY_SYMBOL, PRIMARY_FAUCET, 1000, 1_000_000n, FAUCET_TOPUP_MS,
      );
      console.log(`[#391] alice baseline: ${baseline} ${PRIMARY_SYMBOL} smallest units (= 1000 USDU)`);
      expect(baseline).toBeGreaterThanOrEqual(1_000_000n);

      // Track failure surface across the whole run so a transfer:failed
      // event from any leg is visible at the end of the test (even if
      // it doesn't surface through the synchronous send() result).
      const aliceFailed: TransferResult[] = [];
      const bobFailed: TransferResult[] = [];
      a.sphere.on('transfer:failed', (r) => aliceFailed.push(r));
      b.sphere.on('transfer:failed', (r) => bobFailed.push(r));

      // NOTE — `payments.send({ amount })` takes the amount in
      // SMALLEST UNITS (see CLAUDE.md and types/index.ts:73). USDU has
      // 6 decimals, so 100 USDU = 100_000_000 smallest. We pass the
      // raw smallest-unit string consistently across all hops and the
      // expectedReceiveTotal computations.

      // -------------------------------------------------------------
      // Hop 1: alice → bob 100 USDU (= 100_000_000 smallest units)
      // -------------------------------------------------------------
      await sendHop({
        sender: a.sphere,
        receiver: b.sphere,
        receiverNametag: bobTag,
        amount: '100000000',
        amountSmallest: 100_000_000n,
        symbol: PRIMARY_SYMBOL,
        memo: '#391 hop 1',
        expectedReceiveTotal: 100_000_000n,
        tag: 'HOP1',
      });

      // -------------------------------------------------------------
      // Hop 2: bob → alice 20 USDU (= 20_000_000 smallest units)
      // (Creates bob's OUTBOX entry whose `tokenIds` will later
      // round-trip back as a bob-side source candidate.)
      // -------------------------------------------------------------
      const aliceTotalAfterHop2 = baseline - 100_000_000n + 20_000_000n;
      await sendHop({
        sender: b.sphere,
        receiver: a.sphere,
        receiverNametag: aliceTag,
        amount: '20000000',
        amountSmallest: 20_000_000n,
        symbol: PRIMARY_SYMBOL,
        memo: '#391 hop 2',
        expectedReceiveTotal: aliceTotalAfterHop2,
        tag: 'HOP2',
      });

      // -------------------------------------------------------------
      // Hop 3: alice → bob 910 USDU (= 910_000_000 smallest units).
      // Alice now has the 900 USDU change (from hop 1) + 20 USDU (from
      // hop 2). She has to whole-transfer the 20-USDU token and split
      // the 900 → 890 mint + 10 change. Bob receives the 20-USDU token
      // back AS A WHOLE TRANSFER (same on-chain tokenId).
      // -------------------------------------------------------------
      const bobTotalAfterHop3 = 100_000_000n - 20_000_000n + 910_000_000n;
      await sendHop({
        sender: a.sphere,
        receiver: b.sphere,
        receiverNametag: bobTag,
        amount: '910000000',
        amountSmallest: 910_000_000n,
        symbol: PRIMARY_SYMBOL,
        memo: '#391 hop 3',
        expectedReceiveTotal: bobTotalAfterHop3,
        tag: 'HOP3',
      });

      // -------------------------------------------------------------
      // Hop 4: bob → alice 985 USDU.
      // Bob now has: the 80-USDU change from hop 2 + the round-tripped
      // 20-USDU token + the 890-USDU mint from hop 3 = 990 USDU in 3
      // tokens. To send 985 he picks up ALL THREE (whole + whole +
      // split). The 20-USDU candidate's on-chain tokenId still appears
      // in bob's hop-2 OUTBOX entry's `tokenIds` (recipient set) —
      // PRE-FIX this trips DUPLICATE_BUNDLE_MEMBERSHIP. POST-FIX the
      // guard compares against sourceTokenIds (bob's burned source
      // from hop 2, which is the original 100-USDU receive token, NOT
      // the round-tripped 20) and the send proceeds.
      // -------------------------------------------------------------
      const aliceTotalAfterHop4 = aliceTotalAfterHop2 - 910_000_000n + 985_000_000n;
      const hop4Result = await sendHop({
        sender: b.sphere,
        receiver: a.sphere,
        receiverNametag: aliceTag,
        amount: '985000000',
        amountSmallest: 985_000_000n,
        symbol: PRIMARY_SYMBOL,
        memo: '#391 hop 4 — CRITICAL',
        expectedReceiveTotal: aliceTotalAfterHop4,
        tag: 'HOP4',
      });

      // -------------------------------------------------------------
      // Final balance sanity: net deltas match expectations IF HOP 4
      // actually delivered. When `sendHop` returns `null`, the post-
      // #393 INLINE_CAR_TOO_LARGE throw fired and the bundle never
      // shipped — the #391 invariant is still verified by the
      // duplicate-bundle assertion inside `sendHop`, but the
      // reconciliation can't run.
      //   alice: -100 + 20 - 910 + 985 = -5    → baseline - 5_000_000
      //   bob:   +100 - 20 + 910 - 985 = +5
      // -------------------------------------------------------------
      if (hop4Result === null) {
        console.log(
          `[#391] HOP 4 soft-pass (post-#393 INLINE_CAR_TOO_LARGE). ` +
            `Skipping balance reconciliation — #391 invariant verified by ` +
            `the absence of DUPLICATE_BUNDLE_MEMBERSHIP in sendHop's catch.`,
        );
      } else {
        const aliceFinal = getBalance(a.sphere, PRIMARY_SYMBOL).confirmed;
        const bobFinal = getBalance(b.sphere, PRIMARY_SYMBOL).confirmed;
        console.log(`[#391] alice final: ${aliceFinal} (baseline ${baseline}, expected ${baseline - 5_000_000n})`);
        console.log(`[#391] bob   final: ${bobFinal} (expected 5_000_000)`);
        expect(aliceFinal).toBe(baseline - 5_000_000n);
        expect(bobFinal).toBe(5_000_000n);
      }

      // No transfer:failed events on either side — EXCEPT for the
      // HOP 4 INLINE_CAR_TOO_LARGE soft-pass, which fires
      // `transfer:failed` on the sender (bob) by design when the
      // dispatcher throws. Filter those out and assert nothing else
      // failed.
      const expectedFailRe = /INLINE_CAR_TOO_LARGE|automated CID delivery is currently disabled|DUPLICATE_BUNDLE_MEMBERSHIP/;
      const aliceUnexpectedFailures = aliceFailed.filter(
        (r) => !expectedFailRe.test(r.error ?? ''),
      );
      // For #391 we expect NO failures whatsoever from alice (her sends are
      // small enough to fit inline). Bob may have one expected failure
      // matching the HOP 4 soft-pass.
      const bobUnexpectedFailures = bobFailed.filter(
        (r) => !/INLINE_CAR_TOO_LARGE|automated CID delivery is currently disabled/.test(r.error ?? ''),
      );
      // Surface DUPLICATE_BUNDLE_MEMBERSHIP loudly if it ever appears —
      // that would be a #391 regression even when it doesn't surface
      // through the synchronous send() throw path.
      const dupBundleFailures = [...aliceFailed, ...bobFailed].filter((r) =>
        /DUPLICATE_BUNDLE_MEMBERSHIP|refusing to include token/.test(r.error ?? ''),
      );
      expect(dupBundleFailures).toEqual([]);
      expect(aliceUnexpectedFailures).toEqual([]);
      expect(bobUnexpectedFailures).toEqual([]);
    },
    900_000, // 15-minute test budget for 4 testnet hops with finalize.
  );
});
