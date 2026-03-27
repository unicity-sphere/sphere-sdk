# UXF Test Specification

**Status:** Comprehensive test plan for the UXF module
**Date:** 2026-03-26
**Framework:** Vitest
**Source directory:** `uxf/`
**Test directory:** `tests/unit/uxf/`

This document specifies every test case required to achieve full coverage of the UXF module. Each test case follows the format:

```
- [ ] **test name** -- what it verifies | setup | assertion
```

---

## Table of Contents

1. [errors.test.ts](#1-errorstestts)
2. [types.test.ts](#2-typestestts)
3. [hash.test.ts](#3-hashtestts)
4. [element-pool.test.ts](#4-element-pooltestts)
5. [instance-chain.test.ts](#5-instance-chaintestts)
6. [deconstruct.test.ts](#6-deconstructtestts)
7. [assemble.test.ts](#7-assembletestts)
8. [verify.test.ts](#8-verifytestts)
9. [diff.test.ts](#9-difftestts)
10. [json.test.ts](#10-jsontestts)
11. [ipld.test.ts](#11-ipldtestts)
12. [UxfPackage.test.ts](#12-uxfpackagetestts)
13. [storage-adapters.test.ts](#13-storage-adapterstestts)
14. [integration.test.ts](#14-integrationtestts)

---

## Test Fixtures

All test files share a common set of fixture helpers defined in `tests/unit/uxf/fixtures.ts`:

- `makeMinimalToken(overrides?)` -- returns a minimal valid ITokenJson-shaped object with genesis, state, empty transactions, empty nametags. All hex fields are valid 64-char lowercase hex.
- `makeTokenWithTransactions(count)` -- returns a token with `count` transfer transactions, each with valid sourceState, recipient, salt, inclusionProof.
- `makeNametagToken(name)` -- returns a nametag token (tokenType = `f8aa1383...7509`, coinData = [], tokenData = hex of name).
- `makeTokenWithNametags(names)` -- returns a token with recursively embedded nametag tokens.
- `makeSplitToken(parentToken)` -- returns a split child token with reason = `{ type: "TOKEN_SPLIT", token: parentToken, proofs: [...] }`.
- `makeElement(type, content?, children?)` -- creates a UxfElement with default header (representation=1, semantics=1, kind='default', predecessor=null).
- `makeElementWithHeader(type, header, content?, children?)` -- creates a UxfElement with custom header.
- `KNOWN_HASH` -- a pre-computed content hash for a specific known element (test vector).

---

## 1. errors.test.ts

### describe('UxfError')

- [ ] **constructs with code and message** -- verifies UxfError stores code and formats message as `[UXF:<code>] <message>` | `new UxfError('INVALID_HASH', 'bad hash')` | `error.message === '[UXF:INVALID_HASH] bad hash'` and `error.code === 'INVALID_HASH'`
- [ ] **is an instance of Error** -- verifies prototype chain | `new UxfError('MISSING_ELEMENT', 'not found')` | `error instanceof Error === true`
- [ ] **is an instance of UxfError** -- verifies instanceof check works | `new UxfError('CYCLE_DETECTED', 'loop')` | `error instanceof UxfError === true`
- [ ] **sets name to UxfError** -- verifies name property | `new UxfError('TYPE_MISMATCH', 'wrong')` | `error.name === 'UxfError'`
- [ ] **stores optional cause** -- verifies cause field passthrough | `new UxfError('SERIALIZATION_ERROR', 'fail', originalError)` | `error.cause === originalError`
- [ ] **cause defaults to undefined** -- verifies cause is undefined when not provided | `new UxfError('INVALID_HASH', 'x')` | `error.cause === undefined`
- [ ] **code is typed as UxfErrorCode** -- verifies all valid error codes are accepted at runtime | Create one UxfError per code: `INVALID_HASH`, `MISSING_ELEMENT`, `TOKEN_NOT_FOUND`, `STATE_INDEX_OUT_OF_RANGE`, `TYPE_MISMATCH`, `INVALID_INSTANCE_CHAIN`, `DUPLICATE_TOKEN`, `SERIALIZATION_ERROR`, `VERIFICATION_FAILED`, `CYCLE_DETECTED`, `INVALID_PACKAGE`, `NOT_IMPLEMENTED` | All construct without error

---

## 2. types.test.ts

### describe('contentHash')

- [ ] **accepts valid 64-char lowercase hex** -- validates happy path | `contentHash('a'.repeat(64))` | Returns branded ContentHash string
- [ ] **accepts mixed valid hex characters** -- covers 0-9, a-f | `contentHash('0123456789abcdef'.repeat(4))` | Returns branded ContentHash
- [ ] **rejects uppercase hex** -- validates lowercase enforcement | `contentHash('A'.repeat(64))` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects mixed case hex** -- validates lowercase enforcement | `contentHash('aA'.repeat(32))` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects wrong length (too short)** -- validates 64-char requirement | `contentHash('abcd')` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects wrong length (too long)** -- validates 64-char requirement | `contentHash('a'.repeat(65))` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects empty string** -- validates non-empty | `contentHash('')` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects non-hex characters** -- validates character set | `contentHash('g'.repeat(64))` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects string with spaces** -- validates no whitespace | `contentHash(' ' + 'a'.repeat(63))` | Throws UxfError with code `INVALID_HASH`

### describe('ELEMENT_TYPE_IDS')

- [ ] **has exactly 12 entries** -- validates completeness | `Object.keys(ELEMENT_TYPE_IDS)` | Length is 12
- [ ] **maps token-root to 0x01** -- validates known value | `ELEMENT_TYPE_IDS['token-root']` | Equals `0x01`
- [ ] **maps genesis to 0x02** -- validates known value | Direct access | Equals `0x02`
- [ ] **maps transaction to 0x03** -- validates known value | Direct access | Equals `0x03`
- [ ] **maps genesis-data to 0x04** -- validates known value | Direct access | Equals `0x04`
- [ ] **maps transaction-data to 0x05** -- validates known value | Direct access | Equals `0x05`
- [ ] **maps token-state to 0x06** -- validates known value | Direct access | Equals `0x06`
- [ ] **maps predicate to 0x07** -- validates known value | Direct access | Equals `0x07`
- [ ] **maps inclusion-proof to 0x08** -- validates known value | Direct access | Equals `0x08`
- [ ] **maps authenticator to 0x09** -- validates known value | Direct access | Equals `0x09`
- [ ] **maps unicity-certificate to 0x0a** -- validates known value | Direct access | Equals `0x0a`
- [ ] **maps token-coin-data to 0x0c** -- validates known value | Direct access | Equals `0x0c`
- [ ] **maps smt-path to 0x0d** -- validates known value | Direct access | Equals `0x0d`
- [ ] **all type IDs are unique** -- validates no collision | Collect all values into a Set | Set size equals 12

### describe('STRATEGY_LATEST / STRATEGY_ORIGINAL')

- [ ] **STRATEGY_LATEST has type 'latest'** -- validates constant | `STRATEGY_LATEST` | `{ type: 'latest' }`
- [ ] **STRATEGY_ORIGINAL has type 'original'** -- validates constant | `STRATEGY_ORIGINAL` | `{ type: 'original' }`

---

## 3. hash.test.ts

### describe('hexToBytes')

- [ ] **converts valid hex to bytes** -- validates happy path | `hexToBytes('0102ff')` | `Uint8Array([1, 2, 255])`
- [ ] **converts empty string to empty array** -- validates edge case | `hexToBytes('')` | `Uint8Array(0)` (length 0)
- [ ] **rejects odd-length hex** -- validates even-length requirement | `hexToBytes('abc')` | Throws UxfError with code `INVALID_HASH`
- [ ] **rejects non-hex characters** -- validates character set | `hexToBytes('zzzz')` | Throws UxfError with code `INVALID_HASH`
- [ ] **accepts uppercase hex** -- hexToBytes allows A-F unlike contentHash | `hexToBytes('AABB')` | `Uint8Array([0xAA, 0xBB])`

### describe('prepareContentForHashing')

- [ ] **converts hex byte fields to Uint8Array** -- validates field classification | `prepareContentForHashing('authenticator', { publicKey: 'aabb', algorithm: 'secp256k1', signature: 'ccdd', stateHash: 'eeff' })` | `publicKey`, `signature`, `stateHash` are Uint8Array; `algorithm` remains string
- [ ] **preserves string fields unchanged** -- validates non-byte fields | `prepareContentForHashing('genesis-data', { recipient: 'DIRECT://abc', tokenId: 'aa'.repeat(32) })` | `recipient` is string, `tokenId` is Uint8Array
- [ ] **passes null values through as null** -- validates CBOR null | `prepareContentForHashing('genesis-data', { recipientDataHash: null })` | `recipientDataHash` is `null`
- [ ] **passes Uint8Array values through** -- validates reason field | `prepareContentForHashing('genesis-data', { reason: new Uint8Array([1,2,3]) })` | `reason` is the same Uint8Array
- [ ] **converts SmtPath segments data to bytes and path to BigInt** -- validates special segment handling | `prepareContentForHashing('smt-path', { segments: [{ data: 'aabb', path: '42' }] })` | `segments[0].data` is `Uint8Array([0xaa, 0xbb])`, `segments[0].path` is `BigInt(42)`
- [ ] **handles SmtPath segments with null data** -- validates null subtree nodes | `prepareContentForHashing('smt-path', { segments: [{ data: null, path: '0' }] })` | `segments[0].data` is `null`, `segments[0].path` is `BigInt(0)`
- [ ] **converts SmtPath large path to BigInt** -- validates big number support | `prepareContentForHashing('smt-path', { segments: [{ data: 'ff', path: '340282366920938463463374607431768211456' }] })` | `segments[0].path` is `BigInt('340282366920938463463374607431768211456')`
- [ ] **converts transaction-data nametagRefs to byte arrays** -- validates nametagRef handling | `prepareContentForHashing('transaction-data', { nametagRefs: ['aa'.repeat(32)] })` | `nametagRefs[0]` is `Uint8Array(32)`

### describe('prepareChildrenForHashing')

- [ ] **converts single ContentHash to Uint8Array** -- validates single child | `prepareChildrenForHashing({ genesis: 'aa'.repeat(32) })` | `genesis` is `Uint8Array(32)`
- [ ] **converts array of ContentHash to array of Uint8Array** -- validates array children | `prepareChildrenForHashing({ transactions: ['aa'.repeat(32), 'bb'.repeat(32)] })` | Both entries are Uint8Array(32)
- [ ] **preserves null children** -- validates CBOR null | `prepareChildrenForHashing({ inclusionProof: null })` | `inclusionProof` is `null`

### describe('computeElementHash')

- [ ] **deterministic: same element produces same hash** -- validates hash stability | Compute hash of same element twice | Both hashes are identical
- [ ] **different elements produce different hashes** -- validates collision resistance | Compute hashes of two elements with different content | Hashes differ
- [ ] **returns valid 64-char lowercase hex** -- validates output format | `computeElementHash(element)` | Matches `/^[0-9a-f]{64}$/`
- [ ] **key ordering does not affect hash (dag-cbor sorts)** -- validates canonical encoding | Create two elements with content keys in different insertion order | Same hash (dag-cbor deterministic CBOR sorts map keys)
- [ ] **null predecessor in header encodes as CBOR null** -- validates header encoding | Element with `header.predecessor = null` | Hash is valid, no error thrown
- [ ] **non-null predecessor in header encodes as bytes** -- validates header encoding | Element with `header.predecessor = 'aa'.repeat(32)` | Hash differs from null-predecessor element
- [ ] **known test vector** -- validates against pre-computed hash | Construct a specific token-state element with known content (`predicate: 'ab'.repeat(32)`, `data: 'cd'.repeat(32)`) and no children | Hash matches a pre-computed value (computed once and hardcoded in test)

---

## 4. element-pool.test.ts

### describe('ElementPool')

#### describe('put / get / has / delete')

- [ ] **put returns content hash and stores element** -- validates basic insertion | `pool.put(element)` then `pool.get(hash)` | Returned hash is valid, `pool.get(hash)` returns element
- [ ] **put deduplicates: same element twice returns same hash, pool size is 1** -- validates content-addressing | `pool.put(element)` twice | Same hash returned, `pool.size === 1`
- [ ] **has returns true for existing element** -- validates lookup | `pool.put(element)` then `pool.has(hash)` | Returns `true`
- [ ] **has returns false for non-existent hash** -- validates miss | `pool.has(unknownHash)` | Returns `false`
- [ ] **get returns undefined for non-existent hash** -- validates miss | `pool.get(unknownHash)` | Returns `undefined`
- [ ] **delete removes element and returns true** -- validates removal | `pool.put(element)` then `pool.delete(hash)` | Returns `true`, `pool.has(hash) === false`
- [ ] **delete returns false for non-existent hash** -- validates miss | `pool.delete(unknownHash)` | Returns `false`
- [ ] **size tracks element count** -- validates counter | Put 3 different elements, delete 1 | `pool.size === 2`

#### describe('iteration')

- [ ] **entries yields all [hash, element] pairs** -- validates iteration | Put 2 elements | `[...pool.entries()]` has length 2 with correct hashes and elements
- [ ] **hashes yields all content hashes** -- validates hash iteration | Put 2 elements | `[...pool.hashes()]` has length 2
- [ ] **values yields all elements** -- validates element iteration | Put 2 elements | `[...pool.values()]` has length 2

#### describe('toMap / fromMap')

- [ ] **toMap returns the internal map** -- validates export | Put elements, call `toMap()` | Map size matches, entries are accessible
- [ ] **fromMap creates a pool from a map** -- validates import | Create map, `ElementPool.fromMap(map)` | Pool size matches, elements retrievable by hash
- [ ] **toMap/fromMap round-trip preserves elements** -- validates symmetry | Put elements, `fromMap(pool.toMap())` | New pool has same size, same hashes, same elements

### describe('collectGarbage')

- [ ] **reachable elements are kept** -- validates mark phase | Package with 1 token, all elements reachable from manifest root | After GC, all elements still in pool, returned removed set is empty
- [ ] **orphaned elements are removed** -- validates sweep phase | Add an extra element not referenced by any token | After GC, extra element is removed, returned removed set contains its hash
- [ ] **shared elements are not removed when still referenced by another token** -- validates multi-root reachability | Two tokens share a unicity-certificate element, remove one token from manifest | After GC, shared element is kept (still reachable from other token)
- [ ] **instance chain elements are reachable** -- validates chain expansion in walk | Element with an instance chain (original + newer instance), only original hash referenced in token children | After GC, both chain members are kept
- [ ] **prunes instance chain index entries for removed hashes** -- validates chain pruning after GC | Orphaned element is in an instance chain | After GC, chain index entries for removed hash are deleted

---

## 5. instance-chain.test.ts

### describe('addInstance')

- [ ] **creates a new chain of length 2 (original + new)** -- validates chain creation | Pool with one element, call `addInstance(pool, index, originalHash, newInstance)` | Index has entries for both hashes, chain length is 2, head is new hash
- [ ] **extends existing chain (3 elements)** -- validates chain extension | Add two instances to the same original | Chain length is 3, head is newest
- [ ] **rejects wrong element type** -- validates Rule 1 | Original is `token-state`, new instance is `authenticator` | Throws UxfError with code `INVALID_INSTANCE_CHAIN`
- [ ] **rejects wrong predecessor** -- validates Rule 2 | New instance's `header.predecessor` does not match current head hash | Throws UxfError with code `INVALID_INSTANCE_CHAIN`
- [ ] **rejects semantics version downgrade** -- validates Rule 3 | Current head has semantics=2, new instance has semantics=1 | Throws UxfError with code `INVALID_INSTANCE_CHAIN`
- [ ] **accepts equal semantics version** -- validates Rule 3 boundary | Both have semantics=1 | No error, chain extended
- [ ] **inserts new element into pool** -- validates side effect | Call addInstance | New element is in pool via `pool.get(newHash)`
- [ ] **all chain hashes point to the same InstanceChainEntry** -- validates index consistency | Chain of 3 elements | `index.get(hashA) === index.get(hashB) === index.get(hashC)` (same reference)
- [ ] **rejects when original element is not in pool** -- validates precondition | `addInstance` with non-existent originalHash | Throws UxfError with code `MISSING_ELEMENT`

### describe('selectInstance')

- [ ] **strategy=latest returns head** -- validates O(1) head return | Chain with 3 elements, `selectInstance(entry, { type: 'latest' }, pool)` | Returns head hash
- [ ] **strategy=original returns tail** -- validates tail return | Chain with 3 elements, `selectInstance(entry, { type: 'original' }, pool)` | Returns last chain element hash
- [ ] **strategy=by-kind returns matching kind** -- validates kind search | Chain with kinds ['consolidated-proof', 'individual-proof', 'default'], strategy `{ type: 'by-kind', kind: 'individual-proof' }` | Returns the hash with kind 'individual-proof'
- [ ] **strategy=by-kind with no match returns head** -- validates default fallback | Strategy `{ type: 'by-kind', kind: 'zk-proof' }`, no such kind in chain | Returns head hash
- [ ] **strategy=by-kind with fallback** -- validates fallback strategy | Strategy `{ type: 'by-kind', kind: 'zk-proof', fallback: { type: 'original' } }` | Returns tail hash (fallback to original)
- [ ] **strategy=by-representation returns matching version** -- validates representation search | Chain with representations [3, 2, 1], strategy `{ type: 'by-representation', version: 2 }` | Returns the hash with representation=2
- [ ] **strategy=by-representation with no match returns head** -- validates default fallback | Strategy `{ type: 'by-representation', version: 99 }` | Returns head hash
- [ ] **strategy=custom with matching predicate** -- validates custom predicate | Strategy `{ type: 'custom', predicate: (el) => el.header.semantics === 2 }` | Returns hash of element with semantics=2
- [ ] **strategy=custom with no match returns head** -- validates default fallback | Predicate matches nothing | Returns head hash
- [ ] **strategy=custom with fallback** -- validates fallback chain | Custom predicate matches nothing, fallback is `{ type: 'original' }` | Returns tail hash

### describe('resolveElement')

- [ ] **with chain: returns selected instance element** -- validates chain resolution | Hash is in instance chain, strategy=latest | Returns head element from pool
- [ ] **without chain: returns element directly from pool** -- validates direct lookup | Hash is not in any chain | Returns element directly
- [ ] **missing element throws MISSING_ELEMENT** -- validates error | Hash not in pool and not in chain | Throws UxfError with code `MISSING_ELEMENT`
- [ ] **chain entry with missing selected instance throws MISSING_ELEMENT** -- validates error | Chain entry exists but selected hash is not in pool | Throws UxfError with code `MISSING_ELEMENT`

### describe('mergeInstanceChains')

- [ ] **no overlap: source chain added to target** -- validates fresh merge | Target has no chains, source has one chain | Target now has source chain entries
- [ ] **source is prefix of target: target kept as-is** -- validates prefix detection (target longer) | Source chain has 2 entries, target has 3 (superset of source) | Target chain unchanged
- [ ] **target is prefix of source: source replaces target** -- validates prefix detection (source longer) | Target chain has 2 entries, source has 3 (superset of target) | Target updated to source chain
- [ ] **divergent chains: both kept** -- validates branching (Decision 6) | Source and target share a common tail but diverge | Both heads present as separate entries in target index

### describe('pruneInstanceChains')

- [ ] **removes entries for removed hashes** -- validates pruning | Chain of 3, remove middle hash | Remaining chain is rebuilt with 2 entries
- [ ] **removes trivial chain (1 remaining)** -- validates chain dissolution | Chain of 2, remove one | Index has no entries for either hash (chain dissolved)
- [ ] **no-op for empty removedHashes set** -- validates early return | Empty set | Index unchanged

### describe('rebuildInstanceChainIndex')

- [ ] **reconstructs chains from predecessor links** -- validates rebuild | Pool with elements linked by predecessor fields | Rebuilt index matches expected chain structure
- [ ] **handles branching (two successors)** -- validates Decision 6 | Two elements share the same predecessor | Two separate chain entries created
- [ ] **ignores elements with no predecessor links** -- validates non-chain elements | Pool with standalone elements (predecessor=null, no successors) | Index is empty
- [ ] **cycle protection: visited hashes not re-walked** -- validates safety | Elements forming a long chain | No infinite loop, chain built correctly

---

## 6. deconstruct.test.ts

### describe('deconstructToken')

#### describe('simple token (0 transactions)')

- [ ] **produces correct element count** -- validates element decomposition | Minimal token with 0 transactions | Pool has ~8-10 elements (token-root, genesis, genesis-data, inclusion-proof, authenticator, smt-path, unicity-certificate, token-state x1-2)
- [ ] **token-root element has correct type and tokenId** -- validates root | Check element at returned hash | `type === 'token-root'`, `content.tokenId` matches genesis tokenId (lowercased)
- [ ] **genesis element has correct children** -- validates genesis structure | Resolve genesis child of token-root | Has `data`, `inclusionProof`, `destinationState` children
- [ ] **genesis-data element has all fields** -- validates leaf | Resolve genesis-data element | `tokenId`, `tokenType`, `coinData`, `tokenData`, `salt`, `recipient`, `recipientDataHash`, `reason` all present

#### describe('token with 1 transfer')

- [ ] **produces correct element count** -- validates additional elements per transfer | Token with 1 transaction | Pool has ~15-17 elements (base + transaction, transaction-data, source-state, dest-state, inclusion-proof, authenticator, smt-path, unicity-cert)
- [ ] **transaction element has correct children** -- validates transaction structure | Resolve transaction child | Has `sourceState`, `data`, `inclusionProof`, `destinationState` children

#### describe('token with 5 transfers')

- [ ] **produces correct element count** -- validates scaling | Token with 5 transactions | Pool has proportionally more elements

#### describe('deduplication')

- [ ] **two tokens sharing unicity certificate produce one cert element** -- validates content-addressed dedup | Two tokens with identical `unicityCertificate` hex string | Pool contains only one `unicity-certificate` element
- [ ] **idempotent: deconstructing same token twice adds zero new elements** -- validates no-op on re-ingestion | Deconstruct same token twice into same pool | Pool size unchanged after second deconstruction

#### describe('nametag handling')

- [ ] **recursive nametag deconstruction** -- validates nametag as full token sub-DAG | Token with one nametag token in `nametags` array | Pool contains nametag's token-root, genesis, genesis-data, etc.
- [ ] **string nametags silently skipped** -- validates graceful handling | Token with `nametags: ['alice']` (strings, not objects) | No nametag sub-DAG elements created, token-root `nametags` children array is empty
- [ ] **nametags in transfer transaction data stored as nametagRefs** -- validates cross-location dedup | Token with nametag in both top-level and transaction data | transaction-data element has `nametagRefs` array containing nametag root hash
- [ ] **depth limit: nested nametags > 100 levels** -- validates recursion guard | Token with nametags nested 101 levels deep | Throws UxfError with code `INVALID_PACKAGE`

#### describe('state derivation')

- [ ] **genesis destinationState equals token.state when 0 transactions** -- validates DOMAIN-CONSTRAINTS Section 3.1 | Token with 0 transactions | Genesis element's `destinationState` child resolves to same content as token-root's `state` child
- [ ] **genesis destinationState equals first tx sourceState when 1+ transactions** -- validates DOMAIN-CONSTRAINTS Section 3.1 | Token with 1 transaction | Genesis `destinationState` matches transaction's `sourceState`
- [ ] **each transaction's sourceState and destinationState are correctly derived** -- validates Section 3.2 | Token with 3 transactions | tx[0].sourceState = genesis.destinationState, tx[0].destinationState = tx[1].sourceState, tx[2].destinationState = token.state

#### describe('hex normalization')

- [ ] **uppercase hex input is lowercased in elements** -- validates case normalization | Token with uppercase `tokenId`, `salt`, etc. | All hex fields in stored elements are lowercase

#### describe('null handling')

- [ ] **null state.data preserved as null** -- validates CBOR null | State with `data: null` | token-state element has `content.data === null`
- [ ] **null SmtPath step.data preserved as null** -- validates null subtree nodes | SMT step with `data: null` | smt-path segment data is null

#### describe('special fields')

- [ ] **SmtPath path stored as string (not hex-decoded)** -- validates DOMAIN-CONSTRAINTS Section 2.3 | SMT step with `path: '340282366920938463463374607431768211456'` | smt-path segment `path` is the original decimal string
- [ ] **UnicityCertificate stored opaquely as lowercased hex** -- validates Section 2.2 | Certificate hex `AABB` | Stored as `aabb`
- [ ] **split token reason (object) encoded as dag-cbor Uint8Array** -- validates Section 5.3 | Token with `reason: { type: 'TOKEN_SPLIT', ... }` | genesis-data `content.reason` is `Uint8Array` (dag-cbor encoded)
- [ ] **split token reason (string) encoded as UTF-8 Uint8Array** -- validates string encoding | Token with `reason: 'test reason'` | genesis-data `content.reason` is `Uint8Array` (UTF-8 encoded 'test reason')
- [ ] **split token reason (null) stored as null** -- validates null passthrough | Token with `reason: null` | genesis-data `content.reason === null`

#### describe('validation')

- [ ] **placeholder token rejected** -- validates pre-validation | `{ _placeholder: true }` | Throws UxfError with code `INVALID_PACKAGE`
- [ ] **pendingFinalization token rejected** -- validates pre-validation | `{ _pendingFinalization: {} }` | Throws UxfError with code `INVALID_PACKAGE`
- [ ] **missing genesis rejected** -- validates pre-validation | `{ state: {...} }` (no genesis) | Throws UxfError with code `INVALID_PACKAGE`
- [ ] **null inclusionProof (uncommitted transaction)** -- validates null child ref | Transaction with `inclusionProof: null` | Transaction element's `inclusionProof` child is `null`

---

## 7. assemble.test.ts

### describe('assembleToken')

#### describe('round-trip fidelity')

- [ ] **assemble(deconstruct(token)) produces equivalent token** -- validates inverse relationship | Deconstruct a token, then assemble it | Assembled token deeply equals original (modulo hex case normalization)
- [ ] **tokenId round-trips** -- validates field preservation | Deconstruct + assemble | `assembled.genesis.data.tokenId` matches original (lowercased)
- [ ] **version round-trips** -- validates field preservation | Token with version '2.0' | `assembled.version === '2.0'`
- [ ] **genesis fields round-trip** -- validates all genesis-data fields | Compare `assembled.genesis.data` fields against original (lowercased hex) | All fields match: tokenId, tokenType, coinData, tokenData, salt, recipient, recipientDataHash, reason
- [ ] **transaction fields round-trip** -- validates transfer data | Token with 2 transactions | `assembled.transactions[0].data.recipient`, `.salt`, `.message` etc. match originals
- [ ] **state round-trips** -- validates current state | `assembled.state.predicate` and `.data` match original (lowercased) | Field equality
- [ ] **nametags round-trip** -- validates recursive nametag assembly | Token with nametags | `assembled.nametags` array has same length and content
- [ ] **empty transactions round-trip** -- validates empty array | Token with 0 transactions | `assembled.transactions` is `[]`
- [ ] **empty nametags round-trip** -- validates empty array | Token with no nametags | `assembled.nametags` is `[]`

#### describe('assembleTokenAtState (historical assembly)')

- [ ] **stateIndex=0 returns genesis only, state = genesis destination** -- validates genesis-only view | Token with 3 transactions, `assembleTokenAtState(pool, manifest, tokenId, 0, chains)` | `assembled.transactions` is `[]`, `assembled.state` matches genesis destination state
- [ ] **stateIndex=N returns genesis + N transactions** -- validates truncation | Token with 3 transactions, stateIndex=2 | `assembled.transactions.length === 2`, state matches tx[1]'s destination state
- [ ] **stateIndex=totalTx returns full token (equivalent to assembleToken)** -- validates boundary | stateIndex = total transaction count | Result equals full assembleToken result
- [ ] **stateIndex out of range throws STATE_INDEX_OUT_OF_RANGE** -- validates bounds | stateIndex = -1 or stateIndex > totalTx | Throws UxfError with code `STATE_INDEX_OUT_OF_RANGE`
- [ ] **nametags included regardless of stateIndex** -- validates nametag inclusion | stateIndex=0 on a token with nametags | Nametags still present in assembled result

#### describe('error handling')

- [ ] **corrupted element hash triggers VERIFICATION_FAILED** -- validates integrity check | Tamper with an element's content after putting it in pool (so hash no longer matches) | Throws UxfError with code `VERIFICATION_FAILED`
- [ ] **circular child reference triggers CYCLE_DETECTED** -- validates cycle detection | Element whose child references its own hash | Throws UxfError with code `CYCLE_DETECTED`
- [ ] **missing element triggers MISSING_ELEMENT** -- validates missing child | Token-root references a genesis hash not in pool | Throws UxfError with code `MISSING_ELEMENT`
- [ ] **type mismatch triggers TYPE_MISMATCH** -- validates type checking | Token-root's genesis child points to an authenticator element | Throws UxfError with code `TYPE_MISMATCH`
- [ ] **depth limit in nametag assembly** -- validates recursion guard | Construct a deeply nested nametag chain (>100 levels) | Throws UxfError with code `INVALID_PACKAGE`

#### describe('instance chain selection')

- [ ] **strategy=latest assembles with head instance** -- validates instance selection during reassembly | Element with instance chain, assemble with `STRATEGY_LATEST` | Assembled data reflects head instance content
- [ ] **strategy=original assembles with tail instance** -- validates original selection | Same chain, assemble with `STRATEGY_ORIGINAL` | Assembled data reflects original instance content

#### describe('special fields')

- [ ] **nametag reassembly from root hash (not manifest)** -- validates sub-DAG assembly | Nametag root hash stored in token-root children, not in manifest | Nametag assembled correctly via `assembleTokenFromRoot`
- [ ] **transfer data nametag restoration from nametagRefs** -- validates cross-location restoration | transaction-data has `nametagRefs` pointing to nametag root hashes | `assembled.transactions[n].data.nametags` contains reassembled nametag tokens
- [ ] **reason field round-trip: object -> Uint8Array -> object** -- validates dag-cbor decode | Split token with reason object | `assembled.genesis.data.reason` is the original object (decoded from dag-cbor)
- [ ] **reason field round-trip: string -> Uint8Array -> string** -- validates UTF-8 decode | Token with string reason | `assembled.genesis.data.reason` is the original string
- [ ] **null inclusionProof preserved** -- validates null passthrough | Transaction with null proof | `assembled.transactions[n].inclusionProof === null`

---

## 8. verify.test.ts

### describe('verify')

- [ ] **valid package returns valid=true, zero errors** -- validates happy path | Package created via ingest of valid token | `result.valid === true`, `result.errors.length === 0`
- [ ] **corrupted element hash produces VERIFICATION_FAILED error** -- validates Check 3 | Tamper with element content in pool (hash no longer matches key) | `result.errors` contains issue with code `VERIFICATION_FAILED`
- [ ] **missing child reference produces MISSING_ELEMENT error** -- validates Check 2 | Remove a child element from pool | `result.errors` contains issue with code `MISSING_ELEMENT`
- [ ] **cycle in DAG produces CYCLE_DETECTED error** -- validates Check 4 | Create circular child reference in pool | `result.errors` contains issue with code `CYCLE_DETECTED`
- [ ] **missing manifest root produces MISSING_ELEMENT error** -- validates Check 1 | Remove token-root element from pool but keep manifest entry | Error with code `MISSING_ELEMENT` referencing manifest root
- [ ] **orphaned elements produce warning (not error)** -- validates Check 6 | Add unreferenced element to pool | `result.valid === true`, `result.warnings` contains orphan warning
- [ ] **instance chain with wrong element type produces INVALID_INSTANCE_CHAIN error** -- validates Check 5 Rule 1 | Chain where elements have different types | Error with code `INVALID_INSTANCE_CHAIN`
- [ ] **instance chain with broken predecessor linkage produces error** -- validates Check 5 predecessor check | Chain where element's predecessor does not match next entry | Error with code `INVALID_INSTANCE_CHAIN`
- [ ] **instance chain tail with non-null predecessor produces error** -- validates Check 5 Rule 3 | Chain tail element has predecessor != null | Error with code `INVALID_INSTANCE_CHAIN`
- [ ] **instance chain head mismatch produces error** -- validates head consistency | Chain entry's `head` does not match `chain[0].hash` | Error with code `INVALID_INSTANCE_CHAIN`
- [ ] **divergent instance chains produce warning** -- validates Check 8 | Two chains sharing same tail but different heads | Warning with code `INVALID_INSTANCE_CHAIN`
- [ ] **element type mismatch in child role produces TYPE_MISMATCH** -- validates type consistency | Token-root's `genesis` child is a `transaction` element | Error with code `TYPE_MISMATCH`

#### describe('stats')

- [ ] **tokensChecked equals manifest size** -- validates stat counting | Package with 3 tokens | `result.stats.tokensChecked === 3`
- [ ] **elementsChecked counts unique checked elements** -- validates stat counting | Package with shared elements | `result.stats.elementsChecked` matches expected unique count
- [ ] **orphanedElements count is accurate** -- validates stat counting | Package with 2 orphaned elements | `result.stats.orphanedElements === 2`
- [ ] **instanceChainsChecked counts unique chains** -- validates stat counting | Package with 2 instance chains | `result.stats.instanceChainsChecked === 2`

---

## 9. diff.test.ts

### describe('diff')

- [ ] **identical packages produce empty delta** -- validates no-change case | `diff(pkg, pkg)` (same package) | `addedElements.size === 0`, `removedElements.size === 0`, `addedTokens.size === 0`, `removedTokens.size === 0`, `addedChainEntries.size === 0`
- [ ] **added token produces delta with added elements and manifest entry** -- validates addition | Source has 1 token, target has 2 | `addedElements` contains new elements, `addedTokens` has new tokenId
- [ ] **removed token produces delta with removed elements and token ID** -- validates removal | Source has 2 tokens, target has 1 | `removedElements` contains old elements, `removedTokens` has old tokenId
- [ ] **modified token (new transaction) produces added and removed elements** -- validates modification | Source has token with 1 tx, target has same token with 2 tx | `addedElements` has new transaction elements, `removedElements` has old token-root (different root hash)
- [ ] **shared elements are not in added or removed** -- validates dedup awareness | Two packages with shared unicity-certificate | Shared cert hash not in addedElements or removedElements
- [ ] **instance chain changes detected** -- validates chain diff | Source has no chains, target has one | `addedChainEntries` has one entry

### describe('applyDelta')

- [ ] **apply then verify produces valid package** -- validates delta application integrity | Compute delta, apply to source, verify | `verify(result).valid === true`
- [ ] **corrupted element in delta throws VERIFICATION_FAILED** -- validates hash verification on apply | Delta with element whose hash does not match key | Throws UxfError with code `VERIFICATION_FAILED`
- [ ] **round-trip: diff(a, b) then apply to a produces package equivalent to b** -- validates correctness | `diff(a, b)`, `applyDelta(a, delta)` | `a` pool and manifest now match `b`
- [ ] **idempotent: applying delta of identical packages is a no-op** -- validates empty delta | `diff(a, a)`, apply to `a` | Package unchanged
- [ ] **already-existing elements in addedElements are no-ops** -- validates dedup on apply | Delta includes an element already in pool | Pool size unchanged for that element
- [ ] **non-existent hashes in removedElements are no-ops** -- validates graceful handling | Delta removes a hash not in pool | No error thrown

---

## 10. json.test.ts

### describe('packageToJson / packageFromJson')

#### describe('round-trip')

- [ ] **round-trip preserves package** -- validates serialize then deserialize | `packageFromJson(packageToJson(pkg))` | Pools have same size and same hashes, manifest matches, indexes match
- [ ] **round-trip preserves element content** -- validates field-level fidelity | Assemble token from round-tripped package | Assembled token matches original

#### describe('JSON format')

- [ ] **JSON has "uxf" version field** -- validates format | Parse JSON output, check `parsed.uxf` | `parsed.uxf === '1.0.0'`
- [ ] **JSON has metadata with version, createdAt, updatedAt, elementCount, tokenCount** -- validates metadata | Parse JSON output | All metadata fields present and correct
- [ ] **elements use integer type IDs** -- validates type encoding | Parse JSON, check `elements[hash].type` | Is a number (e.g., `1` for token-root, not `'token-root'`)
- [ ] **Maps serialized as plain objects** -- validates Map encoding | Parse JSON, check `manifest` | Is a plain object `{}`, not an array of entries
- [ ] **Sets serialized as arrays** -- validates Set encoding | Parse JSON, check `indexes.byTokenType[key]` | Is an array `[]`
- [ ] **optional creator and description preserved** -- validates optional fields | Package with creator and description | JSON contains both, round-trip preserves them
- [ ] **absent creator and description omitted** -- validates optional omission | Package without creator/description | JSON does not have these fields

#### describe('content serialization')

- [ ] **reason Uint8Array serialized as hex string** -- validates binary-to-hex | genesis-data with reason | JSON content has reason as hex string
- [ ] **reason hex string deserialized back to Uint8Array** -- validates hex-to-binary | JSON with reason hex string | Deserialized element has `content.reason` as Uint8Array
- [ ] **reason null preserved** -- validates null passthrough | genesis-data with null reason | JSON has `null`, deserialized has `null`

#### describe('hex normalization on deserialize')

- [ ] **uppercase hex content fields normalized to lowercase** -- validates normalization | JSON with uppercase hex in content fields (>= 64 chars) | Deserialized content fields are lowercase
- [ ] **short strings not normalized** -- validates non-hex preservation | JSON with short string field like `algorithm: 'secp256k1'` | Preserved as-is

#### describe('error handling')

- [ ] **malformed JSON throws SERIALIZATION_ERROR** -- validates parse error | `packageFromJson('not json')` | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **missing uxf field throws SERIALIZATION_ERROR** -- validates structure | `packageFromJson('{}')` | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **missing metadata throws SERIALIZATION_ERROR** -- validates structure | JSON with uxf but no metadata | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **missing elements throws SERIALIZATION_ERROR** -- validates structure | JSON with uxf, metadata, manifest but no elements | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **element hash mismatch on deserialize throws SERIALIZATION_ERROR** -- validates integrity | JSON with element key that does not match recomputed hash | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **unknown element type ID throws SERIALIZATION_ERROR** -- validates type mapping | JSON with `type: 999` | Throws UxfError with code `SERIALIZATION_ERROR`
- [ ] **invalid content hash in manifest throws INVALID_HASH** -- validates contentHash brand | Manifest with uppercase or short hash | Throws UxfError with code `INVALID_HASH`

#### describe('instance chain index serialization')

- [ ] **instance chain index round-trips** -- validates chain serialization | Package with instance chain | Deserialized chain matches: same head, same chain entries, all hashes indexed
- [ ] **empty instance chain index round-trips** -- validates empty case | Package with no chains | Deserialized chain index is empty Map

---

## 11. ipld.test.ts

### describe('computeCid')

- [ ] **deterministic: same element produces same CID** -- validates CID stability | Compute CID of same element twice | Both CIDs are identical (`.toString()` match)
- [ ] **CID uses dag-cbor codec (0x71)** -- validates codec | `computeCid(element)` | `cid.code === 0x71`
- [ ] **CID uses sha2-256 hash (0x12)** -- validates hash function | `computeCid(element)` | `cid.multihash.code === 0x12`

### describe('contentHashToCid / cidToContentHash')

- [ ] **CID digest matches ContentHash** -- validates hash equivalence | `const hash = computeElementHash(el); const cid = computeCid(el)` | `cidToContentHash(cid) === hash`
- [ ] **round-trip: contentHashToCid then cidToContentHash** -- validates inverse | `cidToContentHash(contentHashToCid(hash)) === hash` | Equality
- [ ] **non-sha256 CID throws SERIALIZATION_ERROR** -- validates hash function check | CID with different multihash code | Throws UxfError with code `SERIALIZATION_ERROR`

### describe('elementToIpldBlock')

- [ ] **returns cid and bytes** -- validates block structure | `elementToIpldBlock(element)` | Has `cid` (CID instance) and `bytes` (Uint8Array)
- [ ] **children encoded as CID links (not raw hash bytes)** -- validates IPLD form | Decode block bytes via dag-cbor, inspect children | Children are CID objects (not Uint8Array)
- [ ] **CID matches computeElementHash** -- validates hash equivalence | `cidToContentHash(block.cid) === computeElementHash(element)` | True

### describe('exportToCar / importFromCar')

- [ ] **round-trip preserves package** -- validates CAR serialize/deserialize | `importFromCar(await exportToCar(pkg))` | Pool sizes match, manifest matches, all elements present with correct hashes
- [ ] **CAR root is envelope CID** -- validates root block | Read CAR, get roots | Roots array has 1 entry, decodes to envelope with version, createdAt, manifest CID link
- [ ] **block ordering: envelope first, then manifest** -- validates SPEC 6c.4 | Read CAR blocks in order | First block is envelope, second is manifest
- [ ] **shared elements appear once** -- validates dedup in BFS | Two tokens sharing a cert element | CAR has one block for the shared cert
- [ ] **hash verification during CAR import** -- validates integrity | Tamper with a block's bytes in CAR | Throws UxfError with code `VERIFICATION_FAILED`
- [ ] **empty package round-trips** -- validates edge case | Package with 0 tokens | CAR export/import produces empty package with correct envelope

### describe('rebuildInstanceChains (from CAR import)')

- [ ] **chains rebuilt from predecessor links** -- validates chain reconstruction | Export package with instance chain to CAR, import | Imported package has reconstructed chain index
- [ ] **branching chains handled** -- validates Decision 6 | Two elements sharing same predecessor | Both branches present in rebuilt index

---

## 12. UxfPackage.test.ts

### describe('UxfPackage')

#### describe('create')

- [ ] **creates empty package** -- validates factory | `UxfPackage.create()` | `pkg.tokenCount === 0`, `pkg.elementCount === 0`
- [ ] **sets envelope version and timestamps** -- validates envelope | `pkg.packageData.envelope.version === '1.0.0'`, `createdAt` and `updatedAt` are recent Unix timestamps
- [ ] **accepts optional description and creator** -- validates options | `UxfPackage.create({ description: 'test', creator: 'abc' })` | Envelope has description and creator

#### describe('ingest / assemble')

- [ ] **ingest then assemble round-trips** -- validates core flow | `pkg.ingest(token)`, `pkg.assemble(tokenId)` | Assembled token matches original
- [ ] **ingest updates manifest** -- validates manifest mutation | `pkg.ingest(token)` | `pkg.hasToken(tokenId) === true`
- [ ] **ingest updates tokenCount** -- validates counter | Ingest 1 token | `pkg.tokenCount === 1`
- [ ] **ingest updates elementCount** -- validates counter | Ingest 1 token | `pkg.elementCount > 0`
- [ ] **ingest updates updatedAt timestamp** -- validates envelope mutation | Record createdAt, wait, ingest | `updatedAt >= createdAt`

#### describe('ingestAll')

- [ ] **batch ingests multiple tokens** -- validates batch operation | `pkg.ingestAll([token1, token2])` | `pkg.tokenCount === 2`

#### describe('removeToken / gc')

- [ ] **removeToken removes from manifest** -- validates removal | Ingest then remove | `pkg.hasToken(tokenId) === false`
- [ ] **removeToken does not remove elements from pool** -- validates lazy GC | Ingest then remove | `pkg.elementCount` unchanged
- [ ] **gc removes unreachable elements** -- validates GC | Remove token then gc | `pkg.elementCount` drops, gc returns count > 0
- [ ] **gc returns 0 when no garbage** -- validates no-op GC | No removal | `pkg.gc() === 0`

#### describe('merge')

- [ ] **merge with shared elements deduplicates** -- validates dedup | Two packages share a cert element, merge | Merged element count < sum of both
- [ ] **merge re-hashes incoming elements** -- validates hash verification | Merge a package with a tampered element | Throws UxfError with code `VERIFICATION_FAILED`
- [ ] **merge adds source manifest entries** -- validates manifest merge | Merge package with new token | Merged package has both tokens

#### describe('verify')

- [ ] **verify on valid package returns valid=true** -- validates verification | Ingest token, verify | `result.valid === true`

#### describe('index queries')

- [ ] **tokensByCoinId returns matching token IDs** -- validates index | Ingest token with coinData `[['UCT', '1000']]` | `pkg.tokensByCoinId('UCT')` includes tokenId
- [ ] **tokensByTokenType returns matching token IDs** -- validates index | Ingest token | `pkg.tokensByTokenType(tokenType)` includes tokenId
- [ ] **tokensByCoinId returns empty for unknown coinId** -- validates empty case | `pkg.tokensByCoinId('UNKNOWN')` | Returns `[]`
- [ ] **tokensByTokenType returns empty for unknown type** -- validates empty case | `pkg.tokensByTokenType('0000')` | Returns `[]`

#### describe('transactionCount')

- [ ] **returns correct count** -- validates accessor | Token with 3 transactions | `pkg.transactionCount(tokenId) === 3`
- [ ] **throws TOKEN_NOT_FOUND for unknown token** -- validates error | `pkg.transactionCount('unknown')` | Throws UxfError with code `TOKEN_NOT_FOUND`

#### describe('assembleAtState')

- [ ] **assembleAtState delegates correctly** -- validates historical assembly | Token with 2 transactions, `pkg.assembleAtState(tokenId, 1)` | Result has 1 transaction

#### describe('assembleAll')

- [ ] **assembles all tokens** -- validates batch | Package with 2 tokens | Returns Map with 2 entries

#### describe('consolidateProofs')

- [ ] **throws NOT_IMPLEMENTED** -- validates Phase 1 stub | `pkg.consolidateProofs(tokenId, [0, 1])` | Throws UxfError with code `NOT_IMPLEMENTED`

#### describe('diff / applyDelta')

- [ ] **diff then applyDelta produces equivalent package** -- validates class API | `const delta = pkg1.diff(pkg2); pkg1.applyDelta(delta)` | pkg1 now equivalent to pkg2

#### describe('filterTokens')

- [ ] **filters by predicate** -- validates filter | Ingest 2 tokens, filter by tokenId prefix | Returns matching subset

#### describe('toJson / fromJson')

- [ ] **round-trip via class API** -- validates JSON serialization | `UxfPackage.fromJson(pkg.toJson())` | Token count, element count, and assembled tokens match

#### describe('toCar / fromCar')

- [ ] **round-trip via class API** -- validates CAR serialization | `await UxfPackage.fromCar(await pkg.toCar())` | Token count, element count, and assembled tokens match

#### describe('statistics')

- [ ] **tokenCount returns manifest size** -- validates getter | `pkg.tokenCount` | Matches expected count
- [ ] **elementCount returns pool size** -- validates getter | `pkg.elementCount` | Matches expected count
- [ ] **estimatedSize is non-negative** -- validates getter | `pkg.estimatedSize >= 0` | True
- [ ] **packageData returns underlying data** -- validates accessor | `pkg.packageData` | Has envelope, manifest, pool, instanceChains, indexes

---

## 13. storage-adapters.test.ts

### describe('InMemoryUxfStorage')

- [ ] **save then load round-trips** -- validates basic persistence | `storage.save(pkg)`, `storage.load()` | Loaded package matches saved (pool size, manifest, envelope)
- [ ] **load returns null before save** -- validates empty state | `storage.load()` | Returns `null`
- [ ] **clear removes data** -- validates deletion | Save, clear, load | Returns `null`
- [ ] **save deep-clones (no shared references)** -- validates isolation | Save, mutate original pool, load | Loaded package is unaffected by mutation
- [ ] **multiple save/load cycles** -- validates overwrite | Save pkg1, save pkg2, load | Returns pkg2 data

### describe('KvUxfStorageAdapter')

- [ ] **save then load round-trips** -- validates KV delegation | Mock KvStorage, save pkg, load | Loaded package matches saved
- [ ] **load returns null when key not set** -- validates empty state | Mock returns null for get | Returns `null`
- [ ] **clear calls remove on storage** -- validates delegation | Clear, verify mock's `remove` called with correct key | Called once with `'uxf_package'`
- [ ] **uses custom key when provided** -- validates key configuration | `new KvUxfStorageAdapter(storage, 'custom_key')` | `set` and `get` called with `'custom_key'`
- [ ] **defaults to 'uxf_package' key** -- validates default | `new KvUxfStorageAdapter(storage)` | `set` called with `'uxf_package'`

### describe('UxfPackage.save / UxfPackage.open')

- [ ] **save then open with InMemoryUxfStorage** -- validates class-level persistence | `pkg.save(storage)`, `UxfPackage.open(storage)` | Opened package has same tokens and elements
- [ ] **save then open with KvUxfStorageAdapter** -- validates class-level persistence | Same flow with KV adapter | Same assertions
- [ ] **open throws INVALID_PACKAGE when storage is empty** -- validates error | `UxfPackage.open(emptyStorage)` | Throws UxfError with code `INVALID_PACKAGE`

---

## 14. integration.test.ts

### describe('full end-to-end flows')

#### describe('ingest -> assemble -> verify')

- [ ] **create package, ingest multiple tokens with shared certs, assemble all, verify** -- validates full flow | Create 3 tokens (2 sharing same cert), ingest all, assemble each, verify package | All assembled tokens match originals, verification passes with valid=true, pool has fewer cert elements than tokens (dedup)

#### describe('historical assembly')

- [ ] **assemble at each state index produces correct history** -- validates time-travel | Token with 4 transactions, assemble at states 0..4 | State 0 has 0 transactions, state 4 has 4, each state's `state` field matches expected intermediate state

#### describe('serialization round-trips')

- [ ] **JSON round-trip preserves all assembled tokens** -- validates end-to-end JSON | Ingest tokens, toJson, fromJson, assemble all | All tokens match
- [ ] **CAR round-trip preserves all assembled tokens** -- validates end-to-end CAR | Ingest tokens, toCar, fromCar, assemble all | All tokens match
- [ ] **JSON then CAR then JSON produces identical output** -- validates cross-format stability | toJson, fromJson, toCar, fromCar, toJson | Final JSON matches original JSON

#### describe('merge')

- [ ] **merge two packages with shared elements, deduplicate, verify** -- validates merge flow | Package A has token1 + token2, Package B has token2 + token3 (shared elements for token2) | Merged package has 3 tokens, element count < sum of A + B, verify passes

#### describe('diff + apply')

- [ ] **diff then apply delta matches target** -- validates diff/apply flow | Package A has 2 tokens, Package B has 3 tokens (1 shared) | `diff(A, B)`, `applyDelta(A, delta)`, verify A matches B

#### describe('garbage collection')

- [ ] **remove token then GC cleans up unreachable elements** -- validates GC flow | Ingest 2 tokens, remove 1, gc | Element count decreases, remaining token still assembles correctly, verify passes

#### describe('instance chains')

- [ ] **add alternative instance, select by strategy** -- validates chain integration | Ingest token, create alternative instance of inclusion-proof element, add to chain, assemble with STRATEGY_LATEST vs STRATEGY_ORIGINAL | Different instances selected correctly, both produce valid assembled tokens

#### describe('nametag deduplication')

- [ ] **two tokens with same nametag share nametag sub-DAG** -- validates cross-token nametag dedup | Token A and Token B both have nametag "alice" (same nametag token) | Pool has one set of nametag elements, both tokens assemble with correct nametag

#### describe('split token handling')

- [ ] **split token with object reason round-trips** -- validates split token flow | Ingest split child token with ISplitMintReasonJson reason, assemble | Reason object matches original (decoded from dag-cbor)

---

## Coverage Matrix

| Source File | Test File | Functions Covered |
|---|---|---|
| `errors.ts` | `errors.test.ts` | UxfError constructor |
| `types.ts` | `types.test.ts` | contentHash, ELEMENT_TYPE_IDS, STRATEGY_LATEST, STRATEGY_ORIGINAL |
| `hash.ts` | `hash.test.ts` | hexToBytes, prepareContentForHashing, prepareChildrenForHashing, computeElementHash |
| `element-pool.ts` | `element-pool.test.ts` | ElementPool (put, get, has, delete, size, entries, hashes, values, toMap, fromMap), walkReachable, collectGarbage |
| `instance-chain.ts` | `instance-chain.test.ts` | addInstance, selectInstance, resolveElement, mergeInstanceChains, pruneInstanceChains, rebuildInstanceChainIndex |
| `deconstruct.ts` | `deconstruct.test.ts` | deconstructToken, deconstructState, deconstructAuthenticator, deconstructSmtPath, deconstructUnicityCertificate, deconstructInclusionProof, deconstructGenesisData, deconstructGenesis, deconstructTransaction |
| `assemble.ts` | `assemble.test.ts` | assembleToken, assembleTokenFromRoot, assembleTokenAtState |
| `verify.ts` | `verify.test.ts` | verify |
| `diff.ts` | `diff.test.ts` | diff, applyDelta |
| `json.ts` | `json.test.ts` | packageToJson, packageFromJson |
| `ipld.ts` | `ipld.test.ts` | computeCid, contentHashToCid, cidToContentHash, elementToIpldBlock, exportToCar, importFromCar |
| `UxfPackage.ts` | `UxfPackage.test.ts` | UxfPackage class (all methods), ingest, ingestAll, assemble, assembleAtState, removeToken, mergePkg, addInstance, consolidateProofs, collectGarbageFn |
| `storage-adapters.ts` | `storage-adapters.test.ts` | InMemoryUxfStorage, KvUxfStorageAdapter |
| (all) | `integration.test.ts` | End-to-end flows combining all modules |

---

## Test Count Summary

| Test File | Test Count |
|---|---|
| errors.test.ts | 7 |
| types.test.ts | 18 |
| hash.test.ts | 17 |
| element-pool.test.ts | 16 |
| instance-chain.test.ts | 24 |
| deconstruct.test.ts | 26 |
| assemble.test.ts | 22 |
| verify.test.ts | 16 |
| diff.test.ts | 12 |
| json.test.ts | 18 |
| ipld.test.ts | 14 |
| UxfPackage.test.ts | 30 |
| storage-adapters.test.ts | 10 |
| integration.test.ts | 10 |
| **Total** | **240** |
