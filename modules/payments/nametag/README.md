# modules/payments/nametag/ — Nametag Storage Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Per-address nametag data CRUD (storage-backed KV) plus the
on-chain availability probe. NO on-chain nametag minting (that path
retired per scope §3.8 and moved to `legacy-v1/mint-nametag.ts`).

**Public methods this submodule backs** (Phase 5 wave-1 landed):

| Facade method | Currently on facade at | Helper | Extracted file |
|---|---|---|---|
| `setNametag` | PaymentsModule.ts:11450 | `upsertNametag` | `store.ts` |
| `getNametag` | PaymentsModule.ts:11470 | `getActiveNametag` | `store.ts` |
| `getNametagByName` | PaymentsModule.ts:11489 | `findNametagByName` | `store.ts` |
| `getNametags` | PaymentsModule.ts:11496 | `copyNametagList` | `store.ts` |
| `hasNametag` | PaymentsModule.ts:11511 | `hasAnyNametag` | `store.ts` |
| `hasNametagNamed` | PaymentsModule.ts:11520 | `hasNametagWithName` | `store.ts` |
| `clearNametag` | PaymentsModule.ts:11527 | (facade-only — trivial reset) | — |
| `clearNametagByName` | PaymentsModule.ts:11545 | `removeNametagByName` | `store.ts` |
| `reloadNametagsFromStorage` | PaymentsModule.ts:11556 | `reloadNametagsFromProviders` | `store.ts` |
| `isNametagAvailable` | PaymentsModule.ts:11812 | `checkNametagAvailability` | `availability.ts` |

**Instance state:**

- `nametags: NametagData[]` — still lives on the facade; helpers accept it
  as an explicit list argument. Migrating to a `NametagStore` class instance
  is deferred to a follow-up wave (all disposition ledger targets satisfied
  by pure-function delegation for now).

**File shape:**

- `store.ts` — pure list-manipulation helpers + a
  `reloadNametagsFromProviders` recovery scan.
- `availability.ts` — thin NametagMinter wrapper for the
  `isNametagAvailable` check (still on v1 STSDK — file is on the
  `STSDK_CORE_BURNDOWN` allowlist alongside sibling `NametagMinter.ts`
  until Phase 6.C rewires onto `token-engine`).
- `index.ts` — barrel export.

**Not extracted (out of nametag/ scope):**

- `mintNametag` (facade:11582) — disposition `[C] legacy-v1/mint-nametag.ts`
  per the ledger; other agent's scope.
- `mintFungibleToken` (facade:11685) — disposition `[A] mint/fungible.ts`
  per the ledger; other agent's scope.
