# UXF Transfer — Adversarial Test Index

This index maps each adversarial scenario in `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §11.4 to the test(s) that pin its defense. The mapping is the spec-coverage source of truth for T.8.E.3.

Tests live in two places:

- **`tests/adversarial/transfer/`** — first-class adversarial scenarios. Threat-actor framing, hostile-mock pattern, defense assertions.
- **`tests/unit/payments/transfer/`** — unit-level adversarial coverage embedded in component tests (e.g., `replay-lru.test.ts`, `bundle-verifier.test.ts`). Listed below alongside the adversarial-suite wraps so an auditor walking §11.4 finds at least one test per scenario.

Spec section refs: [UXF-TRANSFER-PROTOCOL.md §11.4](../../../docs/uxf/UXF-TRANSFER-PROTOCOL.md).

---

## §11.4 Coverage Matrix

| §11.4 scenario | Adversarial test (this dir) | Unit test (covering) |
|---|---|---|
| Sender claims `mode: 'conservative'` but bundle has unfinalized txs → recipient processes per bundle contents; token enters `pending`. | `mode-claim-mismatch.test.ts` (CONSERVATIVE-claim + unfinalized) | `tests/unit/payments/transfer/disposition-engine.test.ts` (mode='conservative' + unfinalized → PENDING) |
| Sender claims `mode: 'instant'` but bundle has all proofs → recipient processes per §5.3; token enters `valid`. | `mode-claim-mismatch.test.ts` (INSTANT-claim + all-finalized) | `disposition-engine.test.ts` ("does NOT throw for instant mode + chain that is coincidentally fully finalized") |
| Bundle CID hash collision (theoretical SHA-256 collision) → defended at the per-block hash-verify stage of `UxfPackage.fromCar`. | (covered structurally by §5.2 #1; see multi-root) | `tests/unit/uxf/transfer-payload.test.ts` (`extractCarRootCid` rejection paths) |
| **Multi-root CAR** (smuggling attempt) → rejected at `pkg.verify()` (§5.2 #1, normative MUST). | `multi-root-car.test.ts` | `tests/unit/uxf/transfer-payload.test.ts` (`extractCarRootCid` multi-root rejection) |
| Bundle DAG contains token-roots NOT in `payload.tokenIds` → recipient processes them anyway, [B] filter rejects ones that don't bind to us → `audit-not-our-state` in `_audit`. | `smuggled-roots-not-in-tokenids.test.ts` | `tests/unit/payments/transfer/bundle-verifier.test.ts` (advisory unclaimed split) |
| **Forged `payload.sender.nametag`** → recipient discards plaintext nametag, re-resolves against Nostr signing pubkey via identity binding. | `forged-nametag.test.ts` | `tests/unit/payments/transfer/nametag-reresolver.test.ts` |
| **Replay**: identical bundleCid sent 100 times → 1 processed, 99 short-circuited via LRU; if LRU evicts, re-processing is benign (idempotent per §5.6). | `replay-bundlecid.test.ts` | `tests/unit/payments/transfer/replay-lru.test.ts`, `bundle-acquirer.test.ts` (replay short-circuit) |
| **Instant-mode + concurrent split**: 5 split outputs all unfinalized → 5 separate finalizations all converge. | `instant-mode-concurrent-split.test.ts` | `finalization-worker-sender.test.ts` (per-entry finalization paths) |
| **Recipient's local clock skewed by 30 days** → finalization worker still runs (no clock-dependent guards). | `recipient-clock-skew.test.ts` | `tests/unit/payments/transfer/§5.5-2x-window-safety-net.test.ts`, `polling-policy.test.ts` |
| **Chain-mode forwarder dies mid-chain**: queue carries entries for predecessor's pending tx; finalization completes via local worker. | `forwarder-dies-midchain.test.ts` | `finalization-worker-sender.test.ts` (already-terminal entries, multi-requestId) |
| **Forged authenticator on unfinalized tx** → §5.3 [C](1) ECDSA verify fails → `PROOF_INVALID` (auth-invalid). MUST be detected at receive. | `forged-authenticator-mid-chain.test.ts` | `tests/unit/payments/transfer/authenticator-verifier.test.ts`, `disposition-engine.test.ts` (per-tx W37) |
| **Broken source-state continuity** at any tx → C8 walker → `continuity-broken`. | `broken-continuity.test.ts` | `tests/unit/payments/transfer/continuity-walker.test.ts`, `disposition-engine.test.ts` |
| **Bandwidth-burning peer**: hostile flood evicts honest LRU entries — defense via per-sender LRU sub-bucket (Note N5). | `bandwidth-burning-peer.test.ts` | `tests/unit/payments/transfer/replay-lru.test.ts` (Note N5 cross-sender defense) |
| **Peer-reputation cooldown (deferred)**: 1-hour silent-drop window for hard-failing chain peers. | DEFERRED per §12.2 — test will land when framework lands. | — |
| **Faulty-aggregator path (intermittent PATH_NOT_INCLUDED)**: aggregator returns transient PATH_NOT_INCLUDED, then OK. Worker keeps polling. | `faulty-aggregator-intermittent.test.ts` | `finalization-worker-sender.test.ts` (transient retries section) |
| **Race-lost detection (poll-side)**: race-loser's poll returns OK with mismatching transactionHash → hard-fails `race-lost`; cascade does NOT fire. | (covered) | `tests/unit/payments/transfer/§6.1-race-lost-poll-mismatch.test.ts`, `finalization-worker-sender.test.ts` |
| **Client-error at submit (REQUEST_ID_MISMATCH)**: aggregator returns mismatch → hard-fails `client-error`; emits operator-alert; no cascade. | (covered) | `tests/unit/payments/transfer/§6.1-client-error-request-id-mismatch.test.ts`, `finalization-worker-sender.test.ts` |
| **Sustained PATH_NOT_INCLUDED past polling window** → hard-fails `oracle-rejected` after deadline. | (covered) | `finalization-worker-sender.test.ts` ("FinalizationWorkerSender — sustained PATH_NOT_INCLUDED") |
| **Conservative-mode post-send PATH_INVALID** → hard-fail `proof-invalid` after retries. | (covered) | `finalization-worker-sender.test.ts` ("PATH_INVALID") |
| **Conservative-mode post-send NOT_AUTHENTICATED** → emit `transfer:trustbase-warning`; trustBase refresh; sustained-after-refresh emits `transfer:security-alert`. | (covered) | `finalization-worker-sender.test.ts` ("NOT_AUTHENTICATED"), `trustbase-staleness.test.ts` |
| **OrbitDB CRDT replica merge**: monotonic-state-machine LWW resolution; no `finalized → sending` regressions. | (covered by property tests) | `tests/unit/profile/outbox-merger.property.test.ts`, `outbox-merger.test.ts`, `outbox-merger-g-counter-rule4.test.ts` |
| **Stuck-PENDING escape**: token pending >7 days; operator pastes proof via `payments.importInclusionProof()` → grafts in, transitions to `valid`. | `stuck-pending-escape.test.ts` | `tests/unit/payments/transfer/import-inclusion-proof.test.ts` (10 sub-cases) |
| **Conflicting proofs at same requestId** (§6.3 forbidden) → emits `transfer:security-alert`; refuse merge. | `conflicting-proofs-same-requestid.test.ts` | `tests/unit/payments/transfer/§6.3-most-recent-proof-tombstone.test.ts`, `finalization-worker-sender.test.ts` |

---

## Files in This Directory

| File | Tests | Spec section |
|---|---|---|
| `bandwidth-burning-peer.test.ts` | 5 | §5.1 Note N5, §11.4 |
| `broken-continuity.test.ts` | 7 | §5.3 [C](2), C8 |
| `conflicting-proofs-same-requestid.test.ts` | 5 | §6.3 forbidden, C10 |
| `faulty-aggregator-intermittent.test.ts` | 5 | §6.1, §11.4 |
| `forged-authenticator-mid-chain.test.ts` | 6 | §5.3 [C](1), W37/N7 |
| `forged-nametag.test.ts` | 11 | §3.1, §5.6, §9.3, C9 |
| `forwarder-dies-midchain.test.ts` | 5 | §6.1, §11.4 |
| `instant-mode-concurrent-split.test.ts` | 4 | §5.5, §6.1, §11.4 |
| `mode-claim-mismatch.test.ts` | 6 | §3.1, §5.3, §11.4 |
| `multi-root-car.test.ts` | 4 | §5.2 #1, §11.4 |
| `recipient-clock-skew.test.ts` | 6 | §5.5 step 6, §11.4 |
| `replay-bundlecid.test.ts` | 4 | §5.1, §5.6, §11.4 |
| `smuggled-roots-not-in-tokenids.test.ts` | 4 | §5.2 #2, §5.3 [B], §11.4 |
| `stuck-pending-escape.test.ts` | 5 | §6.3, §11.4 |

**Total: 14 files, 77 tests.**

---

## Threat-Actor Modeling Conventions

Each test in this directory follows a consistent shape so an auditor walking the suite finds:

1. **Threat-model docstring** — what the hostile actor is trying to do, in 2–4 sentences.
2. **Spec wording quote** — direct excerpt from the protocol document (`UXF-TRANSFER-PROTOCOL.md`) describing the mandated defense.
3. **What this test pins** — enumerated invariants the test asserts.
4. **Spec references** — section anchors so the test → spec → implementation graph is greppable.

This shape is the regression-resistance contract: a future refactor that breaks one of the listed invariants causes the test to surface a meaningful failure message tied to a §-anchor an operator can look up immediately.

---

## Adding a New Adversarial Test

1. Pick a §11.4 row that does not yet have a dedicated adversarial wrap (or a future §11.4 addition).
2. Read the implementation surface — find the defense in `modules/payments/transfer/` and the unit test that already covers the component.
3. Write a `.test.ts` here that:
    - Mocks the hostile actor (forged input, faulty aggregator, etc.).
    - Asserts the defense's observable invariant (typed error code, no-state-change, idempotency, etc.).
    - Quotes the spec wording in the file-level docstring.
4. Add the row to the coverage matrix above.
