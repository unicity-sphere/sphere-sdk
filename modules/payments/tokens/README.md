# modules/payments/tokens/ — Token Concern Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** In-memory token map + tombstones + archived/forked token
stores + token-identity helpers + parse cache + coin metadata resolution.

**Public methods this submodule owns** (routed from the PaymentsModule
facade):

| Method | Currently at | Target file |
|---|---|---|
| `addToken` | PaymentsModule.ts:10987 | `repository.ts` |
| `updateToken` | PaymentsModule.ts:11130 | `repository.ts` |
| `removeToken` | PaymentsModule.ts:11209 | `repository.ts` |
| `getToken` | PaymentsModule.ts:8612 | `repository.ts` |
| `getTokens` | PaymentsModule.ts:8569 | `repository.ts` |
| `onTokenChange` | PaymentsModule.ts:1901 | `repository.ts` |
| `notifyTokenChange` | PaymentsModule.ts:1913 | `repository.ts` |
| `getTombstones` | PaymentsModule.ts:11261 | `tombstones.ts` |
| `isStateTombstoned` | PaymentsModule.ts:11273 | `tombstones.ts` |
| `mergeTombstones` | PaymentsModule.ts:11293 | `tombstones.ts` |
| `pruneTombstones` | PaymentsModule.ts:11340 | `tombstones.ts` |
| `rebuildTombstoneKeySet` | PaymentsModule.ts:11277 | `tombstones.ts` |
| `getArchivedTokens` | PaymentsModule.ts:11363 | `archive.ts` |
| `getBestArchivedVersion` | PaymentsModule.ts:11376 | `archive.ts` |
| `mergeArchivedTokens` | PaymentsModule.ts:11391 | `archive.ts` |
| `pruneArchivedTokens` | PaymentsModule.ts:11424 | `archive.ts` |
| `getForkedTokens` | PaymentsModule.ts:11446 | `archive.ts` |
| `storeForkedToken` | PaymentsModule.ts:11459 | `archive.ts` |
| `mergeForkedTokens` | PaymentsModule.ts:11474 | `archive.ts` |
| `pruneForkedTokens` | PaymentsModule.ts:11496 | `archive.ts` |
| `getCoinSymbol` | PaymentsModule.ts:6286 | `coin-metadata.ts` |
| `getCoinName` | PaymentsModule.ts:6293 | `coin-metadata.ts` |
| `getCoinDecimals` | PaymentsModule.ts:6300 | `coin-metadata.ts` |
| `getCoinIconUrl` | PaymentsModule.ts:6307 | `coin-metadata.ts` |
| `resolveCoinIdSymbol` | PaymentsModule.ts:12758 | `coin-metadata.ts` |

**Module-scope helpers this submodule owns** (currently at lines 431–1017 in
PaymentsModule.ts):

| Symbol | Currently at | Target file |
|---|---|---|
| `enrichWithRegistry` | 516 | `parse-token-info.ts` |
| `parseTokenInfo` | 534 | `parse-token-info.ts` |
| `sdkDataCache` | 718 | `parse-cache.ts` |
| `SDK_DATA_CACHE_MAX` | 719 | `parse-cache.ts` |
| `parseSdkDataCached` | 721 | `parse-cache.ts` |
| `clearSdkDataCache` | 757 | `parse-cache.ts` |
| `extractCoinAmountForCache` | 6316 | `parse-cache.ts` |
| `rebuildParsedTokenCache` | 6330 | `parse-cache.ts` |
| `extractTokenIdFromSdkData` | 764 | `identity.ts` |
| `extractStateHashFromSdkData` | 772 | `identity.ts` |
| `createTokenStateKey` | 787 | `identity.ts` |
| `extractTokenStateKey` | 795 | `identity.ts` |
| `pendingMintDedupKey` | 821 | `identity.ts` |
| `effectiveDedupKey` | 873 | `identity.ts` |
| `hasSameGenesisTokenId` | 884 | `identity.ts` |
| `isSameTokenState` | 893 | `identity.ts` |
| `isIncrementalUpdate` | 921 | `identity.ts` |
| `countCommittedTxns` | 956 | `identity.ts` |
| `createTombstoneFromToken` | 902 | `tombstones.ts` |
| `pruneTombstonesByAge` | 965 | `tombstones.ts` |
| `pruneMapByCount` | 984 | `tombstones.ts` |
| `findBestTokenVersion` | 997 | `archive.ts` |

**Instance state this submodule owns** (currently facade class fields):

- `tokens: Map<string, Token>` (line 1577) → `repository.ts`
- `tombstones: TombstoneEntry[]` (line 1582) → `tombstones.ts`
- `tombstoneKeySet: Set<string>` (line 1584) → `tombstones.ts`
- `archivedTokens: Map<string, TxfToken>` (line 1585) → `archive.ts`
- `forkedTokens: Map<string, TxfToken>` (line 1586) → `archive.ts`
- `parsedTokenCache: Map<...>` (line 1704) → `parse-cache.ts`
- `tokenChangeCallbacks: Set<TokenChangeCallback>` (line 1697) → `repository.ts`

**Extraction strategy:** greenfield submodule files, then facade delegates
via a `TokenRepository` instance held on the facade. Public class methods on
the facade become one-line delegations. State migrates from class fields
into `TokenRepository`.
