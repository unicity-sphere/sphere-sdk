# modules/payments/mint/ — Mint Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Fungible token minting via the token engine (Phase 6.C
rewires onto `ITokenEngine`; Phase 5 preserves v1-STSDK call signature).

**Public methods this submodule owns:**

| Method | Currently at | Target file |
|---|---|---|
| `mintFungibleToken` | PaymentsModule.ts:11964 | `fungible.ts` |

**Not here (moved to legacy-v1/):**

- `mintNametag` — v1 on-chain nametag mint, retired per scope §3.8;
  quarantined into `modules/payments/legacy-v1/mint-nametag.ts`.
