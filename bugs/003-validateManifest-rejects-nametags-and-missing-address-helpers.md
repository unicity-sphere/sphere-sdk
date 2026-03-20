# BUG-003: validateManifest rejects nametag/proxy addresses + missing address validation helpers

## Problem

### 1. validateManifest only accepts DIRECT:// addresses

`validateManifest()` in `modules/swap/manifest.ts` requires both `party_a_address` and `party_b_address` to start with `DIRECT://`. This rejects manifests that use nametag (`@alice`) or proxy (`PROXY://...`) addresses.

The escrow service and other applications need to accept nametag/proxy addresses in manifests because address resolution happens *after* manifest validation — the manifest is signed and hashed with the nametag address, and the resolved DIRECT:// address is only used internally for routing payouts.

**Current behavior:**
```typescript
validateManifest({ party_a_address: '@alice', ... })
// => { valid: false, errors: ["party_b_address must be a non-empty string starting with DIRECT://"] }
```

**Expected behavior:**
```typescript
validateManifest({ party_a_address: '@alice', ... })
// => { valid: true, errors: [] }
```

### 2. No standard address validation helpers in the SDK

Every application (escrow, sphere app, orchestrator) is forced to implement its own address parsing and validation:
- What constitutes a valid `DIRECT://` address? (hex length, character set)
- What constitutes a valid nametag? (allowed chars, length limits)
- What constitutes a valid `PROXY://` address?
- How to normalize addresses for comparison? (case sensitivity)
- How to determine address type from a string?

The escrow service currently has its own `parseAddress()`, `isValidAddress()`, `normalizeAddress()`, and `addressesMatch()` in `src/utils/address.ts`. These should live in the SDK.

## Current Workaround

The escrow service implements its own `validateManifest()` that:
- Accepts `DIRECT://`, `PROXY://`, and `@nametag` addresses
- Delegates swap_id hash verification to the SDK's `verifyManifestIntegrity()`
- Duplicates all other field validation (currency codes, values, timeout, salt)

This is fragile — if the SDK adds new manifest fields or changes validation rules, the escrow's copy diverges silently.

## Proposed Fix

### Fix 1: Make validateManifest address-format-agnostic

`validateManifest()` should accept any non-empty string for `party_a_address` and `party_b_address`. Address format validation (DIRECT:// vs nametag vs proxy) is a separate concern from manifest integrity.

Alternatively, add an `options` parameter:
```typescript
validateManifest(manifest, {
  addressFormats: ['DIRECT', 'PROXY', 'NAMETAG']  // default: all
})
```

### Fix 2: Add standard address helpers to the SDK

Export from the SDK's public API:

```typescript
// Types
type AddressType = 'DIRECT' | 'PROXY' | 'NAMETAG';
interface ParsedAddress { type: AddressType; raw: string; value: string; }

// Parsing & validation
function parseAddress(address: string): ParsedAddress | null;
function isValidAddress(address: string): boolean;
function isValidDirectAddress(address: string): boolean;

// Normalization & comparison
function normalizeAddress(address: string): string;
function addressesMatch(a: string, b: string): boolean;

// Construction
function toDirectAddress(chainPubkey: string): string;
```

Key decisions needed:
- **DIRECT:// hex length**: Real Unicity `chainPubkey` values are 76 hex chars (33-byte compressed secp256k1 + 5-byte prefix). The SDK should define the canonical format, not leave it to each app to guess.
- **Nametag validation**: What regex? The escrow uses `/^[a-z0-9][a-z0-9_-]{2,19}$/` but this should be SDK-authoritative.
- **Case sensitivity**: DIRECT:// hex should be case-insensitive for comparison but stored lowercase.

## Impact

- **escrow-service**: Can remove ~60 lines of custom address validation and ~100 lines of custom manifest validation
- **sphere app**: Likely has its own address parsing too
- **openclaw-unicity**: Same
- **Any future app**: Won't need to reverse-engineer address formats

## Files Affected

**sphere-sdk:**
- `modules/swap/manifest.ts` — relax address validation in `validateManifest()`
- New file: `core/address.ts` (or `validation/address.ts`) — address parsing/validation helpers
- `index.ts` — export new helpers

**escrow-service** (after SDK fix):
- `src/core/manifest-validator.ts` — revert to re-exporting SDK's `validateManifest`
- `src/utils/address.ts` — replace with imports from SDK
- `src/sphere/message-handler.ts` — use SDK's `npubToDirectAddress` equivalent
