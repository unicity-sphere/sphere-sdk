# NFT Metadata Format (v1)

**Status:** normative. Format version `1`. Design discussion:
[sphere-sdk#785](https://github.com/unicity-sphere/sphere-sdk/issues/785).
Reference implementation: `token-engine/nft-payload.ts`, pinned by
`tests/unit/token-engine/nft-payload.test.ts`.

A coinless token (an NFT) can carry a name, media, traits and a creator signature in
its genesis payload. This document defines that payload: four CBOR tags, their
fields, where each may appear, how a reader recognises them, and the exact bytes a
creator signs. It is written for implementers in any language. The
[test vectors](#test-vectors) fix the bytes.

**Scope: display and attribution.** This format describes an item and records who
signed it. It does not establish collection membership, authorization to issue, or
supply. Those come from a token type's issuance policy, which this format does not
define (see
[Relationship to the yellowpaper token standards](#relationship-to-the-yellowpaper-token-standards)).

The key words MUST, MUST NOT, SHOULD and MAY are used as described in RFC 2119.

## Background

- **`tokenType` is the vessel, not a collection.** One token type carries coin data,
  NFT data or arbitrary bytes. The payload says what a token is. A reader MUST NOT use
  `tokenType` to decide whether a payload is an NFT.
- **Only the genesis payload is issuer-controlled.** It is immutable and covered by the
  mint's inclusion proof. Transfer `data` is set by whoever sends that transfer.
- **Nothing on chain authenticates the minter.** The mint signing key is derived from
  the token id and a fixed universal secret, so anyone who knows a token id can
  reproduce it. A verifier registered for a token type receives the whole certified
  mint transaction, so a type can enforce an issuance policy, but sphere-sdk and
  wallet-api register none: both build `TokenIssuanceVerifierService(false)`, which
  accepts a token type that has no verifier, the NFT vessel included. Anyone can
  therefore mint a byte-identical copy of any payload, so attribution has to live
  inside the payload. `NftSigned` carries it, and it is attribution only
  ([Attribution, not authorization](#attribution-not-authorization)).
- **These payloads stay coinless.** A well-formed tag other than 39050 or 55799 is
  classified `none_tag` by sphere-sdk's `classifyValueEnvelope` and by wallet-api §8.2
  step 6, so wallet-api needs no change. An untagged top-level array with a
  `[bstr, bstr]` element would be read as coin data; the tags prevent that.

## Tags

| Tag | Name | v1 structure | Arity |
|---|---|---|---|
| 39052 | `NftMetadata` | `[1, name, description, image, animation_url, external_url, attributes, collection, collection_id]` | 9 |
| 39053 | `NftMedia` | `[1, media_type, bytes]` | 3 |
| 39054 | `NftLink` | `[1, media_type, uri, sha256]` | 4 |
| 39055 | `NftSigned` | `[1, creator, payload, signature]` | 4 |

These numbers belong in unicity-ids
[`cbor-tags.json`](https://github.com/unicitynetwork/unicity-ids/blob/main/cbor-tags.json),
next to `SpherePaymentData` (39050). Tag 39051 (`SphereTokenBlob`) has been obsolete
since sphere-sdk 0.15.0 and stays reserved.

## Encoding rules

These rules apply to every item. They bind writers and readers equally: a reader
recognises exactly what a writer may produce.

1. **Shape.** An item is `tag(N)[version, …fields]`: a CBOR tag (RFC 8949) whose
   content is a definite-length array with the arity given above.
2. **Version.** `version` is the CBOR unsigned integer `1`. Any other value or type
   makes the item unrecognised. Arity is fixed per version, so adding a field needs a
   new version. A reader that knows only v1 shows a v2 item as a raw payload.
3. **Canonical encoding.** Integer values, lengths and tag numbers use the shortest
   head. Lengths are definite. A non-canonical encoding is not recognised.
4. **Text** is a CBOR text string of valid UTF-8. A reader MUST decode strictly:
   invalid UTF-8 makes the item unrecognised and is never replaced with U+FFFD. A
   leading U+FEFF is part of the text.
5. **Absent** is `null`. An optional text field holds `null` or non-empty text; `""`
   is invalid, so there is only one way to write "absent".
6. **Excluded types.** Apart from `null` where a field allows it, no item uses maps,
   floats, booleans, `undefined` or any other simple value.

## Items

### `NftMetadata` (39052)

Field names follow ERC-721 metadata.

| # | Field | CBOR type | Rule | ERC-721 counterpart |
|---|---|---|---|---|
| 0 | version | uint | `1` | — |
| 1 | `name` | text | Required, non-empty. A nameless NFT is a bare `NftMedia`. | `name` |
| 2 | `description` | text / null | Non-empty when present | `description` |
| 3 | `image` | `NftMedia` / `NftLink` / null | Never a [document link](#metadata-documents) | `image` |
| 4 | `animation_url` | `NftMedia` / `NftLink` / null | Video, audio, 3D. Never a document link. | `animation_url` |
| 5 | `external_url` | text / null | Non-empty when present. The format restricts no scheme; display layers decide what is clickable. | `external_url` |
| 6 | `attributes` | array of `[trait_type, value]` | `[]` when there are none, never `null` | `attributes` |
| 7 | `collection` | text / null | Non-empty when present. A display name only; it never identifies the collection. | contract-level name |
| 8 | `collection_id` | bstr (1–64 bytes) / null | A stable identifier of the collection the item claims. See [Collections](#collections). | contract address |

Each attribute is a 2-element array:

- `trait_type`: non-empty text.
- `value`: non-empty text, or a CBOR integer (major type 0 or 1) in the range
  −(2^53 − 1) to 2^53 − 1, the range a JavaScript number holds exactly. Floats,
  booleans, `null`, byte strings and integers outside the range make the payload
  unrecognised. Write decimals and larger numbers as text: `"3.5"`,
  `"18446744073709551616"`.

The format omits these ERC-721 fields on purpose: `background_color`, `youtube_url`,
and the attribute fields `display_type` and `max_value`.

#### Collections

`collection_id` is an optional stable identifier of the collection the item claims: for
example a collection's token type identifier, or the SHA-256 of a collection manifest.
`collection` stays a display name, and display names can collide.

Both fields are claims. This format does not verify membership; that belongs to the
collection's issuance policy. A wallet MUST NOT present a claimed `collection_id` as
verified membership, whether or not the item is signed.

### `NftMedia` (39053)

| # | Field | CBOR type | Rule |
|---|---|---|---|
| 0 | version | uint | `1` |
| 1 | `media_type` | text | A [media type](#media-type) |
| 2 | `bytes` | bstr | Non-empty. The file itself. |

### `NftLink` (39054)

| # | Field | CBOR type | Rule |
|---|---|---|---|
| 0 | version | uint | `1` |
| 1 | `media_type` | text | The [media type](#media-type) of the linked file |
| 2 | `uri` | text | A [link URI](#link-uri) |
| 3 | `sha256` | bstr (exactly 32) | SHA-256 of the linked file's bytes. Not an IPFS CID, which for most files is not a hash of the raw bytes. |

A link points at a media file or, under the document media type, at a
[metadata document](#metadata-documents).

### `NftSigned` (39055)

| # | Field | CBOR type | Rule |
|---|---|---|---|
| 0 | version | uint | `1` |
| 1 | `creator` | bstr (exactly 33) | A compressed secp256k1 public key, the same kind as a wallet chain key, so a wallet can resolve it to a @nametag |
| 2 | `payload` | `NftMetadata` / `NftMedia` / `NftLink` | Embedded as a CBOR item, not wrapped in a byte string |
| 3 | `signature` | bstr (exactly 65) | `r (32) ‖ s (32) ‖ recovery id (1)`: the state-transition SDK's `Signature.encode()` layout |

Whether `creator` is a valid curve point is not a structural rule. 33 bytes that are
not a point leave the payload recognised, with signature status `invalid`.

### Media type

A media type is a lowercase RFC 6838 restricted-name `type/subtype` with no
parameters:

```
^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$
```

`image/png`, `model/gltf-binary` and `application/vnd.example+json` are valid.
`image/PNG`, `image`, `text/plain;charset=utf-8` and `text/plain; charset=utf-8` are
not.

### Link URI

A link URI is text that meets all of these conditions:

- It starts with exactly `https://`, `ipfs://` or `ar://`, in lower case, followed by
  at least one character.
- It contains no ASCII whitespace or control character (U+0000–U+0020, U+007F).
- It is at most 2048 UTF-16 code units long.

## Metadata documents

An `NftLink` whose `media_type` is `application/vnd.unicity.nft+cbor` is a **document
link**. It points at a metadata document hosted outside the token instead of at a
media file.

- **Where it may appear.** Only where a token's content is expected: the top level of
  a genesis payload, and `NftSigned.payload`. As `image` or `animation_url` it makes
  the payload unrecognised, and an encoder MUST refuse it.
- **The linked file** is exactly one `NftMetadata` or `NftMedia` item under the
  [encoding rules](#encoding-rules), with no trailing bytes. It is never an `NftLink`,
  so links do not chain. It is never an `NftSigned` either: a document is shared
  content, while a signature binds one token, so signatures stay in the token.
- **Resolution.** Fetch the file, check its SHA-256 against the link's `sha256`, then
  parse it as a document. Show nothing from a file that fails either step. The token
  is still held and transferable.
- **Signed documents.** An `NftSigned` over a document link signs the link, including
  its `sha256`, so the signature covers the document.

## Nesting

| Position | May hold |
|---|---|
| A token's genesis payload (top level) | `NftMetadata`, `NftMedia`, `NftLink` (a document link included), `NftSigned` |
| `NftMetadata.image`, `NftMetadata.animation_url` | `NftMedia`, `NftLink` other than a document link, `null` |
| `NftSigned.payload` | `NftMetadata`, `NftMedia`, `NftLink` (a document link included) |
| The file a document link points at | `NftMetadata`, `NftMedia` |

`NftSigned` appears only at the top level: never inside another `NftSigned`, never as
an image and never as a document. Any other item in these positions makes the whole
payload, or the document, unrecognised.

## Recognition

A token's genesis payload is a **recognised NFT** only when all of these hold:

- It is exactly one well-formed item tagged 39052, 39053, 39054 or 39055, with no
  trailing bytes.
- It satisfies every rule above.

Anything else is not recognised. That includes:

- a null or empty payload
- raw file bytes
- any other tag, including a 39050 value envelope and a 55799 self-describe wrapper
- an untagged array
- a malformed or non-canonical item
- an unknown version

**"Not recognised" never means "refused."** Recognition is for display only:

- A reader MUST NOT throw from recognition, and MUST NOT run it where a failure could
  refuse, drop or hide a token. In sphere-sdk the receive path screens every arriving
  token and turns a decode failure into a terminal rejection, which would lose a token
  wallet-api had accepted, so NFT display parsing never runs there.
- An unrecognised token is still held and transferable. Wallets show its raw payload.
- The boundary covers display interpretation only. Type and issuance-policy
  verification, where a token's type defines one, is a separate check and can reject a
  token. This format plays no part in it.

## Signing

### Digest

A creator signs the SHA-256 of a seven-element CBOR array. The layout follows the
yellowpaper's genesis commitment: every term is a byte string except the version and
the network identifier, which are unsigned integers.

```
digest = SHA-256( CBOR array(7) [
  byte string "UNICITY_NFT_SIGNED",   // ASCII domain separator
  unsigned 1,                         // NftSigned format version
  unsigned α,                         // the mint's network identifier
  byte string(recipient predicate),   // the GENESIS recipient, EncodedPredicate.toCBOR()
  byte string(token id),              // the 32 raw token id bytes
  byte string(token type),            // the mint's token type bytes
  byte string(payload)                // NftSigned element 2, exactly as encoded
] )
```

- The array head is `0x87`, and the whole preimage is canonical CBOR.
- **Domain:** the 18 ASCII bytes `UNICITY_NFT_SIGNED`, head `0x52`, named like the
  yellowpaper's `UNICITY_MINT_AUTH` and `UNICITY_SPLIT_OUTPUT`.
- **Version:** `1`, the `NftSigned` format version.
- **Network:** the mint transaction's network identifier α (`NetworkId.id`), with the
  shortest head.
- **Genesis recipient:** the mint transaction's recipient predicate in the
  state-transition SDK's encoding, `EncodedPredicate.toCBOR()`, wrapped in a byte
  string. For the standard signature predicate over a chain key K, the wrapped bytes
  are `39032([1, h'01', h'<K, 33 bytes>'])`. These are the bytes the mint transaction
  itself carries, CBOR tag 39032 included; the yellowpaper draft's predicate-encoding
  table describes the untagged three-element array.
- **Token id:** the 32 raw bytes, head `0x5820`.
- **Token type:** the mint transaction's token type bytes.
- **Payload:** the exact bytes of element 2 as they appear in the `NftSigned` item, its
  tag included, wrapped in a byte string. The signature is not among them, so it never
  covers itself. A verifier hashes the bytes it received and never re-encodes the
  parsed content.
- **Signature:** secp256k1 ECDSA over the 32-byte digest, with no second hash. The
  signer MUST produce a low-s signature. RFC 6979 determinism is not required.

What each element prevents:

- **Domain and version:** reuse of the signature anywhere else. The creator key is a
  wallet key that also signs transactions and messages, and a later signed-message
  layout cannot collide with this one.
- **Network:** a signed statement that leaves its network implicit. The token id
  already commits to α (`id = H(salt, α)`), so this is not a separate replay defence;
  it names the network explicitly.
- **Genesis recipient:** theft by front-running. Someone who sees the mint request can
  resubmit it with the same salt, and so the same token id, naming themselves as
  recipient. The resulting token's signature does not verify. They can still claim the
  token id first and block the creator's mint (the creator re-mints with a new salt).
  That is griefing, not theft.
- **Token id:** copying a signed payload onto another token.
- **Token type:** re-minting the payload under another token type. The token id
  commits to the salt and the network but not to the type, so the same salt under
  another type yields the same token id.

### Signature status

| Status | Meaning |
|---|---|
| `unsigned` | The top-level item is not `NftSigned`. |
| `valid` | All of these hold: `creator` is a valid compressed secp256k1 point; `signature` decodes (recovery id 0–3); `s` is low (s ≤ n/2); and the public key recovered from `(r, s, recovery id)` over the digest equals `creator`. |
| `invalid` | Anything else, including any error during verification. |

- **The recovery byte is bound.** The same `(r, s)` under a different recovery id is
  `invalid`.
- **High-s is refused.** A high-s signature is `invalid` even though it is
  mathematically valid ECDSA.
- **The genesis recipient is used, never the current owner.** A `valid` NFT stays
  `valid` across transfers.
- **`creator` is only a claim until the status is `valid`.** Anyone can mint a payload
  that names someone else's key over a junk signature, so under `invalid` the field
  holds whatever 33 bytes the minter chose. A reader MUST NOT attribute the token to
  `creator`, or resolve it to a @nametag, unless the status is `valid`.
- **No status hides a token.**

### Attribution, not authorization

A `valid` `NftSigned` shows which key signed this item for this token. It does not show
that the signer is a recognised artist, or that a collection authorized the issuance.
Authorization to issue belongs in the mint reason, under the token type's issuance
policy, which this format does not define.

- Wallets SHOULD label a `valid` signature as signed, not as verified.
- Wallets SHOULD keep three claims apart: that the signature is valid, that the signer
  is a key they recognise, and that the item belongs to a collection. This format
  establishes only the first. Resolving `creator` to a @nametag is a separate,
  display-level lookup.

## Reading rules

- **Recognition never refuses a token** (see [Recognition](#recognition)).
- **Verify `NftLink` content before rendering it.** Fetch the file, hash the fetched
  bytes with SHA-256 and compare the result with `sha256`. On a mismatch, do not render
  the file. sphere-sdk provides `verifyNftLinkContent(link, bytes)` for this check. For
  a document link, parse the checked bytes as a [document](#metadata-documents)
  (`parseNftDocument`).
- **Render all metadata text as plain text**, never as markup. Render only media types
  on an allowlist, within size limits.
- **Results may be cached indefinitely per token id.** A token id's genesis payload
  never changes, so a parsed result can be cached for good, including "not an NFT".
- **Inline media travels with every transfer.** A stored token blob is the whole token
  (genesis plus transfers) and is bounded by wallet-api `MAX_BLOB_BYTES` (16 MiB by
  default). Prefer `NftLink` for large files. sphere-sdk's `mintNft` refuses a genesis
  payload over 1 MiB (`NFT_MAX_PAYLOAD_BYTES`, the `NftSigned` wrapper included) before
  minting. That limit is a wallet policy, not a format rule: a reader still recognises a
  larger payload.
- **Listings do not carry payloads.** Showing metadata means fetching each token's
  blob; wallet-api batches the fetches through presigned URLs.

## Supply

This format defines no supply cap, and no field in it limits how many items exist. A
cap comes from a token type's issuance policy, for example the yellowpaper's UTS-3
profiles: a bounded set of genesis identities, enforced by the state uniqueness the
Unicity Service already guarantees, and verified locally by each recipient. Even then a
cap bounds the maximum number of items. It does not reveal the issued count or the
circulating supply.

## Relationship to the yellowpaper token standards

The yellowpaper's draft token standards define token types and mint authorization.
This format sits beside them:

- **The vessel is a container, not a collection type.** The NFT vessel token type
  resembles the yellowpaper's UTS-0 blank container: a well-known type with no
  issuance semantics, whose content the application interprets. An NFT minted into it
  is not a UTS-2 token, even when its payload has the UTS-2 shape described below.
- **Any token type can carry this format.** Recognition never looks at the token type
  (see [Background](#background)), so a UTS-2 or UTS-3 NFT type can use these tags as
  its payload and wallets read it the same way. That type's policy then establishes
  collection membership and any cap; `collection_id` stays a claim.
- **UTS-2 payloads.** A draft UTS-2 genesis payload `[1, h_content, uri]` maps onto
  `NftLink(application/vnd.unicity.nft+cbor, uri, h_content)` when the content is a
  document in this format. `NftLink` requires a [link URI](#link-uri), so a UTS-2
  payload without one has no `NftLink` form.
- **Display metadata and attribution, not issuance authorization.** This format
  describes an item and records who signed it. Authorization to issue belongs in the
  mint reason, verified under the type's policy.
- **Supply** comes from issuance policy, not from this format (see [Supply](#supply)).

## Vessel token type per network

Recognition depends only on the payload. A wallet that mints an NFT still needs a
token type: it uses its network's NFT vessel, the single `non-fungible` entry in that
network's unicity-ids registry.

| Network | Registry | Vessel token type |
|---|---|---|
| `testnet`, `testnet2` | `unicity-ids.testnet2.json` | `971a26eef0e3aeb22bd3e7d44c47ce963400037e8df42b50d4d44e1589f83826` |
| `mainnet` | `unicity-ids.mainnet.json` | `9f190eea6c8d7e1e564c35feb4c289add78be4bedb81bb77fe265e926e5493f4` |

## Examples

The examples use CBOR diagnostic notation.

A signed NFT with an inline image:

```
39055([1,                                         / NftSigned /
  h'02…',                                         / creator, 33 bytes /
  39052([1,                                       / NftMetadata /
    "Cool Cat #1",                                / name /
    "A ginger cat",                               / description /
    39053([1, "image/jpeg", h'ffd8ffe0…']),       / image: NftMedia /
    null,                                         / animation_url /
    "https://coolcats.example",                   / external_url /
    [["Fur", "Ginger"], ["Lives", 9]],            / attributes /
    "Cool Cats",                                  / collection /
    h'…'                                          / collection_id, e.g. a manifest SHA-256 /
  ]),
  h'…'                                            / signature, 65 bytes /
])
```

An unsigned, image-only NFT:

```
39053([1, "image/jpeg", h'ffd8ffe0…'])
```

A hosted image:

```
39054([1, "image/png",
  "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/cbf53542465c852ba219b7d2362adef3b85e3ff4/unicity_logo_32.png",
  h'acc52f7f4e3c271cacb6e633ec8c8508ee74e1415384b8bfd889d6cf0251245c'])
```

A signed link to a hosted metadata document:

```
39055([1,                                         / NftSigned /
  h'02…',                                         / creator, 33 bytes /
  39054([1, "application/vnd.unicity.nft+cbor",   / NftLink: a document link /
    "ipfs://bafy…/1.nft",
    h'…']),                                       / SHA-256 of the document file /
  h'…'                                            / signature, 65 bytes /
])
```

Two small items with their exact encodings:

```
39053([1, "text/plain", h'6869'])
  d9 988d 83 01 6a 746578742f706c61696e 42 6869

39052([1, "Cat", null, null, null, null, [["Lives", 9], ["Debt", -42]], null, null])
  d9 988c 89 01 63 436174 f6 f6 f6 f6
    82 82 65 4c69766573 09
       82 64 44656274 38 29
    f6 f6
```

Payloads that are **not** recognised:

```
39052([1, "", null, null, null, null, [], null, null])              / empty name /
39052([1, "Cat", "", null, null, null, [], null, null])             / "" is not absent /
39053([2, "image/png", h'89504e47'])                                / unknown version /
39052([1, "Cat", null, 39055([…]), null, null, [], null, null])     / NftSigned as an image /
39052([1, "Cat", null, 39054([1, "application/vnd.unicity.nft+cbor", …]), null, null, [], null, null])
                                                                    / a document link as an image /
39052([1, "Cat", null, null, null, null, [["Weight", 3.5]], null, null])   / float value /
39052([1, "Cat", null, null, null, null, [], null, h''])            / empty collection_id /
39054([1, "image/png", "http://example.com/a.png", h'…'])           / scheme not allowed /
```

## Test vectors

The same inputs are pinned in `tests/unit/token-engine/nft-payload.test.ts`.

**Inputs**

| Input | Value |
|---|---|
| network id (α) | `4` |
| genesis recipient | signature predicate over `0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` (the public key of private key 1) |
| token id | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| token type | `971a26eef0e3aeb22bd3e7d44c47ce963400037e8df42b50d4d44e1589f83826` (the testnet2 NFT vessel) |
| creator | public key of private key `11…11` (32 bytes of `0x11`): `034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa` |
| payload | `39053([1, "text/plain", h'68656c6c6f'])` = `d9988d83016a746578742f706c61696e4568656c6c6f` |

**Outputs**

Recipient predicate (`EncodedPredicate.toCBOR()`):

```
d998788301410158210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
```

Preimage, one element per line, with a space after each byte-string head:

```
87
52 554e49434954595f4e46545f5349474e4544
01
04
582a d998788301410158210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
5820 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
5820 971a26eef0e3aeb22bd3e7d44c47ce963400037e8df42b50d4d44e1589f83826
56 d9988d83016a746578742f706c61696e4568656c6c6f
```

Digest:

```
f9094d15f00e78f1395b59e7b70082a784e9fdd50d8d14d1d637676bd84b7daa
```

An `NftSigned` payload that verifies `valid` for these inputs. Its signature is the
RFC 6979 one; another low-s signer produces different signature bytes that must also
verify.

```
d9988f8401
5821034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa
d9988d83016a746578742f706c61696e4568656c6c6f
5841b78f79129a64e58e64413fb983d6744c8b2f0eef4af64be219d0872dc2a4347a0df9c5dcdb3e96454a9a98f7b21d47bb37a8639654542d5ca89c3f476bb9295701
```

## Reference implementation

The reference implementation is `token-engine/nft-payload.ts` in sphere-sdk. Every export below
is available from `@unicitylabs/sphere-sdk/token-engine`. The package root
(`@unicitylabs/sphere-sdk`) re-exports all of them except `NFT_FORMAT_VERSION`,
`encodeNftSigned`, `nftSignedDigest` and `verifyNftSignature`, which only `./token-engine` exports.
A wallet app usually needs none of the signature functions: `sphere.payments.nft(tokenId)` /
`nfts(tokenIds)` return the parsed content, the `creator` key the payload claims, and a `signature`
status (`'unsigned'`, `'valid'` or `'invalid'`) already checked against the token's genesis. Treat
`creator` as authenticated only when `signature` is `'valid'` (see [Signature status](#signature-status)).

| Export | Purpose |
|---|---|
| `NFT_METADATA_TAG`, `NFT_MEDIA_TAG`, `NFT_LINK_TAG`, `NFT_SIGNED_TAG`, `NFT_FORMAT_VERSION` | Tag numbers and format version |
| `NFT_DOCUMENT_MEDIA_TYPE` | `application/vnd.unicity.nft+cbor`, the media type of a document link |
| `encodeNftContent(content)` | Encodes one unsigned item. Throws `SphereError` with code `VALIDATION_ERROR`, naming the offending field. |
| `encodeNftSigned(creator, payload, signature)` | Wraps an encoded unsigned item in `NftSigned` |
| `parseNftPayload(data)` | Recognition. Never throws; returns `null` when the payload is not recognised. |
| `isNftDocumentLink(content)` | Whether content is a document link |
| `parseNftDocument(bytes)` | Parses the file a document link points at: an `NftMetadata` or `NftMedia`, or `null`. Never throws. |
| `nftSignedDigest(context, payload)` | Computes the [digest](#digest). `context` is an `NftSignatureContext`: `{ networkId, recipientPredicate, tokenId, tokenType }`, as the mint records them. |
| `verifyNftSignature(signed, context)` | Returns `valid` or `invalid`. Never throws. |
| `verifyNftLinkContent(link, bytes)` | The `NftLink` check before rendering a file or parsing a document |

Decoded items use the ERC-721 field names above plus a `kind` of `'metadata'`,
`'media'` or `'link'`. A decoded link's `sha256` and a decoded `collection_id` are
lowercase hex; the encoder accepts either case.

## Decisions since the #785 proposal

- **Open questions settled:** `name` stays required, the tags keep their `Nft*` names,
  and the candidate signed digest was adopted, then revised before the freeze (below).
  IANA registration stays open (see [Deferred](#deferred)).
- **Field 4** is named `animation_url`, its ERC-721 name, instead of `animation`.
- **Empty text** is invalid in every text field, so `null` is the only way to write
  "absent".
- **Integer attribute values** are limited to ±(2^53 − 1).
- **Grammars:** the media type and link URI grammars are fixed, and the URI scheme is
  case-sensitive.
- **Verification** binds the recovery byte and refuses high-s signatures.
- **Pre-freeze review**
  ([#785 comment](https://github.com/unicity-sphere/sphere-sdk/issues/785#issuecomment-5670930068)).
  These changes were made to v1 in place, with no version bump. An `NftMetadata`
  written before them is unrecognised, and an earlier signature over any other item
  reads `invalid`.
  - `NftMetadata` gained `collection_id`, so its arity is 9.
  - The signed digest follows the yellowpaper genesis-commitment encoding and also
    binds the network and the token type.
  - The media type `application/vnd.unicity.nft+cbor` marks a document link, so a link
    can reference metadata as well as media.
  - The spec states that a signature is attribution, not authorization; that this
    format defines no supply cap; and where "never rejects" stops.

## Deferred

These are out of scope for v1:

- **Cross-chain identifiers and bridging.**
- **Collection-level metadata** (a collection description or image) **and editions.**
- **Registration in the IANA CBOR tag registry.** None of Unicity's tags are
  registered there.
