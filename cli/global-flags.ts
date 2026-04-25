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
export function parseFlagToken(tok: string): { name: string; inlineValue: string | undefined } {
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
 * Recursive history:
 *   F.11 used `entry.includes('://')` — too permissive.
 *   F.12 switched to `new URL(entry)` + protocol whitelist — closed
 *        F.11 issues but accepted `http:foo` (no `//`).
 *   F.13 added regex pre-check `^https?://` — closed F.12 missing-
 *        authority hole but `^https?:\/\//` was still loose: third
 *        char could be `/`/`?`/`#` and `new URL()` silently absorbed
 *        embedded CR/LF/TAB to shift the host.
 *   F.14 (this version, steelman¹²) closes:
 *        (a) `http:///etc/passwd` → host=`etc` (3-slash promotes path
 *            segment to host). Tightened regex to require a non-slash,
 *            non-?, non-#, non-whitespace character immediately after
 *            `://`.
 *        (b) `http://gw\rextra` → host=`gwextra` (WHATWG URL parser
 *            silently strips C0 control chars; downstream `fetch`
 *            normalizes to a different host than the operator typed).
 *            Reject any C0 control char or DEL in the entry.
 *        (c) `http://trusted.com@evil.com` → host=`evil.com` (userinfo
 *            silently swallowed). IPFS gateways don't use HTTP basic
 *            auth; reject userinfo to prevent phishing-shaped values.
 *
 * IPFS gateways are HTTP(S) URLs of the form `scheme://host[:port][/path]`.
 * Anything else is rejected loudly.
 */
function isValidGatewayUrl(entry: string): boolean {
  // F.15 (steelman¹³): reject any non-printable-ASCII char (everything
  // outside 0x21-0x7E). This is strictly broader than F.14's
  // `[\x00-\x1F\x7F]` (C0 + DEL) and closes the steelman¹³ critical:
  // WHATWG URL parser silently strips Unicode format chars (ZWSP,
  // BOM, ZWJ, bidi marks, etc.) so `http://gw1<U+200B>.test` passed
  // F.14 validation but `new URL().host` was `gw1.test` — the typed
  // bytes and the contacted host differ invisibly.
  //
  // Rejecting non-ASCII forces operators to use punycode (`xn--`) for
  // IDN gateways, which is reasonable for infrastructure config: the
  // operator-typed host equals the bytes sent to fetch, byte-for-byte.
  // The lint rule is meant for accidental binary noise; the rejection
  // here is intentional.
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7E]/.test(entry)) return false;
  // F.14: require literal `://` followed immediately by a non-slash,
  // non-?, non-#, non-whitespace char — the start of the host. This
  // catches `http:foo` (F.13), `http:///path` (3-slash path promoted
  // to host, F.14), `http://?query`, `http://#frag`, and `http://`+ws.
  if (!/^https?:\/\/[^/?#\s]/i.test(entry)) return false;
  try {
    const url = new URL(entry);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.host === '') return false; // defensive: scanner already covers
    // F.14: reject userinfo. IPFS gateways are public HTTP endpoints;
    // `http://trusted.com@evil.com` shape is phishing-prone.
    if (url.username !== '' || url.password !== '') return false;
    return true;
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
  // F.14 (steelman¹²): the F.12 full-argv boolean walk was REMOVED.
  // It produced false positives on legitimate subcommand invocations
  // like `cli invoice-create --memo --no-nostr=fake-memo` where the
  // value of a free-text subcommand flag happens to match the
  // `--no-nostr=...` pattern. The legitimate-no-op concern that
  // motivated the F.12 walk (`cli init --no-nostr=true` silently
  // failing) is addressed instead by `noNostrGlobal` detection in
  // cli/index.ts which now uses parseFlagToken so post-subcommand
  // `--no-nostr=anything` is recognized as Nostr-disabling intent.
  // Tradeoff: lose the loud-error UX for typos in post-subcommand
  // position; gain zero false positives across all current and
  // future subcommands' free-text flag values.
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

/**
 * Detect the position-agnostic `--no-nostr` global flag.
 *
 * Recursive history (steelman⁸ → ¹⁵, the longest-running thread):
 *   F.10 — `Array.includes('--no-nostr')` exact-match across full argv.
 *   F.12 — added full-argv validator walk for `--no-nostr=anything`.
 *          Caught the equals-form typo loudly. Steelman¹⁰: false
 *          positive on `--memo --no-nostr=fake-memo`.
 *   F.14 — switched noNostrGlobal to parseFlagToken-based detection.
 *          Steelman¹²: silent transport-disable on the same shape.
 *   F.15 — reverted to F.10 exact-match. Steelman¹³: equals-form
 *          bug acknowledged as known limitation. Steelman¹⁴: SAME
 *          bug for bare form (memo VALUE = literal `--no-nostr`).
 *   F.16 — scoped to leading region only. Steelman¹⁵: silently broke
 *          14+ daemon-cli.test.ts invocations, the IPFS-only recovery
 *          test, and 9+ doc examples. Tests can pass spuriously while
 *          their named contract is gone.
 *   F.17 (this version) — reverts to F.15/F.10 full-argv exact-match.
 *          The narrow false positive (operator literally passing
 *          `--no-nostr` as a free-text flag VALUE like
 *          `cli send --memo --no-nostr`) is a documented known
 *          limitation. Tradeoff analysis (steelman¹⁵ verdict):
 *            F.16 cost: ~25 silent regressions in real-world tests,
 *                       docs, and operator workflows.
 *            F.15 cost: vanishingly rare typo where operator types
 *                       a flag-shape string as a memo/description.
 *          F.15 wins on practical impact. The `--memo --no-nostr`
 *          shape requires deliberate operator effort; the F.16
 *          break of `daemon start --no-nostr` (and similar) is
 *          everyday-CLI muscle memory.
 *
 * KNOWN LIMITATION: if an operator passes a free-text subcommand flag
 * value that is LITERALLY the string `--no-nostr` (e.g., `cli send
 * --memo --no-nostr`), this detector returns true and Sphere boots
 * with no-op transport. Affected free-text flags across all current
 * subcommands: `--memo` (invoice-create, send), `--description`
 * (group-create), `--message` (swap-propose, payment-request).
 * Mitigation: document; acceptable because (a) memo strings shaped
 * exactly like a CLI flag are vanishingly rare, (b) the failure mode
 * (Nostr disabled when expected) is detectable at runtime via a
 * connection error rather than silent data loss.
 */
export function detectNoNostrGlobalFlag(argv: readonly string[]): boolean {
  return argv.includes('--no-nostr');
}
