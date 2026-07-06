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
// This is enforced by the `no-restricted-imports` rule below, applied to
// every core dir. Pre-existing crossings that predate Phase 3 are kept
// working via a targeted allowlist — each entry is temporary and burns
// down in a later phase (annotation next to each file).
//
// New crossings from unlisted files fail lint. That's the whole point.
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
  'modules/payments/PaymentsModule.ts',
  'modules/accounting/AccountingModule.ts',
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
];

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
  // Core files enforce the extensions/ boundary.
  {
    files: CORE_GLOBS,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/**', 'extensions/**'],
          message:
            'core code MUST NOT import from `extensions/`. Route the callsite through a hook/port (see modules/payments/hooks.ts pattern, or add a raw-event tap on ExtensionHost.transport), or — if this is a temporary landing site — add the file to the allowlist in eslint.config.js with a burn-down phase annotation.',
        }],
      }],
    },
  },
  // Pre-existing crossings — burn-down enumerated above.
  {
    files: EXTENSION_BOUNDARY_ALLOWLIST,
    rules: {
      'no-restricted-imports': 'off',
    },
  }
);
