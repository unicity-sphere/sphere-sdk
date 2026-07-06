/**
 * Tests for profile/cryptographer.ts (Issue #292 foundation sketch)
 *
 * The interface itself has no runtime; it's a type-only contract sketch
 * for a future PR that migrates the in-tree signing/encryption surfaces
 * to delegate via this boundary. The only runtime export today is the
 * `PROFILE_CACHE_PURPOSE` constant, which we lock in as a stable value
 * so a future rename of the HKDF info string at this layer would surface
 * as a test failure (and force the test author to confirm the cache
 * compatibility implications).
 *
 * The constant value MUST stay aligned with `PROFILE_HKDF_INFO` in
 * `profile/encryption.ts` — the encryption module is the source of
 * truth today; the cryptographer purpose tag is the consumer-facing
 * name. They are not REQUIRED to be byte-equivalent, but the binding
 * between purpose and derived key MUST stay stable to avoid invalidating
 * previously-encrypted caches.
 */

import { describe, it, expect } from 'vitest';
import { PROFILE_CACHE_PURPOSE } from '../../../extensions/uxf/profile/cryptographer';
import { PROFILE_HKDF_INFO } from '../../../extensions/uxf/profile/encryption';

describe('profile/cryptographer', () => {
  it('PROFILE_CACHE_PURPOSE has a stable string value', () => {
    // If you rename this, every previously-encrypted Profile cache will
    // become undecryptable. Bumping this constant requires a coordinated
    // migration path; until then, this test acts as a tripwire.
    expect(PROFILE_CACHE_PURPOSE).toBe('profile-cache');
  });

  it('PROFILE_HKDF_INFO (encryption.ts source of truth) is stable', () => {
    // Same tripwire as above for the actual HKDF info string used by
    // `deriveProfileEncryptionKey`. The cryptographer purpose tag and
    // this string are SEPARATE values today; a future SphereCryptographer
    // implementation may bind them, but until then both must stay stable.
    expect(PROFILE_HKDF_INFO).toBe('uxf-profile-encryption');
  });
});
