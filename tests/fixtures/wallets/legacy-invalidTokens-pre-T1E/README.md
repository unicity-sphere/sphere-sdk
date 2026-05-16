# Fixture: legacy `invalidTokens` (pre-T.1.E)

A synthetic Profile snapshot representing a wallet that exists in the
legacy single-blob `${addr}.invalidTokens` form, before the T.1.E
migration runs. Used by `tests/unit/profile/migration.test.ts` to
exercise `migrateInvalidTokensToPerEntryKey`.

## Layout

`profile-snapshot.json` is a JSON object representing the OrbitDB key-
value contents at migration time:

```json
{
  "address_id": "DIRECT_aabbcc_ddeeff",
  "encryption": "none",
  "entries": [
    {
      "key": "DIRECT_aabbcc_ddeeff.invalidTokens",
      "value": "[{\"tokenId\":\"tokA\",\"reason\":\"corrupt\",\"detectedAt\":1000},{\"tokenId\":\"tokB\",\"reason\":\"unknown\",\"detectedAt\":2000}]"
    }
  ]
}
```

Each `entries[i].value` is the JSON-stringified form. Tests load this
into a mock `ProfileDatabase`, run
`migrateInvalidTokensToPerEntryKey()`, and assert:

1. The legacy key is deleted.
2. Per-entry-key records exist at
   `${addr}.invalid.${tokenId}.legacy-${tokenId}` for each entry.
3. Re-running the migration is a no-op (idempotency).
4. If a real per-entry-key already exists at the composite key, it is
   NOT overwritten (additivity).

## Why a fixture?

The migration logic is small but exercises a specific schema-shape
transition. A fixture file documents the canonical pre-T.1.E layout
explicitly so future regressions (e.g. accidentally widening the
matcher to consume the legacy blob shape directly) are caught.
