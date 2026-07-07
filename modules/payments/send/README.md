# modules/payments/send/ — Send Orchestration Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Single entry for `send()` — request validation, spend-queue
serialization, reservation, mode dispatch, retry-on-suspected-spent
(main's `sendOnce`/`demoteSuspectedSpent` pattern), recipient / transport
pubkey resolution, outbound asset-kind classification.

**Public methods this submodule owns** (routed from the PaymentsModule
facade):

| Method | Currently at | Target file |
|---|---|---|
| `send` | PaymentsModule.ts:5566 (720 lines) | `orchestrator.ts` |
| `resolveTransportPubkey` | PaymentsModule.ts:12587 | `recipient-resolve.ts` |
| `resolveRecipientAddress` | PaymentsModule.ts:15461 | `recipient-resolve.ts` |
| `createDirectAddressFromPubkey` | PaymentsModule.ts:15434 | `recipient-resolve.ts` |
| `deriveRecipientAddressFor` | PaymentsModule.ts:15720 | `recipient-resolve.ts` |
| `computeOutboundAssetKinds` | PaymentsModule.ts:12622 | `asset-kind.ts` |
| `resolveOutboundWireProtocol` | PaymentsModule.ts:12647 | `asset-kind.ts` |
| `emitDoubleSpendDetectedIfApplicable` | PaymentsModule.ts:15319 | `double-spend-emit.ts` |

**Extraction strategy:** the 720-line `send()` orchestrator becomes
`send/orchestrator.ts` exporting a `sendOrchestrator({ facade, request })`
free function (facade passed for access to reservation ledger + spend queue
+ oracle + transport). Recipient/asset-kind helpers move independently.
