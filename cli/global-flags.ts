/**
 * Global flag parser for the Sphere CLI.
 *
 * Pure, testable helpers for the leading-flag region of `process.argv`.
 * Two kinds of global flags exist:
 *
 *   - VALUE_BEARING: `--ipfs-gateway <url[,url2,...]>` — consumes a
 *     URL value (space-separated `--ipfs-gateway URL` OR equals form
 *     `--ipfs-gateway=URL`). Has NO subcommand-local meaning;
 *     misplacement post-subcommand is silently dropped (callers should
 *     warn).
 *
 *   - BOOLEAN: `--no-nostr` — no value. Equals form `--no-nostr=...`
 *     is rejected. Can ALSO appear as an init-local flag; detection is
 *     therefore position-agnostic by intent (see the `noNostrGlobal`
 *     comment in `cli/index.ts`).
 *
 * `findLeadingGlobalFlagsEnd` defines the canonical "leading region"
 * shared by the strip in `cli/index.ts`, `parseIpfsGatewayOverride`,
 * `validateLeadingGlobalFlags`, and any future global-flag handlers.
 *
 * History:
 *   F.5  introduced --ipfs-gateway with a full-argv strip that mangled
 *        subcommand args.
 *   F.9  narrowed to leading-only.
 *   F.10 (steelman⁸) extracted these helpers for testability and added
 *        a loud warning for misplaced --ipfs-gateway.
 *   F.11 (steelman⁹) added value validation (URL shape, dash-prefix
 *        rejection) and equals-form support (`--flag=value`). Two
 *        critical bugs fixed:
 *          (a) `--ipfs-gateway init` greedily consumed `init` as URL,
 *              left command=undefined, fell through to printUsage with
 *              no diagnostic.
 *          (b) `--ipfs-gateway=URL` was silently unrecognized → command
 *              became the whole token, "Unknown command" with no hint.
 *
 * CONTRACT: any new value-bearing global flag MUST be added to
 * `VALUE_BEARING_GLOBAL_FLAGS`, and any new boolean global flag MUST be
 * added to `BOOLEAN_GLOBAL_FLAGS`. Otherwise the leading-region scanner
 * stops at the unknown flag and downstream code sees it either as
 * `--help` (handled) or "Unknown command" (rejected). The forward-compat
 * tests in `tests/unit/cli/global-flags.test.ts` document this contract.
 *
 * @module cli/global-flags
 */

export const VALUE_BEARING_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--ipfs-gateway',
]);

export const BOOLEAN_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--no-nostr',
]);

/**
 * Decompose an argv token into its name and (optional) inline value.
 * Handles both the space-separated form (`--flag VALUE`, returned with
 * `inlineValue=undefined`) and the GNU equals form (`--flag=VALUE`,
 * returned with the value pre-extracted).
 *
 * Tokens that don't start with `--` are returned with `name=tok` and
 * no inline value — caller is responsible for the leading-`--` check.
 */
function parseFlagToken(tok: string): { name: string; inlineValue: string | undefined } {
  if (!tok.startsWith('--')) return { name: tok, inlineValue: undefined };
  const eqIdx = tok.indexOf('=');
  if (eqIdx > 2) {
    // eqIdx > 2 ensures the name is at least `--x` (3 chars) — `--=foo`
    // is malformed and treated as an unknown flag (eqIdx <= 2).
    return { name: tok.slice(0, eqIdx), inlineValue: tok.slice(eqIdx + 1) };
  }
  return { name: tok, inlineValue: undefined };
}

/**
 * Returns true if a token at `argv[i+1]` is a usable space-separated
 * value for a value-bearing flag — i.e., it does NOT start with `-`
 * (which would suggest it's another flag, not a value the user
 * intended). The F.10 condition was `!startsWith('--')`, which let
 * single-dash flags like `-h` slip through and get consumed as URL
 * values. F.11 tightens to any leading dash.
 */
function isUsableSpaceSeparatedValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.startsWith('-')) return false;
  return true;
}

/**
 * Strict gateway URL validator.
 *
 * F.11 used `entry.includes('://')` which was too permissive — it
 * accepted `=http://gw1` (from `--ipfs-gateway==http://gw1` double
 * equals; the parser splits on the FIRST `=` leaving `=http://gw1` as
 * the value), `ftp://gw1`, `javascript://anything`, and any other
 * scheme that happens to contain `://`. Steelman¹⁰ caught this — the
 * malformed value silently propagated to IPFS code and produced
 * confusing errors far from the CLI.
 *
 * F.12 tightens to: must be parseable by `new URL(entry)` AND have an
 * http(s) protocol. IPFS gateways are HTTP(S) by definition; rejecting
 * other schemes is loss-less.
 */
function isValidGatewayUrl(entry: string): boolean {
  try {
    const url = new URL(entry);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Compute the index where the leading global-flag region ends. Every
 * argv token at indices [0, end) is either a known global flag or the
 * value of the immediately-preceding flag. The token at index `end`
 * (if any) is either:
 *   - the subcommand (a non-flag token), OR
 *   - an unknown leading flag (e.g., `--help`) that downstream code
 *     handles directly, OR
 *   - a malformed value-bearing flag (no usable value) that we leave
 *     for `validateLeadingGlobalFlags` to surface.
 *
 * Tokens at or after `end` are subcommand-internal and NOT processed
 * by global-flag handlers.
 *
 * NOTE: this scanner does NOT validate the SHAPE of values (e.g., URL
 * format) — it only identifies the structural region. Use
 * `validateLeadingGlobalFlags` for value-shape errors.
 */
export function findLeadingGlobalFlagsEnd(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('--')) break; // subcommand
    const { name, inlineValue } = parseFlagToken(tok);
    if (VALUE_BEARING_GLOBAL_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        // Equals form: `--flag=value` consumes ONE slot. Even if the
        // value is empty/malformed, the structural scan accepts it —
        // shape validation happens in `validateLeadingGlobalFlags`.
        i++;
        continue;
      }
      if (isUsableSpaceSeparatedValue(argv[i + 1])) {
        i += 2;
        continue;
      }
      // `--flag` followed by nothing usable. Stop — let the validator
      // produce an error, OR let downstream "Unknown command" handle it.
      break;
    }
    if (BOOLEAN_GLOBAL_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        // Booleans don't take values; `--no-nostr=anything` is malformed.
        // Stop scan so the validator can surface the error.
        break;
      }
      i++;
      continue;
    }
    // Unknown leading flag — stop scan. The flag stays in argv and
    // downstream code (e.g. `--help`) handles it. Adding a new global
    // flag without registering it in the sets above means it lands
    // here and is treated as the subcommand.
    break;
  }
  return i;
}

/**
 * Validate the value shape of every value-bearing flag in the leading
 * global-flag region. Returns the FIRST error found (as a human-readable
 * string), or `null` if all flags are well-formed. Caller is expected
 * to print the message and exit cleanly on error.
 *
 * Errors caught (Wave F.11 + F.12, from steelman⁹ + ¹⁰):
 *   - `--ipfs-gateway` with no value at all (`--ipfs-gateway` last in argv)
 *   - `--ipfs-gateway` with empty value (`--ipfs-gateway ""`, `--ipfs-gateway=`)
 *   - `--ipfs-gateway VALUE` where VALUE starts with `-` (probably a flag)
 *   - `--ipfs-gateway VALUE` where VALUE is not a parseable http(s) URL
 *     (catches `--ipfs-gateway init`, `=http://gw1` from double-equals,
 *     `ftp://gw1`, `javascript://anything`, etc.)
 *   - `--ipfs-gateway URL_LIST` with any malformed comma-separated entry
 *   - `--no-nostr=anything` (boolean flag with equals-form value) — caught
 *     ANYWHERE in argv, not just the leading region (F.12 fix for the
 *     `cli init --no-nostr=true` silent-no-op hazard).
 *
 * The validator walks the structural leading region for value-bearing
 * flags, then the FULL argv for boolean equals-form errors. It does
 * not modify argv.
 */
export function validateLeadingGlobalFlags(argv: readonly string[]): string | null {
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('--')) break;
    const { name, inlineValue } = parseFlagToken(tok);
    if (VALUE_BEARING_GLOBAL_FLAGS.has(name)) {
      let rawValue: string | undefined;
      let nextI: number;
      if (inlineValue !== undefined) {
        rawValue = inlineValue;
        nextI = i + 1;
      } else if (isUsableSpaceSeparatedValue(argv[i + 1])) {
        rawValue = argv[i + 1];
        nextI = i + 2;
      } else {
        return (
          `${name} requires a value. ` +
          `Got '${tok}${i + 1 < argv.length ? ' ' + argv[i + 1] : ''}'.`
        );
      }
      if (rawValue === '') {
        return `${name} value cannot be empty.`;
      }
      const entries = rawValue
        .split(',')
        .map((e) => e.trim().replace(/\/+$/, ''))
        .filter((e) => e.length > 0);
      if (entries.length === 0) {
        return `${name} value '${rawValue}' contained no usable URLs.`;
      }
      for (const entry of entries) {
        if (entry.startsWith('-')) {
          return (
            `${name}: '${entry}' looks like a flag, not a URL. ` +
            `Did you forget the URL?`
          );
        }
        if (!isValidGatewayUrl(entry)) {
          // F.12: stricter than `includes('://')` — catches double-equals
          // (`=http://gw1`), non-http schemes (`ftp://`, `javascript://`),
          // and otherwise malformed URLs.
          return (
            `${name}: '${entry}' is not a valid http(s) URL. ` +
            `Expected something like http://gw.example.com or https://gw.example.com. ` +
            `Did you forget the URL?`
          );
        }
      }
      i = nextI;
      continue;
    }
    if (BOOLEAN_GLOBAL_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        return `${name} does not take a value (got '${tok}').`;
      }
      i++;
      continue;
    }
    // Unknown leading flag — not our concern; downstream handles it.
    break;
  }
  // F.12: walk FULL argv for boolean global flags with equals form.
  // Booleans are position-agnostic by design (e.g., `init --no-nostr`
  // is the documented init-local form), but they STILL never take a
  // value. Pre-F.12 the validator only walked the leading region, so
  // `cli init --no-nostr=true` was silently accepted by validation
  // and then silently DROPPED by `noNostrGlobal = .includes('--no-nostr')`
  // (exact-string match doesn't catch `--no-nostr=true`). Steelman¹⁰
  // critical: operators expecting Nostr disabled got real Nostr.
  // F.12 catches this loudly anywhere in argv.
  for (let j = i; j < argv.length; j++) {
    const tok = argv[j];
    if (!tok.startsWith('--')) continue;
    const { name, inlineValue } = parseFlagToken(tok);
    if (BOOLEAN_GLOBAL_FLAGS.has(name) && inlineValue !== undefined) {
      return `${name} does not take a value (got '${tok}').`;
    }
  }
  return null;
}

/**
 * Parse `--ipfs-gateway <url[,url2,...]>` from argv. Returns the URL
 * array (possibly empty) — empty means "use the network default".
 *
 * Supports both the space-separated form (`--ipfs-gateway URL`) and
 * the GNU equals form (`--ipfs-gateway=URL`).
 *
 * Multiple invocations of the flag accumulate. Comma-separated single
 * argument also accepted. Trailing slashes are normalized away.
 *
 * Scoped to the leading global-flag region. If a caller misplaces
 * `--ipfs-gateway` after the subcommand, the `onMisplaced` callback
 * fires (typically wired to `console.error` for a loud warning).
 *
 * Value-shape errors (empty, dash-prefix, non-http(s) scheme) are NOT
 * reported here — call `validateLeadingGlobalFlags` first to surface
 * them. This function silently filters bad entries so downstream code
 * keeps a usable (possibly empty) gateway list even after validation
 * is bypassed in tests.
 */
export function parseIpfsGatewayOverride(
  argv: readonly string[],
  onMisplaced?: () => void,
): string[] {
  const gateways: string[] = [];
  const end = findLeadingGlobalFlagsEnd(argv);
  let i = 0;
  while (i < end) {
    const tok = argv[i];
    const { name, inlineValue } = parseFlagToken(tok);
    if (name === '--ipfs-gateway') {
      let raw: string | undefined;
      if (inlineValue !== undefined) {
        raw = inlineValue;
        i++;
      } else if (isUsableSpaceSeparatedValue(argv[i + 1])) {
        raw = argv[i + 1];
        i += 2;
      } else {
        // No usable value — scanner shouldn't have accepted this, but
        // handle defensively: skip without crashing.
        i++;
        continue;
      }
      for (const entry of raw.split(',')) {
        const trimmed = entry.trim().replace(/\/+$/, '');
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('-')) continue; // looks like a flag, skip
        // F.12: defense in depth — same strict URL validity used by the
        // validator. Catches `=http://gw1` from double-equals form,
        // non-http schemes, and otherwise-malformed URLs even if the
        // validator is bypassed (e.g., in tests).
        if (!isValidGatewayUrl(trimmed)) continue;
        gateways.push(trimmed);
      }
      continue;
    }
    // Other leading-region tokens (boolean flags or other registered
    // global flags) — step over one token at a time. The scanner has
    // already validated the structural shape; we just skip non-target
    // tokens here.
    i++;
  }
  if (onMisplaced) {
    for (let j = end; j < argv.length; j++) {
      const { name } = parseFlagToken(argv[j]);
      if (name === '--ipfs-gateway') {
        onMisplaced();
        break;
      }
    }
  }
  return gateways;
}

/**
 * Strip the leading global-flag region from `argv` in place. Returns
 * the modified `argv` for chaining. Tokens at indices [0, end) are
 * removed; the subcommand (or unknown leading flag) is left at index 0.
 */
export function stripLeadingGlobalFlags(argv: string[]): string[] {
  const end = findLeadingGlobalFlagsEnd(argv);
  argv.splice(0, end);
  return argv;
}
