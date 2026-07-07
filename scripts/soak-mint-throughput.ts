/**
 * Extended soak: sequential mint throughput (Wave 6-P2-6, scenario 4).
 *
 * Mints 10 fresh UCT tokens back-to-back on a single wallet and measures
 * per-mint latency. Reports min/max/mean/p95. Fails if any single mint
 * exceeds 30s (gateway health signal — see wave brief).
 *
 * This isolates the mint hot path (aggregator RPC + inclusion proof
 * poll) from send/receive/transport noise. If wallet-to-wallet sends
 * are red but this is green, the issue is in PaymentsModule.send /
 * transport wiring, not the aggregator.
 *
 * Run:
 *   npx tsx scripts/soak-mint-throughput.ts
 *
 * Env:
 *   TESTNET2_API_KEY — override embedded testnet2 key (optional).
 *   SOAK_MINT_COUNT  — number of mints (default 10).
 *   SOAK_DATA_DIR    — data dir (default /tmp/sphere-soak-mint).
 */

import {
  TESTNET2_GATEWAY,
  UCT_COIN_ID,
  log,
  initFreshWallet,
  forceExit,
  reportPass,
  reportFail,
} from './soak-helpers';

const TAG = 'soak-mint-throughput';
const MINT_AMOUNT = 100n;
const HARD_LIMIT_MS = 30_000;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<void> {
  const dataDir = process.env.SOAK_DATA_DIR ?? '/tmp/sphere-soak-mint';
  const count = Number(process.env.SOAK_MINT_COUNT ?? '10');
  log(TAG, 'start', { gateway: TESTNET2_GATEWAY, dataDir, count });

  const { sphere } = await initFreshWallet({ tag: TAG, dataDir });

  const latencies: number[] = [];
  const tokenIds: string[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    try {
      const res = await sphere.payments.mintFungibleToken(UCT_COIN_ID, MINT_AMOUNT);
      const elapsed = Date.now() - t0;
      if (!res.success) {
        failures.push({ index: i, error: res.error });
        log(TAG, `mint #${i} failed`, { ms: elapsed, error: res.error });
        continue;
      }
      latencies.push(elapsed);
      tokenIds.push(res.tokenId);
      log(TAG, `mint #${i} ok`, { ms: elapsed, tokenId: res.tokenId });
      if (elapsed > HARD_LIMIT_MS) {
        throw new Error(
          `mint #${i} exceeded HARD_LIMIT_MS (${elapsed} > ${HARD_LIMIT_MS}) — gateway health signal`,
        );
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ index: i, error: message });
      log(TAG, `mint #${i} threw`, { ms: elapsed, error: message });
      throw err;
    }
  }

  await sphere.destroy();

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = latencies.reduce((s, v) => s + v, 0);
  const mean = latencies.length ? Math.round(sum / latencies.length) : 0;
  const min = latencies.length ? sorted[0] : 0;
  const max = latencies.length ? sorted[sorted.length - 1] : 0;
  const p95 = pct(sorted, 95);

  log(TAG, 'SOAK COMPLETE', { minted: latencies.length, failed: failures.length });
  log(TAG, 'latency', { min, max, mean, p95 });

  if (failures.length > 0) {
    reportFail('mint-throughput', new Error(`${failures.length} mints failed`));
    forceExit(1);
  }
  reportPass({
    gateway: TESTNET2_GATEWAY,
    mintCount: latencies.length,
    latencyMs: { min, max, mean, p95 },
    tokenIds,
  });
  forceExit(0);
}

main().catch((err) => {
  log(TAG, 'SOAK FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  reportFail('mint-throughput', err);
  forceExit(1);
});
