# modules/payments/nametag/ — Nametag Storage Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Per-address nametag data CRUD (storage-backed KV).
NO on-chain nametag minting (that path retired per scope §3.8 and moved
to `legacy-v1/mint-nametag.ts`).

**Public methods this submodule owns:**

| Method | Currently at | Target file |
|---|---|---|
| `setNametag` | PaymentsModule.ts:11713 | `store.ts` |
| `getNametag` | PaymentsModule.ts:11739 | `store.ts` |
| `getNametagByName` | PaymentsModule.ts:11758 | `store.ts` |
| `getNametags` | PaymentsModule.ts:11767 | `store.ts` |
| `hasNametag` | PaymentsModule.ts:11782 | `store.ts` |
| `hasNametagNamed` | PaymentsModule.ts:11791 | `store.ts` |
| `clearNametag` | PaymentsModule.ts:11798 | `store.ts` |
| `clearNametagByName` | PaymentsModule.ts:11818 | `store.ts` |
| `reloadNametagsFromStorage` | PaymentsModule.ts:11835 | `store.ts` |
| `isNametagAvailable` | PaymentsModule.ts:12091 | `availability.ts` |

**Instance state:**

- `nametags` (Map<string, NametagData>) → `store.ts`
