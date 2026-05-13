/**
 * Tests for the CLI storage-mode resolver (cli/storage-mode.ts).
 *
 * Covers every branch of the resolution state machine:
 *
 *   1. Explicit --profile / --legacy wins and is persisted.
 *   2. Already-committed config.storageMode is honoured (no re-probe).
 *   3. Pristine dataDir + deps available → profile (default).
 *   4. Pristine dataDir + deps missing → legacy + fallback notice.
 *   5. Legacy wallet file present → legacy (upgrade path).
 *   6. Explicit --profile with deps missing → throws (unit behaviour).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveStorageMode,
  type StorageModeConfig,
  type LegacyWalletProbe,
  type ProfileWalletProbe,
  type ProfileDepsProbe,
} from '../../../cli/storage-mode';

function baseConfig(overrides: Partial<StorageModeConfig> = {}): StorageModeConfig {
  return {
    network: 'testnet',
    dataDir: '/tmp/sphere-cli-test',
    tokensDir: '/tmp/sphere-cli-test/tokens',
    ...overrides,
  };
}

function mockProbes(opts: {
  legacyWalletExists?: boolean;
  profileWalletExists?: boolean;
  depsAvailable?: boolean;
  depsReason?: string;
}) {
  const legacy: LegacyWalletProbe = vi.fn().mockReturnValue(opts.legacyWalletExists ?? false);
  const profileWallet: ProfileWalletProbe = vi.fn().mockReturnValue(opts.profileWalletExists ?? false);
  const profile: ProfileDepsProbe = vi.fn().mockResolvedValue(
    opts.depsAvailable ?? true
      ? { ok: true }
      : { ok: false, reason: opts.depsReason ?? 'Cannot find module' },
  );
  return { legacyProbe: legacy, profileWalletProbe: profileWallet, profileProbe: profile };
}

describe('resolveStorageMode', () => {
  it('honours explicit --profile and persists it', async () => {
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({ depsAvailable: true });
    const mode = await resolveStorageMode({
      config: baseConfig(),
      explicit: 'profile',
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
      onExplicitProfileMissing: 'throw',
    });
    expect(mode).toBe('profile');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'profile' });
  });

  it('honours explicit --legacy even when profile deps are available', async () => {
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({ depsAvailable: true });
    const mode = await resolveStorageMode({
      config: baseConfig(),
      explicit: 'legacy',
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(mode).toBe('legacy');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'legacy' });
    // Profile probe is not consulted when legacy is explicitly requested.
    expect(profileProbe).not.toHaveBeenCalled();
  });

  it('explicit --profile with missing deps throws when onExplicitProfileMissing=throw', async () => {
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      depsAvailable: false,
      depsReason: 'Cannot find module @orbitdb/core',
    });
    await expect(
      resolveStorageMode({
        config: baseConfig(),
        explicit: 'profile',
        legacyProbe,
        profileProbe,
        persist: vi.fn(),
        notify: vi.fn(),
        onExplicitProfileMissing: 'throw',
      }),
    ).rejects.toThrow(/Cannot find module @orbitdb\/core/);
  });

  it('does not re-persist when explicit matches existing config', async () => {
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({ depsAvailable: true });
    const mode = await resolveStorageMode({
      config: baseConfig({ storageMode: 'profile' }),
      explicit: 'profile',
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
      onExplicitProfileMissing: 'throw',
    });
    expect(mode).toBe('profile');
    // No write since the config already matches.
    expect(persist).not.toHaveBeenCalled();
  });

  it('honours committed config.storageMode without probing', async () => {
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({});
    const mode = await resolveStorageMode({
      config: baseConfig({ storageMode: 'legacy' }),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(mode).toBe('legacy');
    expect(legacyProbe).not.toHaveBeenCalled();
    expect(profileProbe).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('detects an existing legacy wallet on a fresh config', async () => {
    const persist = vi.fn();
    const notify = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: true,
      depsAvailable: true,
    });

    const mode = await resolveStorageMode({
      config: baseConfig(),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify,
    });
    expect(mode).toBe('legacy');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'legacy' });
    // Profile probe is not consulted — disk state takes precedence.
    expect(profileProbe).not.toHaveBeenCalled();
  });

  it('defaults to profile on a pristine dataDir with deps available', async () => {
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: false,
      depsAvailable: true,
    });
    const mode = await resolveStorageMode({
      config: baseConfig(),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(mode).toBe('profile');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'profile' });
  });

  it('falls back to legacy when deps missing, with a notice', async () => {
    const persist = vi.fn();
    const notify = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: false,
      depsAvailable: false,
      depsReason: 'Cannot find module helia',
    });
    const mode = await resolveStorageMode({
      config: baseConfig(),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify,
    });
    expect(mode).toBe('legacy');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'legacy' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/falling back to legacy/);
  });

  it('refuses --legacy when a Profile wallet (orbitdb/) exists on disk', async () => {
    // Regression for steelman finding: Profile mode also writes
    // wallet.json (its FileStorage local cache), so legacyProbe alone
    // would mis-detect a Profile dir as legacy. The Profile-wallet
    // probe is the canonical disambiguator and must take precedence.
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: true,        // Profile wrote wallet.json too
      profileWalletExists: true,        // OrbitDB dir present
      depsAvailable: true,
    });
    await expect(
      resolveStorageMode({
        config: baseConfig(),  // no committed mode
        explicit: 'legacy',
        legacyProbe,
        profileWalletProbe,
        profileProbe,
        persist: vi.fn(),
        notify: vi.fn(),
        onExplicitProfileMissing: 'throw',
      }),
    ).rejects.toThrow(/Refusing --legacy/);
  });

  it('refuses --profile when a legacy-only wallet exists on disk', async () => {
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: true,
      profileWalletExists: false,
      depsAvailable: true,
    });
    await expect(
      resolveStorageMode({
        config: baseConfig(),
        explicit: 'profile',
        legacyProbe,
        profileWalletProbe,
        profileProbe,
        persist: vi.fn(),
        notify: vi.fn(),
        onExplicitProfileMissing: 'throw',
      }),
    ).rejects.toThrow(/Refusing --profile/);
  });

  it('disk-state detection: orbitdb/ wins over wallet.json (Profile detected)', async () => {
    // No committed config, both wallet.json and orbitdb/ on disk —
    // this is exactly what a Profile install produces. Resolver MUST
    // pick profile, not legacy.
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: true,
      profileWalletExists: true,
      depsAvailable: true,
    });
    const mode = await resolveStorageMode({
      config: baseConfig(),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(mode).toBe('profile');
    expect(persist).toHaveBeenCalledWith({ storageMode: 'profile' });
    // The deps probe wasn't consulted — disk state was authoritative.
    expect(profileProbe).not.toHaveBeenCalled();
  });

  it('falls back to auto-detection when config.storageMode is corrupt', async () => {
    // Hand-edited config with garbage value — must not be honoured
    // verbatim (the CLI elsewhere assumes 'profile' | 'legacy' enums).
    const persist = vi.fn();
    const notify = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: false,
      profileWalletExists: false,
      depsAvailable: true,
    });
    const mode = await resolveStorageMode({
      config: baseConfig({
        storageMode: 'something-bogus' as unknown as 'profile',
      }),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify,
    });
    expect(mode).toBe('profile');  // pristine + deps available → default
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/unknown value/));
  });

  it('persister can observe multiple calls if called from independent resolutions', async () => {
    // First call: pristine → profile
    const persist = vi.fn();
    const { legacyProbe, profileWalletProbe, profileProbe } = mockProbes({
      legacyWalletExists: false,
      depsAvailable: true,
    });
    const first = await resolveStorageMode({
      config: baseConfig(),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(first).toBe('profile');
    expect(persist).toHaveBeenCalledTimes(1);

    // Second call with config that now records the mode → no persist
    await resolveStorageMode({
      config: baseConfig({ storageMode: 'profile' }),
      legacyProbe,
      profileWalletProbe,
      profileProbe,
      persist,
      notify: vi.fn(),
    });
    expect(persist).toHaveBeenCalledTimes(1); // no additional write
  });
});
