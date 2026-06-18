// connect/semver.ts
// Tiny, dependency-free semver helpers for the Connect compatibility gate.

/** MAJOR component of a semver string (e.g. '2.7.3' -> 2). NaN if unparseable. */
export function majorOf(v: string): number {
  return parseInt(String(v).split('.')[0], 10);
}

/**
 * Compare two semver strings, prerelease-aware. Returns -1 | 0 | 1.
 * A release outranks its own prerelease: compareSemver('1.2.3', '1.2.3-rc.1') === 1.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = String(v).split('-', 2) as [string, string | undefined];
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === undefined && pb.pre === undefined) return 0;
  if (pa.pre === undefined) return 1;   // release > prerelease
  if (pb.pre === undefined) return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
