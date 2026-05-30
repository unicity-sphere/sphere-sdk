/**
 * core/perf-counters.ts — opt-in runtime measurement hooks.
 *
 * Created in response to GH issue #363 (post-mortem of #360). The
 * lesson from #360: do NOT propose perf fixes from static analysis.
 * Measure first, fix second. This module exists so that the next
 * investigator can capture real numbers from the hot paths the #360
 * findings called out but never instrumented.
 *
 * ## Activation
 *
 * Zero overhead when off. Enabled by either of:
 *
 *   - `process.env.SPHERE_PERF=1` at process start (Node), OR
 *   - `localStorage.SPHERE_PERF=1` (browser)
 *
 * When enabled, the module:
 *
 *   1. Records counter / timer samples taken via {@link incr},
 *      {@link observeMs}, and {@link time}.
 *   2. Dumps a snapshot of all counters every
 *      `SPHERE_PERF_DUMP_MS` (default 5000 ms) via
 *      `logger.info('perf', { snapshot })`.
 *   3. Clears the snapshot after each dump so the numbers reflect the
 *      most recent window, not cumulative since start.
 *
 * ## API
 *
 *   - `incr(name, n=1)` — bump a counter.
 *   - `observeMs(name, ms)` — record a timing sample (ms).
 *   - `time(name, fn)` — wrap an async function; records its wall-clock.
 *   - `snapshot()` — return current counters without clearing.
 *   - `dumpAndReset()` — emit + clear (called periodically when enabled).
 *
 * All calls are guarded by `PERF_ENABLED` and bail out cheap when off
 * (one boolean check + early return; no allocations, no time reads).
 *
 * ## Why no histograms / no p99
 *
 * Keep it minimal. The first profile-driven investigation needs
 * count + total + max, not a HDR histogram. If a future investigation
 * needs percentiles, swap the storage at that point. We are recovering
 * from the over-engineering of #360 — do not repeat that here.
 *
 * @module core/perf-counters
 */

import { logger } from './logger.js';

// =============================================================================
// Activation
// =============================================================================

function detectEnabled(): boolean {
  try {
    if (typeof process !== 'undefined' && process?.env) {
      if (process.env.SPHERE_PERF === '1') return true;
    }
  } catch {
    /* ignore — browser ESM */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      if (localStorage.getItem('SPHERE_PERF') === '1') return true;
    }
  } catch {
    /* ignore — sandboxed iframe / private mode */
  }
  return false;
}

/**
 * Cached at module load. We deliberately do NOT re-read the env on
 * every call — the gating must be cheap. To flip the flag for an
 * in-flight test, call `__setPerfEnabledForTest`.
 */
let PERF_ENABLED: boolean = detectEnabled();

function detectDumpIntervalMs(): number {
  try {
    if (typeof process !== 'undefined' && process?.env?.SPHERE_PERF_DUMP_MS) {
      const n = Number(process.env.SPHERE_PERF_DUMP_MS);
      if (Number.isFinite(n) && n > 0) return Math.max(100, Math.floor(n));
    }
  } catch {
    /* ignore */
  }
  return 5_000;
}

// =============================================================================
// Storage
// =============================================================================

interface CounterCell {
  count: number;
  totalMs: number;
  maxMs: number;
}

const counters = new Map<string, CounterCell>();

function getCell(name: string): CounterCell {
  let c = counters.get(name);
  if (c === undefined) {
    c = { count: 0, totalMs: 0, maxMs: 0 };
    counters.set(name, c);
  }
  return c;
}

// =============================================================================
// API
// =============================================================================

/**
 * Bump a counter by `n` (default 1). No-op when perf is disabled.
 */
export function incr(name: string, n: number = 1): void {
  if (!PERF_ENABLED) return;
  const c = getCell(name);
  c.count += n;
}

/**
 * Record one timing sample (milliseconds). No-op when perf is disabled.
 *
 * Negative or non-finite values are silently clamped to 0 — caller
 * mistakes (e.g., subtracting `Date.now()` across a clock skip) must
 * not corrupt the counter state.
 */
export function observeMs(name: string, ms: number): void {
  if (!PERF_ENABLED) return;
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const c = getCell(name);
  c.count += 1;
  c.totalMs += v;
  if (v > c.maxMs) c.maxMs = v;
}

/**
 * Wrap a function and record its wall-clock. No-op overhead is one
 * boolean check + the function call. When enabled, adds a single
 * `performance.now()` pair around the call.
 *
 * Errors propagate; the timing is still recorded (so a failing
 * subsystem still shows up in the snapshot).
 */
export async function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!PERF_ENABLED) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    observeMs(name, performance.now() - t0);
  }
}

/**
 * Sync wrapper variant. Same semantics as `time` for synchronous
 * functions.
 */
export function timeSync<T>(name: string, fn: () => T): T {
  if (!PERF_ENABLED) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    observeMs(name, performance.now() - t0);
  }
}

/**
 * Read-only view of the current counters. Returns an empty object
 * when perf is disabled. Does NOT clear.
 */
export function snapshot(): Record<
  string,
  { count: number; totalMs: number; avgMs: number; maxMs: number }
> {
  const out: Record<
    string,
    { count: number; totalMs: number; avgMs: number; maxMs: number }
  > = {};
  for (const [name, c] of counters) {
    out[name] = {
      count: c.count,
      totalMs: Math.round(c.totalMs * 1000) / 1000,
      avgMs: c.count > 0 ? Math.round((c.totalMs / c.count) * 1000) / 1000 : 0,
      maxMs: Math.round(c.maxMs * 1000) / 1000,
    };
  }
  return out;
}

/**
 * Emit the current counters via `logger.info('perf', ...)` and clear.
 * Intended to be called by the auto-dump timer; safe to call manually
 * for tests.
 */
export function dumpAndReset(): void {
  if (!PERF_ENABLED) return;
  if (counters.size === 0) return;
  const snap = snapshot();
  counters.clear();
  logger.info('perf', `[perf-counters] snapshot:`, snap);
}

// =============================================================================
// Auto-dump timer
// =============================================================================

let dumpTimer: ReturnType<typeof setInterval> | null = null;

function startAutoDump(): void {
  if (dumpTimer !== null) return;
  if (!PERF_ENABLED) return;
  const ms = detectDumpIntervalMs();
  dumpTimer = setInterval(() => {
    try {
      dumpAndReset();
    } catch {
      /* never let the dump path throw into the event loop */
    }
  }, ms);
  // Don't keep the event loop alive just for the dump timer.
  if (typeof (dumpTimer as { unref?: () => void }).unref === 'function') {
    (dumpTimer as { unref?: () => void }).unref!();
  }
}

/**
 * Stop the auto-dump timer (test cleanup; not for production).
 */
export function __stopAutoDumpForTest(): void {
  if (dumpTimer !== null) {
    clearInterval(dumpTimer);
    dumpTimer = null;
  }
}

/**
 * Toggle PERF_ENABLED at runtime. Tests only. In production the flag
 * is read once at module load.
 */
export function __setPerfEnabledForTest(value: boolean): void {
  PERF_ENABLED = value;
  if (value) startAutoDump();
  else __stopAutoDumpForTest();
}

/**
 * Public: is perf measurement currently on? Useful for callers that
 * want to skip building expensive instrumentation payloads when off.
 */
export function isPerfEnabled(): boolean {
  return PERF_ENABLED;
}

// Boot the auto-dump if env enables it at module load.
startAutoDump();
