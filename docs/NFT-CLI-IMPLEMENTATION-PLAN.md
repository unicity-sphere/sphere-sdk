# NFT CLI Implementation Plan

> **Date:** 2026-03-21
> **Spec:** [NFT-CLI-SPEC.md](NFT-CLI-SPEC.md)
> **Module:** `modules/nft/NFTModule.ts`
> **Target file:** `cli/index.ts` (currently 4956 lines)

---

## Coverage Verification

### NFTModule Public Methods vs CLI Commands

| NFTModule Method | CLI Command | Spec Section | Status |
|---|---|---|---|
| `createCollection(request)` | `nft-collection-create` | Section 4 | Covered |
| `getCollection(collectionId)` | `nft-collection-info` | Section 4 | Covered |
| `getCollections(options?)` | `nft-collection-list` | Section 4 | Covered |
| `mintNFT(metadata, collectionId?, ...)` | `nft-mint` | Section 5 | Covered |
| `batchMintNFT(items, collectionId?)` | `nft-batch-mint` | Section 5 | Covered |
| `sendNFT(tokenId, recipient, memo?)` | `nft-send` | Section 6 | Covered |
| `getNFT(tokenId)` | `nft-info` | Section 7 | Covered |
| `getNFTs(options?)` | `nft-list` | Section 7 | Covered |
| `getCollectionNFTs(collectionId)` | `nft-list --collection` | Section 7 | Covered (shorthand for `getNFTs({ collectionId })`) |
| `getNFTHistory(tokenId)` | `nft-history` | Section 7 | Covered |
| `importNFT(token)` | `nft-import` | Section 8 | Covered |
| `exportNFT(tokenId)` | `nft-export` | Section 8 | Covered |
| `verifyNFT(tokenId)` | `nft-verify` | Section 9 | Covered |

**Result: All 13 public methods are covered by the spec. No gaps.**

### Spec Consistency with Existing CLI Patterns

| Pattern | Existing CLI | NFT Spec | Match? |
|---|---|---|---|
| Flat hyphenated command names | `swap-propose`, `invoice-create` | `nft-mint`, `nft-collection-create` | Yes |
| Manual arg parsing (`args.indexOf`) | All commands | All commands | Yes |
| Module guard check | `if (!sphere.swap)` | `if (!sphere.nft)` | Yes |
| Lifecycle: `getSphere()` / `ensureSync()` / work / `syncAfterWrite()` / `closeSphere()` | All stateful commands | All NFT commands | Yes |
| Output: `JSON.stringify(obj, null, 2)` for structured data | `swap-propose`, `invoice-status` | `nft-collection-info`, `nft-info` | Yes |
| Tabular output for lists | `swap-list`, `invoice-list` | `nft-list`, `nft-collection-list` | Yes |
| Error output: `console.error()` + `process.exit(1)` | All commands | All commands | Yes |
| COMMAND_HELP entry structure | `{ usage, description, flags, examples, notes? }` | Same structure | Yes |
| Completion entry structure | `{ name, description, flags? }` | Same structure | Yes |
| Prefix resolution for IDs | `swap-*` commands use prefix matching | `nft-*` uses same pattern | Yes |

### Error Cases Review

All commands include the standard error cases:
- Missing required arguments with usage message
- NFT module not enabled guard
- ID prefix resolution errors (no match, ambiguous)
- Command-specific validation errors (invalid formats, file not found, etc.)

The `nft-verify` command correctly uses exit code 1 for invalid/spent tokens (scripting-friendly).

---

## Implementation Tasks

### Task 0: Enable NFT module in `getSphere()`

**Location:** `cli/index.ts` line ~193 (inside `getSphere()`)

Add `nft: true` to `Sphere.init()` options, alongside existing `swap: true` and `accounting: true`.

**Estimated diff:** 1 line

---

### Task 1: Helper functions for ID prefix resolution

**Location:** Insert before the main `switch` block (around line 1520), or at the top of the file near other helpers.

Two helper functions are needed to avoid duplicating prefix resolution logic across 8+ commands:

```typescript
function resolveNFTPrefix(sphere: Sphere, idOrPrefix: string): string
function resolveCollectionPrefix(sphere: Sphere, idOrPrefix: string): string
```

Both follow the algorithm in spec Section 3: exact 64-char match, prefix filter, 0/1/N match handling.

**Estimated lines:** ~40 lines (2 functions, ~20 each)

---

### Task 2: Case blocks in main switch statement

**Location:** Insert after the swap case blocks (after line ~4650, before the `daemon` / utility cases). The spec has 12 commands.

Each command follows the same skeleton:
1. Parse args/flags
2. Validate inputs
3. `getSphere()` + optional `ensureSync()`
4. Resolve prefix IDs if needed
5. Call `sphere.nft.*` method
6. Format and print output
7. Optional `syncAfterWrite()` + `closeSphere()`

#### Estimated lines per command:

| Command | Complexity | Est. Lines |
|---|---|---|
| `nft-collection-create` | Medium (6 flags, validation) | ~65 |
| `nft-collection-list` | Simple (2 flags, table output) | ~50 |
| `nft-collection-info` | Simple (prefix resolve, JSON output) | ~30 |
| `nft-mint` | High (10 flags, repeatable `--attribute`, collection prefix) | ~85 |
| `nft-batch-mint` | Medium (file I/O, JSON parse, collection prefix) | ~70 |
| `nft-send` | Simple (2 positional, 1 flag, prefix resolve) | ~40 |
| `nft-list` | Medium (3 flags, collection prefix, table output) | ~55 |
| `nft-info` | Simple (prefix resolve, JSON output) | ~30 |
| `nft-history` | Medium (prefix resolve, table output, date formatting) | ~45 |
| `nft-export` | Medium (prefix resolve, file output option) | ~40 |
| `nft-import` | Medium (file I/O, JSON parse, result output) | ~45 |
| `nft-verify` | Medium (prefix resolve, conditional exit code) | ~45 |

**Total estimated lines for case blocks:** ~600

---

### Task 3: COMMAND_HELP entries

**Location:** Inside the `COMMAND_HELP` record (starts at line 369). Insert after the swap entries, before any closing brace.

The spec provides exact content for all 12 entries in Section 12. These are copy-paste with minor formatting adjustments.

**Estimated lines:** ~190 (from spec Section 12, verbatim)

---

### Task 4: printUsage section

**Location:** Inside `printUsage()` (line 1360). Insert the NFTs section between the SWAPS section (line ~1454) and the EVENT DAEMON section (line ~1456).

Content is provided verbatim in spec Section 10.

**Estimated lines:** ~14

---

### Task 5: Completions entries

**Location:** Inside `getCompletionCommands()` return array (line 4706). Insert after the swap entries (line ~4772), before the market entries.

Content is provided verbatim in spec Section 11.

**Estimated lines:** ~13

---

## Implementation Order

The recommended order minimizes the risk of merge conflicts and allows incremental testing:

1. **Task 0** -- `getSphere()` change (1 line, enables the module)
2. **Task 1** -- Helper functions (40 lines, no dependencies)
3. **Task 3** -- COMMAND_HELP entries (190 lines, standalone record)
4. **Task 4** -- printUsage section (14 lines, standalone function)
5. **Task 5** -- Completions entries (13 lines, standalone function)
6. **Task 2** -- Case blocks (600 lines, the bulk of the work)

Tasks 2-5 are independent and can be done in parallel, but Task 2 depends on Task 1 (helper functions). Task 0 must come first.

---

## Total Estimated Impact

| Section | Lines Added |
|---|---|
| `getSphere()` modification | ~1 |
| Helper functions | ~40 |
| Case blocks (12 commands) | ~600 |
| COMMAND_HELP entries | ~190 |
| printUsage section | ~14 |
| Completions entries | ~13 |
| **Total** | **~858** |

`cli/index.ts` will grow from ~4956 to ~5814 lines.

---

## Notes and Risks

1. **`sphere.nft` type access.** The existing swap module is accessed via `(sphere as any).swap`. NFT will likely need the same pattern `(sphere as any).nft` unless a typed accessor is added to `Sphere.ts`. Check whether `Sphere.ts` exports an `nft` property or if a cast is needed.

2. **`--attribute` repeatable flag.** This is the only repeatable flag in the NFT CLI. The existing CLI has no precedent for repeatable flags (all current flags are single-use). The parsing loop from spec Section 5 (scanning `args` array for multiple `--attribute` occurrences) is the correct approach.

3. **`nft-batch-mint` file I/O.** Uses `fs.readFileSync` + `JSON.parse`, same pattern as `invoice-import` and `parse-wallet`. No new dependencies needed.

4. **`nft-verify` exit code.** The spec requires `process.exit(1)` for invalid/spent NFTs. This differs from most commands where exit 1 means error. This is intentional for scripting (`&& echo VALID || echo INVALID`). Ensure the exit happens after `closeSphere()` to avoid resource leaks.

5. **`nft-export` stdout vs file.** When `--output` is not specified, TXF JSON goes to stdout. Confirmation messages must go to stderr (`console.error`) to avoid corrupting the JSON output when piped. This pattern exists in the codebase already.

6. **Collection prefix resolution in `nft-list` and `nft-mint`.** Both commands accept `--collection <id>` which needs prefix resolution. The `resolveCollectionPrefix` helper handles this uniformly.
