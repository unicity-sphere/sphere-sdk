/**
 * Storage Mode Resolver
 *
 * Small state machine that picks between the two CLI storage backends:
 *
 *   - `'profile'` — OrbitDB-backed Profile with UXF element pool on IPFS
 *     (the new default; content-addressable, multi-device via OrbitDB CRDT)
 *   - `'legacy'`  — file-based JSON wallet + per-address TXF token files
 *     with IPFS/IPNS sync (the pre-UXF format)
 *
 * Resolution precedence:
 *   1. Explicit caller intent (`init --legacy` / `init --profile`) wins.
 *   2. Previously committed `config.storageMode` is honoured — the mode
 *      is locked per wallet once set.
 *   3. Otherwise detect from disk: an existing legacy wallet file
 *      (`{dataDir}/wallet.json`) pins the wallet to legacy (upgrade path).
 *   4. On a pristine dataDir, prefer profile when `@orbitdb/core` +
 *      `helia` are importable; fall back to legacy with a one-line note
 *      otherwise.
 *
 * Dependency injection: filesystem probe and module-import probe are
 * injected so unit tests can exercise each branch without touching the
 * real disk or node_modules.
 *
 * @module cli/storage-mode
 */

import * as fs from 'fs';
import * as path from 'path';
import type { NetworkType } from '../constants';

export type StorageMode = 'profile' | 'legacy';

export interface StorageModeConfig {
  readonly network: NetworkType;
  readonly dataDir: string;
  readonly tokensDir: string;
  readonly currentProfile?: string;
  readonly storageMode?: StorageMode;
}

/**
 * Filesystem probe injected into the resolver — returns true iff a
 * legacy wallet file exists at the expected path.
 */
export type LegacyWalletProbe = (dataDir: string, walletFileName?: string) => boolean;

/**
 * Async probe injected into the resolver — returns `{ ok: true }` if
 * the Profile/OrbitDB runtime dependencies are importable, or
 * `{ ok: false, reason }` if not. In the CLI wiring this calls
 * `await import('@orbitdb/core')` and `await import('helia')`.
 */
export type ProfileDepsProbe = () => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * Config persister injected into the resolver — called whenever the
 * resolved mode needs to be written back so subsequent CLI invocations
 * are consistent.
 */
export type ConfigPersister = (patch: Partial<StorageModeConfig> & Pick<StorageModeConfig, 'storageMode'>) => void;

/**
 * Notifier for user-facing notes (e.g. "falling back to legacy").
 * Defaults to console.error in the CLI; tests pass a noop.
 */
export type Notifier = (message: string) => void;

/**
 * Error behaviour when `--profile` is requested but deps are missing.
 * CLI default: `'exit'` (print + process.exit(1)). Tests use `'throw'`.
 */
export type ExplicitProfileMissingBehaviour = 'exit' | 'throw';

export interface ResolveStorageModeDeps {
  readonly config: StorageModeConfig;
  readonly explicit?: StorageMode;
  readonly legacyProbe: LegacyWalletProbe;
  readonly profileProbe: ProfileDepsProbe;
  readonly persist: ConfigPersister;
  readonly notify: Notifier;
  readonly onExplicitProfileMissing?: ExplicitProfileMissingBehaviour;
}

/**
 * Default legacy-wallet probe: checks that `{dataDir}/{walletFileName}`
 * exists and is non-empty. `createFileStorageProvider` writes
 * `wallet.json` by default, so that filename is sufficient for the
 * CLI's dataDirs. Callers that use a custom filename can provide it.
 */
export function defaultLegacyWalletProbe(
  dataDir: string,
  walletFileName = 'wallet.json',
): boolean {
  const walletPath = path.join(dataDir, walletFileName);
  try {
    const st = fs.statSync(walletPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Default Profile-deps probe: tries to import `@orbitdb/core` and
 * `helia`. The cast to `string` defeats TS static checks so the import
 * resolves at runtime even when the modules aren't on the CLI's own
 * type graph.
 */
export async function defaultProfileDepsProbe(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    await import('@orbitdb/core' as string);
    await import('helia' as string);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pure state machine: given the inputs, pick a storage mode and
 * (optionally) persist the decision. Returns the resolved mode.
 *
 * Callers are expected to pass idempotent probes and a persister that
 * writes to their config file. The resolver itself is stateless apart
 * from invoking those callbacks.
 */
export async function resolveStorageMode(deps: ResolveStorageModeDeps): Promise<StorageMode> {
  const { config, explicit, legacyProbe, profileProbe, persist, notify } = deps;

  // Step 1: explicit intent (from `init --legacy` / `init --profile`)
  if (explicit) {
    if (explicit === 'profile') {
      const probe = await profileProbe();
      if (!probe.ok) {
        const msg =
          `Cannot use --profile mode: ${probe.reason}. ` +
          `Install with: npm install @orbitdb/core helia @chainsafe/libp2p-gossipsub`;
        if (deps.onExplicitProfileMissing === 'throw') {
          throw new Error(msg);
        }
        notify(msg);
        process.exit(1);
      }
    }
    if (config.storageMode !== explicit) {
      persist({ storageMode: explicit });
    }
    return explicit;
  }

  // Step 2: wallet already committed to a mode — respect it
  if (config.storageMode) return config.storageMode;

  // Step 3: existing legacy wallet on disk → legacy
  if (legacyProbe(config.dataDir)) {
    persist({ storageMode: 'legacy' });
    return 'legacy';
  }

  // Step 4: pristine dataDir — prefer profile when deps are available
  const probe = await profileProbe();
  if (probe.ok) {
    persist({ storageMode: 'profile' });
    return 'profile';
  }

  // Deps missing; fall back with a note
  notify(
    `Note: @orbitdb/core / helia not installed — falling back to legacy storage.\n` +
      `      Install them to enable OrbitDB-backed Profile mode.`,
  );
  persist({ storageMode: 'legacy' });
  return 'legacy';
}
