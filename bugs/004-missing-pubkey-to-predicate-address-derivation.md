# BUG-004: Missing public-key-to-predicate-address derivation function

## Problem

`deriveL3PredicateAddress(privateKey)` derives a predicate address from a private key, but there is no public-key-only equivalent. Applications that receive a `chainPubkey` (compressed secp256k1 public key, 66 hex chars) cannot derive the corresponding `DIRECT://` predicate address (76 hex chars) without the private key.

## Impact

The escrow service's v2 protocol verifies swap consent signatures via `verifySwapSignature(swapId, escrowAddress, signature, chainPubkey)`. This proves the holder of `chainPubkey` consented, but the escrow cannot verify that `chainPubkey` corresponds to `manifest.party_a_address` (a predicate address). This means v2 signatures prove "someone consented" but not "the named party consented."

Without this function:
- Signature-to-party identity binding is impossible for predicate addresses
- Party role detection in the message handler cannot reliably map Nostr pubkeys to predicate addresses
- The `npubToDirectAddress` helper produces `DIRECT://{64-char-npub}` which never matches `DIRECT://{76-char-predicate}`

## Proposed Fix

Export a public function:

```typescript
/**
 * Derives the L3 predicate address from a compressed secp256k1 public key.
 * This is the public-key-only equivalent of deriveL3PredicateAddress(privateKey).
 */
export function deriveL3PredicateAddressFromPubkey(chainPubkey: string): string;
```

The implementation should mirror `deriveL3PredicateAddress` but use `SigningService.createFromPublicKey` (or equivalent) instead of `createFromSecret`.

## Workaround

The escrow currently uses substring containment checks (`resolvedAddr.includes(npubLower)`) as a best-effort heuristic. This works if the predicate address contains the raw pubkey as a component, but is not guaranteed by the predicate format and could produce false positives.

## Files Affected

- `core/crypto.ts` or `core/address.ts` — add `deriveL3PredicateAddressFromPubkey`
- `index.ts` — export the new function
