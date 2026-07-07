# modules/payments/receive/ — Receive Concern Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** `receive()` + inbound handler (post-Phase-6.C, when the v2
"tokens arrive finished" semantics land and the [C] finalization family
is deleted). Wake handling. Inbound-handler v2 branches.

**Public methods this submodule owns** (routed from the PaymentsModule
facade):

| Method | Currently at | Target file |
|---|---|---|
| `receive` | PaymentsModule.ts:8066 | `receive.ts` |
| `handleIncomingTransfer` (v2 branch only) | PaymentsModule.ts:16143 (585 lines total, mixed) | `inbound-handler.ts` |

**Types this submodule owns:**

| Type | Currently at | Target file |
|---|---|---|
| `ReceiveOptions` | PaymentsModule.ts:434 | `types.ts` |
| `ReceiveResult` | PaymentsModule.ts:447 | `types.ts` |

**Ambiguity note:** `handleIncomingTransfer` is a 585-line multiplexer
over 6 payload shapes. The v2 branch is [A] survive-bound; the UXF-shape
branch is [B] extension-bound; 4 legacy branches are [C] delete-bound.
Per-branch classification requires a product-decision hold before
Phase 6.C — see uxfv2-phase-5-payments-disposition.md §Ambiguities item 1.
