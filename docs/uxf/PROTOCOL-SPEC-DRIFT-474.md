# Trader Protocol Spec Drift Audit (issue #474 G4)

**Spec audited:** `/home/vrogojin/trader-service/docs/protocol-spec.md` v0.1 (Draft, dated 2026-04-03), with §2 marked v0.2 internally (Appendix D notes a 2026-04-03 revision replacing NIP-29 with MarketModule).
**Implementation audited:** `trader-service` at HEAD on `main`, files `src/trader/*.ts` (`acp-types.ts`, `negotiation-handler.ts`, `intent-engine.ts`, `swap-executor.ts`, `trader-command-handler.ts`, `utils.ts`, `types.ts`, `main.ts`), and the controller surface in `sphere-cli-work/sphere-cli/src/trader/trader-commands.ts`.
**Audit date:** 2026-06-10
**Auditor's verdict:** **DRIFT BLOCKS #474 G2 SOAK** — the rate/volume type drift (D1) is load-bearing for the soak script's unit choice, the human-friendly-float design intent (D-NEW) is also unaddressed, and the CLI surface uses parameter names that the trader doesn't recognize (D2c). Several further drifts (envelope-signature input, deal_id field set, FAILED reason codes, error-code names) are tractable but should be fixed in the spec before this becomes a public reference.

## Summary

The implementation is largely faithful to the spec at the **state-machine** level (intent and deal lifecycles match the §6.1/§6.2 tables modulo a couple of pragmatic widenings), the **8-criterion matching rules** (§5.1) are all implemented in `intent-engine.ts`, and the §5.7 lower-pubkey-proposer election is enforced with a 45 s yield-timeout fallback. The privacy/security envelope (anti-replay window, clock-skew, dangerous-key rejection, dedup window of 600 s / 10 000 entries, max active intents, max-concurrent-swaps) all match the documented numbers.

Where the spec and implementation **disagree** is on the **wire-encoding of monetary values** and on a few small structural details. The most consequential disagreement is the rate/volume type drift (§2.4 says `number`; the implementation has always been `bigint` strings end-to-end, and that's the only encoding the deployed v0.1 image accepts). Other notable drifts are: the NP envelope signature input formula in §3.4 is wrong (spec says `sha256hex(deal_id+":"+msg_id+":"+type)`; implementation hashes canonical JSON of the whole envelope-minus-signature); the deal_id derivation in §3.5 omits four fields the implementation actually hashes (proposer_address, acceptor_address, deposit_timeout_sec, proposer_direction); the spec's error-code names (`INTENT_NOT_FOUND`, `MAX_INTENTS_REACHED`, `INVALID_ADDRESS`, `TRANSFER_FAILED`, `WITHDRAWAL_LOCKED`) don't match the names the handler returns (`NOT_FOUND`, `LIMIT_EXCEEDED`, `INVALID_PARAM`, `WITHDRAW_FAILED`).

The third-party concern surfaced by the coordinator update — that the **CLI surface should accept human-friendly floats** (`--rate-min 0.08`) and **convert to bigint smallest-units** via a token-registry decimals lookup before sending — is **neither in the spec nor in the implementation today** and surfaces as a three-way drift between design intent, the spec, and the code. The CLI today requires the operator to type fully-scaled bigint strings (`--rate-min 80000000000000000` for 0.08 UCT at 18 decimals), which is a soak-UX hazard.

## Findings

### FINDING D1 — Rate/volume types: float-in-spec vs bigint-in-code (BLOCKS SOAK UNIT CHOICE)

- **Spec:** `protocol-spec.md:139-142` and `:191-195` declares `rate_min/rate_max/volume_min/volume_max` as `number` (JS float). `protocol-spec.md:399-402` repeats this in the canonical TypeScript interface. §7.3 line `1341` writes `assert(rate_min > 0)` style assertions against `number` values.
- **Code (ACP wire shape):** `src/trader/acp-types.ts:20-23` declares `rate_min: string`, `rate_max: string`, `volume_min: string`, `volume_max: string` on `CreateIntentParams`. `acp-types.ts:36-39` does the same for `CreateIntentResult`. `acp-types.ts:74-78` and `:105-106` do the same for `IntentSummary` and `DealSummary`.
- **Code (handler parse):** `src/trader/trader-command-handler.ts:370-378` parses incoming `rate_min/rate_max/volume_min/volume_max` via `safeParseBigint`. `safeParseBigint` at `:120-131` rejects anything that isn't `/^-?\d+$/`, so a float literal like `"0.5"` is rejected as `INVALID_PARAM`.
- **Code (canonical domain shape):** `src/trader/types.ts:72-75` declares the canonical `TradingIntent.rate_min/rate_max/volume_min/volume_max` as `bigint`. `DealTerms.rate` (`types.ts:108-109`) is `bigint`. `intent-engine.ts:832-835` parses params via `BigInt(params.rate_min)`, and `utils.ts:182-186` does the same in `validateIntentParams`.
- **Code (CLI surface):** `sphere-cli-work/sphere-cli/src/trader/trader-commands.ts:386-389` declares `--rate-min <bigint>`, `--rate-max <bigint>`, `--volume-min <bigint>`, `--volume-max <bigint>` and forwards the literal strings without conversion (`trader-commands.ts:224-231`).
- **Impact:** Soak operators don't know whether to encode rates as decimal numbers or smallest-unit bigint strings. The actual deployed v0.1 image accepts ONLY bigint strings, so operators MUST use that — but the spec docs read like floats are the wire format. `utils.ts:182-189` catches the `BigInt()` throw and returns the generic `"rate and volume parameters must be valid integer strings"` — operators reading the spec will burn time trying decimals before discovering the actual contract.
- **Recommendation:** patch the spec §2.4 to declare these as bigint strings (canonical JSON tolerates `"42000000000000000000"` strings). Specifically:
  - Change the TypeScript interface block at `protocol-spec.md:130-148` to use `string` (with a doc comment `// stringified bigint, smallest units`).
  - Change the constraint table at `:191-195` from "Positive finite number" to "Positive bigint (string-encoded, smallest units)".
  - Update §5.2's `floor((overlap_min + overlap_max) / 2)` to clarify it's bigint integer division (the implementation in `intent-engine.ts:896` does `Number((rateMin + rateMax) / 2n)` for the MarketModule midpoint, but the on-the-wire midpoint stays bigint).
  - Update §7.3 assertions to use bigint comparison operators (`> 0n`).

### FINDING D-NEW — CLI should accept human-friendly floats; spec/code only see bigints (HIGH; design intent unspoken)

- **Design intent (from owner):** At the CLI surface, operators work with **human-friendly float numbers** (`--rate-min 0.08 --rate-max 0.12`, `--volume-min 50 --volume-max 50`). The CLI is responsible for converting these to bigint smallest-units internally via a token-registry decimals lookup. The ACP wire format SHOULD remain bigint-string so canonical JSON doesn't lose precision.
- **Spec today:** `protocol-spec.md:139-142, :694-705` describes `number` end-to-end — float at the wire too. No mention of CLI-side conversion. No mention of asset-decimals.
- **Code today (CLI):** `sphere-cli/src/trader/trader-commands.ts:386-389` declares `--rate-min <bigint>` and forwards the literal string. `:224-231` builds the ACP payload with `rate_min: opts.rateMin` directly — no conversion, no decimals lookup, no validation that the input is bigint-shaped.
- **Code today (trader):** `trader-command-handler.ts:370-378` enforces bigint-string at the ACP boundary; the trader has no float path.
- **Impact:** Three-way drift between (a) design intent (float at CLI, bigint at wire), (b) spec (float end-to-end), (c) implementation (bigint end-to-end including CLI). An operator who types `sphere trader create-intent --rate-min 0.08` today gets a CLI-side parser error or a downstream `INVALID_PARAM` from the trader. The soak script must currently spell out `80000000000000000` and rely on the operator/script-author to know UCT is 18-decimal.
- **Recommendation (multi-step, do NOT apply now):**
  1. **CLI:** accept floats; add an optional `--rate-min-bigint` fallback for power users. Convert via a token-registry decimals lookup (e.g. a new `MarketModule.decimalsFor(asset)` or extending `TokenRegistry`). For each pair, the conversion is `BigInt(Math.round(floatValue * 10 ** decimals))` with explicit overflow guard.
  2. **ACP wire:** stays bigint-string (matches D1's recommendation).
  3. **Spec §2.4 / §4.2:** patch to declare wire as bigint-string. Add a §2.4-bis subsection: "Recommended CLI UX — accept floats with decimal-registry-based conversion".
  4. **CLI validation:** also catch silly values pre-flight — non-finite floats, negatives, more decimal digits than the asset supports.

### FINDING D2 — NP envelope signature input formula is wrong in spec

- **Spec:** `protocol-spec.md:469` declares `signature: string;       // ECDSA over sha256hex(deal_id + ":" + msg_id + ":" + type)`.
- **Code:** `negotiation-handler.ts:561-563` and `:815-823` compute the signature input as `sha256hex(canonicalJson(envelope-minus-signature))`. That is, the signature covers EVERY field of the envelope (np_version, msg_id, deal_id, sender_pubkey, type, ts_ms, payload), not just three of them.
- **Impact:** A spec-conformant implementation built off `protocol-spec.md` would sign only three fields and the deployed v0.1 trader would reject every message it sent (signature verification at `:815-823` recomputes the canonical-JSON hash and would fail). The implementation's choice is also more secure — the formula in the spec lets a MITM tamper with `payload` (e.g. `proposer_swap_address`) while keeping the original signature valid, which the implementation's docstring at `:553-560` explicitly flags as a known-bad pattern.
- **Recommendation:** patch §3.4 line 469 to `// ECDSA over sha256hex(canonicalJson(envelope-minus-signature))`. Add a "Rationale: binds every field, prevents payload-substitution" sentence so a future implementor knows why the wider commitment is required.

### FINDING D3 — Deal ID derivation omits four fields the implementation hashes

- **Spec:** `protocol-spec.md:487-500` declares deal_id derivation includes the field set `{proposer_pubkey, acceptor_pubkey, proposer_intent_id, acceptor_intent_id, base_asset, quote_asset, rate, volume, escrow_address, created_ms}`.
- **Code:** `negotiation-handler.ts:531-551` (`computeDealId`) hashes the field set `{acceptor_intent_id, acceptor_pubkey, base_asset, created_ms, deposit_timeout_sec, escrow_address, proposer_address, acceptor_address, proposer_direction, proposer_intent_id, proposer_pubkey, quote_asset, rate, volume}` — i.e. the spec's 10 fields PLUS `proposer_address`, `acceptor_address`, `deposit_timeout_sec`, and `proposer_direction`.
- **Impact:** A spec-conformant agent computes a DIFFERENT deal_id than the deployed trader for the same negotiated terms. Cross-implementation interoperability is impossible until they agree. The extra fields in the implementation are good additions — `deposit_timeout_sec` is a money-relevant negotiated value, and `proposer_direction` flips who-deposits-what — but the spec needs to record them. Without `proposer_direction` in the hash, an attacker could swap who-sells-what and the deal_id would be unchanged.
- **Recommendation:** patch §3.5 to add the four missing fields to the canonical JSON input. Document the rationale next to each: addresses bind the on-chain destinations; deposit_timeout_sec binds the funds-at-risk window; proposer_direction prevents who-sells-what flip attacks.

### FINDING D4 — DealTerms interface omits four fields the implementation carries

Related to D3 but distinct (since the spec also publishes a `DealTerms` TypeScript interface that doesn't include the extra fields).

- **Spec:** `protocol-spec.md:505-518, 626-638` declares `DealTerms` with 11 fields including no addresses, no proposer_direction, no `deal_id` at all.
- **Code:** `types.ts:98-114` declares `DealTerms` with 16 fields: spec's 11 PLUS `deal_id`, `proposer_address`, `acceptor_address`, `proposer_direction`.
- **Recommendation:** patch §3.6 to add `deal_id` (the content-addressed ID of the deal, lowercase 64-hex), `proposer_address`, `acceptor_address` (Nostr DM destination addresses, max 256 chars), and `proposer_direction` (`'buy' | 'sell'`).

### FINDING D5 — ACP command error codes don't match spec names

The spec publishes a closed set of error codes in §4 and Appendix B.1. The implementation returns DIFFERENT names.

- **CANCEL_INTENT (§4.3 spec line 754-757):** spec promises `INTENT_NOT_FOUND` / `INTENT_NOT_ACTIVE` / `DEAL_IN_PROGRESS`. Code at `trader-command-handler.ts:479` returns `NOT_FOUND` (not `INTENT_NOT_FOUND`). `INTENT_NOT_ACTIVE` is never returned. `DEAL_IN_PROGRESS` at `:490` matches.
- **CREATE_INTENT (§4.2 spec line 724-728):** spec promises `INVALID_PARAM` / `ASSET_UNKNOWN` / `INSUFFICIENT_BALANCE` / `MAX_INTENTS_REACHED`. Code at `:434` returns `LIMIT_EXCEEDED` instead of `MAX_INTENTS_REACHED`. `ASSET_UNKNOWN` and `INSUFFICIENT_BALANCE` are not returned by `handleCreateIntent` (they're only reachable in WITHDRAW_TOKEN).
- **WITHDRAW_TOKEN (§4.9 spec line 958-962):** spec promises `INSUFFICIENT_BALANCE` / `INVALID_ADDRESS` / `WITHDRAWAL_BLOCKED` / `TRANSFER_FAILED`. Code at `:716` returns `INVALID_PARAM` (NOT `INVALID_ADDRESS`); at `:728` returns `INSUFFICIENT_BALANCE` (matches); at `:761` returns `WITHDRAW_FAILED` (NOT `TRANSFER_FAILED`); `WITHDRAWAL_BLOCKED` / `WITHDRAWAL_LOCKED` (Appendix B.1 line 1604) is never returned.
- **Generic INTERNAL_ERROR:** spec never lists `INTERNAL_ERROR` but the handler returns it at `:462, 511, 540, 569, 624, 686, 868`. (This is fine — it's the canonical fallback — but Appendix B.1 should list it.)
- **Recommendation:** decide per-code whether to rename the spec or rename the code. Recommend renaming the **spec** to match implementation (the codes are already in the deployed trader and are observable behavior). Specifically:
  - §4.3: `INTENT_NOT_FOUND` → `NOT_FOUND`.
  - §4.2: `MAX_INTENTS_REACHED` → `LIMIT_EXCEEDED`.
  - §4.9: `INVALID_ADDRESS` → `INVALID_PARAM` (`to_address must be ...`), `TRANSFER_FAILED` → `WITHDRAW_FAILED`.
  - Appendix B.1: add `INTERNAL_ERROR`, remove `WITHDRAWAL_LOCKED` / `INVALID_TXF` / `PROOF_INVALID` / `ASSET_MISMATCH` / `TRANSFER_NOT_TO_AGENT` (none of these are returned by the trader).

### FINDING D6 — `INTENT_NOT_ACTIVE` is undocumented behavior

- **Spec:** `protocol-spec.md:756` declares `INTENT_NOT_ACTIVE` is returned when an intent is already filled/cancelled/expired.
- **Code:** `trader-command-handler.ts:468-513` has NO `INTENT_NOT_ACTIVE` branch. `intentEngine.cancelIntent` at `intent-engine.ts:944-978` throws "Cannot cancel intent in terminal state" when called on a terminal intent; the command handler at `:511` wraps this in `INTERNAL_ERROR`.
- **Impact:** an operator who tries to cancel an already-filled intent gets a generic `INTERNAL_ERROR` instead of the documented `INTENT_NOT_ACTIVE`. Not load-bearing for the soak but corrosive to debugging.
- **Recommendation:** code fix (in trader-service, NOT here) — `cancelIntent` should pre-check terminal state and return `INTENT_NOT_ACTIVE`; OR drop `INTENT_NOT_ACTIVE` from §4.3 / Appendix B.1 and rely on `INTERNAL_ERROR`. Recommend the former.

### FINDING D7 — `SetStrategyResult.strategy` echoes the partial input, not the merged full strategy

- **Spec:** `protocol-spec.md:857-859` says `strategy: SetStrategyParams; // echoes back the full merged strategy`.
- **Code:** `trader-command-handler.ts:615-617` sets `result.strategy = strategyParams` — the partial input the operator supplied, NOT the full merged result. The merge result is computed at `:597-607` (the `merged` variable) but never returned.
- **Impact:** operator can't verify the merged state without a follow-up call. Not security-sensitive but breaks the implicit "set returns the new full state" contract.
- **Recommendation:** code fix — set `result.strategy = merged`. Cheap and contained.

### FINDING D8 — CLI SET_STRATEGY param names don't match trader expectations

- **Spec / trader:** `protocol-spec.md:841-850` and `trader-command-handler.ts:579-589` expect param names `auto_match`, `auto_negotiate`, `max_concurrent_swaps`, `max_active_intents`, `min_search_score`, `scan_interval_ms`, `market_api_url`, `trusted_escrows`, `blocked_counterparties`.
- **Code (CLI):** `sphere-cli-work/sphere-cli/src/trader/trader-commands.ts:340-352` sends `rate_strategy` (not in spec or trader), `max_concurrent_negotiations` (trader expects `max_concurrent_swaps`), and `trusted_escrows` (matches).
- **Impact:** `sphere trader set-strategy --max-concurrent N` SILENTLY DOES NOTHING — the trader receives an unknown param and the existing strategy stays unchanged. `--rate-strategy aggressive` similarly disappears. Only `--trusted-escrows` actually takes effect.
- **Recommendation:** code fix in sphere-cli (NOT here): rename to `max_concurrent_swaps` and drop `rate_strategy` (or add a `rate_strategy` field on the trader-side strategy). This is a CLI bug, not a spec bug.

### FINDING D9 — LIST_INTENTS / LIST_SWAPS use `filter`/`state` interchangeably

- **Spec:** `protocol-spec.md:767-771, 803-807` declares the param is `filter` (not `state`). Values: `active`, `filled`, `cancelled`, `expired`, `all` for intents; `active`, `completed`, `failed`, `all` for swaps.
- **Code (trader):** `trader-command-handler.ts:521, 550` reads `params['filter']`. Matches spec.
- **Code (CLI):** `sphere-cli/src/trader/trader-commands.ts:283, 301` sends `state` (NOT `filter`). The trader's `matchesIntentFilter` falls through `filter === undefined` → `return true` (`trader-command-handler.ts:202`), so the CLI's `--state filled` request actually returns ALL intents, not just filled.
- **Impact:** another silent CLI bug — operator-facing filter knob is ignored. Soak operator using `sphere trader list-intents --state filled` sees confusing output.
- **Recommendation:** code fix in sphere-cli: rename `state` → `filter`. Trivially safe.

### FINDING D10 — TIP_VERSION = "0.2" declared by spec but unused in code

- **Spec:** `protocol-spec.md:105, 382` declares `TIP_VERSION = "0.2"`.
- **Code:** No reference anywhere in `src/trader/*.ts` to `TIP_VERSION`. There is no `tip_version` field on any envelope (TIP-0 is just a thin wrapper over MarketModule's HTTP API and the spec admits "There are no explicit wire-format message types" at line 121).
- **Impact:** harmless today (MarketModule postIntent doesn't carry the TIP version), but a future TIP-1 would have no rollout vector. The spec's claim that the version is meaningful is misleading.
- **Recommendation:** spec patch — either delete the `TIP_VERSION` constant declaration, or add a §2.x noting that "the TIP version is currently an internal compatibility marker; it is not transmitted over the wire because TIP-0 piggybacks the unversioned MarketModule HTTP API. A future TIP-1 will be signaled via an explicit version field on PostIntentRequest."

### FINDING D11 — IntentSummary spec includes `volume_min`, the result interface does not

- **Spec:** `protocol-spec.md:781-794` declares `IntentSummary` with 12 fields including `rate_min`, `rate_max`, `volume_max`, `volume_filled` — but NOT `volume_min`.
- **Code:** `acp-types.ts:69-83` declares `IntentSummary` with `volume_min` AND `volume_max` AND `volume_filled`. `trader-command-handler.ts:151-167` (`toIntentSummary`) emits all three.
- **Impact:** spec under-documents the response shape. Soak script consuming `list-intents` output gets a `volume_min` field that isn't in the spec.
- **Recommendation:** spec patch — add `volume_min: string` to §4.4 line ~787. Trivial.

### FINDING D12 — DealSummary error_code is undocumented

- **Spec:** `protocol-spec.md:819-831` declares `DealSummary` with 10 fields. No `error_code`.
- **Code:** `acp-types.ts:100-117` adds optional `error_code?: string` carrying the FAILED-state failure reason. `trader-command-handler.ts:192-193` (`toDealSummary`) emits it when present.
- **Impact:** an operator reading the spec to write a list-deals consumer wouldn't know how to surface failure reasons. The set of values it carries (`EXECUTION_TIMEOUT`, `ESCROW_UNREACHABLE`, `INVALID_ESCROW`, `PAYOUT_UNVERIFIED`, `PROPOSE_SWAP_FAILED: ...`) is documented in `types.ts:120-139` but invisible from the spec.
- **Recommendation:** spec patch — add `error_code?: string` to §4.5 `DealSummary` (line ~830), with a footnote listing the canonical values. Reference Appendix B.3 (which DOES list some of these in the spec).

### FINDING D13 — Deal failure reason codes in Appendix B.3 are incomplete

- **Spec:** `protocol-spec.md:1622-1628` lists `DEPOSIT_TIMEOUT`, `ESCROW_REJECTED`, `ESCROW_UNREACHABLE`, `COUNTERPARTY_UNRESPONSIVE`, `NETWORK_ERROR`, `INTERNAL_ERROR`.
- **Code:** the actually-emitted values are `EXECUTION_TIMEOUT` (`swap-executor.ts:402`, `:398` variant), `ESCROW_UNREACHABLE` (`types.ts:129`), `INVALID_ESCROW` (`types.ts:130`), `PAYOUT_UNVERIFIED` (`trader-main.ts:646, 666`), `PROPOSE_SWAP_FAILED: <message>` (`swap-executor.ts:518`), `EXECUTION_TIMEOUT_REJECT_FAILED: <message>` (`swap-executor.ts:398`), `MISSING_COUNTERPARTY_PUBKEY` (`main.ts:1281`), `PROTOCOL_VERSION_TOO_OLD` (`main.ts:1260`).
- **Impact:** spec promises codes that never appear; code emits codes the spec doesn't list. Operators triaging failures from logs see codes they can't look up.
- **Recommendation:** spec patch — replace Appendix B.3 with the actual emitted set: `EXECUTION_TIMEOUT`, `ESCROW_UNREACHABLE`, `INVALID_ESCROW`, `PAYOUT_UNVERIFIED`, `PROPOSE_SWAP_FAILED`, `MISSING_COUNTERPARTY_PUBKEY`, `PROTOCOL_VERSION_TOO_OLD`. Note that `PROPOSE_SWAP_FAILED` and `EXECUTION_TIMEOUT_REJECT_FAILED` carry a colon-suffix message tail.

### FINDING D14 — `np.reject_deal` reason_code set is wider than spec promises

- **Spec:** `protocol-spec.md:568-577, 614-622` declares 8 reason codes: `RATE_UNACCEPTABLE`, `VOLUME_UNACCEPTABLE`, `ESCROW_UNACCEPTABLE`, `TIMEOUT_UNACCEPTABLE`, `INSUFFICIENT_BALANCE`, `STRATEGY_MISMATCH`, `AGENT_BUSY`, `OTHER`.
- **Code (emitted by trader):** `negotiation-handler.ts:1003` emits `UNKNOWN_INTENT` (NOT in spec); `:1109` emits `AGENT_BUSY` (in spec); `:1152, :1293, :1454` emit the FAILED/CANCELLED/COMPLETED state name as the reason_code (NOT in spec); `:1227` emits `ACCEPT_DM_SEND_FAILED` (NOT in spec).
- **Impact:** counterparty implementations don't know how to handle the extra reason codes. They get logged as `UNKNOWN` (`:1496`) and the negotiation just stops.
- **Recommendation:** spec patch — add `UNKNOWN_INTENT`, `ACCEPT_DM_SEND_FAILED`, and the three terminal-state mirror codes (`CANCELLED`, `COMPLETED`, `FAILED`) to the `DEAL_REJECT_REASONS` set in §3.7.3 and Appendix B.2. Document the semantics: "terminal-state mirror codes signal that the deal_id is already finalized; the receiver should drop their copy without further state change."

### FINDING D15 — Spec NP message validation requires `ts_ms within 300,000 ms` but doesn't address payload `message` length

- **Spec:** `protocol-spec.md:1389` says "ts_ms is within 300,000 ms of local time". The spec does not say what to do with the optional `message` payload field beyond the 512-char limit declared at `:531, 547, 562` per message subtype.
- **Code:** `negotiation-handler.ts:1697-1705` enforces a 512-char cap on `payload.message` BEFORE dispatching to handlers. The cap is global to all three message types, even though the spec only declares it per-type.
- **Impact:** minor — consistent with the spec's intent. Document it once in §3.4 instead of per subtype.
- **Recommendation:** spec patch — add to §3.4 envelope validation: "`payload.message`, if present, MUST be a string of at most 512 chars."

### FINDING D16 — Description format §2.8 omits "Expires" line that the implementation emits

- **Spec:** `protocol-spec.md:363-371` declares the description format with 4 lines: header (direction+volume+assets), rate, escrow, deposit timeout. Example at `:371`: `"Selling 500-1000 ALPHA for USDC. Rate: 450-500 USDC per ALPHA. Escrow: any. Deposit timeout: 300s."`
- **Code:** `utils.ts:73-82` (`encodeDescription`) emits a FIFTH line: `Expires: ${epoch_ms}.` `:107` regex parses it and `:134-140` extracts the epoch ms.
- **Impact:** spec-conformant parsers don't extract `expiry_ms` and fall back to the MarketModule's `expiresAt` (1-day granularity). The implementation comment at `intent-engine.ts:302-304` warns about this: "Prefer the precise expiry_ms from the description (epoch ms) over the MarketModule's coarse expiresAt (1-day granularity)". Spec-conformant agents lose minute-level expiry precision.
- **Recommendation:** spec patch — add the `Expires: {epoch_ms}.` line to §2.8 with the example updated accordingly. Note that the trailing fields are extension-points.

### FINDING D17 — Spec deal state machine: ACCEPTED can transition to FAILED/COMPLETED in code; spec only allows EXECUTING/CANCELLED

- **Spec:** `protocol-spec.md:1263-1273` deal state transition table allows from ACCEPTED only `EXECUTING`, `FAILED` (escrow), `CANCELLED` (timeout or reject).
- **Code:** `types.ts:51` declares `ACCEPTED: ['EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED']`. The COMPLETED branch is reachable on the acceptor path: `swap-executor.ts:471` registers an acceptor deal in `EXECUTING`, but the proposer-side handoff can short-circuit.
- **Impact:** matches the implementation but spec readers see an under-specified machine and could refuse legitimate transitions.
- **Recommendation:** spec patch — add to §6.2 table: `ACCEPTED → COMPLETED` (rare; SDK swap-completed event fired between np.accept_deal and our EXECUTING transition).

### FINDING D18 — Spec intent state machine: ACTIVE → PARTIALLY_FILLED / FILLED is implemented (acceptor-direct), not in spec

- **Spec:** `protocol-spec.md:1199-1216` intent state transition table only allows `ACTIVE → MATCHING` / `CANCELLED` / `EXPIRED`. `PARTIALLY_FILLED` is reachable from `NEGOTIATING` only; `FILLED` from `NEGOTIATING` or `PARTIALLY_FILLED`.
- **Code:** `types.ts:29` declares `ACTIVE: ['MATCHING', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']`. The code comment at `types.ts:23-28` explicitly justifies the widening: "ACTIVE → PARTIALLY_FILLED / FILLED is permitted because an acceptor never passes through MATCHING: only the side that proposes runs the match-fan-out path that transitions the intent into MATCHING. The acceptor's intent remains ACTIVE until the swap completes."
- **Impact:** this is a real bug-fix that the spec doesn't capture. Spec-conformant agents on the acceptor side would either reject the transition or silently fail to credit volume.
- **Recommendation:** spec patch — add to §6.1 table: `ACTIVE → PARTIALLY_FILLED` and `ACTIVE → FILLED` with guard "acceptor path; deal completed". Explain that acceptor intents bypass MATCHING because the proposer drives the fan-out.

### FINDING D19 — Spec §5.7 wait period is 30s; implementation uses 45s

- **Spec:** `protocol-spec.md:1142-1144` says "wait up to 30 seconds for the proposer's message" before some unspecified fallback.
- **Code:** `intent-engine.ts:175` declares `YIELD_TIMEOUT_MS = 45_000` (45 s) and falls through to PROPOSING ourselves at `:411-451` if the lower-priority candidates haven't proposed.
- **Impact:** modest — soak operator expects the deadlock-recovery to happen at 30s and sees it happen at 45s. Doesn't break correctness; only operator expectation.
- **Recommendation:** spec patch — change 30s to 45s and document the fall-through-to-propose behavior (the spec is silent on what happens AFTER the wait).

### FINDING D20 — Spec NP-0 `np.accept_deal` validation lists nothing about scheduling the SDK swap; spec §3.7.4 understates handshake

- **Spec:** `protocol-spec.md:585-598` says "After the deal is accepted, the proposer verifies escrow liveness via `pingEscrow()` and then transitions to `EXECUTING`." The implementation does this differently.
- **Code:** `main.ts:719-746` pings trusted escrows from the SWAP-POLL loop (every 3s), NOT from the post-accept handshake. The actual proposeSwap call happens via `onDealAccepted` callback (which is the np.accept_deal acceptor's handler running in the proposer's swap-executor through `executeDeal`, `swap-executor.ts:439-533`). There is NO explicit `pingEscrow` between ACCEPTED and EXECUTING in the proposer's path — the proposer just calls `proposeSwap` and the SDK handles escrow handshake.
- **Impact:** spec promises a verification step that doesn't happen at the documented point. If the escrow is dead, the deal fails at PROPOSE_SWAP_FAILED, not at "ACCEPTED → FAILED (ESCROW_UNREACHABLE)".
- **Recommendation:** spec patch — rewrite §3.7.4 to reflect: "the proposer calls `SwapModule.proposeSwap(deal)` immediately on np.accept_deal receipt; escrow liveness is pre-warmed by an out-of-band poll loop pinging trusted escrows every 3 seconds". Delete the "pingEscrow() before EXECUTING" promise from §6.2 ACCEPTED row.

### FINDING D21 — Spec ESCROW_UNREACHABLE failure trigger description is wrong

Related to D20.

- **Spec:** `protocol-spec.md:1232, 1268` says `pingEscrow()` failure transitions ACCEPTED → FAILED with reason `ESCROW_UNREACHABLE`.
- **Code:** `ESCROW_UNREACHABLE` is listed in `types.ts:129` as a documented reason code but I cannot find any code path that EMITS it. The grep shows it only in docstrings/comments. The actual failure path is `PROPOSE_SWAP_FAILED: <SDK error message>` via `swap-executor.ts:518`.
- **Impact:** documented behavior diverges from observable behavior. Operators looking for ESCROW_UNREACHABLE in logs never find it; the actual code is PROPOSE_SWAP_FAILED with an SDK error message.
- **Recommendation:** code fix (in trader-service) — wrap `swap.proposeSwap` in a path that detects escrow-unreachable errors specifically (e.g. error.message includes "no response" / "transport") and emits `ESCROW_UNREACHABLE`. OR: drop `ESCROW_UNREACHABLE` from the spec and acknowledge `PROPOSE_SWAP_FAILED` as the escrow-down signal.

## Non-findings (verified OK)

The following spec sections match the implementation closely enough that no patch is needed:

- **§3.3 NP message types** — `negotiation-handler.ts:38` declares `NP_VERSION = '0.1'`, `types.ts:170-175` declares the exact 3-tuple `['np.propose_deal', 'np.accept_deal', 'np.reject_deal']`. No extras, no missing types. Dispatch at `:1708-1720`.
- **§3.4 envelope shape** — all required fields match between `types.ts:177-186` and the spec interface. Sender pubkey shape validated at `:796-798`. UUID v4 regex matches the spec.
- **§3.4 size limit** — `negotiation-handler.ts:1608-1612` enforces 64 KiB via `MAX_MESSAGE_SIZE` from `envelope.ts`.
- **§3.4 dangerous keys** — `negotiation-handler.ts:1626-1629` calls `hasDangerousKeys(parsed)`.
- **§5.1 8 matching criteria** — all 8 implemented in `intent-engine.ts:272-350`: opposite direction (1), asset pair (2), rate overlap (3), volume (4), not-expired (5), not-self (6), not-blocked (7), escrow compatible (8). Note: spec criterion numbering puts not-expired at 6 and escrow at 7; code uses 5 and 8; the underlying logic matches.
- **§5.2 rate formula** — `intent-engine.ts:896` matches `(rateMin + rateMax) / 2n` for the midpoint, although the formula appears only at MarketModule-posting time; the actual NP-0 proposed rate is the agreed counterparty value (no formula). The spec's `floor((overlap_min + overlap_max) / 2)` is reachable but only when computing the proposer's offered rate — implementation defers this to `agreedRate` passed by the caller. Functionally equivalent given bigint division.
- **§5.3 volume formula** — `intent-engine.ts:556-572` implements greedy allocation with per-candidate cap at `min(remaining, candidate.volume_max)`. The greedy strategy is documented to BEAT the spec's simple `min(A.available, B.available)` in the multi-counterparty scenario; aligns with §5.5 priority ordering.
- **§5.4 escrow agreement** — `intent-engine.ts:107-121` implements the same branches.
- **§5.5 priority sort** — `intent-engine.ts:454-482` implements the spec's `[rate, time, volume]` sort, except **time priority is REVERSED** (newest first, `timeB - timeA`) per a deliberate choice documented at `:471`: "prefer newest listings (most likely to be live counterparties)". Spec says "earlier first" (`created_ms ASC`).
- **§5.7 proposer election** — `intent-engine.ts:376-380` implements `myKey < cpKey` correctly.
- **§7.1 intent authentication** — implemented at `intent-engine.ts:861` (sign intent_id) and `utils.ts:34-67` (computeIntentId). Server-side ECDSA signed requests are inherited from MarketModule.
- **§7.4 expiry sweep** — `intent-engine.ts:94, 1099` sweeps every 10 s.
- **§7.6 message authentication** — clock-skew 300_000 ms at `negotiation-handler.ts:53`, dedup window 600_000 ms / 10_000 entries at `:41-42`. Sender-participant check at `:1660-1672`.
- **§7.7 DoS mitigations** — `max_active_intents` at `types.ts:208` (default 20, matches spec); proposal flood is bounded by global cap `MAX_INBOUND_PROPOSALS_PER_MIN = 600` at `:426`. Spec says "Max 3 pending proposals per counterparty per 60s" — `negotiation-handler.ts:44-45` declares `RATE_LIMIT_MAX = 3` / `RATE_LIMIT_WINDOW_MS = 60_000`. Matches exactly. Global cap is an undocumented but harmless addition.
- **§7.8 dangerous keys + nesting** — `hasDangerousKeys` enforced at message ingress.
- **§7.9.5 protocolVersion=2 enforcement** — `main.ts:1244-1268` rejects v1 swaps. Matches spec recommendation exactly.
- **§7.9.4 NP-0 ↔ SwapModule term binding** — `main.ts:~1316-1325` compares received SwapDeal fields against negotiated DealTerms (`partyACurrency`, `partyAAmount`, `partyBCurrency`, `partyBAmount`, escrow address, timeout). Matches spec.
- **CREATE_INTENT params shape** (modulo D1/D-NEW) — all 9 spec fields are accepted at the right names; `deposit_timeout_sec` default of 300 at `intent-engine.ts:93`; `escrow_address` default of `"any"` at `:92`.
- **§4.5 LIST_SWAPS / DealSummary** — modulo D12 (`error_code`), all 10 spec fields are emitted.
- **§4.7 GET_PORTFOLIO** — `trader-command-handler.ts:630-688` returns all 5 documented top-level fields. `AssetBalance` 5 sub-fields all emitted at `:646-655` (`asset`, `available`, `total`, `confirmed`, `unconfirmed`). Amounts as strings — bigint convention.
- **§7.9.6 volume reservation atomicity** — `volume-reservation-ledger.ts` (not directly read but referenced from multiple call sites) is the documented invariant-keeper.

## Recommended actions

### Spec patches (apply in this order)

1. **D1 + D-NEW + D2:** the three load-bearing edits. Patch §2.4 / §4.2 to declare wire as bigint-string. Add §2.4-bis "Recommended CLI UX". Patch §3.4 envelope signature input.
2. **D3 + D4:** patch §3.5 deal_id derivation and §3.6 DealTerms to add the 4 missing fields.
3. **D5 + D13 + D14:** Appendix B.1, B.2, B.3 — align error/reason-code sets with what's actually emitted.
4. **D17 + D18 + D19 + D20 + D21:** state machine and §3.7.4 / §5.7 corrections.
5. **D10 + D11 + D12 + D15 + D16:** minor structural fixes.

### Implementation fixes (do NOT write the fix; describe and file)

1. **D6 (INTENT_NOT_ACTIVE):** `cancelIntent` should pre-check terminal state and emit `INTENT_NOT_ACTIVE`. File against trader-service.
2. **D7 (SET_STRATEGY echo):** trivial fix — return `merged` instead of `strategyParams`. File against trader-service.
3. **D8 (CLI SET_STRATEGY params):** rename `max_concurrent_negotiations` → `max_concurrent_swaps`; drop `rate_strategy` until the trader supports it. File against sphere-cli-work/sphere-cli.
4. **D9 (CLI list-intents filter):** rename `state` → `filter`. File against sphere-cli-work/sphere-cli.
5. **D21 (ESCROW_UNREACHABLE):** add an escrow-down detection branch in `main.ts` around `swap.proposeSwap`. File against trader-service.

### Recommended sub-issues to file under #474

Two of the findings rise to "block the soak"; the rest are documentation cleanups. Suggested sub-issues:

**Sub-issue #474.G4.1 — Rate/volume wire encoding (BLOCKS SOAK):**

> Trader protocol spec §2.4 declares `rate_min/rate_max/volume_min/volume_max` as `number` (float). The deployed v0.1 trader accepts ONLY bigint strings (`trader-command-handler.ts:370-378`, `acp-types.ts:20-23`). Soak operators reading the spec have no way to learn the correct wire encoding without reading the code.
>
> Required spec patches:
> 1. Change §2.4 interface block to use `string` for all four fields, with `// stringified bigint, smallest units` comment.
> 2. Change §2.4 constraint table from "Positive finite number" to "Positive bigint (string-encoded, smallest units)".
> 3. Change §4.2 `CreateIntentParams` interface accordingly.
> 4. Update §5.2/§7.3 formulas/assertions to bigint-style.
>
> Reference: `docs/uxf/PROTOCOL-SPEC-DRIFT-474.md` finding D1.

**Sub-issue #474.G4.2 — CLI float UX + decimal-aware conversion (BLOCKS SOAK):**

> The design intent is that CLI operators type human-friendly floats (`--rate-min 0.08`) and the CLI converts to bigint smallest-units via a token-registry decimals lookup. Today's CLI (`sphere-cli/src/trader/trader-commands.ts:386-389`) requires fully-scaled bigint strings, and the spec doesn't document this convention.
>
> Required work:
> 1. CLI: accept `--rate-min <float>`; add `--rate-min-bigint <bigint>` escape hatch.
> 2. CLI: look up decimals via `MarketModule.decimalsFor(asset)` (new SDK helper) or `TokenRegistry`.
> 3. CLI: pre-flight validate non-finite, negative, and over-precise floats.
> 4. Spec §2.4-bis: document the recommended CLI UX.
>
> Reference: `docs/uxf/PROTOCOL-SPEC-DRIFT-474.md` finding D-NEW.

**Sub-issue #474.G4.3 — Spec hygiene cleanup pass:**

> Patch protocol-spec.md for the 18 documentation drifts identified in findings D2-D21 of `docs/uxf/PROTOCOL-SPEC-DRIFT-474.md`. None are individually load-bearing; together they make the spec a reliable reference. Estimated patch: ~150 line changes across §3, §4, §5, §6, §7, and Appendix B.

**Sub-issue #474.G4.4 — Trader code: ESCROW_UNREACHABLE + INTENT_NOT_ACTIVE + SET_STRATEGY echo:**

> Three small implementation fixes to align observable trader behavior with the spec contract:
> 1. Add an escrow-down detection branch around `swap.proposeSwap` in `main.ts` to emit `ESCROW_UNREACHABLE` instead of `PROPOSE_SWAP_FAILED`. (D21)
> 2. `cancelIntent` pre-checks terminal state and emits `INTENT_NOT_ACTIVE`. (D6)
> 3. `handleSetStrategy` returns the merged strategy, not the partial input. (D7)
>
> Reference: `docs/uxf/PROTOCOL-SPEC-DRIFT-474.md` findings D6/D7/D21.

**Sub-issue #474.G4.5 — sphere-cli trader command param-name fixes:**

> Two CLI bugs cause silent param drops:
> 1. `sphere trader set-strategy --max-concurrent N` sends `max_concurrent_negotiations`; trader expects `max_concurrent_swaps`. (D8)
> 2. `sphere trader list-intents --state filled` sends `state`; trader expects `filter`. (D9)
>
> Reference: `docs/uxf/PROTOCOL-SPEC-DRIFT-474.md` findings D8/D9.
