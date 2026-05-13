# Fixture: legacy outbox (pre-T.6.D)

A synthetic Profile snapshot representing a wallet that exists in the legacy
per-token `${addr}.outbox.${id}` form, before the T.6.D migration runs. Used
by `tests/unit/profile/migration-outbox.test.ts` and
`tests/unit/profile/migration-outbox-backup-ordering.test.ts` to exercise
`migrateLegacyOutbox()` per UXF-TRANSFER-PROTOCOL §7.2.

## Layout

`profile-snapshot.json` is a JSON object representing the OrbitDB key-value
contents at migration time. Each `entries[i].value` is the parsed legacy
`OutboxEntry` shape (NOT JSON-stringified — tests `JSON.stringify` it before
encoding). This makes the fixture human-readable in source control.

## Coverage

The fixture exercises every §7.2 mapping case:

| Entry | Status (legacy) | Nametag? | Group           | Synthesized status | bundleCid form    |
|-------|-----------------|----------|-----------------|--------------------|-------------------|
| 001   | `delivered`     | `bob`    | singleton       | `finalized`        | `txf-tok-001`     |
| 002   | `pending`       | (none)   | singleton       | `sending`          | `txf-tok-002`     |
| 003   | `failed`        | `carol`  | singleton       | `failed-permanent` | `txf-tok-003`     |
| 004   | `delivered`     | `dave`   | multi (with 005)| `finalized`        | `legacy-02bb…bb-1700000180000` |
| 005   | `delivered`     | (none)   | multi (with 004)| —                  | (folded into 004) |

The multi-token group falls inside a single 60-second window (created at
`+180s` and `+210s` from epoch 1700000000000) with the same
`recipientPubkey`, exercising the `(recipientPubkey, ⌊createdAt/60_000⌋)`
grouping rule.

`recipientNametag` preservation (W18) is exercised by:

  - Entry 001: nametag flows to the synthesized UXF entry's `recipientNametag`.
  - Entry 002: no nametag — synthesized entry has no `recipientNametag`.
  - Entry 003: nametag flows.
  - Entries 004 + 005: only 004 has a nametag — the synthesized group entry
    gets `recipientNametag: 'dave'` (first-non-empty rule).

## Why a fixture file

The migration is a one-way transformation that's hard to reproduce by hand
when verifying a regression. A canonical pre-T.6.D snapshot makes the
migration's input shape stable across test runs and lets future regressions
(e.g. accidentally widening the matcher to consume UXF-shape entries, or
rewriting the windowing rule) fail with a clear diff against this baseline.

The fixture is also consumed by the C7 backup-ordering test
(`migration-outbox-backup-ordering.test.ts`) — the partial-crash recovery
case asserts the legacy entries are still readable from the backup blob
after a simulated crash.

## Cross-reference

  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.2 — canonical migration rules.
  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §10.3 — backward-compat note.
  - `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.6.D — implementation task.
  - `profile/migration-outbox.ts` — `migrateLegacyOutbox()` entry point.
