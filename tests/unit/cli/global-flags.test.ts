/**
 * Tests for `cli/global-flags.ts` — the leading-flag region parser
 * shared by the CLI strip, parseIpfsGatewayOverride, and noNostrGlobal
 * detection.
 *
 * History (Wave F.10, steelman⁸):
 *   These tests lock in the leading-region contract that prevents
 *   regressions like:
 *     F.5 → strip walked whole argv, mangled subcommand args.
 *     F.9 → narrowed strip but `--no-nostr` strip handler missing.
 *     F.10 → extracted helpers + warning for misplaced --ipfs-gateway.
 *
 * The forward-compat block at the end documents the rule for adding
 * future global flags: register in the appropriate set or be treated
 * as the subcommand.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  findLeadingGlobalFlagsEnd,
  parseIpfsGatewayOverride,
  stripLeadingGlobalFlags,
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
