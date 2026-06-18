import { describe, it, expect } from 'vitest';
import { majorOf, compareSemver } from '../../../connect/semver';

describe('majorOf', () => {
  it('extracts MAJOR', () => {
    expect(majorOf('2.0')).toBe(2);
    expect(majorOf('2.7.3')).toBe(2);
    expect(majorOf('1.0')).toBe(1);
    expect(majorOf('10.2')).toBe(10);
  });
});

describe('compareSemver', () => {
  it('orders core versions', () => {
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
    expect(compareSemver('2.0.0', '2.1.0')).toBe(-1);
    expect(compareSemver('2.1.0', '2.0.0')).toBe(1);
    expect(compareSemver('1.9.9', '2.0.0')).toBe(-1);
  });
  it('treats a release as greater than its prerelease', () => {
    expect(compareSemver('0.9.0', '0.9.0-dev.0')).toBe(1);
    expect(compareSemver('0.9.0-dev.0', '0.9.0')).toBe(-1);
  });
  it('orders prereleases (numeric segments numerically)', () => {
    expect(compareSemver('0.9.0-dev.2', '0.9.0-dev.10')).toBe(-1);
    expect(compareSemver('0.9.0-rc.1', '0.9.0-rc.1')).toBe(0);
  });
});
