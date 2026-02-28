/**
 * Centralized SDK Logger
 *
 * A lightweight singleton logger that works across all tsup bundles
 * by storing state on globalThis. Supports three log levels:
 * - debug: detailed messages (only shown when debug=true)
 * - warn: important warnings (ALWAYS shown regardless of debug flag)
 * - error: critical errors (ALWAYS shown regardless of debug flag)
 *
 * Global debug flag enables all logging. Per-tag overrides allow
 * granular control (e.g., only transport debug).
 *
 * @example
 * ```ts
 * import { logger } from '@unicitylabs/sphere-sdk';
 *
 * // Enable all debug logging
 * logger.configure({ debug: true });
 *
 * // Enable only specific tags
 * logger.setTagDebug('Nostr', true);
 *
 * // Usage in SDK classes
 * logger.debug('Payments', 'Transfer started', { amount, recipient });
 * logger.warn('Nostr', 'queryEvents timed out after 5s');
 * logger.error('Sphere', 'Critical failure', error);
 * ```
 */

export type LogLevel = 'debug' | 'warn' | 'error';

export type LogHandler = (level: LogLevel, tag: string, message: string, ...args: unknown[]) => void;

export interface LoggerConfig {
  /** Enable debug logging globally (default: false). When false, only warn and error messages are shown. */
  debug?: boolean;
  /** Custom log handler. If provided, replaces console output. Useful for tests or custom log sinks. */
  handler?: LogHandler | null;
}

// Use a unique symbol-like key on globalThis to share logger state across tsup bundles
const LOGGER_KEY = '__sphere_sdk_logger__';

interface LoggerState {
  debug: boolean;
  tags: Record<string, boolean>;
  handler: LogHandler | null;
}

function getState(): LoggerState {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[LOGGER_KEY]) {
    g[LOGGER_KEY] = { debug: false, tags: {}, handler: null } satisfies LoggerState;
  }
  return g[LOGGER_KEY] as LoggerState;
}

function isEnabled(tag: string): boolean {
  const state = getState();
  // Per-tag override takes priority
  if (tag in state.tags) return state.tags[tag];
  // Fall back to global flag
  return state.debug;
}

export const logger = {
  /**
   * Configure the logger. Can be called multiple times (last write wins).
   * Typically called by createBrowserProviders(), createNodeProviders(), or Sphere.init().
   */
  configure(config: LoggerConfig): void {
    const state = getState();
    if (config.debug !== undefined) state.debug = config.debug;
    if (config.handler !== undefined) state.handler = config.handler;
  },

  /**
   * Enable/disable debug logging for a specific tag.
   * Per-tag setting overrides the global debug flag.
   *
   * @example
   * ```ts
   * logger.setTagDebug('Nostr', true);  // enable only Nostr logs
   * logger.setTagDebug('Nostr', false); // disable Nostr logs even if global debug=true
   * ```
   */
  setTagDebug(tag: string, enabled: boolean): void {
    getState().tags[tag] = enabled;
  },

  /**
   * Clear per-tag override, falling back to global debug flag.
   */
  clearTagDebug(tag: string): void {
    delete getState().tags[tag];
  },

  /** Returns true if debug mode is enabled for the given tag (or globally). */
  isDebugEnabled(tag?: string): boolean {
    if (tag) return isEnabled(tag);
    return getState().debug;
  },

  /**
   * Debug-level log. Only shown when debug is enabled (globally or for this tag).
   * Use for detailed operational information.
   */
  debug(tag: string, message: string, ...args: unknown[]): void {
    if (!isEnabled(tag)) return;
    const state = getState();
    if (state.handler) {
      state.handler('debug', tag, message, ...args);
    } else {
      console.log(`[${tag}]`, message, ...args);
    }
  },

  /**
   * Warning-level log. ALWAYS shown regardless of debug flag.
   * Use for important but non-critical issues (timeouts, retries, degraded state).
   */
  warn(tag: string, message: string, ...args: unknown[]): void {
    const state = getState();
    if (state.handler) {
      state.handler('warn', tag, message, ...args);
    } else {
      console.warn(`[${tag}]`, message, ...args);
    }
  },

  /**
   * Error-level log. ALWAYS shown regardless of debug flag.
   * Use for critical failures that should never be silenced.
   */
  error(tag: string, message: string, ...args: unknown[]): void {
    const state = getState();
    if (state.handler) {
      state.handler('error', tag, message, ...args);
    } else {
      console.error(`[${tag}]`, message, ...args);
    }
  },

  /** Reset all logger state (debug flag, tags, handler). Primarily for tests. */
  reset(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[LOGGER_KEY];
  },
};
