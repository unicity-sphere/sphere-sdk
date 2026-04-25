/**
 * Tests for `cli/global-flags.ts` — the leading-flag region parser
 * shared by the CLI strip, parseIpfsGatewayOverride, validation, and
 * noNostrGlobal detection.
 *
 * History (Waves F.10 + F.11, steelman rounds 8 → 9):
 *   These tests lock in the leading-region contract that prevents
 *   regressions like:
 *     F.5 → strip walked whole argv, mangled subcommand args.
 *     F.9 → narrowed strip but `--no-nostr` strip handler missing.
 *     F.10 → extracted helpers + warning for misplaced --ipfs-gateway.
 *     F.11 → validation + equals form, fixes 2 critical UX bugs:
 *       (a) `--ipfs-gateway init` greedily consumed `init` as URL,
 *           command=undefined → silent printUsage (no diagnostic).
 *       (b) `--ipfs-gateway=URL` was unrecognized → "Unknown command".
 *
 * The forward-compat block at the end documents the rule for adding
 * future global flags: register in the appropriate set or be treated
 * as the subcommand.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectNoNostrGlobalFlag,
  findLeadingGlobalFlagsEnd,
  parseIpfsGatewayOverride,
  stripLeadingGlobalFlags,
  validateLeadingGlobalFlags,
  VALUE_BEARING_GLOBAL_FLAGS,
  BOOLEAN_GLOBAL_FLAGS,
} from '../../../cli/global-flags';

describe('findLeadingGlobalFlagsEnd', () => {
  it('returns 0 when first token is the subcommand', () => {
    expect(findLeadingGlobalFlagsEnd(['init'])).toBe(0);
    expect(findLeadingGlobalFlagsEnd(['init', '--no-nostr'])).toBe(0);
    expect(findLeadingGlobalFlagsEnd(['pointer', 'flush'])).toBe(0);
  });

  it('consumes leading --no-nostr', () => {
    expect(findLeadingGlobalFlagsEnd(['--no-nostr', 'init'])).toBe(1);
    expect(findLeadingGlobalFlagsEnd(['--no-nostr'])).toBe(1);
  });

  it('consumes leading --ipfs-gateway with its value', () => {
    expect(findLeadingGlobalFlagsEnd(['--ipfs-gateway', 'http://gw1', 'init'])).toBe(2);
  });

  it('consumes both --no-nostr and --ipfs-gateway in order', () => {
    expect(
      findLeadingGlobalFlagsEnd([
        '--no-nostr',
        '--ipfs-gateway',
        'http://gw1',
        'pointer',
        'flush',
      ]),
    ).toBe(3);
    expect(
      findLeadingGlobalFlagsEnd([
        '--ipfs-gateway',
        'http://gw1',
        '--no-nostr',
        'init',
      ]),
    ).toBe(3);
  });

  it('stops at first unknown leading flag (forward-compat: --help)', () => {
    expect(findLeadingGlobalFlagsEnd(['--help'])).toBe(0);
    expect(findLeadingGlobalFlagsEnd(['--no-nostr', '--unknown', 'init'])).toBe(1);
  });

  it('stops at subcommand even if subcommand args contain global-flag-named tokens', () => {
    // Critical regression case from F.5 → F.9: subcommand-internal
    // `--ipfs-gateway` must NOT be consumed.
    const argv = ['send', '--ipfs-gateway', 'http://gw1'];
    expect(findLeadingGlobalFlagsEnd(argv)).toBe(0);
  });

  it('does not consume --ipfs-gateway when its value is another flag', () => {
    // `--ipfs-gateway --no-nostr` is malformed (missing value); the
    // scanner refuses to consume them as a pair, leaving --ipfs-gateway
    // as an unknown leading flag boundary.
    const argv = ['--ipfs-gateway', '--no-nostr', 'init'];
    // First iteration: --ipfs-gateway has next='--no-nostr' which
    // starts with '--', so it falls through. --ipfs-gateway is in
    // VALUE_BEARING_GLOBAL_FLAGS so it's not BOOLEAN; falls to "unknown"
    // path and stops.
    expect(findLeadingGlobalFlagsEnd(argv)).toBe(0);
  });

  it('handles empty argv', () => {
    expect(findLeadingGlobalFlagsEnd([])).toBe(0);
  });

  it('handles --ipfs-gateway at end of argv with no value', () => {
    // Final token, no value to consume — falls through to unknown path.
    expect(findLeadingGlobalFlagsEnd(['--ipfs-gateway'])).toBe(0);
    expect(findLeadingGlobalFlagsEnd(['--no-nostr', '--ipfs-gateway'])).toBe(1);
  });
});

describe('stripLeadingGlobalFlags', () => {
  it('removes leading globals and leaves subcommand intact', () => {
    const argv = ['--no-nostr', '--ipfs-gateway', 'http://gw1', 'pointer', 'flush'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['pointer', 'flush']);
  });

  it('preserves subcommand-internal --ipfs-gateway', () => {
    const argv = ['init', '--ipfs-gateway', 'http://gw-internal'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['init', '--ipfs-gateway', 'http://gw-internal']);
  });

  it('preserves --help as subcommand fallthrough', () => {
    const argv = ['--help'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['--help']);
  });

  it('strips nothing when only subcommand is present', () => {
    const argv = ['status'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['status']);
  });

  it('returns the argv reference (in-place modification)', () => {
    const argv = ['--no-nostr', 'init'];
    const ret = stripLeadingGlobalFlags(argv);
    expect(ret).toBe(argv);
  });
});

describe('parseIpfsGatewayOverride', () => {
  it('returns empty array when no --ipfs-gateway is given', () => {
    expect(parseIpfsGatewayOverride([])).toEqual([]);
    expect(parseIpfsGatewayOverride(['init'])).toEqual([]);
    expect(parseIpfsGatewayOverride(['--no-nostr', 'init'])).toEqual([]);
  });

  it('parses a single gateway from the leading region', () => {
    expect(
      parseIpfsGatewayOverride(['--ipfs-gateway', 'http://gw1', 'pointer', 'flush']),
    ).toEqual(['http://gw1']);
  });

  it('parses comma-separated list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,http://gw2,http://gw3',
        'pointer',
        'flush',
      ]),
    ).toEqual(['http://gw1', 'http://gw2', 'http://gw3']);
  });

  it('accumulates multiple --ipfs-gateway invocations', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1',
        '--ipfs-gateway',
        'http://gw2',
        'pointer',
        'flush',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });

  it('normalizes trailing slashes', () => {
    expect(
      parseIpfsGatewayOverride(['--ipfs-gateway', 'http://gw1/,http://gw2///', 'init']),
    ).toEqual(['http://gw1', 'http://gw2']);
  });

  it('skips empty entries from comma-separated input', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        ',http://gw1, ,http://gw2,',
        'init',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });

  it('IGNORES subcommand-internal --ipfs-gateway (the F.10 contract)', () => {
    // The F.5 full-argv scan would have honoured this; F.9+ drops it.
    expect(
      parseIpfsGatewayOverride(['init', '--ipfs-gateway', 'http://gw-internal']),
    ).toEqual([]);
  });

  it('fires onMisplaced callback when --ipfs-gateway is post-subcommand', () => {
    const onMisplaced = vi.fn();
    parseIpfsGatewayOverride(
      ['init', '--ipfs-gateway', 'http://gw-internal'],
      onMisplaced,
    );
    expect(onMisplaced).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onMisplaced when --ipfs-gateway is leading', () => {
    const onMisplaced = vi.fn();
    parseIpfsGatewayOverride(
      ['--ipfs-gateway', 'http://gw1', 'pointer', 'flush'],
      onMisplaced,
    );
    expect(onMisplaced).not.toHaveBeenCalled();
  });

  it('fires onMisplaced at most once even with multiple post-subcommand occurrences', () => {
    const onMisplaced = vi.fn();
    parseIpfsGatewayOverride(
      [
        'send',
        '--ipfs-gateway',
        'http://gw1',
        'token',
        '--ipfs-gateway',
        'http://gw2',
      ],
      onMisplaced,
    );
    expect(onMisplaced).toHaveBeenCalledTimes(1);
  });

  it('still parses leading occurrences AND warns on subcommand-internal occurrences', () => {
    const onMisplaced = vi.fn();
    const result = parseIpfsGatewayOverride(
      [
        '--ipfs-gateway',
        'http://gw-leading',
        'send',
        '--ipfs-gateway',
        'http://gw-internal',
      ],
      onMisplaced,
    );
    expect(result).toEqual(['http://gw-leading']);
    expect(onMisplaced).toHaveBeenCalledTimes(1);
  });
});

describe('flag registry contract (forward-compat)', () => {
  it('VALUE_BEARING_GLOBAL_FLAGS is the canonical source of truth', () => {
    // Adding a new value-bearing global flag MUST go through this set.
    // If this test starts failing because someone added a flag,
    // ALSO update findLeadingGlobalFlagsEnd unit tests above to cover
    // the new flag's strip behavior.
    expect([...VALUE_BEARING_GLOBAL_FLAGS].sort()).toEqual(['--ipfs-gateway']);
  });

  it('BOOLEAN_GLOBAL_FLAGS is the canonical source of truth', () => {
    // Adding a new boolean global flag MUST go through this set.
    expect([...BOOLEAN_GLOBAL_FLAGS].sort()).toEqual(['--no-nostr']);
  });

  it('unregistered flags are treated as subcommand boundary (current behavior)', () => {
    // If a future hypothetical flag `--newflag` is added without
    // registering, the scanner stops at it. Documents the failure mode.
    const argv = ['--newflag', 'value', 'init'];
    expect(findLeadingGlobalFlagsEnd(argv)).toBe(0);
    // strip leaves --newflag in argv:
    const argvCopy = [...argv];
    stripLeadingGlobalFlags(argvCopy);
    expect(argvCopy).toEqual(['--newflag', 'value', 'init']);
    // Downstream behavior: command='--newflag' → "Unknown command".
  });
});

// ============================================================================
// Wave F.11 — equals form, value validation (steelman⁹ critical fixes)
// ============================================================================

describe('--flag=value equals form (F.11)', () => {
  it('findLeadingGlobalFlagsEnd consumes --ipfs-gateway=URL as one token', () => {
    expect(findLeadingGlobalFlagsEnd(['--ipfs-gateway=http://gw1', 'init'])).toBe(1);
  });

  it('strip removes equals-form token cleanly', () => {
    const argv = ['--ipfs-gateway=http://gw1', '--no-nostr', 'pointer', 'flush'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['pointer', 'flush']);
  });

  it('parser extracts URL from equals form', () => {
    expect(
      parseIpfsGatewayOverride(['--ipfs-gateway=http://gw1', 'pointer', 'flush']),
    ).toEqual(['http://gw1']);
  });

  it('parser handles equals-form comma list', () => {
    expect(
      parseIpfsGatewayOverride(['--ipfs-gateway=http://gw1,http://gw2', 'init']),
    ).toEqual(['http://gw1', 'http://gw2']);
  });

  it('parser mixes equals-form and space-separated occurrences', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway=http://gw1',
        '--ipfs-gateway',
        'http://gw2',
        'pointer',
        'flush',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });

  it('rejects --no-nostr=value (boolean flags do not take values)', () => {
    expect(findLeadingGlobalFlagsEnd(['--no-nostr=true', 'init'])).toBe(0);
    // Token stays in argv, downstream surfaces it as "Unknown command".
    const argv = ['--no-nostr=true', 'init'];
    stripLeadingGlobalFlags(argv);
    expect(argv).toEqual(['--no-nostr=true', 'init']);
  });

  it('rejects malformed equals form `--=value` (eqIdx <= 2)', () => {
    expect(findLeadingGlobalFlagsEnd(['--=foo', 'init'])).toBe(0);
  });
});

describe('value validation — single-dash and missing-URL guards (F.11)', () => {
  it('refuses to consume `-h` as --ipfs-gateway value', () => {
    // F.10 would have consumed `-h` (only `--` was rejected). F.11
    // tightens to any leading dash. Result: scanner stops at the
    // `--ipfs-gateway` token, leaving everything in argv for downstream.
    const argv = ['--ipfs-gateway', '-h', 'init'];
    expect(findLeadingGlobalFlagsEnd(argv)).toBe(0);
  });

  it('refuses to consume `-` (single dash) as --ipfs-gateway value', () => {
    expect(findLeadingGlobalFlagsEnd(['--ipfs-gateway', '-', 'init'])).toBe(0);
  });

  it('still consumes URLs that contain dashes inside (not at start)', () => {
    expect(
      findLeadingGlobalFlagsEnd([
        '--ipfs-gateway',
        'http://gateway-1.example.com',
        'init',
      ]),
    ).toBe(2);
  });

  it('parser silently filters non-URL entries (no `://`)', () => {
    // `init` happens to look like a non-URL — the scanner consumed it
    // (doesn't start with `-`), but the parser drops it as malformed.
    // The final defense for users is `validateLeadingGlobalFlags` in
    // the CLI entry point — not the parser.
    expect(parseIpfsGatewayOverride(['--ipfs-gateway', 'init'])).toEqual([]);
  });

  it('parser silently filters dash-prefix entries from comma list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,-bogus,http://gw2',
        'init',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });
});

describe('validateLeadingGlobalFlags (F.11 — loud failure on typos)', () => {
  it('returns null when no global flags are present', () => {
    expect(validateLeadingGlobalFlags([])).toBeNull();
    expect(validateLeadingGlobalFlags(['init'])).toBeNull();
    expect(validateLeadingGlobalFlags(['init', '--foo', 'bar'])).toBeNull();
  });

  it('returns null on well-formed leading flags', () => {
    expect(
      validateLeadingGlobalFlags([
        '--no-nostr',
        '--ipfs-gateway',
        'http://gw1',
        'pointer',
        'flush',
      ]),
    ).toBeNull();
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway=https://gw1', 'init']),
    ).toBeNull();
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1,https://gw2', 'init']),
    ).toBeNull();
  });

  it('catches the F.11 critical case: --ipfs-gateway init (subcommand-as-value)', () => {
    const err = validateLeadingGlobalFlags(['--ipfs-gateway', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain("'init'");
    expect(err).toContain('not a valid http(s) URL');
    expect(err).toContain('Did you forget the URL?');
  });

  it('catches --ipfs-gateway with single-dash value (`-h`)', () => {
    const err = validateLeadingGlobalFlags(['--ipfs-gateway', '-h', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain('--ipfs-gateway');
    expect(err).toContain('requires a value');
  });

  it('catches --ipfs-gateway with no value at all (last in argv)', () => {
    expect(validateLeadingGlobalFlags(['--ipfs-gateway'])).toContain(
      'requires a value',
    );
  });

  it('catches --ipfs-gateway with empty equals value', () => {
    expect(validateLeadingGlobalFlags(['--ipfs-gateway=', 'init'])).toContain(
      'cannot be empty',
    );
  });

  it('catches --ipfs-gateway with empty space-separated value (empty string)', () => {
    // Empty string passes the `isUsableSpaceSeparatedValue` check
    // (doesn't start with `-`), so the scanner consumes it. The
    // validator then catches it via the empty-value branch.
    expect(validateLeadingGlobalFlags(['--ipfs-gateway', '', 'init'])).toContain(
      'cannot be empty',
    );
  });

  it('catches `,,,,` malformed value (no usable URLs)', () => {
    const err = validateLeadingGlobalFlags(['--ipfs-gateway', ',,,,', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain('contained no usable URLs');
  });

  it('catches comma-list with one bad entry', () => {
    const err = validateLeadingGlobalFlags([
      '--ipfs-gateway',
      'http://gw1,bogus-no-scheme,http://gw2',
      'init',
    ]);
    expect(err).not.toBeNull();
    expect(err).toContain('bogus-no-scheme');
    expect(err).toContain('not a valid http(s) URL');
  });

  it('catches --no-nostr=value (boolean flag with equals)', () => {
    const err = validateLeadingGlobalFlags(['--no-nostr=true', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain('--no-nostr');
    expect(err).toContain('does not take a value');
  });

  it('returns the FIRST error when multiple are present', () => {
    const err = validateLeadingGlobalFlags([
      '--ipfs-gateway',
      'init',
      '--ipfs-gateway=', // also bad, but first one wins
      'pointer',
    ]);
    expect(err).not.toBeNull();
    expect(err).toContain("'init'");
    expect(err).toContain('not a valid http(s) URL');
  });

  it('does not validate post-subcommand tokens', () => {
    // `--ipfs-gateway` post-subcommand is the parser's `onMisplaced`
    // case, NOT the validator's job.
    expect(
      validateLeadingGlobalFlags([
        'init',
        '--ipfs-gateway',
        'init', // subcommand-internal; ignored.
      ]),
    ).toBeNull();
  });
});

describe('strip + parse + snapshot interaction (F.11 integration)', () => {
  it('snapshot survives strip and remains parseable', () => {
    // Mirrors the production flow in cli/index.ts:
    //   const _globalFlagPreStrip = [...args];
    //   stripLeadingGlobalFlags(args);
    //   parseIpfsGatewayOverride(_globalFlagPreStrip);
    const args = ['--ipfs-gateway', 'http://gw1', '--no-nostr', 'pointer', 'flush'];
    const snapshot = [...args];
    stripLeadingGlobalFlags(args);
    expect(args).toEqual(['pointer', 'flush']);
    expect(parseIpfsGatewayOverride(snapshot)).toEqual(['http://gw1']);
    // Snapshot is unmutated:
    expect(snapshot).toEqual([
      '--ipfs-gateway',
      'http://gw1',
      '--no-nostr',
      'pointer',
      'flush',
    ]);
  });

  it('equals-form snapshot survives strip and remains parseable', () => {
    const args = ['--ipfs-gateway=http://gw1', '--no-nostr', 'init'];
    const snapshot = [...args];
    stripLeadingGlobalFlags(args);
    expect(args).toEqual(['init']);
    expect(parseIpfsGatewayOverride(snapshot)).toEqual(['http://gw1']);
  });
});

// ============================================================================
// Wave F.12 — strict URL validity + boolean=value anywhere (steelman¹⁰ fixes)
// ============================================================================

describe('strict URL validation (F.12 — steelman¹⁰ critical 1)', () => {
  it('rejects double-equals form `--ipfs-gateway==http://gw1` (the F.12 critical)', () => {
    // parseFlagToken splits on FIRST `=`, so the inlineValue is
    // `=http://gw1`. Pre-F.12 `includes('://')` accepted this and
    // pushed garbage into the gateway list. F.12 uses `new URL()`
    // which rejects `=http://gw1` because `=http` isn't a valid scheme.
    const err = validateLeadingGlobalFlags(['--ipfs-gateway==http://gw1', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain('not a valid http(s) URL');
  });

  it('parser drops double-equals garbage entry', () => {
    // Defense in depth — even if validator is bypassed, the parser
    // does not propagate `=http://gw1` to downstream IPFS code.
    expect(
      parseIpfsGatewayOverride(['--ipfs-gateway==http://gw1', 'init']),
    ).toEqual([]);
  });

  it('rejects ftp:// scheme', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'ftp://gw1', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects javascript:// pseudo-URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'javascript://alert(1)', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects file:// scheme', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'file:///etc/passwd', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('accepts http:// with port', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://localhost:8080',
        'init',
      ]),
    ).toBeNull();
  });

  it('accepts https:// with path', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'https://gw.example.com/ipfs',
        'init',
      ]),
    ).toBeNull();
  });

  it('accepts comma-list of valid http(s) URLs', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://gw1.example.com,https://gw2.example.com',
        'init',
      ]),
    ).toBeNull();
  });

  it('parser accepts only http(s), drops other schemes from comma list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,ftp://gw2,https://gw3',
        'init',
      ]),
    ).toEqual(['http://gw1', 'https://gw3']);
  });
});

describe('boolean=value: leading rejected, post-subcommand silently accepted (F.14 — steelman¹² fix)', () => {
  // F.12 had the validator walk the FULL argv looking for boolean
  // flags with equals form (e.g. `--no-nostr=true`). Steelman¹² caught
  // a real false-positive: `cli invoice-create --memo --no-nostr=fake`
  // (legitimate free-text value of --memo) was rejected. F.14 drops
  // the full-argv walk and instead uses parseFlagToken in noNostrGlobal
  // detection (see cli/index.ts) so post-subcommand `--no-nostr=true`
  // is still recognized as Nostr-disabling intent — silently accepted,
  // not loudly rejected.
  //
  // Net behavior:
  //   --no-nostr=value LEADING        → loud error (validator rejects)
  //   --no-nostr=value POST-SUBCOMMAND → silently accepted (functional)

  it('LEADING `--no-nostr=true` still loud-errors', () => {
    const err = validateLeadingGlobalFlags(['--no-nostr=true', 'init']);
    expect(err).not.toBeNull();
    expect(err).toContain('--no-nostr');
    expect(err).toContain('does not take a value');
  });

  it('POST-SUBCOMMAND `cli init --no-nostr=true` is silently accepted (F.14)', () => {
    // Pre-F.14: validator threw "does not take a value" — but this
    // false-positives on `--memo --no-nostr=fake-memo`. F.14 drops the
    // full-argv walk; functional intent is honored via parseFlagToken
    // in noNostrGlobal detection.
    expect(validateLeadingGlobalFlags(['init', '--no-nostr=true'])).toBeNull();
  });

  it('POST-SUBCOMMAND deeper position is silently accepted', () => {
    expect(
      validateLeadingGlobalFlags([
        'init',
        '--network',
        'testnet',
        '--no-nostr=true',
      ]),
    ).toBeNull();
  });

  it('POST-SUBCOMMAND `--no-nostr=false` is silently accepted', () => {
    // Per F.14 contract: post-subcommand validation is permissive;
    // operator typed `=false` thinking it inverts; actual semantics
    // (Nostr disabled) is set by noNostrGlobal detection regardless.
    expect(validateLeadingGlobalFlags(['init', '--no-nostr=false'])).toBeNull();
  });

  it('still accepts `cli init --no-nostr` (no value, position-agnostic)', () => {
    expect(validateLeadingGlobalFlags(['init', '--no-nostr'])).toBeNull();
  });

  it('still accepts `cli --no-nostr init` (leading boolean, no value)', () => {
    expect(validateLeadingGlobalFlags(['--no-nostr', 'init'])).toBeNull();
  });

  it('NO false positive on subcommand free-text flag value (the F.14 critical fix)', () => {
    // Steelman¹² critical: `--memo --no-nostr=fake-memo` is legitimate
    // for invoice-create (--memo is a free-text flag). F.12's
    // full-argv walk false-positived. F.14 must not.
    expect(
      validateLeadingGlobalFlags([
        'invoice-create',
        '--target',
        '@alice',
        '--memo',
        '--no-nostr=fake-memo',
      ]),
    ).toBeNull();
  });

  it('NO false positive on subcommand free-text flag value (--description variant)', () => {
    expect(
      validateLeadingGlobalFlags(['send', '--description', '--no-nostr=hi']),
    ).toBeNull();
  });
});

// ============================================================================
// Wave F.13 — missing-authority URL forms (steelman¹¹ critical fix)
// ============================================================================

describe('missing-authority URL rejection (F.13 — steelman¹¹ critical)', () => {
  // F.12's `new URL()` accepted scheme-only forms like `http:foo` because
  // WHATWG URL parsing treats `http:` as "special" — it interprets the
  // remainder as host or path. F.11's `includes('://')` would have
  // rejected these. F.13 restores that intuition by also requiring the
  // literal `://` prefix.

  it('rejects `http:foo` (scheme + colon, no slashes) — the F.13 critical', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http:foo', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http:gw.example.com` (looks like a URL but missing `//`)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http:gw.example.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `https:foo` (https variant of the same typo)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'https:foo', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http:/gw` (single slash after colon)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http:/gw', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http://` alone (scheme + authority delimiter, no host)', () => {
    // The trailing-slash strip turns `http://` into `http:` which fails
    // the regex AND new URL.
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://', 'init']),
    ).not.toBeNull();
  });

  it('rejects equals-form `--ipfs-gateway=http:foo`', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway=http:foo', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects mixed comma list `http://gw1,http:foo`', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://gw1,http:foo',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('parser drops missing-authority entries from comma list', () => {
    // Defense in depth — even if validator is bypassed, the parser
    // does not propagate `http:foo` to downstream IPFS code.
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,http:foo,https://gw2',
        'init',
      ]),
    ).toEqual(['http://gw1', 'https://gw2']);
  });

  it('rejects extra-slashes `http:////gw` (F.14 — strict authority required)', () => {
    // F.13 forgivingly accepted this. F.14 tightens: regex requires a
    // non-slash char immediately after `://`. Extra slashes promote
    // path segments to host in URL parsing — surface to operator
    // rather than silently normalize.
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http:////gw.example.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });
});

describe('error precedence (F.13 — lock in lexical-first ordering)', () => {
  it('URL error wins over post-subcommand bool=value when both present', () => {
    // Lexical-first ordering: validator's first loop catches URL error
    // before reaching the second loop's full-argv bool walk.
    const err = validateLeadingGlobalFlags([
      '--ipfs-gateway',
      'http:foo',
      'init',
      '--no-nostr=true',
    ]);
    expect(err).toContain('not a valid http(s) URL');
    expect(err).not.toContain('does not take a value');
  });

  it('leading bool=value rejected; post-subcommand bool=value silently accepted (F.14)', () => {
    // F.14: only the leading `--no-nostr=leading` is rejected.
    // Post-subcommand `--no-nostr=trailing` is silently accepted by
    // the validator (functional intent honored via noNostrGlobal
    // detection in cli/index.ts using parseFlagToken).
    const err = validateLeadingGlobalFlags([
      '--no-nostr=leading',
      'init',
      '--no-nostr=trailing',
    ]);
    expect(err).toContain("'--no-nostr=leading'");
  });

  it('post-subcommand bool=value silently accepted (F.14 — no full-argv walk)', () => {
    // Post-F.14: the validator does NOT scan post-subcommand for
    // boolean=value forms. functional intent is honored via
    // parseFlagToken in cli/index.ts noNostrGlobal detection.
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://gw1', // valid
        'init',
        '--no-nostr=true', // post-subcommand: silently accepted
      ]),
    ).toBeNull();
  });
});

// ============================================================================
// Wave F.14 — control-char + 3-slash + userinfo rejection (steelman¹² fixes)
// ============================================================================

describe('control-char URL rejection (F.14 — steelman¹² critical 1)', () => {
  // WHATWG URL parser silently strips C0 control chars (CR/LF/TAB)
  // from URLs. `new URL('http://gw\rextra')` produces host=`gwextra`.
  // F.13's protocol whitelist + ://-anchor regex didn't catch this —
  // host shifts silently between operator input and downstream fetch.
  // F.14 rejects any C0 control or DEL in the entry.

  it('rejects CR (carriage return) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw\rextra', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects LF (newline) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw\nextra', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects TAB in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw\textra', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects NUL byte in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw\x00.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects DEL char (0x7F) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw\x7F.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('parser drops control-char entries from comma list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,http://gw\rinjected,http://gw2',
        'init',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });
});

describe('3-slash path-as-host rejection (F.14 — steelman¹² critical 2)', () => {
  // `new URL('http:///etc/passwd')` produces host=`etc`, pathname=`/passwd`.
  // F.13's regex `^https?:\/\//` accepted this. F.14 tightens to
  // require a non-slash, non-?, non-#, non-whitespace char immediately
  // after `://`.

  it('rejects `http:///etc/passwd` (file-path-shape promoted to host)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http:///etc/passwd', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http:///gw.example.com` (extra slash)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http:///gw.example.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http://?query=foo` (query-only no host)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://?query=foo', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http://#fragment` (fragment-only no host)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://#fragment', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http:// ` (whitespace as host start)', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http:// gw', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('still accepts IPv6 hosts `http://[::1]:8080`', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://[::1]:8080', 'init']),
    ).toBeNull();
  });

  it('still accepts IPv4 hosts `http://127.0.0.1:8080`', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://127.0.0.1:8080', 'init']),
    ).toBeNull();
  });

  it('still accepts mixed-case scheme `HTTPS://GW.example.com`', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'HTTPS://GW.example.com', 'init']),
    ).toBeNull();
  });
});

describe('userinfo URL rejection (F.14 — steelman¹² warning fix)', () => {
  // `http://trusted.com@evil.com` → host=`evil.com`, username=`trusted.com`.
  // Phishing-shaped: substring `trusted.com` is visible but request
  // routes to `evil.com`. IPFS gateways don't use HTTP basic auth;
  // reject userinfo unconditionally.

  it('rejects `http://trusted.com@evil.com` (phishing-shaped)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://trusted.com@evil.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http://user:pass@gw.example.com` (basic auth)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://user:pass@gw.example.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects `http://user@gw.example.com` (username-only)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://user@gw.example.com',
        'init',
      ]),
    ).toContain('not a valid http(s) URL');
  });

  it('parser drops userinfo entries from comma list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1,http://user@evil.com,http://gw2',
        'init',
      ]),
    ).toEqual(['http://gw1', 'http://gw2']);
  });
});

// ============================================================================
// Wave F.15 — detectNoNostrGlobalFlag exact-match contract (steelman¹³ critical 1)
// ============================================================================

describe('detectNoNostrGlobalFlag exact-match contract (F.15 — steelman¹³ critical 1)', () => {
  // Recursive history: F.10 used Array.includes() exact match. F.14
  // switched to parseFlagToken. Steelman¹³ caught a SILENT
  // transport-disable false positive: `cli invoice-create --memo
  // --no-nostr=fake-memo` activated noNostrGlobal=true because
  // parseFlagToken('--no-nostr=fake-memo').name === '--no-nostr'.
  //
  // F.15 reverts to exact match. The legitimate cases (leading and
  // post-subcommand bare `--no-nostr`) work; equals-form typos like
  // `init --no-nostr=true` silently no-op (the documented original
  // behavior — boolean flags don't take values).

  it('matches leading bare `--no-nostr`', () => {
    expect(detectNoNostrGlobalFlag(['--no-nostr', 'init'])).toBe(true);
  });

  it('does NOT match post-subcommand `--no-nostr` (F.16 — steelman¹⁴ scope tightening)', () => {
    // F.15 used full-argv exact match. Steelman¹⁴ caught the bare-form
    // false positive: `cli send --memo --no-nostr` (memo VALUE = literal
    // `--no-nostr`) silently activated noNostrGlobal.
    // F.16 scopes detection to the LEADING global-flag region only.
    // Operators must use `cli --no-nostr init` (leading) instead of
    // `cli init --no-nostr`. e2e scripts updated accordingly.
    expect(detectNoNostrGlobalFlag(['init', '--no-nostr'])).toBe(false);
    expect(
      detectNoNostrGlobalFlag(['init', '--network', 'testnet', '--legacy', '--no-nostr']),
    ).toBe(false);
  });

  it('does NOT match equals form `--no-nostr=true` (the F.14 regression source)', () => {
    // This is the documented silent-no-op case. Operators who type
    // `=true` with a boolean flag get the typo treated as not-recognized.
    // Compare to leading `--no-nostr=true` which the validator rejects
    // loudly (validateLeadingGlobalFlags returns an error).
    expect(detectNoNostrGlobalFlag(['init', '--no-nostr=true'])).toBe(false);
    expect(detectNoNostrGlobalFlag(['init', '--no-nostr=false'])).toBe(false);
    expect(detectNoNostrGlobalFlag(['init', '--no-nostr=anything'])).toBe(false);
  });

  it('THE F.15 CRITICAL: --memo --no-nostr=fake-memo does NOT activate', () => {
    // Steelman¹³ regression: F.14's parseFlagToken-based detection
    // returned true here, silently activating no-op transport when
    // the operator passed `--no-nostr=fake-memo` as the VALUE of
    // a free-text `--memo` flag. F.15 must NOT match this shape.
    expect(
      detectNoNostrGlobalFlag([
        'invoice-create',
        '--target',
        '@alice',
        '--memo',
        '--no-nostr=fake-memo',
      ]),
    ).toBe(false);
  });

  it('THE F.16 CRITICAL: --memo --no-nostr (bare form free-text value) does NOT activate', () => {
    // Steelman¹⁴ caught the bare-form false positive that F.15 missed.
    // `cli send --memo --no-nostr` — the literal token `--no-nostr` is
    // the VALUE of --memo, not a global flag. F.15's full-argv exact
    // match returned true here, silently activating no-op transport.
    // F.16 scopes to leading region only — closes the bug.
    expect(
      detectNoNostrGlobalFlag(['send', '--memo', '--no-nostr']),
    ).toBe(false);
    expect(
      detectNoNostrGlobalFlag([
        'invoice-create',
        '--target',
        '@alice',
        '--memo',
        '--no-nostr',
      ]),
    ).toBe(false);
    // Same hazard with --mnemonic: operator could have a mnemonic word
    // sequence ending with `--no-nostr` (extremely unlikely, but the
    // bug class is identical).
    expect(
      detectNoNostrGlobalFlag(['init', '--mnemonic', '--no-nostr']),
    ).toBe(false);
  });

  it('does NOT match other free-text flag value patterns (equals OR bare form)', () => {
    expect(
      detectNoNostrGlobalFlag(['send', '--description', '--no-nostr=hi']),
    ).toBe(false);
    expect(
      detectNoNostrGlobalFlag(['send', '--description', '--no-nostr']),
    ).toBe(false);
    expect(
      detectNoNostrGlobalFlag(['payment-request', '--message', '--no-nostr=test']),
    ).toBe(false);
    expect(
      detectNoNostrGlobalFlag(['payment-request', '--message', '--no-nostr']),
    ).toBe(false);
  });

  it('returns false on empty argv', () => {
    expect(detectNoNostrGlobalFlag([])).toBe(false);
  });

  it('returns false when --no-nostr is absent', () => {
    expect(detectNoNostrGlobalFlag(['init', '--network', 'testnet'])).toBe(false);
  });

  it('matches `--no-nostr` even with --ipfs-gateway leading', () => {
    expect(
      detectNoNostrGlobalFlag([
        '--ipfs-gateway',
        'http://gw',
        '--no-nostr',
        'init',
      ]),
    ).toBe(true);
  });
});

// ============================================================================
// Wave F.15 — Unicode/non-ASCII URL rejection (steelman¹³ critical 2)
// ============================================================================

describe('non-printable-ASCII URL rejection (F.15 — steelman¹³ critical 2)', () => {
  // F.14 rejected only C0 controls + DEL. WHATWG URL parser silently
  // strips Unicode format chars (ZWSP, BOM, etc.) → host shifts
  // invisibly. F.15 broadens to reject anything outside 0x21-0x7E.

  it('rejects ZWSP (U+200B) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1​.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects BOM (U+FEFF) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1﻿.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects ZWJ (U+200D) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1‍.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects LRM (U+200E left-to-right mark) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1‎.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects RLM (U+200F right-to-left mark) in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1‏.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects raw IDN domains (Cyrillic example) — operator must use punycode', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://пример.рф', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('rejects emoji in URL', () => {
    expect(
      validateLeadingGlobalFlags(['--ipfs-gateway', 'http://gw1🚀.test', 'init']),
    ).toContain('not a valid http(s) URL');
  });

  it('still accepts punycode IDN form (ASCII-only, valid)', () => {
    expect(
      validateLeadingGlobalFlags([
        '--ipfs-gateway',
        'http://xn--e1afmkfd.xn--p1ai', // punycode for пример.рф
        'init',
      ]),
    ).toBeNull();
  });

  it('parser drops Unicode-poisoned entries from comma list', () => {
    expect(
      parseIpfsGatewayOverride([
        '--ipfs-gateway',
        'http://gw1.test,http://gw2​.test,http://gw3.test',
        'init',
      ]),
    ).toEqual(['http://gw1.test', 'http://gw3.test']);
  });
});
