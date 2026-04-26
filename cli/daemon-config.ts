/**
 * Daemon configuration: interfaces, validation, loading, and CLI flag parsing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// =============================================================================
// Interfaces
// =============================================================================

export interface DaemonConfig {
  logFile?: string;
  pidFile?: string;
  marketFeed?: boolean;
  actionTimeout?: number;
  rules: DaemonRule[];
}

export interface DaemonRule {
  name?: string;
  events: string[];
  filter?: Record<string, unknown>;
  actions: DaemonAction[];
  sequential?: boolean;
  disabled?: boolean;
}

export type DaemonAction = BashAction | WebhookAction | BuiltinAction;

export interface BashAction {
  type: 'bash';
  command: string;
  timeout?: number;
  cwd?: string;
}

export interface WebhookAction {
  type: 'webhook';
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  method?: 'POST' | 'PUT';
}

export interface BuiltinAction {
  type: 'builtin';
  action: 'auto-receive' | 'log-to-file';
  path?: string;
  finalize?: boolean;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_CONFIG_PATH = './.sphere-cli/daemon.json';
const DEFAULT_LOG_FILE = './.sphere-cli/daemon.log';
const DEFAULT_PID_FILE = './.sphere-cli/daemon.pid';
const DEFAULT_ACTION_TIMEOUT = 30000;

// =============================================================================
// Validation
// =============================================================================

export function validateDaemonConfig(config: unknown): DaemonConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Daemon config must be a JSON object');
  }

  const c = config as Record<string, unknown>;

  if (c.logFile !== undefined && typeof c.logFile !== 'string') {
    throw new Error('logFile must be a string');
  }
  if (c.pidFile !== undefined && typeof c.pidFile !== 'string') {
    throw new Error('pidFile must be a string');
  }
  if (c.marketFeed !== undefined && typeof c.marketFeed !== 'boolean') {
    throw new Error('marketFeed must be a boolean');
  }
  if (c.actionTimeout !== undefined) {
    if (typeof c.actionTimeout !== 'number' || c.actionTimeout <= 0) {
      throw new Error('actionTimeout must be a positive number');
    }
  }

  if (!Array.isArray(c.rules)) {
    throw new Error('rules must be an array');
  }

  const rules = c.rules.map((rule: unknown, i: number) => validateRule(rule, i));

  return {
    logFile: c.logFile as string | undefined,
    pidFile: c.pidFile as string | undefined,
    marketFeed: c.marketFeed as boolean | undefined,
    actionTimeout: c.actionTimeout as number | undefined,
    rules,
  };
}

function validateRule(rule: unknown, index: number): DaemonRule {
  if (!rule || typeof rule !== 'object') {
    throw new Error(`rules[${index}]: must be an object`);
  }

  const r = rule as Record<string, unknown>;

  if (r.name !== undefined && typeof r.name !== 'string') {
    throw new Error(`rules[${index}]: name must be a string`);
  }

  if (!Array.isArray(r.events) || r.events.length === 0) {
    throw new Error(`rules[${index}]: events must be a non-empty array of strings`);
  }
  for (const e of r.events) {
    if (typeof e !== 'string' || e.length === 0) {
      throw new Error(`rules[${index}]: each event must be a non-empty string`);
    }
  }

  if (r.filter !== undefined) {
    if (!r.filter || typeof r.filter !== 'object' || Array.isArray(r.filter)) {
      throw new Error(`rules[${index}]: filter must be an object`);
    }
  }

  if (!Array.isArray(r.actions) || r.actions.length === 0) {
    throw new Error(`rules[${index}]: actions must be a non-empty array`);
  }
  const actions = r.actions.map((a: unknown, j: number) => validateAction(a, index, j));

  if (r.sequential !== undefined && typeof r.sequential !== 'boolean') {
    throw new Error(`rules[${index}]: sequential must be a boolean`);
  }
  if (r.disabled !== undefined && typeof r.disabled !== 'boolean') {
    throw new Error(`rules[${index}]: disabled must be a boolean`);
  }

  return {
    name: r.name as string | undefined,
    events: r.events as string[],
    filter: r.filter as Record<string, unknown> | undefined,
    actions,
    sequential: r.sequential as boolean | undefined,
    disabled: r.disabled as boolean | undefined,
  };
}

function validateAction(action: unknown, ruleIndex: number, actionIndex: number): DaemonAction {
  if (!action || typeof action !== 'object') {
    throw new Error(`rules[${ruleIndex}].actions[${actionIndex}]: must be an object`);
  }

  const a = action as Record<string, unknown>;
  const prefix = `rules[${ruleIndex}].actions[${actionIndex}]`;

  switch (a.type) {
    case 'bash': {
      if (typeof a.command !== 'string' || a.command.length === 0) {
        throw new Error(`${prefix}: bash action requires a non-empty command`);
      }
      if (a.timeout !== undefined && (typeof a.timeout !== 'number' || a.timeout <= 0)) {
        throw new Error(`${prefix}: timeout must be a positive number`);
      }
      if (a.cwd !== undefined && typeof a.cwd !== 'string') {
        throw new Error(`${prefix}: cwd must be a string`);
      }
      return {
        type: 'bash',
        command: a.command as string,
        timeout: a.timeout as number | undefined,
        cwd: a.cwd as string | undefined,
      };
    }

    case 'webhook': {
      if (typeof a.url !== 'string' || a.url.length === 0) {
        throw new Error(`${prefix}: webhook action requires a non-empty url`);
      }
      if (a.headers !== undefined) {
        if (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers)) {
          throw new Error(`${prefix}: headers must be an object`);
        }
      }
      if (a.timeout !== undefined && (typeof a.timeout !== 'number' || a.timeout <= 0)) {
        throw new Error(`${prefix}: timeout must be a positive number`);
      }
      if (a.method !== undefined && a.method !== 'POST' && a.method !== 'PUT') {
        throw new Error(`${prefix}: method must be "POST" or "PUT"`);
      }
      return {
        type: 'webhook',
        url: a.url as string,
        headers: a.headers as Record<string, string> | undefined,
        timeout: a.timeout as number | undefined,
        method: a.method as 'POST' | 'PUT' | undefined,
      };
    }

    case 'builtin': {
      if (a.action !== 'auto-receive' && a.action !== 'log-to-file') {
        throw new Error(`${prefix}: builtin action must be "auto-receive" or "log-to-file"`);
      }
      if (a.action === 'log-to-file' && (typeof a.path !== 'string' || a.path.length === 0)) {
        throw new Error(`${prefix}: log-to-file requires a non-empty path`);
      }
      if (a.finalize !== undefined && typeof a.finalize !== 'boolean') {
        throw new Error(`${prefix}: finalize must be a boolean`);
      }
      return {
        type: 'builtin',
        action: a.action as 'auto-receive' | 'log-to-file',
        path: a.path as string | undefined,
        finalize: a.finalize as boolean | undefined,
      };
    }

    default:
      throw new Error(`${prefix}: type must be "bash", "webhook", or "builtin" (got "${a.type}")`);
  }
}

// =============================================================================
// Loading
// =============================================================================

/**
 * Steelman²⁸ critical: resolve daemon config paths against
 * `~/.sphere-cli/` by default, NOT the CWD. The previous default
 * (`./.sphere-cli/daemon.json`) made `bash:` actions an arbitrary-RCE
 * vector via CWD-poisoning: a malicious user dropped a config in any
 * shared directory and waited for a developer to `cd` there and run
 * `cli daemon start`. The home-relative default is safe; CWD-relative
 * is opt-in via explicit `--config <path>` or env override.
 *
 * Resolution order:
 *   1. Explicit `configPath` argument (--config <path>) — used as-is.
 *   2. SPHERE_CLI_HOME env var — joined with `daemon.json`.
 *   3. `~/.sphere-cli/daemon.json` (HOME-relative).
 *   4. Legacy CWD-relative `./.sphere-cli/daemon.json` — emits a loud
 *      stderr warning before loading; printable-character `bash:` actions
 *      from a CWD config are now also surfaced in the warning.
 */
function resolveDaemonConfigPath(explicitPath: string | undefined): {
  path: string;
  source: 'explicit' | 'env' | 'home' | 'cwd-legacy';
} {
  if (explicitPath) return { path: explicitPath, source: 'explicit' };
  // Steelman²⁹ critical: empty SPHERE_CLI_HOME or empty os.homedir()
  // would `path.join('', '.sphere-cli', ...)` resolve to a CWD-relative
  // path, silently bypassing the CWD-poisoning fix. Reject empty home
  // values so the legacy-CWD branch with its loud warning ALWAYS fires
  // for any environment without a real HOME directory.
  const envHome = process.env.SPHERE_CLI_HOME;
  if (envHome && envHome.length > 0 && path.isAbsolute(envHome)) {
    return { path: path.join(envHome, 'daemon.json'), source: 'env' };
  }
  const homeDir = os.homedir();
  if (homeDir && homeDir.length > 0 && path.isAbsolute(homeDir)) {
    const homeDefault = path.join(homeDir, '.sphere-cli', 'daemon.json');
    if (fs.existsSync(homeDefault)) {
      return { path: homeDefault, source: 'home' };
    }
  }
  // Last-resort legacy fallback. The caller will warn before consuming.
  return { path: DEFAULT_CONFIG_PATH, source: 'cwd-legacy' };
}

export function loadDaemonConfig(configPath?: string): DaemonConfig {
  const { path: filePath, source } = resolveDaemonConfigPath(configPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Config file not found: ${filePath}` +
        (source === 'cwd-legacy'
          ? ' (no config in $HOME/.sphere-cli either; pass --config <path>)'
          : ''),
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${filePath}`);
  }

  const cfg = validateDaemonConfig(parsed);

  // Steelman²⁸: when loading from CWD-relative legacy default, warn
  // loudly. If the config contains bash: actions, additionally print
  // the action commands so the operator can spot CWD-poisoning attempts.
  if (source === 'cwd-legacy') {
    process.stderr.write(
      `WARNING: loading daemon config from CWD-relative path "${filePath}". ` +
        `This is a CWD-poisoning attack vector — drop a malicious config in any ` +
        `shared directory and wait for a developer to cd there. Move config to ` +
        `~/.sphere-cli/daemon.json or pass --config <path> explicitly.\n`,
    );
    const bashActions: string[] = [];
    for (const rule of cfg.rules) {
      for (const action of rule.actions) {
        if (action.type === 'bash') bashActions.push(action.command);
      }
    }
    if (bashActions.length > 0) {
      process.stderr.write(
        `WARNING: this CWD config contains ${bashActions.length} bash action(s). ` +
          `Review before continuing:\n${bashActions.map((c) => `  - ${c}`).join('\n')}\n`,
      );
    }
  }

  return cfg;
}

// =============================================================================
// CLI Flag Parsing
// =============================================================================

export interface DaemonFlags {
  configPath?: string;
  detach: boolean;
  logFile?: string;
  pidFile?: string;
  events: string[];
  actions: string[];
  marketFeed: boolean;
  verbose: boolean;
  _forked: boolean;
}

export function parseDaemonFlags(args: string[]): DaemonFlags {
  const flags: DaemonFlags = {
    detach: false,
    events: [],
    actions: [],
    marketFeed: false,
    verbose: false,
    _forked: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
        flags.configPath = args[++i];
        break;
      case '--detach':
        flags.detach = true;
        break;
      case '--log':
        flags.logFile = args[++i];
        break;
      case '--pid':
        flags.pidFile = args[++i];
        break;
      case '--event':
        flags.events.push(args[++i]);
        break;
      case '--action':
        flags.actions.push(args[++i]);
        break;
      case '--market-feed':
        flags.marketFeed = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
      case '--_forked':
        flags._forked = true;
        break;
    }
  }

  return flags;
}

/**
 * Build a DaemonConfig from quick-mode CLI flags (--event / --action).
 * When no --event/--action flags are given and a config file exists, load from file.
 * When --event/--action flags are given, build an inline config.
 */
export function buildConfigFromFlags(flags: DaemonFlags): DaemonConfig {
  // If there are quick-mode flags, build inline config
  if (flags.events.length > 0 || flags.actions.length > 0) {
    if (flags.events.length === 0) {
      throw new Error('--action requires at least one --event');
    }
    if (flags.actions.length === 0) {
      throw new Error('--event requires at least one --action');
    }

    const actions: DaemonAction[] = flags.actions.map(parseActionSpec);

    return {
      logFile: flags.logFile,
      pidFile: flags.pidFile,
      marketFeed: flags.marketFeed,
      rules: [
        {
          name: 'cli-quick',
          events: flags.events,
          actions,
        },
      ],
    };
  }

  // Otherwise load from config file
  const config = loadDaemonConfig(flags.configPath);

  // Apply CLI overrides
  if (flags.logFile) config.logFile = flags.logFile;
  if (flags.pidFile) config.pidFile = flags.pidFile;
  if (flags.marketFeed) config.marketFeed = true;

  return config;
}

/**
 * Parse an action spec string from --action flag.
 * Formats: "auto-receive", "bash:command", "webhook:url", "log:path"
 */
function parseActionSpec(spec: string): DaemonAction {
  if (spec === 'auto-receive') {
    return { type: 'builtin', action: 'auto-receive', finalize: true };
  }

  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid action spec "${spec}". Expected: auto-receive, bash:command, webhook:url, or log:path`);
  }

  const prefix = spec.substring(0, colonIdx);
  const value = spec.substring(colonIdx + 1);

  if (!value) {
    throw new Error(`Invalid action spec "${spec}": missing value after "${prefix}:"`);
  }

  switch (prefix) {
    case 'bash':
      return { type: 'bash', command: value };
    case 'webhook':
      return { type: 'webhook', url: value };
    case 'log':
      return { type: 'builtin', action: 'log-to-file', path: value };
    default:
      throw new Error(`Unknown action type "${prefix}". Expected: bash, webhook, log, or auto-receive`);
  }
}

// =============================================================================
// Resolved Config (with defaults applied)
// =============================================================================

export interface ResolvedDaemonConfig extends DaemonConfig {
  logFile: string;
  pidFile: string;
  actionTimeout: number;
}

export function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  return {
    ...config,
    logFile: config.logFile || DEFAULT_LOG_FILE,
    pidFile: config.pidFile || DEFAULT_PID_FILE,
    actionTimeout: config.actionTimeout || DEFAULT_ACTION_TIMEOUT,
  };
}

export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function getDefaultPidFile(): string {
  return DEFAULT_PID_FILE;
}

export function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
