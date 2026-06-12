import { describe, it, expect } from 'vitest';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import pkg from '../../../package.json' with { type: 'json' };

describe('@noble/ciphers phantom-dep guard', () => {
  it('declares @noble/ciphers ^2 as a direct dependency', () => {
    const dep = (pkg as { dependencies: Record<string, string> }).dependencies[
      '@noble/ciphers'
    ];
    expect(dep).toBeDefined();
    expect(dep).toMatch(/^\^?2/);
  });

  it('xchacha20poly1305 resolves from the declared dep', () => {
    expect(typeof xchacha20poly1305).toBe('function');
  });
});
