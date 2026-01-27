/**
 * Currency Utilities
 * Conversion between human-readable amounts and smallest units (bigint)
 */

// =============================================================================
// Constants
// =============================================================================

/** Default token decimals (18 for most tokens) */
export const DEFAULT_TOKEN_DECIMALS = 18;

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Convert human-readable amount to smallest unit (bigint)
 *
 * @example
 * ```ts
 * toSmallestUnit('1.5', 18) // 1500000000000000000n
 * toSmallestUnit('100', 6)  // 100000000n
 * ```
 */
export function toSmallestUnit(amount: number | string, decimals: number = DEFAULT_TOKEN_DECIMALS): bigint {
  if (!amount) return 0n;

  try {
    const str = amount.toString();
    const [integer, fraction = ''] = str.split('.');

    // Pad fraction to exact decimal places, truncate if longer
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);

    return BigInt(integer + paddedFraction);
  } catch {
    return 0n;
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
 * formatAmount(1500000000000000000n, { decimals: 18, symbol: 'ALPHA' })
 * // '1.5 ALPHA'
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
  toSmallestUnit,
  toHumanReadable,
  format: formatAmount,
};
