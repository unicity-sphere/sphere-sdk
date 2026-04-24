/**
 * Token Conservation Invariant harness (T-E21).
 *
 * The load-bearing property for ANY Phase E integration test that
 * touches the token-pool: across the operation under test, the sum
 * of token coin values must be invariant, except for explicitly
 * declared mints and burns.
 *
 *   Σ(before.tokens.coinValues) + Σ(minted.coinValues)
 *       = Σ(after.tokens.coinValues) + Σ(burned.coinValues)
 *
 * Concretely a token conservation violation signals one of:
 *   - A reconcile that lost a bundle (Rule 1/3/4 regression)
 *   - A JOIN that dropped a same-tokenId candidate (Rule 3)
 *   - A consolidation that deleted a bundle before the safety
 *     retention window (consolidation.ts #338-346 deletion path)
 *   - A replication that silently overwrote a peer's write
 *   - A flush that pinned a partial CAR (partial deserialize on
 *     read)
 *
 * TEST §3.2 pre-freeze requirement: this harness MUST be committed
 * before the T-E11–T-E17 integration streams open, since all of
 * them depend on it as a shared fixture.
 *
 * @see PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md §3.2
 * @see PROFILE-ARCHITECTURE.md §10.4
 *
 * @module tests/integration/pointer/token-conservation
 */

// =============================================================================
// Public types
// =============================================================================

/**
 * Minimal coin-bearing interface. Real tokens carry much richer
 * structure (genesis, predicate, tx chain, etc.), but conservation
 * is purely a sum-of-coin-values assertion — the harness is
 * deliberately narrow so it composes with any token representation
 * whose coin data is iterable.
 *
 * `coinId` is the fungible-token identifier (e.g., 'UCT', 'USDU').
 * `amount` is expressed as a bigint to avoid floating-point rounding
 * drift at the conservation boundary — if any callers work with
 * string amounts, they must convert at the snapshot edge.
 */
export interface TokenCoinEntry {
  readonly coinId: string;
  readonly amount: bigint;
}

/**
 * Minimal per-token view: a tokenId and the coin amounts it holds.
 * A single token may hold multiple fungible coin types (e.g., a
 * multi-asset bundle); the snapshot preserves each as its own
 * (coinId, amount) pair so the conservation sum aggregates
 * correctly.
 */
export interface ConservationToken {
  readonly tokenId: string;
  readonly coins: ReadonlyArray<TokenCoinEntry>;
}

export interface TokenSnapshot {
  /**
   * The tokens present at the snapshot moment. Order is irrelevant —
   * the harness sorts by `tokenId` internally for deterministic
   * diff output.
   */
  readonly tokens: ReadonlyArray<ConservationToken>;
  /**
   * Free-form annotation — e.g. `'pre-flush'`, `'post-reconcile'`,
   * `'after JOIN of bundles A+B'`. Surfaced in assertion errors so
   * a failing test points straight at the diff between two named
   * states rather than two anonymous snapshots.
   */
  readonly label: string;
}

/**
 * Explicit mint/burn expectations. Any conservation mismatch that
 * is NOT accounted for by these entries is treated as a violation.
 */
export interface ConservationExpectation {
  /**
   * Tokens minted by the operation under test (e.g., a nametag
   * token, an invoice token). Added to the "after" side of the
   * conservation equation. Declaring a minted token that did not
   * actually mint is a FAIL — the expectation is a two-way check.
   */
  readonly minted?: ReadonlyArray<ConservationToken>;
  /**
   * Tokens consumed / burned by the operation (e.g., tokens spent
   * in a transfer where only the receiver's side is being
   * observed). Declared burn sums are added to the "before" side.
   */
  readonly burned?: ReadonlyArray<ConservationToken>;
  /**
   * Optional per-coinId tolerance. Defaults to ZERO — exact
   * conservation. Set a small positive bigint here only when the
   * operation under test has a documented non-integer coin
   * (historical: none exist today; reserved for future
   * fractional-coin use).
   */
  readonly tolerance?: ReadonlyMap<string, bigint>;
}

// =============================================================================
// Assertion
// =============================================================================

/**
 * Per-coin totals derived from a snapshot, keyed by coinId. Internal
 * shape — surfaced in violation errors but not part of the public
 * API.
 */
type CoinTotals = Map<string, bigint>;

function totalize(tokens: ReadonlyArray<ConservationToken>): CoinTotals {
  const totals: CoinTotals = new Map();
  for (const t of tokens) {
    // Duplicate-coinId detection WITHIN a single token's coins[]. A
    // token should list each coinId at most once; a fixture that
    // lists `[{UCT, 5n}, {UCT, 5n}]` silently totalled to 10 UCT
    // under the old impl — exactly the kind of typo that masks a
    // real conservation violation. Reject at the source.
    const seenInToken = new Set<string>();
    for (const c of t.coins) {
      // W1: negative amounts are definitionally nonsensical (tokens
      // cannot hold negative coin balances). A negative amount in a
      // fixture would self-cancel during totalization and mask
      // real violations — fail loudly at the snapshot edge instead.
      if (c.amount < 0n) {
        throw new Error(
          `TokenConservation: token ${t.tokenId} coin ${c.coinId} has negative amount ${c.amount}; fixtures must use non-negative bigints`,
        );
      }
      if (seenInToken.has(c.coinId)) {
        throw new Error(
          `TokenConservation: token ${t.tokenId} lists coinId '${c.coinId}' more than once; each token should carry at most one entry per coinId (duplicate would silently sum and mask violations)`,
        );
      }
      seenInToken.add(c.coinId);
      totals.set(c.coinId, (totals.get(c.coinId) ?? 0n) + c.amount);
    }
  }
  return totals;
}

/** Union of keys from any number of maps. */
function unionKeys(...maps: CoinTotals[]): Set<string> {
  const out = new Set<string>();
  for (const m of maps) for (const k of m.keys()) out.add(k);
  return out;
}

/**
 * Throws `TokenConservationViolation` on any coinId whose
 * "before + minted - burned" does not equal "after" (within the
 * per-coin tolerance, default 0).
 *
 * The error message names every diverging coinId with its expected
 * vs observed total and the delta. A diff is shown per named
 * snapshot so you can tell at a glance which state contributed the
 * extra/missing units. The error also exposes the raw deltas as
 * a `.byCoin` map for machine-readable consumers (test reporters).
 */
export class TokenConservationViolation extends Error {
  public readonly byCoin: ReadonlyMap<string, {
    readonly expected: bigint;
    readonly observed: bigint;
    readonly delta: bigint;
  }>;

  constructor(
    message: string,
    byCoin: Map<string, { expected: bigint; observed: bigint; delta: bigint }>,
  ) {
    super(message);
    this.name = 'TokenConservationViolation';
    // Freeze each entry so a consumer cannot mutate the recorded
    // expected/observed/delta in place.
    for (const v of byCoin.values()) Object.freeze(v);
    // Expose as a genuine read-only Map: Object.freeze does NOT
    // block Map.prototype.set/delete/clear on an otherwise-frozen
    // Map instance (the mutators bypass property descriptors), so a
    // frozen Map is not actually immutable at runtime. Proxy trap
    // the three mutators to throw; leave every other method/get
    // untouched so the ReadonlyMap surface is fully usable.
    // Proxy-trap the three mutators to throw. Other members
    // (size, get, has, entries, keys, values, forEach, Symbol.iterator)
    // are forwarded to the underlying Map. We use `target` as the
    // receiver on `Reflect.get` because Map accessors (notably `size`)
    // rely on an internal [[MapData]] slot check that fails if the
    // receiver is the Proxy; binding function results to `target`
    // keeps the internal-slot machinery pointed at the real Map.
    const inner = new Map(byCoin);
    this.byCoin = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'set' || prop === 'delete' || prop === 'clear') {
          return () => {
            throw new TypeError(
              `TokenConservationViolation.byCoin is read-only; ${String(prop)} is not permitted`,
            );
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ReadonlyMap<string, { expected: bigint; observed: bigint; delta: bigint }>;
  }
}

/**
 * The canonical invariant check. Callable from any test that
 * captures a pre-operation snapshot, performs the operation, and
 * captures a post-operation snapshot.
 *
 * Throws `TokenConservationViolation` on the first coinId found to
 * violate conservation — by convention the test framework renders
 * the thrown error via `.message`, which names every divergent coin
 * (not just the first, despite the throw being on the first loop
 * iteration — the aggregation collects all violations before
 * throwing).
 */
export function assertTokenConservation(
  before: TokenSnapshot,
  after: TokenSnapshot,
  expected: ConservationExpectation = {},
): void {
  const beforeTotals = totalize(before.tokens);
  const afterTotals = totalize(after.tokens);
  const mintedTotals = totalize(expected.minted ?? []);
  const burnedTotals = totalize(expected.burned ?? []);
  const tolerance = expected.tolerance ?? new Map<string, bigint>();

  // W2: a negative tolerance would flip the absDelta comparison at
  // line below into a state where EVEN zero-delta (observed ===
  // expected) reports as a violation (|0| > -1 is true). Pre-
  // validate so a typo at the tolerance fixture edge fails here
  // instead of reporting confusing false-positives across every
  // coinId in the snapshot.
  for (const [coinId, tol] of tolerance) {
    if (tol < 0n) {
      throw new Error(
        `TokenConservation: tolerance for ${coinId} is negative (${tol}); tolerances must be non-negative`,
      );
    }
  }

  const allCoins = unionKeys(beforeTotals, afterTotals, mintedTotals, burnedTotals);

  const violations = new Map<
    string,
    { expected: bigint; observed: bigint; delta: bigint }
  >();

  for (const coinId of allCoins) {
    const b = beforeTotals.get(coinId) ?? 0n;
    const a = afterTotals.get(coinId) ?? 0n;
    const m = mintedTotals.get(coinId) ?? 0n;
    const x = burnedTotals.get(coinId) ?? 0n;
    const tol = tolerance.get(coinId) ?? 0n;

    const expectedAfter = b + m - x;
    const delta = a - expectedAfter;
    const absDelta = delta < 0n ? -delta : delta;

    if (absDelta > tol) {
      violations.set(coinId, {
        expected: expectedAfter,
        observed: a,
        delta,
      });
    }
  }

  if (violations.size === 0) return;

  const lines: string[] = [
    `Token conservation violation: ${violations.size} coin(s) diverged between "${before.label}" and "${after.label}"`,
  ];
  // Sort coinIds for stable output — test reporters diff errors
  // textually and non-deterministic order masks regressions.
  const sortedCoins = [...violations.keys()].sort();
  for (const coinId of sortedCoins) {
    const v = violations.get(coinId)!;
    const sign = v.delta > 0n ? '+' : '';
    lines.push(
      `  ${coinId}: expected=${v.expected} observed=${v.observed} delta=${sign}${v.delta}`,
    );
  }
  if (expected.minted && expected.minted.length > 0) {
    lines.push(`  (minted: ${expected.minted.length} token(s))`);
  }
  if (expected.burned && expected.burned.length > 0) {
    lines.push(`  (burned: ${expected.burned.length} token(s))`);
  }
  throw new TokenConservationViolation(lines.join('\n'), violations);
}

// =============================================================================
// Snapshot builders (optional convenience)
// =============================================================================

/**
 * Build a `TokenSnapshot` from a sequence of tokens. Convenience
 * helper so call sites can `captureSnapshot(label, tokens)` without
 * spelling out the object literal.
 */
export function captureSnapshot(
  label: string,
  tokens: Iterable<ConservationToken>,
): TokenSnapshot {
  return { label, tokens: [...tokens] };
}

/**
 * Compare two snapshots and produce a per-coin diff table without
 * asserting. Useful for test output that wants to display deltas
 * even when they are within tolerance / expected by mint+burn.
 * Return value is a Map sorted by coinId (insertion order).
 */
export function diffSnapshots(
  a: TokenSnapshot,
  b: TokenSnapshot,
): Map<string, { a: bigint; b: bigint; delta: bigint }> {
  const totalsA = totalize(a.tokens);
  const totalsB = totalize(b.tokens);
  const out = new Map<string, { a: bigint; b: bigint; delta: bigint }>();
  const coins = [...unionKeys(totalsA, totalsB)].sort();
  for (const c of coins) {
    const va = totalsA.get(c) ?? 0n;
    const vb = totalsB.get(c) ?? 0n;
    out.set(c, { a: va, b: vb, delta: vb - va });
  }
  return out;
}
