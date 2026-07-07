import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// =============================================================================
// Phase 3.C — Extension boundary
// =============================================================================
//
// The `extensions/uxf/*` subtree is an OPT-IN extension attached via
// `Sphere.init({ extensions: [uxfExtension()] })`. Core code (everything
// outside `extensions/`) MUST NOT import from it — an import at that layer
// makes the extension effectively mandatory and breaks the "invisible to
// main-only consumers" invariant that anchors the whole extension design.
//
// New crossings from unlisted files fail lint. That's the whole point.
// =============================================================================
//
// Phase 6.A — STSDK anti-corruption layer
// =============================================================================
//
// The v2 state-transition SDK is imported ONLY inside `token-engine/`
// (the SHA-pinned anti-corruption layer). Every other subtree — core AND
// extensions — routes v2 SDK usage through `ITokenEngine`.
//
// Extension code that still speaks v1 SDK (parked until Phase 9's port)
// uses the `stsdk-v1` npm alias, which resolves to the pinned v1 version.
// The direct package name `@unicitylabs/state-transition-sdk` outside
// `token-engine/` is banned.
//
// Core files that legitimately still use v1 direct today are enumerated in
// `STSDK_CORE_BURNDOWN` below. Each entry burns down as Phase 6.C
// rewires the file onto `token-engine`.
// =============================================================================

const CORE_GLOBS = [
  'core/**/*.ts',
  'modules/**/*.ts',
  'transport/**/*.ts',
  'impl/**/*.ts',
  'types/**/*.ts',
  'oracle/**/*.ts',
  'price/**/*.ts',
  'storage/**/*.ts',
  'validation/**/*.ts',
  'registry/**/*.ts',
  'serialization/**/*.ts',
  'connect/**/*.ts',
  'index.ts',
  'tools/**/*.ts',
  'lib/**/*.ts',
];

// Pre-existing core→extensions crossings — TEMPORARY allowlist.
// Each burn-down phase is what the execution plan schedules for
// eliminating that specific crossing.
const EXTENSION_BOUNDARY_ALLOWLIST = [
  // Phase 5 — Core mega-file structural splits will move the payments-side
  // dispatch/orchestration behind a `modules/payments/hooks.ts` seam that
  // extensions register into, so PaymentsModule no longer imports
  // `extensions/*` directly. Same shape for Sphere pointer wiring moving
  // out to `extensions/uxf/profile/wiring.ts` behind lifecycle hooks.
  'core/Sphere.ts',
  // Wave 6-P2-8 splits — sphere-*.ts files carved out of Sphere.ts inherit
  // its extension crossings. Retire alongside `core/Sphere.ts` in Phase 7.
  'core/sphere-epoch.ts',
  'core/sphere-nametag-sync.ts',
  'core/sphere-wallet-io.ts',
  'modules/payments/PaymentsModule.ts',
  // Phase 5 sync/ concern extraction — inherits the facade's
  // `computeAddressId` crossing (address-guard on remote merged data).
  // Burns down alongside the parent facade in Phase 7 when the
  // extensions layer inverts control.
  'modules/payments/sync/engine.ts',
  // Phase 5 read-model/ extraction — `history.ts` wraps
  // `resolveSenderInfoViaBinding` from
  // `extensions/uxf/pipeline/nametag-reresolver`. Phase 7 API-surface
  // alignment will re-home the C9 nametag re-resolution helper into core
  // (or route through a `transport.resolveIncomingSenderInfo` port on
  // ExtensionHost), at which point this entry burns down.
  'modules/payments/read-model/history.ts',
  'modules/accounting/types.ts',
  'modules/communications/CommunicationsModule.ts',
  'modules/groupchat/GroupChatModule.ts',
  'types/index.ts',
  // Phase 7 — API surface alignment will invert the transport→uxf
  // `transfer-payload` import into a raw-event tap on
  // `ExtensionHost.transport` (uxfv2-extension-design.md OQ-4), so transport
  // stops crossing the boundary. Same for the impl factories and root
  // re-exports.
  'transport/NostrTransportProvider.ts',
  'transport/transport-provider.ts',
  'impl/browser/index.ts',
  'impl/browser/storage/IndexedDBStorageProvider.ts',
  'impl/nodejs/index.ts',
  'impl/nodejs/storage/FileStorageProvider.ts',
  'index.ts',
  // Legacy operator tool — evaluate for drop-or-relocate during Phase 7
  // (tools/ is not part of the shipped surface but is CI-linted).
  'tools/restore-legacy-outbox.ts',
  // Phase 5 wave-3 [C] quarantine — files were carved out of
  // PaymentsModule.ts wholesale and inherit its `extensions/` crossings.
  // Phase 6.C runs `git rm -r modules/payments/legacy-v1/` in a single
  // diff, at which point this entry retires.
  'modules/payments/legacy-v1/**/*.ts',
  // Phase 6 wave-P2-4c quarantine — AccountingModule.ts was slim-rebuilt
  // on ITokenEngine; the 7,747-LoC v1 impl was carved into legacy-v1/.
  // Phase 7 runs `git rm -r modules/accounting/legacy-v1/` in a single
  // diff, at which point this entry retires.
  'modules/accounting/legacy-v1/**/*.ts',
];

// Phase 6.C burn-down: core files that still import v1 STSDK directly.
// Each will be rewired onto `token-engine` (via `ITokenEngine`) during
// the sub-phase; the entry is deleted from this list when the file
// stops importing `@unicitylabs/state-transition-sdk`.
const STSDK_CORE_BURNDOWN = [
  // Removed in wave 6-P2-4d: core/Sphere.ts now routes SigningService through
  // the `token-engine/sdk` barrel and the DIRECT-address derivation through
  // `token-engine.deriveDirectAddress` — no direct
  // `@unicitylabs/state-transition-sdk` imports remain.
  // Removed in wave 6-P2-4b: modules/payments/PaymentsModule.ts now routes
  // ALL v2 SDK access through `ITokenEngine` — no direct
  // `@unicitylabs/state-transition-sdk` imports remain (v1 impl quarantined
  // to legacy-v1/ where the STSDK ban is relaxed).
  // Removed in wave 6-P2-4c: modules/accounting/AccountingModule.ts now
  // routes ALL v2 SDK access through `ITokenEngine.mintDataToken` — no
  // direct `@unicitylabs/state-transition-sdk` imports remain (v1 impl
  // quarantined to legacy-v1/).
  // Removed in wave 6-P2-4a: oracle/UnicityAggregatorProvider.ts now routes
  // ALL v2 SDK access through `token-engine/sdk` (the anti-corruption layer)
  // — no direct `@unicitylabs/state-transition-sdk` imports remain.
  // Phase 5 wave-3 [C] + Phase 6 wave-P2-2 Group-A quarantine —
  // files were carved out of PaymentsModule.ts (and its Group-A
  // helpers TokenSplitCalculator / TokenSplitExecutor /
  // InstantSplitExecutor / InstantSplitProcessor /
  // extract-state-publickey / v5-pending-shape) and now live under
  // legacy-v1/. Wave 6-P2-2 rewired them to use the `stsdk-v1`
  // alias, so they no longer need a burndown entry for direct
  // `@unicitylabs/state-transition-sdk` imports; but the wave-3
  // files still do, so the glob stays until Phase 6.C runs
  // `git rm -r modules/payments/legacy-v1/` in a single diff.
  'modules/payments/legacy-v1/**/*.ts',
  // Phase 6 wave-P2-4c quarantine — legacy AccountingModule kept its v1
  // STSDK direct imports; the slim v2 rebuild replaces them with
  // ITokenEngine calls in the new AccountingModule.ts.
  'modules/accounting/legacy-v1/**/*.ts',
];

// Pattern definitions kept as named constants so the overrides below can
// compose them cleanly.
const EXT_PATTERN = {
  group: ['**/extensions/**', 'extensions/**'],
  message:
    'core code MUST NOT import from `extensions/`. Route the callsite through a hook/port (see modules/payments/hooks.ts pattern, or add a raw-event tap on ExtensionHost.transport), or — if this is a temporary landing site — add the file to EXTENSION_BOUNDARY_ALLOWLIST in eslint.config.js with a burn-down phase annotation.',
};

const STSDK_PATTERN = {
  group: ['@unicitylabs/state-transition-sdk', '@unicitylabs/state-transition-sdk/**'],
  message:
    'v2 state-transition SDK is only importable from `token-engine/` (the anti-corruption layer). Route the callsite through `ITokenEngine` — see modules/payments/PaymentsModule.ts on mainstream sphere-sdk main for the reference pattern. Extension code parked on v1 uses the `stsdk-v1` npm alias. For files still on v1 direct, add to STSDK_CORE_BURNDOWN in eslint.config.js and open a Phase 6.C burn-down issue.',
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.cjs', '*.mjs'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Core files enforce BOTH boundaries: extensions/ ban AND STSDK ban.
  {
    files: CORE_GLOBS,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [EXT_PATTERN, STSDK_PATTERN],
      }],
    },
  },
  // Extension boundary burn-down — files listed here may import
  // `extensions/*` but still cannot bypass the STSDK ban.
  {
    files: EXTENSION_BOUNDARY_ALLOWLIST,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [STSDK_PATTERN],
      }],
    },
  },
  // STSDK burn-down — files listed here may import `@unicitylabs/state-transition-sdk`
  // directly but still cannot bypass the extensions/ ban.
  {
    files: STSDK_CORE_BURNDOWN,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [EXT_PATTERN],
      }],
    },
  },
  // Files that appear on BOTH burn-down lists (currently: core/Sphere.ts,
  // modules/payments/PaymentsModule.ts, modules/accounting/AccountingModule.ts)
  // need both bans relaxed until their respective burn-downs land.
  {
    files: STSDK_CORE_BURNDOWN.filter((f) => EXTENSION_BOUNDARY_ALLOWLIST.includes(f)),
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Extension code parked on v1 — `stsdk-v1` alias is the ONLY sanctioned
  // way to reach v1 STSDK from here. Direct `@unicitylabs/state-transition-sdk`
  // imports are banned (would resolve to v2 once package.json bumps in 6.B).
  // Phase 9 ports the extension onto v2 through `token-engine`; the alias
  // + this rule both retire at that point.
  {
    files: ['extensions/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [STSDK_PATTERN],
      }],
    },
  },
);
