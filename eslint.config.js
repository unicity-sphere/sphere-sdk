import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', 'scripts/', '*.js', '*.cjs', '*.mjs'],
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
  // ── token-engine boundary ───────────────────────────────────────────────────
  // The state-transition SDK is an isolated dependency. Only token-engine/sdk.ts
  // (the anti-corruption barrel) may import it; everything else imports from
  // ./sdk re-exports. This prevents SDK types leaking across the codebase and
  // guards against ad-hoc deep imports creeping back in after the v1 removal.
  {
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@unicitylabs/state-transition-sdk', '@unicitylabs/state-transition-sdk/*'],
            message:
              'Import the state-transition SDK only via token-engine/sdk.ts. ' +
              'Other modules must import from token-engine (the ITokenEngine port), not the SDK directly.',
          },
        ],
      }],
    },
  },
  {
    // The single allowed SDK import surface.
    files: ['token-engine/sdk.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Vendored v2 test infrastructure (TestAggregatorClient + BFT fixtures).
    // Copied verbatim from the v2 SDK's own tests (not shipped in its package),
    // so it imports SDK internals not on the engine barrel. Test-only.
    files: ['tests/**/token-engine/support/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  }
);
