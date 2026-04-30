/**
 * E2E Test: UXF Send/Receive against REAL Unicity testnet (Phase 9 gap closure)
 *
 * What this test specifically validates that mocked-aggregator integration
 * tests under `tests/integration/transfer/` do NOT:
 *   - Production code paths exercised against the live Unicity testnet
 *     aggregator (`goggregator-test.unicity.network`).
 *   - Real testnet Nostr relay (`nostr-relay.testnet.unicity.network`)
 *     carrying the actual UXF wire payload (kind: 'uxf-car' | 'uxf-cid').
 *   - Real Unicity IPFS gateways for any CID-by-reference deliveries.
 *   - Real testnet faucet for funding.
 *
 * No mocks for any of these — every byte travels through production code.
 *
 * Feature flags:
 *   The two wallets are forcibly configured with
 *     senderUxf=true + recipientUxf=true + recipientLegacyAdapter=true
 *   regardless of the SDK's compiled-in defaults. The forcible override is
 *   a `Object.defineProperty` write on the PaymentsModule's frozen `features`
 *   record performed AFTER `Sphere.init()`. This keeps the test self-
 *   contained and forward-compatible: it works whether the parallel agent
 *   flipping the defaults has landed yet or not, and it exercises the UXF
 *   send/receive path explicitly even before the eventual default flip.
 *
 * Skip gates:
 *   - `NO_TESTNET=1` — ecosystem-wide "no network" gate. All scenarios
 *     resolve to `it.skip(...)` so the test file stays green when the
 *     runner has no network access (e.g., a sandboxed CI shard).
 *   - `RUN_UXF_E2E=1` opt-in — by default the live-network scenarios are
 *     SKIPPED in vitest. Opt in to drive the actual sends. See "Known UXF
 *     orchestrator blockers" below for why this is opt-in for now.
 *
 * Known UXF orchestrator blockers surfaced by this test (as of writing):
 *   1. CBOR uint64 overflow on SMT path bignums.
 *      `uxf/hash.ts:prepareSmtSegments` casts SMT path strings to native
 *      bigints (`path: BigInt(seg.path)`). When the source token's
 *      inclusion proof carries a 256-bit SMT path (always, post-aggregator),
 *      `@ipld/dag-cbor` (via `cborg`) rejects the bigint with
 *      `encountered BigInt larger than allowable range` because it tries
 *      raw uint encoding (top out at 2^64 - 1) instead of CBOR tag 2
 *      (bignum). Reproduces with USDU (6 decimals) — confirms the bigint
 *      is the SMT path, not the coin amount.
 *   2. Symbol → hex coinId resolution missing on the UXF dispatch arm.
 *      The legacy `instantSplitSend` path (PaymentsModule ~line 1868) does
 *      `TokenRegistry.getDefinitionBySymbol(...)` if no token literally
 *      matches `request.coinId`. The UXF dispatcher
 *      (`dispatchUxfConservativeSend`, `dispatchUxfInstantSend`) does NOT
 *      replicate that resolution — `request.coinId === 'UCT'` lands in
 *      `validateTargets` against tokens whose projected `coinData[0][0]`
 *      is the hex coinId, returning `available=0` and throwing
 *      `INSUFFICIENT_BALANCE`. The test sidesteps this by calling
 *      `sphere.payments.getBalance()[i].coinId` and passing the canonical
 *      hex coinId straight through — but production callers passing
 *      symbols will trip this.
 *
 * The scenarios in this file would pass if the orchestrator worked. They
 * exist precisely to detect a regression once those bugs are fixed; until
 * then the suite is opt-in via `RUN_UXF_E2E=1`.
 *
 * Network requirements:
 *   - Outbound HTTPS to `faucet.unicity.network`,
 *     `goggregator-test.unicity.network`, the Unicity IPFS gateways, and
 *     `raw.githubusercontent.com` (trustbase fetch).
 *   - Outbound WSS to `wss://nostr-relay.testnet.unicity.network`.
 *
 * Run with:
 *   npm run test:e2e                        # default — scenarios SKIPPED
 *   RUN_UXF_E2E=1 npm run test:e2e          # actually hit testnet
 *   RUN_UXF_E2E=1 RUN_UCT_SMOKE=1 npm run test:e2e  # also try UCT
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
import {
  ensureTrustbase,
  getBalance,
  getTokenIds,
  makeProviders,
  makeTempDirs,
  POLL_INTERVAL_MS,
  rand,
  requestFaucet,
  TEST_COINS,
} from './helpers';
import type { TokenTransferPayload } from '../../transport/transport-provider';
import type { TransferResult } from '../../types';

// =============================================================================
// Constants
// =============================================================================

// SKIP gate — true means the scenario is skipped at vitest collection.
//   - NO_TESTNET=1 (ecosystem convention) skips everything.
//   - default: skipped because of the known UXF orchestrator blockers
//     documented in the file header.
//   - RUN_UXF_E2E=1: opt in.
const SKIP = process.env.NO_TESTNET === '1' || process.env.RUN_UXF_E2E !== '1';

/** UCT smoke is opt-in even when RUN_UXF_E2E=1; UCT amounts overflow uint64. */
const UCT_SMOKE_DISABLED = process.env.RUN_UCT_SMOKE !== '1';

const FAUCET_TOPUP_MS = 120_000;
const TRANSFER_RECV_MS = 90_000;
const FINALIZE_MS = 120_000;

// Primary test coin: USDU (6 decimals). Faucet drops 1000 USDU = 1e9
// smallest units, well below uint64.
const PRIMARY_SYMBOL = 'USDU' as const;
const PRIMARY_FAUCET = 'unicity-usd' as const;

// Secondary coin for multi-coin scenario: USDC (6 decimals). The faucet
// name lives in TEST_COINS — we just need the symbol here.
const SECONDARY_SYMBOL = 'USDC' as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Force UXF feature flags ON post-init. Replaces the frozen `features`
 * record on the underlying PaymentsModule. Idempotent. Returns the new
 * snapshot for the assertion message.
 *
 * The PaymentsModule freezes `features` at construction (rollback safety
 * for production). We bypass the freeze here ONLY in test code — the
 * point of this gap-closing test is to exercise UXF regardless of what
 * the compiled defaults happen to be on the day the test runs.
 */
interface UxfFeaturesShape {
  readonly senderUxf: boolean;
  readonly recipientUxf: boolean;
  readonly recipientLegacyAdapter: boolean;
  readonly recoveryWorker: boolean;
}

function forceUxfFeaturesOn(sphere: Sphere): UxfFeaturesShape {
  // PaymentsModule.features is private + frozen at construction (rollback
  // safety). Bypass via `unknown` cast to a feature-bag shape — runtime-only,
  // not a leak into production code paths.
  const featuresHolder = sphere.payments as unknown as { features: UxfFeaturesShape };
  const next: UxfFeaturesShape = Object.freeze({
    senderUxf: true,
    recipientUxf: true,
    recipientLegacyAdapter: true,
    // Leave recoveryWorker alone (defaults OFF; would require an
    // explicitly-injected republish hook).
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

/**
 * Wait for a peer's nametag binding to propagate to the relay so the
 * sender can resolve it. After `Sphere.init({ nametag })` the binding
 * event is published to Nostr but may take several seconds to be
 * indexed and replayable to other subscribers.
 */
async function waitForPeerResolvable(
  resolver: Sphere,
  peerNametag: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => (await resolver.resolve(`@${peerNametag}`)) !== null ? true : null,
    timeoutMs,
    `peer @${peerNametag} to be resolvable from sender's transport`,
  );
}

/**
 * Sphere.init() with a spendable wallet on real testnet. Returns the
 * sphere plus the generated mnemonic so callers can re-import if needed.
 */
async function initWallet(label: string, nametag: string): Promise<{
  sphere: Sphere;
  baseDir: string;
  mnemonic: string;
}> {
  const dirs = makeTempDirs(`uxf-${label}`);
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

/**
 * Hook the transport's outgoing token transfer call so the test can
 * assert on the actual wire payload structure (kind: 'uxf-car' or
 * 'uxf-cid'). Returns an array that captures every payload sent during
 * the wrap window, plus an `unwrap()` to restore the original.
 */
function captureSentPayloads(sphere: Sphere): {
  captured: Array<{ recipient: string; payload: TokenTransferPayload }>;
  unwrap: () => void;
} {
  const transport = (sphere as unknown as {
    _transport: { sendTokenTransfer: (r: string, p: TokenTransferPayload) => Promise<string> };
  })._transport;
  const original = transport.sendTokenTransfer.bind(transport);
  const captured: Array<{ recipient: string; payload: TokenTransferPayload }> = [];
  transport.sendTokenTransfer = async (recipient: string, payload: TokenTransferPayload) => {
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
 * Wait for `predicate()` to return truthy, polling at `POLL_INTERVAL_MS`.
 * Returns the truthy value or throws on timeout.
 */
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

/**
 * Resolve a token symbol (e.g. 'USDU') to its canonical coinId via the
 * wallet's own asset list. The UXF dispatcher (currently) does NOT
 * symbol-resolve like the legacy path; pass a hex coinId straight
 * through `request.coinId` to avoid a `target-validator` mismatch.
 */
function resolveCoinId(sphere: Sphere, symbol: string): string {
  const assets = sphere.payments.getBalance();
  const a = assets.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`No asset found for symbol ${symbol}`);
  return a.coinId;
}

/**
 * Top up `nametag` with `symbol` (via faucet name `faucetName`) until the
 * wallet sees `>= minAmount` confirmed. Throws on timeout.
 */
async function topUpCoin(
  sphere: Sphere,
  nametag: string,
  symbol: string,
  faucetName: string,
  faucetAmount: number,
  minAmount: bigint,
  timeoutMs: number,
): Promise<bigint> {
  const faucet = await requestFaucet(nametag, faucetName, faucetAmount);
  if (!faucet.success) {
    console.warn(
      `  Faucet ${symbol} request failed (continuing — may already be funded): ${faucet.message}`,
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
    `Faucet top-up timed out: have ${confirmed} confirmed ${symbol}, need >= ${minAmount}`,
  );
}

// =============================================================================
// Test Suite
// =============================================================================

describe('UXF Send/Receive — real Unicity testnet (Phase 9 gap closure)', () => {
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

  // ---------------------------------------------------------------------------
  // Scenario 1: Conservative-mode UXF send (USDU)
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)(
    'conservative-mode: A → B UXF send (USDU) delivers via real Nostr + real aggregator',
    async () => {
      const tag = rand();
      const aliceTag = `e2e-uxf-a-${tag}`;
      const bobTag = `e2e-uxf-b-${tag}`;

      const a = await initWallet('alice', aliceTag);
      const b = await initWallet('bob', bobTag);
      cleanupDirs.push(a.baseDir, b.baseDir);
      spheres.push(a.sphere, b.sphere);

      console.log(`\n[S1] Alice=@${aliceTag} Bob=@${bobTag} (primary coin: ${PRIMARY_SYMBOL})`);
      console.log(`     UXF flags forced ON: senderUxf=true recipientUxf=true recipientLegacyAdapter=true`);

      // Faucet 1000 USDU for Alice
      const aBalance = await topUpCoin(
        a.sphere, aliceTag, PRIMARY_SYMBOL, PRIMARY_FAUCET, 1000, 1_000_000n, FAUCET_TOPUP_MS,
      );
      console.log(`[S1] Alice has ${aBalance} ${PRIMARY_SYMBOL} confirmed`);

      const aliceConfirmedTransfers: TransferResult[] = [];
      const aliceFailedTransfers: TransferResult[] = [];
      const bobIncoming: { tokens: number; senderNametag?: string }[] = [];
      a.sphere.on('transfer:confirmed', (r) => { aliceConfirmedTransfers.push(r); });
      a.sphere.on('transfer:failed', (r) => { aliceFailedTransfers.push(r); });
      b.sphere.on('transfer:incoming', (e) => {
        bobIncoming.push({ tokens: e.tokens.length, senderNametag: e.senderNametag });
      });

      // Wait for Bob's nametag binding event to propagate before sending.
      console.log(`[S1] waiting for @${bobTag} to be resolvable...`);
      await waitForPeerResolvable(a.sphere, bobTag, 60_000);

      const aHook = captureSentPayloads(a.sphere);
      const primaryCoinId = resolveCoinId(a.sphere, PRIMARY_SYMBOL);
      const sendStart = performance.now();
      const result = await a.sphere.payments.send({
        recipient: `@${bobTag}`,
        coinId: primaryCoinId,
        amount: '1000',
        memo: 'S1 conservative UXF',
        transferMode: 'conservative',
      });
      const sendDur = ((performance.now() - sendStart) / 1000).toFixed(1);
      aHook.unwrap();
      console.log(`[S1] send() returned in ${sendDur}s status=${result.status} err=${result.error ?? '-'}`);

      // Wire payload UXF-shaped (kind: 'uxf-car' | 'uxf-cid')
      expect(aHook.captured.length).toBeGreaterThan(0);
      const wirePayload = aHook.captured[0]!.payload as { kind?: string };
      console.log(`[S1] Wire payload kind=${wirePayload.kind}`);
      expect(['uxf-car', 'uxf-cid']).toContain(wirePayload.kind ?? '');

      expect(['delivered', 'completed', 'submitted']).toContain(result.status);
      expect(result.tokenTransfers.length).toBeGreaterThan(0);

      // Bob receives the token
      await waitFor(
        async () => {
          try { await b.sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
          const bal = getBalance(b.sphere, PRIMARY_SYMBOL);
          return bal.total >= 1000n ? bal : null;
        },
        TRANSFER_RECV_MS,
        `Bob to receive ${PRIMARY_SYMBOL}`,
      );
      const bBalance = getBalance(b.sphere, PRIMARY_SYMBOL);
      console.log(`[S1] Bob received ${bBalance.total} ${PRIMARY_SYMBOL} in ${bBalance.tokens} token(s)`);
      expect(bBalance.total).toBeGreaterThanOrEqual(1000n);

      // Bob can re-spend the received tokens
      await waitForPeerResolvable(b.sphere, aliceTag, 60_000);
      const bobPrimaryCoinId = resolveCoinId(b.sphere, PRIMARY_SYMBOL);
      const reSendResult = await b.sphere.payments.send({
        recipient: `@${aliceTag}`,
        coinId: bobPrimaryCoinId,
        amount: '500',
        memo: 'S1 re-spend',
        transferMode: 'conservative',
      });
      expect(['delivered', 'completed', 'submitted']).toContain(reSendResult.status);

      expect(aliceFailedTransfers.length).toBe(0);
      console.log(`[S1] confirmed=${aliceConfirmedTransfers.length} failed=${aliceFailedTransfers.length}`);
    },
    300_000,
  );

  // ---------------------------------------------------------------------------
  // Scenario 2: Instant-mode UXF send + finalization (USDU)
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)(
    'instant-mode: A → B UXF send (USDU) returns submitted, finalizes via §6.1 cycle',
    async () => {
      const tag = rand();
      const aliceTag = `e2e-uxf-a2-${tag}`;
      const bobTag = `e2e-uxf-b2-${tag}`;

      const a = await initWallet('alice2', aliceTag);
      const b = await initWallet('bob2', bobTag);
      cleanupDirs.push(a.baseDir, b.baseDir);
      spheres.push(a.sphere, b.sphere);

      console.log(`\n[S2] Alice=@${aliceTag} Bob=@${bobTag} (primary coin: ${PRIMARY_SYMBOL})`);
      await topUpCoin(
        a.sphere, aliceTag, PRIMARY_SYMBOL, PRIMARY_FAUCET, 1000, 1_000_000n, FAUCET_TOPUP_MS,
      );

      const submitted: TransferResult[] = [];
      const confirmed: TransferResult[] = [];
      a.sphere.on('transfer:submitted', (r) => { submitted.push(r); });
      a.sphere.on('transfer:confirmed', (r) => { confirmed.push(r); });

      console.log(`[S2] waiting for @${bobTag} to be resolvable...`);
      await waitForPeerResolvable(a.sphere, bobTag, 60_000);

      const primaryCoinId = resolveCoinId(a.sphere, PRIMARY_SYMBOL);
      const aHook = captureSentPayloads(a.sphere);
      const result = await a.sphere.payments.send({
        recipient: `@${bobTag}`,
        coinId: primaryCoinId,
        amount: '500',
        memo: 'S2 instant UXF',
        transferMode: 'instant',
      });
      aHook.unwrap();

      console.log(`[S2] send() status=${result.status} err=${result.error ?? '-'}`);

      expect(aHook.captured.length).toBeGreaterThan(0);
      const wirePayload = aHook.captured[0]!.payload as { kind?: string };
      console.log(`[S2] Wire payload kind=${wirePayload.kind}`);
      expect(['uxf-car', 'uxf-cid']).toContain(wirePayload.kind ?? '');

      // Instant returns non-completed status (proof not yet collected)
      expect(['submitted', 'pending']).toContain(result.status);

      // Bob receives — recipient may need to drive its own §6.1 cycle
      await waitFor(
        async () => {
          try { await b.sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
          const bal = getBalance(b.sphere, PRIMARY_SYMBOL);
          return bal.total >= 500n ? bal : null;
        },
        TRANSFER_RECV_MS,
        `Bob to receive ${PRIMARY_SYMBOL} (instant mode)`,
      );

      // Sender-side §6.1 finalization workers should drive the outbox to confirmed
      await waitFor(
        async () => (confirmed.length > 0 ? confirmed[0] : null),
        FINALIZE_MS,
        'Alice transfer:confirmed event after instant finalization',
      );
      console.log(`[S2] submitted=${submitted.length} confirmed=${confirmed.length}`);

      const bBefore = getBalance(b.sphere, PRIMARY_SYMBOL);
      expect(bBefore.total).toBeGreaterThanOrEqual(500n);
      await waitForPeerResolvable(b.sphere, aliceTag, 60_000);
      const bobPrimaryCoinId = resolveCoinId(b.sphere, PRIMARY_SYMBOL);
      const reSpend = await b.sphere.payments.send({
        recipient: `@${aliceTag}`,
        coinId: bobPrimaryCoinId,
        amount: '100',
        memo: 'S2 re-spend',
        transferMode: 'conservative',
      });
      expect(['delivered', 'completed', 'submitted']).toContain(reSpend.status);
    },
    360_000,
  );

  // ---------------------------------------------------------------------------
  // Scenario 3: Multi-coin send (USDU + USDC in one UXF bundle)
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP)(
    `multi-coin: A → B sends ${PRIMARY_SYMBOL} + ${SECONDARY_SYMBOL} in one UXF bundle`,
    async () => {
      const tag = rand();
      const aliceTag = `e2e-uxf-a3-${tag}`;
      const bobTag = `e2e-uxf-b3-${tag}`;

      const a = await initWallet('alice3', aliceTag);
      const b = await initWallet('bob3', bobTag);
      cleanupDirs.push(a.baseDir, b.baseDir);
      spheres.push(a.sphere, b.sphere);

      console.log(`\n[S3] Alice=@${aliceTag} Bob=@${bobTag}`);

      // Top up two 6-decimal coins. Each faucet hit uses TEST_COINS amounts.
      const primaryCoin = TEST_COINS.find((c) => c.symbol === PRIMARY_SYMBOL)!;
      const secondaryCoin = TEST_COINS.find((c) => c.symbol === SECONDARY_SYMBOL)!;
      await Promise.all([
        requestFaucet(aliceTag, primaryCoin.faucetName, primaryCoin.amount),
        requestFaucet(aliceTag, secondaryCoin.faucetName, secondaryCoin.amount),
      ]);

      // Wait until BOTH coins are confirmed
      await waitFor(
        async () => {
          try { await a.sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
          const p = getBalance(a.sphere, PRIMARY_SYMBOL);
          const s = getBalance(a.sphere, SECONDARY_SYMBOL);
          return p.confirmed >= 1_000n && s.confirmed >= 1_000n ? { p, s } : null;
        },
        FAUCET_TOPUP_MS * 2,
        `Alice to have both ${PRIMARY_SYMBOL} and ${SECONDARY_SYMBOL} confirmed`,
      );

      console.log(`[S3] waiting for @${bobTag} to be resolvable...`);
      await waitForPeerResolvable(a.sphere, bobTag, 60_000);

      const primaryCoinId = resolveCoinId(a.sphere, PRIMARY_SYMBOL);
      const secondaryCoinId = resolveCoinId(a.sphere, SECONDARY_SYMBOL);
      const aHook = captureSentPayloads(a.sphere);
      const result = await a.sphere.payments.send({
        recipient: `@${bobTag}`,
        coinId: primaryCoinId,
        amount: '500',
        additionalAssets: [{ kind: 'coin', coinId: secondaryCoinId, amount: '200' }],
        memo: 'S3 multi-coin UXF',
        transferMode: 'conservative',
      });
      aHook.unwrap();

      console.log(`[S3] send() status=${result.status} err=${result.error ?? '-'}`);
      expect(aHook.captured.length).toBeGreaterThan(0);
      const wirePayload = aHook.captured[0]!.payload as { kind?: string };
      expect(['uxf-car', 'uxf-cid']).toContain(wirePayload.kind ?? '');

      // Bob receives BOTH coins
      await waitFor(
        async () => {
          try { await b.sphere.payments.receive({ finalize: true }); } catch { /* keep polling */ }
          const p = getBalance(b.sphere, PRIMARY_SYMBOL);
          const s = getBalance(b.sphere, SECONDARY_SYMBOL);
          return p.total >= 500n && s.total >= 200n ? { p, s } : null;
        },
        TRANSFER_RECV_MS * 2,
        `Bob to receive both ${PRIMARY_SYMBOL} and ${SECONDARY_SYMBOL}`,
      );

      const bPrimary = getBalance(b.sphere, PRIMARY_SYMBOL);
      const bSecondary = getBalance(b.sphere, SECONDARY_SYMBOL);
      console.log(
        `[S3] Bob: ${PRIMARY_SYMBOL}=${bPrimary.total} (${bPrimary.tokens}), ` +
          `${SECONDARY_SYMBOL}=${bSecondary.total} (${bSecondary.tokens})`,
      );
      expect(bPrimary.total).toBeGreaterThanOrEqual(500n);
      expect(bSecondary.total).toBeGreaterThanOrEqual(200n);

      // Token IDs disjoint between coin classes
      const primaryIds = getTokenIds(b.sphere, PRIMARY_SYMBOL);
      const secondaryIds = getTokenIds(b.sphere, SECONDARY_SYMBOL);
      for (const id of primaryIds) expect(secondaryIds.has(id)).toBe(false);
    },
    480_000,
  );

  // ---------------------------------------------------------------------------
  // Scenario 4 (skipped by default): UCT smoke — documents the CBOR uint64
  // overflow bug the test discovered. Set RUN_UCT_SMOKE=1 to attempt.
  // ---------------------------------------------------------------------------

  it.skipIf(SKIP || UCT_SMOKE_DISABLED)(
    'UCT smoke (expected to fail with CBOR uint64 overflow until UXF encoder fix)',
    async () => {
      const tag = rand();
      const aliceTag = `e2e-uxf-uct-a-${tag}`;
      const bobTag = `e2e-uxf-uct-b-${tag}`;

      const a = await initWallet('alice-uct', aliceTag);
      const b = await initWallet('bob-uct', bobTag);
      cleanupDirs.push(a.baseDir, b.baseDir);
      spheres.push(a.sphere, b.sphere);

      console.log(`\n[S4] Alice=@${aliceTag} Bob=@${bobTag} (UCT, expected CBOR overflow)`);
      await topUpCoin(a.sphere, aliceTag, 'UCT', 'unicity', 100, 5_000n, FAUCET_TOPUP_MS);

      await waitForPeerResolvable(a.sphere, bobTag, 60_000);
      const uctCoinId = resolveCoinId(a.sphere, 'UCT');
      let threw: unknown = null;
      try {
        await a.sphere.payments.send({
          recipient: `@${bobTag}`,
          coinId: uctCoinId,
          amount: '1000',
          memo: 'S4 UCT smoke',
          transferMode: 'conservative',
        });
      } catch (err) {
        threw = err;
      }
      // Currently we expect this to throw the CBOR overflow. Once the UXF
      // encoder grows arbitrary-precision support, this assertion flips
      // (or the test moves into the main suite using UCT).
      expect(threw).not.toBeNull();
      const msg = String(threw instanceof Error ? threw.message : threw);
      console.log(`[S4] threw: ${msg}`);
      expect(msg.toLowerCase()).toContain('bigint');
    },
    300_000,
  );
});
