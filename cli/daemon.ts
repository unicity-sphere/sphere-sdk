/**
 * CLI Daemon: persistent event listener with configurable actions.
 *
 * Subscribes to all Sphere events and dispatches configurable actions
 * (bash scripts, HTTP webhooks, built-in actions) based on rules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { fork } from 'child_process';
import type { Sphere } from '../core/Sphere';
import type { SphereEventType } from '../types';
import type {
  DaemonRule,
  DaemonAction,
  BashAction,
  WebhookAction,
  BuiltinAction,
  ResolvedDaemonConfig,
  DaemonFlags,
} from './daemon-config';
import {
  parseDaemonFlags,
  buildConfigFromFlags,
  resolveConfig,
  getDefaultPidFile,
  ensureDir,
} from './daemon-config';

// =============================================================================
// All known SphereEventType values (for wildcard expansion)
// =============================================================================

const ALL_SPHERE_EVENTS: SphereEventType[] = [
  'transfer:incoming',
  'transfer:confirmed',
  'transfer:failed',
  'payment_request:incoming',
  'payment_request:accepted',
  'payment_request:rejected',
  'payment_request:paid',
  'payment_request:response',
  'message:dm',
  'message:read',
  'message:typing',
  'composing:started',
  'message:broadcast',
  'sync:started',
  'sync:completed',
  'sync:provider',
  'sync:error',
  'connection:changed',
  'nametag:registered',
  'nametag:recovered',
  'identity:changed',
  'address:activated',
  'address:hidden',
  'address:unhidden',
  'sync:remote-update',
  'groupchat:message',
  'groupchat:joined',
  'groupchat:left',
  'groupchat:kicked',
  'groupchat:group_deleted',
  'groupchat:updated',
  'groupchat:connection',
];

// =============================================================================
// Event Matching
// =============================================================================

/**
 * Expand a pattern like "transfer:*" or "*" against known event types.
 */
function expandPattern(pattern: string): SphereEventType[] {
  if (pattern === '*') return [...ALL_SPHERE_EVENTS];

  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1); // "transfer:" from "transfer:*"
    return ALL_SPHERE_EVENTS.filter(e => e.startsWith(prefix));
  }

  // Exact match — verify it's a known event type
  if (ALL_SPHERE_EVENTS.includes(pattern as SphereEventType)) {
    return [pattern as SphereEventType];
  }

  // Unknown event pattern — return as-is (may be a custom/future event)
  return [pattern as SphereEventType];
}

/**
 * Build a dispatch map: event type → list of rules that match it.
 */
function buildDispatchMap(rules: DaemonRule[]): Map<SphereEventType, DaemonRule[]> {
  const map = new Map<SphereEventType, DaemonRule[]>();

  for (const rule of rules) {
    if (rule.disabled) continue;

    for (const pattern of rule.events) {
      const expanded = expandPattern(pattern);
      for (const eventType of expanded) {
        if (!map.has(eventType)) map.set(eventType, []);
        const list = map.get(eventType)!;
        if (!list.includes(rule)) list.push(rule);
      }
    }
  }

  return map;
}

// =============================================================================
// Filter Matching
// =============================================================================

function matchesFilter(filter: Record<string, unknown> | undefined, data: unknown): boolean {
  if (!filter) return true;
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(filter)) {
    if (obj[key] !== value) return false;
  }
  return true;
}

// =============================================================================
// Environment Variables from Event Data
// =============================================================================

function buildEnvVars(eventType: string, data: unknown): Record<string, string> {
  const env: Record<string, string> = {
    SPHERE_EVENT: eventType,
    SPHERE_EVENT_JSON: JSON.stringify(data),
    SPHERE_TIMESTAMP: new Date().toISOString(),
  };

  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;

    if (d.senderNametag) env.SPHERE_SENDER = String(d.senderNametag);
    else if (d.senderPubkey) env.SPHERE_SENDER = String(d.senderPubkey);
    else if (d.authorNametag) env.SPHERE_SENDER = String(d.authorNametag);
    else if (d.authorPubkey) env.SPHERE_SENDER = String(d.authorPubkey);

    if (d.amount) env.SPHERE_AMOUNT = String(d.amount);
    if (d.coinId) env.SPHERE_COIN_ID = String(d.coinId);
    if (d.groupId) env.SPHERE_GROUP_ID = String(d.groupId);

    if (d.content) env.SPHERE_MESSAGE = String(d.content);
    else if (d.memo) env.SPHERE_MESSAGE = String(d.memo);
    else if (d.message) env.SPHERE_MESSAGE = String(d.message);

    // For incoming transfers, sum token amounts
    if (Array.isArray(d.tokens) && d.tokens.length > 0 && !d.amount) {
      try {
        const total = d.tokens.reduce((sum: bigint, t: Record<string, unknown>) => {
          return sum + BigInt(String(t.amount || '0'));
        }, BigInt(0));
        env.SPHERE_AMOUNT = total.toString();
      } catch {
        // Ignore amount calculation errors
      }
    }
  }

  return env;
}

// =============================================================================
// Action Executors
// =============================================================================

function executeBash(action: BashAction, envVars: Record<string, string>, globalTimeout: number): Promise<void> {
  const timeout = action.timeout || globalTimeout;
  return new Promise<void>((resolve) => {
    const child = exec(action.command, {
      env: { ...process.env, ...envVars },
      timeout,
      cwd: action.cwd || process.cwd(),
    }, (error, stdout, stderr) => {
      if (error) {
        log(`  [BASH ERROR] ${action.command}: ${error.message}`);
      }
      if (stdout) {
        for (const line of stdout.trimEnd().split('\n')) {
          log(`  [BASH] ${line}`);
        }
      }
      if (stderr) {
        for (const line of stderr.trimEnd().split('\n')) {
          log(`  [BASH STDERR] ${line}`);
        }
      }
      resolve();
    });

    // Pipe event JSON to stdin.
    // Steelman³⁸ warning: attach an 'error' listener BEFORE writing.
    // Without it, an EPIPE from a fast-exiting child (e.g.,
    // command-not-found, misconfigured shell) escalates to
    // uncaughtException → daemon process crashes mid-event-dispatch.
    if (child.stdin) {
      child.stdin.on('error', () => { /* swallow EPIPE etc — child exit logged separately */ });
      try {
        child.stdin.write(envVars.SPHERE_EVENT_JSON);
        child.stdin.end();
      } catch { /* sync write throws are caught here too */ }
    }
  });
}

async function executeWebhook(action: WebhookAction, eventType: string, data: unknown, globalTimeout: number): Promise<void> {
  const timeout = action.timeout || Math.min(globalTimeout, 10000);
  const method = action.method || 'POST';
  const body = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(action.url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...action.headers,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      log(`  [WEBHOOK ERROR] ${action.url}: HTTP ${response.status}`);
    } else {
      log(`  [WEBHOOK] ${action.url}: ${response.status}`);
    }
  } catch (err) {
    log(`  [WEBHOOK ERROR] ${action.url}: ${err instanceof Error ? err.message : err}`);
  }
}

async function executeAutoReceive(action: BuiltinAction, sphere: Sphere): Promise<void> {
  try {
    const finalize = action.finalize !== false;
    const result = await sphere.payments.receive({ finalize });
    log(`  [AUTO-RECEIVE] Received ${result.transfers.length} transfer(s), finalize=${finalize}`);
    try {
      await sphere.payments.sync();
      log('  [AUTO-RECEIVE] Synced with IPFS');
    } catch (err) {
      log(`  [AUTO-RECEIVE] Sync warning: ${err instanceof Error ? err.message : err}`);
    }
  } catch (err) {
    log(`  [AUTO-RECEIVE ERROR] ${err instanceof Error ? err.message : err}`);
  }
}

function executeLogToFile(action: BuiltinAction, eventType: string, data: unknown): void {
  const filePath = action.path!;
  try {
    ensureDir(filePath);
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event: eventType,
      data,
    }) + '\n';
    fs.appendFileSync(filePath, entry);
    log(`  [LOG] → ${filePath}`);
  } catch (err) {
    log(`  [LOG ERROR] ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
}

// =============================================================================
// Action Dispatch
// =============================================================================

async function executeAction(
  action: DaemonAction,
  eventType: string,
  data: unknown,
  envVars: Record<string, string>,
  sphere: Sphere,
  globalTimeout: number,
): Promise<void> {
  switch (action.type) {
    case 'bash':
      await executeBash(action, envVars, globalTimeout);
      break;
    case 'webhook':
      await executeWebhook(action, eventType, data, globalTimeout);
      break;
    case 'builtin':
      if (action.action === 'auto-receive') {
        await executeAutoReceive(action, sphere);
      } else if (action.action === 'log-to-file') {
        executeLogToFile(action, eventType, data);
      }
      break;
  }
}

async function dispatchRule(
  rule: DaemonRule,
  eventType: string,
  data: unknown,
  envVars: Record<string, string>,
  sphere: Sphere,
  globalTimeout: number,
): Promise<void> {
  const ruleName = rule.name || '(unnamed)';

  if (!matchesFilter(rule.filter, data)) return;

  const actionNames = rule.actions.map(a => {
    if (a.type === 'builtin') return a.action;
    if (a.type === 'bash') return `bash`;
    return a.type;
  }).join(', ');

  log(`[${new Date().toISOString()}] EVENT ${eventType} | rule:${ruleName} | actions: ${actionNames}`);

  if (rule.sequential) {
    for (const action of rule.actions) {
      await executeAction(action, eventType, data, envVars, sphere, globalTimeout);
    }
  } else {
    await Promise.all(
      rule.actions.map(action =>
        executeAction(action, eventType, data, envVars, sphere, globalTimeout)
      )
    );
  }
}

// =============================================================================
// Logging
// =============================================================================

let logStream: fs.WriteStream | null = null;
let verboseMode = false;

function log(message: string): void {
  const line = message.startsWith('[') ? message : `[${new Date().toISOString()}] ${message}`;
  if (logStream) {
    logStream.write(line + '\n');
  }
  console.log(line);
}

// =============================================================================
// Market Feed Integration
// =============================================================================

function setupMarketFeed(
  sphere: Sphere,
  dispatchMap: Map<SphereEventType, DaemonRule[]>,
  globalTimeout: number,
): (() => void) | null {
  if (!sphere.market) {
    log('Warning: Market module not available, skipping market feed');
    return null;
  }

  // Market feed events are dispatched as synthetic "market:feed" rules
  const marketRules = dispatchMap.get('market:feed' as SphereEventType);
  if (!marketRules || marketRules.length === 0) return null;

  const unsubscribe = sphere.market.subscribeFeed((message) => {
    const envVars = buildEnvVars('market:feed', message);
    for (const rule of marketRules) {
      dispatchRule(rule, 'market:feed', message, envVars, sphere, globalTimeout).catch(err => {
        log(`[DISPATCH ERROR] market:feed: ${err instanceof Error ? err.message : err}`);
      });
    }
  });

  log('Subscribed to market feed');
  return unsubscribe;
}

// =============================================================================
// runDaemon — Foreground Mode
// =============================================================================

export async function runDaemon(
  args: string[],
  getSphere: () => Promise<Sphere>,
  closeSphere: () => Promise<void>,
): Promise<void> {
  const flags = parseDaemonFlags(args);

  // Detach mode: fork and exit parent
  if (flags.detach && !flags._forked) {
    return detachDaemon(args, flags);
  }

  // Build or load config
  let config: ResolvedDaemonConfig;
  try {
    const rawConfig = buildConfigFromFlags(flags);
    config = resolveConfig(rawConfig);
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  verboseMode = flags.verbose;

  // In forked mode, redirect stdout/stderr to log file
  if (flags._forked) {
    ensureDir(config.logFile);
    // Steelman³⁸ warning: bounded log rotation. Without this, a daemon
    // running for days at high event volume fills the disk and crashes.
    // Strategy: at startup, rotate <log>→<log>.1 if size > LOG_ROTATE_BYTES
    // (10 MiB default). Keep the previous one as <log>.1 (single
    // rotation; older logs are dropped). Operators can wire logrotate
    // for richer retention.
    const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
    try {
      const st = fs.statSync(config.logFile);
      if (st.isFile() && st.size > LOG_ROTATE_BYTES) {
        const prev = config.logFile + '.1';
        try { fs.unlinkSync(prev); } catch { /* prev may not exist */ }
        fs.renameSync(config.logFile, prev);
      }
    } catch { /* logFile may not exist yet */ }
    const stream = fs.createWriteStream(config.logFile, { flags: 'a' });
    logStream = stream;
    // Redirect console output to log file
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => { stream.write(a.map(String).join(' ') + '\n'); };
    console.error = (...a: unknown[]) => { stream.write('[ERROR] ' + a.map(String).join(' ') + '\n'); };
    console.warn = (...a: unknown[]) => { stream.write('[WARN] ' + a.map(String).join(' ') + '\n'); };

    // Write PID file with mode 0o600 (owner-read/write only).
    // Steelman²⁸ warning: world-writable PID files allow a local attacker
    // to overwrite the PID with an arbitrary user-owned process number,
    // turning `daemon stop` into a kill-arbitrary-process gadget.
    //
    // Also write a sibling canary file with the daemon's exec path +
    // start-time token; `daemon stop` cross-validates before signaling so
    // a stale PID that was recycled by an unrelated process is not killed.
    ensureDir(config.pidFile);
    const pidString = String(process.pid);
    fs.writeFileSync(config.pidFile, pidString, { mode: 0o600 });
    try { fs.chmodSync(config.pidFile, 0o600); } catch { /* best-effort */ }
    const canaryPath = config.pidFile + '.canary';
    const canaryToken = `${process.execPath}\n${process.pid}\n${Date.now()}\n`;
    fs.writeFileSync(canaryPath, canaryToken, { mode: 0o600 });
    try { fs.chmodSync(canaryPath, 0o600); } catch { /* best-effort */ }

    // Disconnect from parent
    if (process.disconnect) process.disconnect();

    // Restore on exit for cleanup logging
    process.on('exit', () => {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    });
  }

  // Filter out disabled rules
  const activeRules = config.rules.filter(r => !r.disabled);
  if (activeRules.length === 0) {
    log('No active rules in config. Nothing to do.');
    process.exit(0);
  }

  // Build dispatch map
  const dispatchMap = buildDispatchMap(activeRules);
  const subscribedEvents = [...dispatchMap.keys()].filter(e => e !== 'market:feed' as string);

  log('Starting Sphere daemon...');
  log(`Active rules: ${activeRules.length}`);
  log(`Subscribed events: ${subscribedEvents.join(', ') || '(none)'}`);
  if (config.marketFeed || dispatchMap.has('market:feed' as SphereEventType)) {
    log('Market feed: enabled');
  }

  // Initialize Sphere
  let sphere: Sphere;
  try {
    sphere = await getSphere();
  } catch (err) {
    log(`Failed to initialize Sphere: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const identity = sphere.identity;
  if (identity) {
    log(`Wallet: ${identity.nametag ? '@' + identity.nametag : identity.l1Address}`);
  }

  // Subscribe to events
  const unsubscribers: (() => void)[] = [];

  for (const eventType of subscribedEvents) {
    const rules = dispatchMap.get(eventType)!;
    const unsub = sphere.on(eventType, (data: unknown) => {
      if (verboseMode) {
        log(`[${new Date().toISOString()}] EVENT ${eventType} data=${JSON.stringify(data)}`);
      }
      const envVars = buildEnvVars(eventType, data);
      for (const rule of rules) {
        dispatchRule(rule, eventType, data, envVars, sphere, config.actionTimeout).catch(err => {
          log(`[DISPATCH ERROR] ${eventType}: ${err instanceof Error ? err.message : err}`);
        });
      }
    });
    unsubscribers.push(unsub);
  }

  // Market feed
  if (config.marketFeed || dispatchMap.has('market:feed' as SphereEventType)) {
    const unsub = setupMarketFeed(sphere, dispatchMap, config.actionTimeout);
    if (unsub) unsubscribers.push(unsub);
  }

  log('Daemon running. Waiting for events...');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down daemon...');

    for (const unsub of unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }

    try { await closeSphere(); } catch { /* ignore */ }

    // Clean up PID file
    if (flags._forked || flags.detach) {
      try {
        if (fs.existsSync(config.pidFile)) fs.unlinkSync(config.pidFile);
      } catch { /* ignore */ }
    }

    if (logStream) {
      logStream.end();
      logStream = null;
    }

    log('Daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

// =============================================================================
// Detach Mode
// =============================================================================

function detachDaemon(args: string[], flags: DaemonFlags): void {
  // Build the resolved config just to get the PID file path
  let pidFile: string;
  try {
    const rawConfig = buildConfigFromFlags(flags);
    const config = resolveConfig(rawConfig);
    pidFile = config.pidFile;
  } catch {
    pidFile = getDefaultPidFile();
  }

  // Check if already running
  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isProcessAlive(existingPid)) {
      console.error(`Daemon already running (PID ${existingPid}). Use "daemon stop" first.`);
      process.exit(1);
    }
    // Stale PID file — clean up alongside its canary file so a
    // pre-existing forged canary doesn't outlive the unlinked pidFile.
    fs.unlinkSync(pidFile);
    const staleCanary = pidFile + '.canary';
    if (fs.existsSync(staleCanary)) fs.unlinkSync(staleCanary);
  }

  // Build child args: replace --detach with --_forked, keep everything else
  const childArgs = ['daemon', 'start', '--_forked', ...args.filter(a => a !== '--detach')];

  // Steelman²⁸ warning: `fork()` runs the entry-script via Node directly
  // (no tsx). When the CLI is invoked from source via tsx and entry is a
  // .ts file, the child dies immediately because Node can't execute .ts
  // — the parent reports success and writes a misleading PID file.
  // Detect this and refuse with a clear error.
  const entryPath = process.argv[1] ?? '';
  if (entryPath.endsWith('.ts') || entryPath.endsWith('.tsx')) {
    console.error(
      `--detach requires a Node-executable entry script; got "${entryPath}" ` +
        `which Node cannot run directly. Either install the compiled CLI ` +
        `(npm i / npm run build) or omit --detach to run in foreground.`,
    );
    process.exit(1);
  }

  // Fork the child process
  const child = fork(entryPath, childArgs, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  console.log(`Daemon started in background (PID ${child.pid})`);
  console.log(`PID file: ${pidFile}`);

  if (flags.logFile) {
    console.log(`Log file: ${flags.logFile}`);
  } else {
    console.log('Log file: .sphere-cli/daemon.log');
  }

  process.exit(0);
}

// =============================================================================
// stopDaemon
// =============================================================================

export async function stopDaemon(args: string[]): Promise<void> {
  const flags = parseDaemonFlags(args);
  const pidFile = flags.pidFile || getDefaultPidFile();

  if (!fs.existsSync(pidFile)) {
    console.log('No daemon running (PID file not found).');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);

  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`Refusing to signal invalid PID "${pid}" from PID file.`);
    process.exit(1);
  }

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (process ${pid} not running). Cleaning up.`);
    fs.unlinkSync(pidFile);
    const canaryPath = pidFile + '.canary';
    if (fs.existsSync(canaryPath)) fs.unlinkSync(canaryPath);
    return;
  }

  // Steelman²⁸ warning: cross-validate the canary before signaling.
  // Without this, a stale PID file whose number got recycled by an
  // unrelated user-owned process can be SIGTERM/SIGKILL'd by daemon stop.
  const canaryPath = pidFile + '.canary';
  if (!fs.existsSync(canaryPath)) {
    console.error(
      `Refusing to signal PID ${pid}: no canary file at ${canaryPath}. ` +
        `The PID file may be stale or attacker-supplied. Inspect manually.`,
    );
    process.exit(1);
  }
  const canary = fs.readFileSync(canaryPath, 'utf8').split('\n');
  const [canaryExec, canaryPidStr] = canary;
  if (canaryPidStr !== String(pid)) {
    console.error(
      `Refusing to signal PID ${pid}: canary file references a different PID ` +
        `(${canaryPidStr}). Inspect ${canaryPath} manually.`,
    );
    process.exit(1);
  }
  // Best-effort: check /proc/<pid>/exe to confirm it's our daemon.
  // Linux-only; on macOS / other this is skipped silently.
  try {
    const procExe = fs.readlinkSync(`/proc/${pid}/exe`);
    if (canaryExec && procExe !== canaryExec) {
      console.error(
        `Refusing to signal PID ${pid}: /proc/${pid}/exe (${procExe}) does ` +
          `not match canary execPath (${canaryExec}). Stale PID likely recycled.`,
      );
      process.exit(1);
    }
  } catch {
    // /proc not available (non-Linux) or permission denied — skip.
  }

  console.log(`Stopping daemon (PID ${pid})...`);

  // Send SIGTERM
  process.kill(pid, 'SIGTERM');

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isProcessAlive(pid)) {
      console.log('Daemon stopped.');
      // Clean up PID file + canary if they still exist
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      if (fs.existsSync(canaryPath)) fs.unlinkSync(canaryPath);
      return;
    }
  }

  // Force kill
  console.log('Graceful shutdown timed out, sending SIGKILL...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have exited between check and kill
  }

  await sleep(500);

  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  console.log('Daemon killed.');
}

// =============================================================================
// statusDaemon
// =============================================================================

export async function statusDaemon(args: string[]): Promise<void> {
  const flags = parseDaemonFlags(args);
  const pidFile = flags.pidFile || getDefaultPidFile();

  if (!fs.existsSync(pidFile)) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);

  if (!isProcessAlive(pid)) {
    console.log(`Daemon is not running (stale PID file, process ${pid}).`);
    return;
  }

  console.log(`Daemon is running (PID ${pid}).`);
  console.log(`PID file: ${path.resolve(pidFile)}`);

  // Try to show config summary
  try {
    const rawConfig = buildConfigFromFlags(flags);
    const config = resolveConfig(rawConfig);
    console.log(`Log file: ${path.resolve(config.logFile)}`);
    console.log(`Rules: ${config.rules.filter(r => !r.disabled).length} active`);
    if (config.marketFeed) console.log('Market feed: enabled');
  } catch {
    // Config may not be loadable without full flags
  }
}

// =============================================================================
// Helpers
// =============================================================================

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
