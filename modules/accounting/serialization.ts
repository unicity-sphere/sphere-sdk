/**
 * Canonical serialization for InvoiceTerms.
 *
 * Produces a deterministic JSON string from an InvoiceTerms object, suitable
 * for use as the input to SHA-256 when deriving an invoice token ID.
 *
 * Serialization rules (per §3.4 of ACCOUNTING-SPEC.md):
 *
 * 1. Sort targets by address (lexicographic, ascending).
 * 2. Within each target, sort assets: coins before NFTs; coins sorted by
 *    coinId (ascending); NFTs sorted by tokenId (ascending).
 * 3. Key insertion order is strict alphabetical:
 *    `createdAt`, [`creator`], `deliveryMethods`, `dueDate`, `memo`, `targets`
 * 4. `creator` is CONDITIONALLY present — the key is OMITTED entirely when
 *    `terms.creator` is undefined (anonymous invoices). It is NOT normalized
 *    to null.
 * 5. Null normalization for remaining optional fields:
 *    - `deliveryMethods`: null when undefined or empty array
 *    - `dueDate`: null when undefined
 *    - `memo`: null when undefined
 * 6. Compact JSON — no trailing whitespace, no pretty-printing.
 */

import type { InvoiceTerms } from './types';

export { INVOICE_TOKEN_TYPE_HEX } from '../../constants';

/**
 * Produce a deterministic JSON string from InvoiceTerms.
 *
 * The output is used as the byte input to SHA-256 for invoice token ID
 * derivation — any change to encoding rules breaks token ID stability.
 *
 * @param terms - Invoice terms to serialize
 * @returns Compact, deterministic JSON string
 *
 * @example
 * const terms: InvoiceTerms = {
 *   createdAt: 1700000000000,
 *   targets: [{ address: 'DIRECT://abc', assets: [{ coin: ['UCT', '1000000'] }] }],
 * };
 * const json = canonicalSerialize(terms);
 * // '{"createdAt":1700000000000,"deliveryMethods":null,"dueDate":null,"memo":null,"targets":[...]}'
 */
export function canonicalSerialize(terms: InvoiceTerms): string {
  // Sort targets by address, lexicographic ascending.
  const sortedTargets = [...terms.targets]
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .map((t) => ({
      address: t.address,
      assets: [...t.assets].sort((a, b) => {
        // Both coins — sort by coinId (index 0 of the tuple).
        if (a.coin && b.coin) return a.coin[0] < b.coin[0] ? -1 : a.coin[0] > b.coin[0] ? 1 : 0;
        // Both NFTs — sort by tokenId.
        if (a.nft && b.nft) return a.nft.tokenId < b.nft.tokenId ? -1 : a.nft.tokenId > b.nft.tokenId ? 1 : 0;
        // Mixed — coins come before NFTs.
        return a.coin ? -1 : 1;
      }),
    }));

  // Build the canonical object with keys in strict alphabetical order.
  // JavaScript (ES2015+) preserves string-key insertion order in objects, so
  // inserting keys alphabetically guarantees JSON.stringify output key order
  // on all supported runtimes (Node.js >= 18, modern browsers).
  //
  // `creator` is conditionally inserted (omitted for anonymous invoices).
  // All other optional fields are null-normalized (always present in output).
  const sorted: Record<string, unknown> = {};

  sorted.createdAt = terms.createdAt;

  // `creator` is absent from the serialized object for anonymous invoices —
  // it is NOT written as null. This is the intentional spec behavior (§3.4):
  // "creator is conditionally included (omitted for anonymous invoices)."
  if (terms.creator !== undefined) {
    sorted.creator = terms.creator;
  }

  // Normalize: undefined and empty array both serialize as null.
  sorted.deliveryMethods =
    terms.deliveryMethods && terms.deliveryMethods.length > 0
      ? terms.deliveryMethods
      : null;

  sorted.dueDate = terms.dueDate ?? null;
  sorted.memo = terms.memo ?? null;
  sorted.targets = sortedTargets;

  return JSON.stringify(sorted);
}
