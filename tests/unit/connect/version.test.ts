import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SDK_VERSION } from '../../../connect/version';

describe('SDK_VERSION', () => {
  it('matches package.json version (regenerate via scripts/gen-version.mjs on drift)', () => {
    // vitest runs from the package root, so process.cwd() is the repo root.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
