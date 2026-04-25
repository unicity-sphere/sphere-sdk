/**
 * Global flag parser for the Sphere CLI.
 *
 * Pure, testable helpers for the leading-flag region of `process.argv`.
 * Two kinds of global flags exist:
 *
 *   - VALUE_BEARING: `--ipfs-gateway <url[,url2,...]>` — consumes one
 *     trailing value. Has NO subcommand-local meaning; misplacement
 *     post-subcommand is silently dropped (callers should warn).
 *
 *   - BOOLEAN: `--no-nostr` — no value. Can ALSO appear as an init-local
 *     flag; detection is therefore position-agnostic by intent (see the
 *     `noNostrGlobal` comment in `cli/index.ts`).
 *
 * `findLeadingGlobalFlagsEnd` defines the canonical "leading region"
 * shared by the strip in `cli/index.ts`, `parseIpfsGatewayOverride`, and
 * any future global-flag handlers.
 *
 * History: Wave F.5 introduced --ipfs-gateway with a full-argv strip
 * that mangled subcommand args. Wave F.9 narrowed to leading-only.
 * Wave F.10 (steelman⁸) extracted the helpers here for testability and
 * added a loud warning for misplaced --ipfs-gateway.
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
 * Compute the index where the leading global-flag region ends. Every
 * argv token at indices [0, end) is either a known global flag or the
 * value of the immediately-preceding flag. The token at index `end`
 * (if any) is either:
 *   - the subcommand (a non-flag token), OR
 *   - an unknown leading flag (e.g., `--help`) that downstream code
 *     handles directly.
 *
 * Tokens at or after `end` are subcommand-internal and NOT processed
 * by global-flag handlers.
 */
export function findLeadingGlobalFlagsEnd(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith('--')) break; // subcommand
    if (
      VALUE_BEARING_GLOBAL_FLAGS.has(tok) &&
      i + 1 < argv.length &&
      !argv[i + 1].startsWith('--')
    ) {
      i += 2;
      continue;
    }
    if (BOOLEAN_GLOBAL_FLAGS.has(tok)) {
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
 * Parse `--ipfs-gateway <url[,url2,...]>` from argv. Returns the URL
 * array (possibly empty) — empty means "use the network default".
 *
 * Multiple invocations of the flag accumulate. Comma-separated single
 * argument also accepted. Trailing slashes are normalized away.
 *
 * Wave F.10: scoped to the leading global-flag region. If a caller
 * misplaces `--ipfs-gateway` after the subcommand, an `onMisplaced`
 * callback fires (typically wired to `console.error` for a loud
 * warning) — silent drop without notice was the steelman⁸ regression.
 */
export function parseIpfsGatewayOverride(
  argv: readonly string[],
  onMisplaced?: () => void,
): string[] {
  const gateways: string[] = [];
  const end = findLeadingGlobalFlagsEnd(argv);
  for (let i = 0; i < end; i++) {
    if (argv[i] === '--ipfs-gateway') {
      const raw = argv[i + 1];
      for (const entry of raw.split(',')) {
        const trimmed = entry.trim().replace(/\/+$/, '');
        if (trimmed.length > 0) gateways.push(trimmed);
      }
      i++; // skip value
    }
    // BOOLEAN_GLOBAL_FLAGS (e.g. --no-nostr) are silently ignored here.
  }
  if (onMisplaced) {
    for (let i = end; i < argv.length; i++) {
      if (argv[i] === '--ipfs-gateway') {
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
