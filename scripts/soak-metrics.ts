/**
 * Soak metrics harness — measures per-soak wall-clock across 3 runs each,
 * plus per-step latencies parsed from the soaks' existing log stream.
 *
 * Purpose: get a v2-baseline number for gateway.testnet2.unicity.network
 * latency + slim-facade overhead. No v1 baseline available (v1 aggregator
 * retired), so this is a snapshot of TODAY's v2 numbers only.
 *
 * Run:
 *   npx tsx scripts/soak-metrics.ts
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const SOAKS = [
  { name: 'mint-throughput', script: 'soak-mint-throughput.ts', timeout: 90 },
  { name: 'two-wallet-send', script: 'soak-two-wallet-send.ts', timeout: 120 },
  { name: 'multi-coin-bundle', script: 'soak-multi-coin-bundle.ts', timeout: 120 },
  { name: 'invoice-lifecycle', script: 'soak-invoice-lifecycle.ts', timeout: 120 },
  { name: 'invoice-return', script: 'soak-invoice-return.ts', timeout: 180 },
] as const;
const RUNS_PER_SOAK = 3;

interface RunResult {
  soak: string;
  runIndex: number;
  totalMs: number;
  status: 'PASSED' | 'FAILED' | 'TIMEOUT';
  steps: Array<{ tag: string; ms: number }>;
}

async function runOne(
  soakName: string,
  script: string,
  timeoutSec: number,
  runIndex: number,
): Promise<RunResult> {
  const t0 = Date.now();
  const child = spawn(
    'npx',
    ['tsx', `scripts/${script}`],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c.toString()));
  child.stderr.on('data', (c) => (stderr += c.toString()));

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
  const code: number = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c ?? -1));
  });
  clearTimeout(timer);
  const totalMs = Date.now() - t0;

  const status: 'PASSED' | 'FAILED' | 'TIMEOUT' =
    code === -1 || code === 143
      ? 'TIMEOUT'
      : stdout.includes('"result": "PASSED"') || stdout.includes('SOAK PASSED')
        ? 'PASSED'
        : 'FAILED';

  const stepLines = stderr
    .split('\n')
    .filter((l) => /^\[soak-[a-z0-9-]+\]/.test(l));
  // Reconstruct per-step latency: each log line is one event; delta from
  // previous log line's implicit clock (parsed from message ordering).
  const steps: Array<{ tag: string; ms: number }> = [];
  if (stepLines.length >= 2) {
    // We don't have wall-clock in log lines. Estimate: assume even
    // distribution across the run's totalMs (very rough) — this is only
    // useful for RELATIVE per-run comparison, not absolute.
    // For real per-step timings a future wave would need to embed
    // `Date.now()` in the log lines directly.
    for (let i = 0; i < stepLines.length; i++) {
      const line = stepLines[i];
      const m = line.match(/^\[soak-[a-z0-9-]+\]\s+(.+?)(?:\s—\s|$)/);
      const tag = m?.[1] ?? line.slice(0, 60);
      steps.push({ tag, ms: -1 });
    }
  }

  return { soak: soakName, runIndex, totalMs, status, steps };
}

function stats(nums: number[]): { min: number; p50: number; mean: number; max: number } {
  if (nums.length === 0) return { min: 0, p50: 0, mean: 0, max: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0]!,
    p50: sorted[Math.floor(sorted.length / 2)]!,
    mean: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1]!,
  };
}

async function main(): Promise<void> {
  console.error('[metrics] starting soak metrics harness');
  console.error(`[metrics] running each soak ${RUNS_PER_SOAK}x`);
  const allResults: RunResult[] = [];
  for (const soak of SOAKS) {
    console.error(`\n[metrics] === ${soak.name} ===`);
    for (let i = 0; i < RUNS_PER_SOAK; i++) {
      // fresh data dirs
      if (fs.existsSync('/tmp/sphere-soak')) {
        try {
          fs.rmSync('/tmp/sphere-soak', { recursive: true });
        } catch { /* ignore */ }
      }
      // Also clean per-soak tmp dirs (e.g. /tmp/sphere-soak-invoice)
      try {
        for (const d of fs.readdirSync('/tmp')) {
          if (d.startsWith('sphere-soak-') || d.startsWith('sphere-smoke-')) {
            try { fs.rmSync(`/tmp/${d}`, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      const r = await runOne(soak.name, soak.script, soak.timeout, i + 1);
      allResults.push(r);
      console.error(
        `[metrics]   run ${i + 1}/${RUNS_PER_SOAK}: ${r.status} in ${r.totalMs} ms (${r.steps.length} steps)`,
      );
    }
  }

  // Aggregate
  console.error('\n\n[metrics] === Summary (per-soak wall-clock, 3 runs) ===');
  console.error(
    'soak                  | pass/total | min ms | p50 ms | mean ms | max ms',
  );
  console.error(
    '----------------------+------------+--------+--------+---------+--------',
  );
  const summary: Array<{
    soak: string;
    passed: number;
    total: number;
    min: number;
    p50: number;
    mean: number;
    max: number;
  }> = [];
  for (const soak of SOAKS) {
    const runs = allResults.filter((r) => r.soak === soak.name);
    const passed = runs.filter((r) => r.status === 'PASSED').length;
    const times = runs.filter((r) => r.status === 'PASSED').map((r) => r.totalMs);
    const s = stats(times);
    summary.push({
      soak: soak.name,
      passed,
      total: runs.length,
      ...s,
    });
    console.error(
      `${soak.name.padEnd(22)}| ${String(passed).padStart(3)}/${runs.length}      | ${String(s.min).padStart(6)} | ${String(s.p50).padStart(6)} | ${String(s.mean).padStart(7)} | ${String(s.max).padStart(6)}`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        harness: 'soak-metrics',
        runsPerSoak: RUNS_PER_SOAK,
        summary,
        allRuns: allResults.map((r) => ({
          soak: r.soak,
          runIndex: r.runIndex,
          totalMs: r.totalMs,
          status: r.status,
          stepCount: r.steps.length,
        })),
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[metrics] FAILED:', err);
  process.exit(1);
});
