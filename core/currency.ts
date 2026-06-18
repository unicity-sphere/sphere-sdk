/**
 * Currency Utilities
 * Conversion between human-readable amounts and smallest units (bigint)
 */

import { SphereError } from './errors';

// =============================================================================
// Constants
// =============================================================================

/** Default token decimals (18 for most tokens) */
export const DEFAULT_TOKEN_DECIMALS = 18;

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Parse a human-readable decimal amount into smallest units (bigint) — STRICT.
 *
 * Mirrors ethers `parseUnits`: throws `SphereError('INVALID_AMOUNT')` on invalid
 * input rather than silently corrupting the value. Rejects empty/non-string
 * values, non-decimal strings (sign, scientific notation, hex, junk), and more
 * fractional digits than `decimals` (NO silent truncation). `'0'` is valid; the
 * `> 0` business rule is the caller's responsibility.
 *
 * For money movement always use this (or {@link safeParseTokenAmount} for live UI
 * input). Use {@link toHumanReadable} / {@link formatAmount} for display.
 *
 * @example
 * ```ts
 * parseTokenAmount('1.5', 18) // 1500000000000000000n
 * parseTokenAmount('100', 6)  // 100000000n
 * parseTokenAmount('1.5', 0)  // throws SphereError('INVALID_AMOUNT')
 * ```
 */
export function parseTokenAmount(value: string, decimals: number = DEFAULT_TOKEN_DECIMALS): bigint {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SphereError('Amount must be a non-empty string', 'INVALID_AMOUNT');
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new SphereError(`Invalid decimals: ${decimals}`, 'INVALID_AMOUNT');
  }
  const str = value.trim();
  // Unsigned decimal only — no leading '-', no scientific notation, no hex.
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new SphereError(`Invalid amount: "${value}"`, 'INVALID_AMOUNT');
  }
  const [integer, fraction = ''] = str.split('.');
  if (fraction.length > decimals) {
    throw new SphereError(`Amount "${value}" exceeds ${decimals} decimal place(s)`, 'INVALID_AMOUNT');
  }
  return BigInt(integer + fraction.padEnd(decimals, '0'));
}

/**
 * Non-throwing variant of {@link parseTokenAmount} for live UI input: returns
 * `null` when the value is not (yet) a valid amount. `null` is distinct from a
 * genuine `0n`, so callers can tell "invalid / mid-typing" from "zero".
 */
export function safeParseTokenAmount(
  value: string,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): bigint | null {
  try {
    return parseTokenAmount(value, decimals);
  } catch {
    return null;
  }
}

/**
 * Convert smallest unit (bigint) to human-readable string
 *
 * @example
 * ```ts
 * toHumanReadable(1500000000000000000n, 18) // '1.5'
 * toHumanReadable(100000000n, 6)            // '100'
 * ```
 */
export function toHumanReadable(amount: bigint | string, decimals: number = DEFAULT_TOKEN_DECIMALS): string {
  if (!decimals || decimals < 0 || !Number.isFinite(decimals)) return amount.toString();
  const str = amount.toString().padStart(decimals + 1, '0');
  const integer = str.slice(0, -decimals) || '0';
  const fraction = str.slice(-decimals).replace(/0+$/, '');

  return fraction ? `${integer}.${fraction}` : integer;
}

/**
 * Format amount for display with optional symbol
 *
 * @example
 * ```ts
 * formatAmount(1500000000000000000n, { decimals: 18, symbol: 'UCT' })
 * // '1.5 UCT'
 * ```
 */
export function formatAmount(
  amount: bigint | string,
  options: {
    decimals?: number;
    symbol?: string;
    maxFractionDigits?: number;
  } = {}
): string {
  const { decimals = DEFAULT_TOKEN_DECIMALS, symbol, maxFractionDigits } = options;

  let readable = toHumanReadable(amount, decimals);

  // Limit fraction digits if specified
  if (maxFractionDigits !== undefined) {
    const [int, frac] = readable.split('.');
    if (frac && frac.length > maxFractionDigits) {
      readable = maxFractionDigits > 0 ? `${int}.${frac.slice(0, maxFractionDigits)}` : int;
    }
  }

  return symbol ? `${readable} ${symbol}` : readable;
}

// =============================================================================
// Export as namespace for convenience
// =============================================================================

export const CurrencyUtils = {
  parseTokenAmount,
  safeParseTokenAmount,
  toHumanReadable,
  format: formatAmount,
};
