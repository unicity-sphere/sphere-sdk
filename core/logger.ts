/**
 * Centralized SDK Logger
 *
 * Lightweight singleton logger that works across all tsup bundles by storing
 * state on globalThis. Issue #274 extends the original three-level logger
 * (`debug | warn | error`) with timestamps, env/localStorage bootstrap,
 * namespace globs, level qualifiers, lazy message builders, timing spans,
 * secret redaction, and pluggable sinks.
 *
 * Back-compat: the legacy call shapes still work unchanged.
 *
 * ```ts
 * logger.configure({ debug: true });        // existing
 * logger.setTagDebug('Nostr', true);        // existing
 * logger.debug('Payments', 'sent', { id }); // existing — single-tag
 * logger.warn('Sphere', 'degraded');        // existing
 * ```
 *
 * New surface:
 *
 * ```ts
 * // Per-namespace toggle via env: SPHERE_DEBUG=payments:*,transport:nostr=trace
 * // Per-namespace toggle via localStorage in browsers.
 * // Runtime toggle:
 * setDebug('payments:*,transport:nostr=trace');
 * disableDebug();
 * listDebug();
 *
 * const span = logger.time('Payments', 'send', { recipient: '@bob' });
 * span.mark('split-planned', { sources: 4 });
 * span.end({ ok: true });   // -> one debug line with durationMs + marks
 *
 * // Pluggable sinks (default = console). Multiple sinks allowed; ring buffer
 * // included for `sphere debug timings`-style summaries.
 * const buf = createRingBufferSink(1024);
 * const remove = addSink(buf);
 * ```
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Per-level integer for fast comparison. */
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** Lowest level always emitted regardless of toggles (existing behaviour). */
const ALWAYS_LEVEL_RANK = LEVEL_RANK.warn;

/**
 * Legacy handler signature. Pre-existing consumers receive 'debug'|'warn'|'error'
 * only — the new `trace`/`info` levels are downgraded to 'debug' before being
 * passed to a legacy handler to keep its switch-statement exhaustive.
 */
export type LogHandler = (
  level: 'debug' | 'warn' | 'error',
  tag: string,
  message: string,
  ...args: unknown[]
) => void;

export interface LoggerConfig {
  /** Global debug toggle (legacy). Enables `debug` level for all tags lacking an override. */
  debug?: boolean;
  /** Legacy single-sink shim. Setting `handler` removes all sinks except this one. */
  handler?: LogHandler | null;
  /**
   * Prepend ISO-8601 ms timestamp + level + namespace to each line. Defaults
   * to true once any namespace is enabled at debug-or-lower; false otherwise.
   * Pass explicit boolean to override.
   */
  timestamps?: boolean;
  /** Honour the redaction denylist on `fields` / args (default true). */
  redaction?: boolean;
}

export interface LogRecord {
  ts: number;
  level: LogLevel;
  namespace: string;
  message: string;
  fields?: Record<string, unknown>;
  /** Extra positional args from the legacy `logger.debug(tag, msg, ...args)` signature. */
  args?: unknown[];
}

export interface LogSink {
  /**
   * `formatted` is the default-formatted single-line string the console sink
   * would emit. Custom sinks can ignore it and re-render from the record.
   */
  write(record: LogRecord, formatted: string): void;
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface Span {
  /** Record a checkpoint with elapsed-ms-from-start. Buffered into the span. */
  mark(label: string, fields?: Record<string, unknown>): void;
  /** Elapsed ms since the span was created. */
  elapsed(): number;
  /**
   * End the span successfully. Emits ONE `debug`-level record carrying
   * `{ spanName, durationMs, marks: [...] }`. Returns durationMs.
   */
  end(extraFields?: Record<string, unknown>): number;
  /**
   * End the span with error. Emits ONE `warn`-level record carrying the err
   * message + marks. Returns durationMs.
   */
  endWithError(err: unknown, extraFields?: Record<string, unknown>): number;
}

export interface NamespacedLogger {
  readonly namespace: string;
  isEnabled(level: LogLevel): boolean;
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown> | Error): void;
  /** Lazy form — `build()` is only invoked when the level passes the gate. */
  traceLazy(build: () => [string, Record<string, unknown>?]): void;
  debugLazy(build: () => [string, Record<string, unknown>?]): void;
  /** Child logger with appended namespace segment, e.g. 'payments' -> 'payments:send'. */
  child(suffix: string): NamespacedLogger;
  /** Timing span helper — emits one line at .end() / .endWithError(). */
  time(spanName: string, initialFields?: Record<string, unknown>): Span;
}

// -----------------------------------------------------------------------------
// Singleton state (shared across tsup bundles via globalThis)
// -----------------------------------------------------------------------------

const LOGGER_KEY = '__sphere_sdk_logger__';

interface LoggerState {
  /** Legacy global debug flag — debug for everything not overridden. */
  debug: boolean;
  /** Legacy per-tag boolean override. Wins over global, loses to namespace levels. */
  tags: Record<string, boolean>;
  /**
   * Per-namespace level cap. A log at level L passes iff
   * `LEVEL_RANK[L] >= LEVEL_RANK[levels[ns]]` for the namespace (or an ancestor
   * via colon-segment cascade).
   */
  levels: Record<string, LogLevel>;
  /** Legacy single-handler shim. If set, takes precedence over `sinks`. */
  handler: LogHandler | null;
  sinks: LogSink[];
  /**
   * Prepend ISO timestamp + level to formatted lines. Defaults to false to
   * preserve the legacy `[Tag] message` console shape. Auto-enabled when an
   * env / runtime spec is applied (issue #274). Consumers can opt in/out
   * explicitly via `configure({ timestamps })`.
   */
  timestamps: boolean;
  redaction: boolean;
  envBootstrapped: boolean;
}

function getState(): LoggerState {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[LOGGER_KEY] as Partial<LoggerState> | undefined;
  if (!existing) {
    const fresh: LoggerState = {
      debug: false,
      tags: {},
      levels: {},
      handler: null,
      sinks: [],
      timestamps: false,
      redaction: true,
      envBootstrapped: false,
    };
    g[LOGGER_KEY] = fresh;
    bootstrapFromEnv(fresh);
    return fresh;
  }
  // Migrate from older shape (pre-#274) that may be missing the new fields.
  if (existing.levels === undefined) existing.levels = {};
  if (existing.sinks === undefined) existing.sinks = [];
  if (existing.timestamps === undefined) existing.timestamps = false;
  if (existing.redaction === undefined) existing.redaction = true;
  if (existing.envBootstrapped === undefined) {
    existing.envBootstrapped = false;
    bootstrapFromEnv(existing as LoggerState);
  }
  return existing as LoggerState;
}

// -----------------------------------------------------------------------------
// Env / localStorage bootstrap
// -----------------------------------------------------------------------------

function readEnvSpec(): string | null {
  // Node.js — guard for browser ESM where `process` is unavailable.
  try {
    if (typeof process !== 'undefined' && process?.env) {
      const v = process.env.SPHERE_DEBUG ?? process.env.SPHERE_LOG;
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // ignore
  }
  // Browser — localStorage access can throw in private mode / sandboxed iframes.
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('SPHERE_DEBUG');
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // ignore
  }
  return null;
}

function bootstrapFromEnv(state: LoggerState): void {
  if (state.envBootstrapped) return;
  state.envBootstrapped = true;
  const spec = readEnvSpec();
  if (spec) applySpec(state, spec);
}

// -----------------------------------------------------------------------------
// Spec parsing — `payments:*,transport:nostr=trace,-storage:*`
// -----------------------------------------------------------------------------

const VALID_LEVELS: ReadonlySet<string> = new Set(['trace', 'debug', 'info', 'warn', 'error']);

interface SpecEntry {
  pattern: string;
  level: LogLevel;
  negate: boolean;
}

/**
 * DoS bound from security review H2 (issue #274): a malicious
 * `localStorage.SPHERE_DEBUG` or process-env value cannot blow up state.
 * Caps spec length at 8 KB and entry count at 256. Patterns are required to
 * match a conservative allowlist so they cannot smuggle control characters
 * into namespace strings (additional defense-in-depth against C3).
 */
const SPEC_MAX_LENGTH = 8 * 1024;
const SPEC_MAX_ENTRIES = 256;
const SPEC_PATTERN_RE = /^[A-Za-z0-9:_*\-]{1,128}$/;

function parseSpec(spec: string): SpecEntry[] {
  const out: SpecEntry[] = [];
  if (spec.length > SPEC_MAX_LENGTH) {
    try {
      // eslint-disable-next-line no-console
      console.warn(`[logger] SPHERE_DEBUG spec exceeds ${SPEC_MAX_LENGTH} bytes — rejecting`);
    } catch {
      // ignore
    }
    return out;
  }
  let processed = 0;
  for (const rawEntry of spec.split(',')) {
    if (processed >= SPEC_MAX_ENTRIES) {
      try {
        // eslint-disable-next-line no-console
        console.warn(`[logger] SPHERE_DEBUG spec exceeds ${SPEC_MAX_ENTRIES} entries — truncating`);
      } catch {
        // ignore
      }
      break;
    }
    processed += 1;
    const trimmed = rawEntry.trim();
    if (!trimmed) continue;
    let pattern = trimmed;
    let level: LogLevel = 'debug';
    const negate = pattern.startsWith('-') || pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1).trim();
    const eq = pattern.indexOf('=');
    if (eq >= 0) {
      const levelPart = pattern.slice(eq + 1).trim().toLowerCase();
      pattern = pattern.slice(0, eq).trim();
      if (VALID_LEVELS.has(levelPart)) {
        level = levelPart as LogLevel;
      } else if (levelPart.length > 0) {
        // Surface the typo on a level the operator hasn't disabled, since
        // gating themselves on `warn` would be a chicken-and-egg problem.
        // Emit directly through console — the logger itself is mid-config.
        try {
          // eslint-disable-next-line no-console
          console.warn(
            `[logger] SPHERE_DEBUG entry "${rawEntry.trim()}": unknown level "${levelPart}" — ` +
              `falling back to "debug". Valid: trace, debug, info, warn, error.`,
          );
        } catch {
          // ignore
        }
      }
    }
    if (!pattern) continue;
    // Pattern allowlist — reject anything that could carry control characters
    // or other forms of injection. `\0`, `\n`, etc. would otherwise reach
    // `[${ns}]` formatting via legitimate-looking entries.
    if (!SPEC_PATTERN_RE.test(pattern)) {
      try {
        // eslint-disable-next-line no-console
        console.warn(`[logger] SPHERE_DEBUG entry has invalid pattern "${pattern}" — skipping`);
      } catch {
        // ignore
      }
      continue;
    }
    out.push({ pattern, level, negate });
  }
  return out;
}

/**
 * Apply a spec to `state.levels` and `state.tags`. Entries processed in order;
 * later entries override earlier ones (debug-style `last match wins`).
 * No-op when the spec parses to zero entries (e.g. `setDebug('')`,
 * `setDebug(',,')`) — in particular, does NOT toggle timestamps.
 */
function applySpec(state: LoggerState, spec: string): void {
  const entries = parseSpec(spec);
  if (entries.length === 0) return;
  for (const entry of entries) {
    // A `*`-only pattern flips the global debug flag for full back-compat with
    // legacy tags lacking an explicit level override.
    if (entry.pattern === '*' && !entry.negate) {
      state.debug = LEVEL_RANK[entry.level] <= LEVEL_RANK.debug;
      // Also drop the wildcard into levels so info/trace specs win against
      // legacy `tags[]` overrides.
      state.levels['*'] = entry.level;
      continue;
    }
    if (entry.negate) {
      // Negation means "raise minimum to warn for this pattern".
      state.levels[entry.pattern] = 'warn';
    } else {
      state.levels[entry.pattern] = entry.level;
    }
  }
  // Spec application implies the operator wants structured debugging output
  // — auto-enable timestamps. `configure({ timestamps: false })` afterwards
  // can still turn them off.
  state.timestamps = true;
}

// -----------------------------------------------------------------------------
// Namespace matching
// -----------------------------------------------------------------------------

/** Walks the namespace tree from most-specific to least. */
function* namespaceAncestors(ns: string): Generator<string> {
  if (!ns) {
    yield '*';
    return;
  }
  let cursor = ns;
  while (true) {
    yield cursor;
    yield `${cursor}:*`;
    const idx = cursor.lastIndexOf(':');
    if (idx <= 0) break;
    cursor = cursor.slice(0, idx);
  }
  yield '*';
}

/**
 * Resolve the minimum LogLevel allowed for `namespace`. Walks ancestors so a
 * spec like `payments:*=trace` matches `payments:send:execute`. Falls back to
 * the legacy `tags[]` boolean and the global `state.debug` flag.
 */
function resolveMinLevel(state: LoggerState, namespace: string): LogLevel {
  // Most-specific level override wins.
  for (const candidate of namespaceAncestors(namespace)) {
    const lvl = state.levels[candidate];
    if (lvl) return lvl;
  }
  // Legacy single-segment tag toggle (e.g. `setTagDebug('Nostr', true)`).
  // Only checked at the leaf for back-compat with the original API.
  if (namespace in state.tags) {
    return state.tags[namespace] ? 'debug' : 'warn';
  }
  return state.debug ? 'debug' : 'warn';
}

function isLevelEnabled(state: LoggerState, namespace: string, level: LogLevel): boolean {
  if (LEVEL_RANK[level] >= ALWAYS_LEVEL_RANK) return true; // warn/error always on
  const min = resolveMinLevel(state, namespace);
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

/**
 * Lowercase-normalised exact key matches. Extended per security review C2
 * (issue #274) to cover every secret-bearing field name found in the SDK
 * codebase: BIP-32 master + chaincode, AES encryption keys, IPFS Ed25519
 * peer keys, ALPHA WIF, OAuth/bearer tokens, raw cipher material.
 */
const REDACT_KEYS = new Set([
  // BIP-32 / BIP-39 / wallet secrets
  'privatekey',
  'private_key',
  'priv',
  'privkey',
  'priv_key',
  'masterkey',
  'master_key',
  'chaincode',
  'chain_code',
  'mnemonic',
  'seed',
  'seedphrase',
  'seed_phrase',
  'recoveryphrase',
  'recovery_phrase',
  'wif',
  'xpriv',
  'xprv',
  // Nostr / transport secrets
  'nsec',
  'nsechex',
  'nsec_hex',
  // Crypto material
  'keymaterial',
  'key_material',
  'rawkey',
  'raw_key',
  'keyhex',
  'key_hex',
  'signingkey',
  'signing_key',
  'attestkey',
  'attest_key',
  'hmackey',
  'hmac_key',
  'encryptionkey',
  'encryption_key',
  'ciphertext',
  'iv',
  'salt',
  'nonce',
  // IPFS / libp2p
  'peerid',
  'peer_id',
  'ipnskey',
  'ipns_key',
  'ipns_private_key',
  // Auth tokens
  'secret',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessiontoken',
  'session_token',
  'bearer',
  'authorization',
  'auth',
  'token',
  // Generic password
  'password',
  'passphrase',
]);

/**
 * Three alternatives:
 *   1. snake_case / kebab / dot — boundary on both sides
 *      `user_secret`, `api_key`, `priv-key`, `my.password`, `seed_phrase`
 *   2. lowercase-leading camelCase / PascalCase — `userSecret`, `myPrivateKey`,
 *      `ApiKey`, `URLSecret` (uppercase before capitalized term).
 *   3. lowercase camelCase compound where the term starts with lowercase
 *      letter — `privKey`, `seedPhrase`, `walletKey`, `nsecHex`. Required
 *      because alts 1/2 miss these per security review C2.
 *
 * Intentional bias toward aggressive redaction: false positives like
 * `mySeedling` are preferable to leaking a real secret.
 */
const REDACT_KEY_RE = new RegExp(
  '(?:^|[._-])(?:secret|priv|private|nsec|mnemonic|seed|password|passphrase|apikey|api_key|bearer|authorization|token|wif|xpriv|xprv|chaincode|masterkey|encryptionkey|hmackey|attestkey|peerid|ipnskey)(?:[._-]|$)' +
    '|(?:^|[a-zA-Z])(?:Secret|Priv|Private|Nsec|Mnemonic|Seed|Password|Passphrase|ApiKey|Bearer|Authorization|Token|Wif|Xpriv|Xprv|ChainCode|MasterKey|EncryptionKey|HmacKey|AttestKey|PeerId|IpnsKey)' +
    '|(?:^|[a-z])(?:priv|seed|nsec|mnemonic|password|secret|wallet|signing|encryption|chain|master|hmac|attest|peer|ipns|cipher|access|refresh|session|api|raw)(?:[A-Z][a-zA-Z]*)?(?:Key|Phrase|Token|Hex|Code|Text|Material)(?:[A-Z]|$|[._-])',
);

function shouldRedactKey(key: string): boolean {
  const k = key.toLowerCase();
  if (REDACT_KEYS.has(k)) return true;
  return REDACT_KEY_RE.test(key);
}

const REDACTED = '[REDACTED]';

const REDACT_MAX_DEPTH = 8;
const REDACT_TRUNCATED = '[REDACTED:depth-exceeded]';

/**
 * Recursively redact denylisted keys at every depth, with a cycle-detection
 * WeakSet and a max-depth cap. Returns a deep-cloned object so subsequent
 * mutations of the caller's input do NOT mutate the recorded log payload —
 * critical for `RingBufferSink` (security review H3, issue #274).
 *
 * Depth cap is fail-closed: at the limit, the value is replaced by the
 * `REDACT_TRUNCATED` sentinel rather than passed through. Without this, a
 * secret nested deeper than the cap would leak silently.
 */
function redactFields(input: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return redactValue(input, 0, seen) as Record<string, unknown>;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (depth >= REDACT_MAX_DEPTH) return REDACT_TRUNCATED;
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACT_TRUNCATED;
    seen.add(value);
    return value.map((el) => redactValue(el, depth + 1, seen));
  }
  if (value instanceof Error) {
    return value; // Errors handled by the sink path; do not deep-clone (preserves prototype).
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return REDACT_TRUNCATED;
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (shouldRedactKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1, seen);
      }
    }
    return out;
  }
  return value;
}

function redactArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return args;
  const seen = new WeakSet<object>();
  return args.map((a) => redactValue(a, 0, seen));
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function pad(level: LogLevel): string {
  // Five chars padded for column alignment.
  switch (level) {
    case 'trace': return 'TRACE';
    case 'debug': return 'DEBUG';
    case 'info':  return 'INFO ';
    case 'warn':  return 'WARN ';
    case 'error': return 'ERROR';
  }
}

/**
 * Escape control characters in a string before it enters the formatted log
 * line. Prevents log-injection (security review C3, issue #274) where a
 * peer-controlled nametag/memo/title containing `\n[ERROR] ...` could forge a
 * fake log entry indistinguishable from real ones in downstream aggregators.
 * Replaces CR, LF, TAB, ANSI escape introducer (0x1b), and other C0 control
 * codes with `\xNN` notation.
 */
function escapeControlChars(s: string): string {
  if (typeof s !== 'string') return String(s);
  // Fast path — most messages have no control chars. Range covers every C0
  // control code (NUL..US) plus DEL.
  if (!/[\x00-\x1f\x7f]/.test(s)) return s;
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code === 0x0a) return '\\n';
    if (code === 0x0d) return '\\r';
    if (code === 0x09) return '\\t';
    if (code === 0x1b) return '\\x1b'; // ANSI escape introducer
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

function formatRecord(state: LoggerState, record: LogRecord): string {
  const wantTs = state.timestamps === true;
  const ts = wantTs ? `[${new Date(record.ts).toISOString()}] ` : '';
  const level = wantTs ? `[${pad(record.level)}] ` : '';
  const ns = `[${escapeControlChars(record.namespace)}]`;
  const safeMessage = escapeControlChars(record.message);
  let msg = `${ts}${level}${ns} ${safeMessage}`;
  if (record.fields && Object.keys(record.fields).length > 0) {
    try {
      // JSON.stringify already escapes \n / \r / \t inside string values, so
      // the fields object cannot be a log-injection vector on its own.
      msg += ` ${JSON.stringify(record.fields)}`;
    } catch {
      msg += ' [unserializable fields]';
    }
  }
  return msg;
}

// -----------------------------------------------------------------------------
// Console sink (default)
// -----------------------------------------------------------------------------

/**
 * Default console sink. When timestamps are off AND no structured `fields` are
 * attached, emits the legacy split shape `console.log('[Tag]', message, ...args)`
 * to keep every pre-#274 test and grep pattern intact. Otherwise emits the
 * single formatted line.
 *
 * The legacy-vs-formatted choice consults `state.timestamps` directly rather
 * than sniffing the formatted string, so a future change to the timestamp
 * format (or millennium rollover) doesn't silently flip behaviour.
 */
const CONSOLE_SINK: LogSink = {
  write(record, formatted) {
    const state = getState();
    const legacy = record.fields === undefined && state.timestamps !== true;
    const target =
      record.level === 'error' ? console.error
        : record.level === 'warn' ? console.warn
        : console.log;
    if (legacy) {
      const prefix = `[${record.namespace}]`;
      if (record.args && record.args.length > 0) target(prefix, record.message, ...record.args);
      else target(prefix, record.message);
    } else {
      if (record.args && record.args.length > 0) target(formatted, ...record.args);
      else target(formatted);
    }
  },
};

// -----------------------------------------------------------------------------
// Ring buffer sink
// -----------------------------------------------------------------------------

export interface RingBufferSink extends LogSink {
  getRecords(): LogRecord[];
  clear(): void;
  capacity: number;
}

export function createRingBufferSink(capacity: number): RingBufferSink {
  const cap = Math.max(1, capacity | 0);
  const buf: (LogRecord | undefined)[] = new Array(cap);
  let head = 0;
  let size = 0;
  return {
    capacity: cap,
    write(record) {
      buf[head] = record;
      head = (head + 1) % cap;
      if (size < cap) size += 1;
    },
    getRecords(): LogRecord[] {
      const out: LogRecord[] = [];
      const start = size < cap ? 0 : head;
      for (let i = 0; i < size; i++) {
        const r = buf[(start + i) % cap];
        if (r) out.push(r);
      }
      return out;
    },
    clear() {
      for (let i = 0; i < cap; i++) buf[i] = undefined;
      head = 0;
      size = 0;
    },
  };
}

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

function emit(
  state: LoggerState,
  level: LogLevel,
  namespace: string,
  message: string,
  fields: Record<string, unknown> | undefined,
  args: unknown[],
): void {
  const safeFields = fields && state.redaction ? redactFields(fields) : fields;
  const safeArgs = args.length && state.redaction ? redactArgs(args) : args;
  const record: LogRecord = {
    ts: Date.now(),
    level,
    namespace,
    message,
    fields: safeFields,
    args: safeArgs.length > 0 ? safeArgs : undefined,
  };

  // Legacy handler shim wins when set (preserves pre-#274 contract).
  if (state.handler) {
    const downgraded: 'debug' | 'warn' | 'error' =
      level === 'warn' || level === 'error' ? level : 'debug';
    state.handler(downgraded, namespace, message, ...(record.args ?? []));
    return;
  }

  // Default sink is always present unless the consumer removed it.
  const sinks = state.sinks.length > 0 ? state.sinks : [CONSOLE_SINK];
  const formatted = formatRecord(state, record);
  for (const sink of sinks) {
    try {
      sink.write(record, formatted);
    } catch (err) {
      // One sink's failure must not block others; surface once via console.error.
      try {
        console.error('[logger] sink threw', err);
      } catch {
        // last-ditch — give up
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Span implementation
// -----------------------------------------------------------------------------

interface MarkRecord {
  label: string;
  elapsedMs: number;
  fields?: Record<string, unknown>;
}

function now(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // ignore
  }
  return Date.now();
}

function makeSpan(
  state: LoggerState,
  namespace: string,
  spanName: string,
  initialFields: Record<string, unknown> | undefined,
): Span {
  const start = now();
  const marks: MarkRecord[] = [];
  let ended = false;
  return {
    mark(label, fields) {
      if (ended) return;
      marks.push({ label, elapsedMs: Math.round((now() - start) * 1000) / 1000, fields });
    },
    elapsed() {
      return Math.round((now() - start) * 1000) / 1000;
    },
    end(extraFields) {
      if (ended) return 0;
      ended = true;
      const dur = Math.round((now() - start) * 1000) / 1000;
      if (!isLevelEnabled(state, namespace, 'debug')) return dur;
      const fields: Record<string, unknown> = {
        ...(initialFields ?? {}),
        ...(extraFields ?? {}),
        spanName,
        durationMs: dur,
      };
      if (marks.length > 0) fields.marks = marks;
      emit(state, 'debug', namespace, `span.end ${spanName}`, fields, []);
      return dur;
    },
    endWithError(err, extraFields) {
      if (ended) return 0;
      ended = true;
      const dur = Math.round((now() - start) * 1000) / 1000;
      // warn level is always enabled — no isLevelEnabled gate.
      const fields: Record<string, unknown> = {
        ...(initialFields ?? {}),
        ...(extraFields ?? {}),
        spanName,
        durationMs: dur,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
      if (marks.length > 0) fields.marks = marks;
      emit(state, 'warn', namespace, `span.error ${spanName}`, fields, []);
      return dur;
    },
  };
}

// -----------------------------------------------------------------------------
// Namespaced logger factory
// -----------------------------------------------------------------------------

function buildNamespacedLogger(namespace: string): NamespacedLogger {
  const ns = namespace || 'root';
  return {
    namespace: ns,
    isEnabled(level) {
      return isLevelEnabled(getState(), ns, level);
    },
    trace(message, fields) {
      const state = getState();
      if (!isLevelEnabled(state, ns, 'trace')) return;
      emit(state, 'trace', ns, message, fields, []);
    },
    debug(message, fields) {
      const state = getState();
      if (!isLevelEnabled(state, ns, 'debug')) return;
      emit(state, 'debug', ns, message, fields, []);
    },
    info(message, fields) {
      const state = getState();
      if (!isLevelEnabled(state, ns, 'info')) return;
      emit(state, 'info', ns, message, fields, []);
    },
    warn(message, fields) {
      const state = getState();
      emit(state, 'warn', ns, message, fields, []);
    },
    error(message, fieldsOrErr) {
      const state = getState();
      let fields: Record<string, unknown> | undefined;
      let args: unknown[] = [];
      if (fieldsOrErr instanceof Error) {
        fields = { err: `${fieldsOrErr.name}: ${fieldsOrErr.message}` };
        args = [fieldsOrErr];
      } else {
        fields = fieldsOrErr;
      }
      emit(state, 'error', ns, message, fields, args);
    },
    traceLazy(build) {
      const state = getState();
      if (!isLevelEnabled(state, ns, 'trace')) return;
      const [msg, fields] = build();
      emit(state, 'trace', ns, msg, fields, []);
    },
    debugLazy(build) {
      const state = getState();
      if (!isLevelEnabled(state, ns, 'debug')) return;
      const [msg, fields] = build();
      emit(state, 'debug', ns, msg, fields, []);
    },
    child(suffix) {
      return buildNamespacedLogger(`${ns}:${suffix}`);
    },
    time(spanName, initialFields) {
      return makeSpan(getState(), ns, spanName, initialFields);
    },
  };
}

export function getLogger(namespace: string): NamespacedLogger {
  return buildNamespacedLogger(namespace);
}

/**
 * Helper for instrumenting a function body with a single timing span. The span
 * is ended on resolve and endWithError'd on reject — so the caller always sees
 * exactly one log line per invocation. Use sparingly on hot paths; spans
 * allocate a marks array even when the namespace is disabled.
 *
 * ```ts
 * const result = await withSpan('payments:receive', 'receive',
 *   { finalize: !!opts?.finalize },
 *   async (span) => {
 *     // body — may call span.mark('events-fetched', { count })
 *     return result;
 *   });
 * ```
 */
export async function withSpan<T>(
  namespace: string,
  spanName: string,
  initialFields: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = makeSpan(getState(), namespace, spanName, initialFields);
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (err) {
    span.endWithError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Runtime control surface
// -----------------------------------------------------------------------------

export function setDebug(spec: string | boolean): void {
  const state = getState();
  if (spec === false) {
    state.debug = false;
    state.levels = {};
    state.tags = {};
    state.timestamps = false;
    return;
  }
  if (spec === true) {
    state.debug = true;
    state.levels['*'] = 'debug';
    state.timestamps = true;
    return;
  }
  applySpec(state, spec);
}

export function disableDebug(): void {
  const state = getState();
  state.debug = false;
  state.levels = {};
  state.tags = {};
  state.timestamps = false;
}

export function listDebug(): { namespace: string; level: LogLevel }[] {
  const state = getState();
  const out: { namespace: string; level: LogLevel }[] = [];
  for (const [ns, level] of Object.entries(state.levels)) {
    out.push({ namespace: ns, level });
  }
  for (const [ns, on] of Object.entries(state.tags)) {
    if (state.levels[ns]) continue;
    out.push({ namespace: ns, level: on ? 'debug' : 'warn' });
  }
  if (state.debug && !state.levels['*']) out.push({ namespace: '*', level: 'debug' });
  return out;
}

export function addSink(sink: LogSink): () => void {
  const state = getState();
  state.sinks.push(sink);
  return () => {
    const i = state.sinks.indexOf(sink);
    if (i >= 0) state.sinks.splice(i, 1);
  };
}

export function clearSinks(): void {
  getState().sinks = [];
}

// -----------------------------------------------------------------------------
// Legacy default export — same shape as pre-#274, with new methods bolted on
// -----------------------------------------------------------------------------

export const logger = {
  configure(config: LoggerConfig): void {
    const state = getState();
    if (config.debug !== undefined) {
      state.debug = config.debug;
    }
    if (config.handler !== undefined) state.handler = config.handler;
    if (config.timestamps !== undefined) state.timestamps = config.timestamps;
    if (config.redaction !== undefined) state.redaction = config.redaction;
  },

  setTagDebug(tag: string, enabled: boolean): void {
    getState().tags[tag] = enabled;
  },

  clearTagDebug(tag: string): void {
    delete getState().tags[tag];
  },

  isDebugEnabled(tag?: string): boolean {
    const state = getState();
    if (tag) return isLevelEnabled(state, tag, 'debug');
    return state.debug || Object.values(state.levels).some((l) => LEVEL_RANK[l] <= LEVEL_RANK.debug);
  },

  /** Legacy single-tag debug. Keeps the `tag, message, ...args` signature. */
  debug(tag: string, message: string, ...args: unknown[]): void {
    const state = getState();
    if (!isLevelEnabled(state, tag, 'debug')) return;
    emit(state, 'debug', tag, message, undefined, args);
  },

  /** Legacy single-tag info — promoted alias for `debug`. */
  info(tag: string, message: string, ...args: unknown[]): void {
    const state = getState();
    if (!isLevelEnabled(state, tag, 'info')) return;
    emit(state, 'info', tag, message, undefined, args);
  },

  /** Legacy single-tag trace — gated by trace-or-lower namespace level. */
  trace(tag: string, message: string, ...args: unknown[]): void {
    const state = getState();
    if (!isLevelEnabled(state, tag, 'trace')) return;
    emit(state, 'trace', tag, message, undefined, args);
  },

  warn(tag: string, message: string, ...args: unknown[]): void {
    emit(getState(), 'warn', tag, message, undefined, args);
  },

  error(tag: string, message: string, ...args: unknown[]): void {
    emit(getState(), 'error', tag, message, undefined, args);
  },

  /** Per-tag span helper — same as `getLogger(tag).time(...)`. */
  time(tag: string, spanName: string, initialFields?: Record<string, unknown>): Span {
    return makeSpan(getState(), tag, spanName, initialFields);
  },

  /** Reset all logger state. Primarily for tests. */
  reset(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[LOGGER_KEY];
  },
};
