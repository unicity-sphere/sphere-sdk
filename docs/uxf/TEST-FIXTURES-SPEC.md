# UXF Test Fixtures Specification

**Status:** Ready for implementation
**Date:** 2026-03-26

This document defines mock token data for testing UXF deconstruction (`deconstructToken`) and reassembly (`assembleToken`) round-trips. Each mock token is specified with enough field detail for unambiguous TypeScript implementation.

---

## Conventions

- All hex values are 64 lowercase hex characters unless noted otherwise.
- `HEX32(label)` denotes a deterministic 64-char hex string. In the fixture implementation, generate these as `sha256(label)` or use the literal values provided below.
- All tokens use `version: "2.0"`.
- Predicates are variable-length hex strings (~340 chars). Fixtures use shortened 64-char hex for simplicity; round-trip correctness does not depend on predicate length.
- SMT path `path` fields are decimal bigint strings, never hex.

### Reusable Hex Constants

```
TOKEN_TYPE_FUNGIBLE  = "0000000000000000000000000000000000000000000000000000000000000001"
TOKEN_TYPE_NAMETAG   = "f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509"

PUBKEY_ALICE   = "02a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"  (66 chars)
PUBKEY_BOB     = "03b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"  (66 chars)

PREDICATE_A    = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
PREDICATE_B    = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"
PREDICATE_C    = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"
PREDICATE_D    = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"

STATE_DATA_NULL = null

SHARED_CERT_HEX = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"
```

The `SHARED_CERT_HEX` above (200 hex chars, 100 bytes) is used identically by Token B's transaction 1 and Token C's transaction 2 to test cross-token unicity certificate deduplication.

---

## 1. Mock Token Definitions

### Token A: Simple Fungible (0 Transactions)

**Purpose:** Tests the minimal deconstruction path -- a freshly minted token with no transfers and no nametags.

```
{
  version: "2.0",
  state: {
    predicate: PREDICATE_A,
    data: null
  },
  genesis: {
    data: {
      tokenId:           "aa00000000000000000000000000000000000000000000000000000000000001",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "1000000"]],
      tokenData:         "",
      salt:              "aa00000000000000000000000000000000000000000000000000000000salt01",
      recipient:         "DIRECT://alice-address-01",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01022000bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb",
        stateHash:  "aa000000000000000000000000000000000000000000000000000000aashash1"
      },
      merkleTreePath: {
        root:  "aaroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "aastep00000000000000000000000000000000000000000000000000000001", path: "0" },
          { data: "aastep00000000000000000000000000000000000000000000000000000002", path: "1" },
          { data: null, path: "340282366920938463463374607431768211456" }
        ]
      },
      transactionHash: "aatxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "aacert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert01"
    }
  },
  transactions: [],
  nametags: []
}
```

**State derivation:** Zero transactions, so genesis destination state = `token.state` = `{ predicate: PREDICATE_A, data: null }`.

**Expected elements after deconstruction:**

| # | Element Type | Notes |
|---|-------------|-------|
| 1 | `token-root` | Root. tokenId = `aa...01`, version = `"2.0"` |
| 2 | `genesis` | Children: data, inclusionProof, destinationState |
| 3 | `genesis-data` | Leaf. All mint fields. |
| 4 | `inclusion-proof` | Children: authenticator, merkleTreePath, unicityCertificate |
| 5 | `authenticator` | Leaf. secp256k1 signature data. |
| 6 | `smt-path` | Leaf. root + 3 segments. |
| 7 | `unicity-certificate` | Leaf. Opaque cert hex. |
| 8 | `token-state` | Leaf. Current state AND genesis dest state (same content hash since identical). |

**Total unique elements: 8.** The `token-state` for the current state and the genesis destination state are identical (same predicate, same data), so content-hashing produces one element.

---

### Token B: Single Transfer (1 Transaction)

**Purpose:** Tests state derivation for one transfer -- genesis destination differs from current state. The unicity certificate on the transfer's inclusion proof is `SHARED_CERT_HEX`, shared with Token C.

```
{
  version: "2.0",
  state: {
    predicate: PREDICATE_B,
    data: null
  },
  genesis: {
    data: {
      tokenId:           "bb00000000000000000000000000000000000000000000000000000000000002",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "5000000"]],
      tokenData:         "",
      salt:              "bb00000000000000000000000000000000000000000000000000000000salt02",
      recipient:         "DIRECT://alice-address-02",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01022000cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc",
        stateHash:  "bb000000000000000000000000000000000000000000000000000000bbshash1"
      },
      merkleTreePath: {
        root:  "bbroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "bbstep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "bbtxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "bbcert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert02"
    }
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: PREDICATE_A,
          data: null
        },
        recipient:         "DIRECT://bob-address-01",
        salt:              "bb00000000000000000000000000000000000000000000000000000000xslt01",
        recipientDataHash: null,
        message:           null,
        nametags:          []
      },
      inclusionProof: {
        authenticator: {
          algorithm:  "secp256k1",
          publicKey:  PUBKEY_ALICE,
          signature:  "3045022100bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02022000dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd",
          stateHash:  "bb000000000000000000000000000000000000000000000000000000bbshash2"
        },
        merkleTreePath: {
          root:  "bbroot00000000000000000000000000000000000000000000000000000000r2",
          steps: [
            { data: "bbstep00000000000000000000000000000000000000000000000000000002", path: "1" }
          ]
        },
        transactionHash: "bbtxhash0000000000000000000000000000000000000000000000000000tx02",
        unicityCertificate: SHARED_CERT_HEX
      }
    }
  ],
  nametags: []
}
```

**State derivation:**
- Genesis destination state = `transactions[0].data.sourceState` = `{ predicate: PREDICATE_A, data: null }`
- Transaction 0 source state = genesis destination = `{ predicate: PREDICATE_A, data: null }`
- Transaction 0 destination state = `token.state` = `{ predicate: PREDICATE_B, data: null }`

**Expected elements after deconstruction:**

| # | Element Type | Notes |
|---|-------------|-------|
| 1 | `token-root` | tokenId = `bb...02` |
| 2 | `genesis` | |
| 3 | `genesis-data` | |
| 4 | `inclusion-proof` (genesis) | |
| 5 | `authenticator` (genesis) | |
| 6 | `smt-path` (genesis) | |
| 7 | `unicity-certificate` (genesis) | Unique cert. |
| 8 | `token-state` (genesis dest / tx0 source) | `{ PREDICATE_A, null }` |
| 9 | `transaction` | |
| 10 | `transaction-data` | |
| 11 | `inclusion-proof` (tx0) | |
| 12 | `authenticator` (tx0) | |
| 13 | `smt-path` (tx0) | |
| 14 | `unicity-certificate` (tx0) | = SHARED_CERT_HEX |
| 15 | `token-state` (current / tx0 dest) | `{ PREDICATE_B, null }` |

**Total unique elements: 15.**

**Cross-token sharing:** Element #8 (`token-state` with `PREDICATE_A, null`) is identical content to Token A's state element. When both Token A and Token B are ingested into the same pool, this element is deduplicated.

---

### Token C: Multiple Transfers (3 Transactions)

**Purpose:** Tests state chain derivation across multiple transfers. Transaction 2 uses `SHARED_CERT_HEX` (same as Token B transaction 1), exercising cross-token unicity certificate dedup.

```
{
  version: "2.0",
  state: {
    predicate: PREDICATE_D,
    data: null
  },
  genesis: {
    data: {
      tokenId:           "cc00000000000000000000000000000000000000000000000000000000000003",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "2000000"]],
      tokenData:         "",
      salt:              "cc00000000000000000000000000000000000000000000000000000000salt03",
      recipient:         "DIRECT://alice-address-03",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01022000ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee",
        stateHash:  "cc000000000000000000000000000000000000000000000000000000ccshash1"
      },
      merkleTreePath: {
        root:  "ccroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "ccstep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "cctxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "cccert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert03"
    }
  },
  transactions: [
    {
      data: {
        sourceState: { predicate: PREDICATE_A, data: null },
        recipient:         "DIRECT://bob-address-02",
        salt:              "cc00000000000000000000000000000000000000000000000000000000xslt01",
        recipientDataHash: null,
        message:           "first transfer",
        nametags:          []
      },
      inclusionProof: {
        authenticator: {
          algorithm:  "secp256k1",
          publicKey:  PUBKEY_ALICE,
          signature:  "3045022100cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02022000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff",
          stateHash:  "cc000000000000000000000000000000000000000000000000000000ccshash2"
        },
        merkleTreePath: {
          root:  "ccroot00000000000000000000000000000000000000000000000000000000r2",
          steps: [
            { data: "ccstep00000000000000000000000000000000000000000000000000000002", path: "1" }
          ]
        },
        transactionHash: "cctxhash0000000000000000000000000000000000000000000000000000tx02",
        unicityCertificate: "cccert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert04"
      }
    },
    {
      data: {
        sourceState: { predicate: PREDICATE_B, data: null },
        recipient:         "DIRECT://charlie-address-01",
        salt:              "cc00000000000000000000000000000000000000000000000000000000xslt02",
        recipientDataHash: null,
        message:           null,
        nametags:          []
      },
      inclusionProof: {
        authenticator: {
          algorithm:  "secp256k1",
          publicKey:  PUBKEY_BOB,
          signature:  "3045022100cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03022001110111011101110111011101110111011101110111011101110111011101",
          stateHash:  "cc000000000000000000000000000000000000000000000000000000ccshash3"
        },
        merkleTreePath: {
          root:  "ccroot00000000000000000000000000000000000000000000000000000000r3",
          steps: [
            { data: "ccstep00000000000000000000000000000000000000000000000000000003", path: "0" }
          ]
        },
        transactionHash: "cctxhash0000000000000000000000000000000000000000000000000000tx03",
        unicityCertificate: SHARED_CERT_HEX
      }
    },
    {
      data: {
        sourceState: { predicate: PREDICATE_C, data: null },
        recipient:         "DIRECT://alice-address-04",
        salt:              "cc00000000000000000000000000000000000000000000000000000000xslt03",
        recipientDataHash: null,
        message:           "returned",
        nametags:          []
      },
      inclusionProof: {
        authenticator: {
          algorithm:  "secp256k1",
          publicKey:  PUBKEY_BOB,
          signature:  "3045022100cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04022002220222022202220222022202220222022202220222022202220222022202",
          stateHash:  "cc000000000000000000000000000000000000000000000000000000ccshash4"
        },
        merkleTreePath: {
          root:  "ccroot00000000000000000000000000000000000000000000000000000000r4",
          steps: [
            { data: "ccstep00000000000000000000000000000000000000000000000000000004", path: "1" }
          ]
        },
        transactionHash: "cctxhash0000000000000000000000000000000000000000000000000000tx04",
        unicityCertificate: "cccert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert05"
      }
    }
  ],
  nametags: []
}
```

**State derivation:**
- Genesis destination = `tx[0].data.sourceState` = `{ PREDICATE_A, null }`
- Tx0: source = `{ PREDICATE_A, null }`, dest = `tx[1].data.sourceState` = `{ PREDICATE_B, null }`
- Tx1: source = `{ PREDICATE_B, null }`, dest = `tx[2].data.sourceState` = `{ PREDICATE_C, null }`
- Tx2: source = `{ PREDICATE_C, null }`, dest = `token.state` = `{ PREDICATE_D, null }`

**Expected elements after deconstruction:**

| # | Element Type | Notes |
|---|-------------|-------|
| 1 | `token-root` | tokenId = `cc...03` |
| 2 | `genesis` | |
| 3 | `genesis-data` | |
| 4 | `inclusion-proof` (genesis) | |
| 5 | `authenticator` (genesis) | |
| 6 | `smt-path` (genesis) | |
| 7 | `unicity-certificate` (genesis) | Unique cert. |
| 8 | `token-state` (PREDICATE_A) | Genesis dest, tx0 source -- ONE element. |
| 9 | `transaction` (tx0) | |
| 10 | `transaction-data` (tx0) | message = "first transfer" |
| 11 | `inclusion-proof` (tx0) | |
| 12 | `authenticator` (tx0) | |
| 13 | `smt-path` (tx0) | |
| 14 | `unicity-certificate` (tx0) | Unique cert. |
| 15 | `token-state` (PREDICATE_B) | Tx0 dest, tx1 source -- ONE element. |
| 16 | `transaction` (tx1) | |
| 17 | `transaction-data` (tx1) | |
| 18 | `inclusion-proof` (tx1) | |
| 19 | `authenticator` (tx1) | |
| 20 | `smt-path` (tx1) | |
| 21 | `unicity-certificate` (tx1) | = SHARED_CERT_HEX |
| 22 | `token-state` (PREDICATE_C) | Tx1 dest, tx2 source -- ONE element. |
| 23 | `transaction` (tx2) | |
| 24 | `transaction-data` (tx2) | message = "returned" |
| 25 | `inclusion-proof` (tx2) | |
| 26 | `authenticator` (tx2) | |
| 27 | `smt-path` (tx2) | |
| 28 | `unicity-certificate` (tx2) | Unique cert. |
| 29 | `token-state` (PREDICATE_D) | Current state, tx2 dest -- ONE element. |

**Total unique elements: 29.**

**Cross-token sharing with Token B:**
- `token-state(PREDICATE_A, null)` = same as Token A state, Token B genesis-dest
- `token-state(PREDICATE_B, null)` = same as Token B current state
- `unicity-certificate(SHARED_CERT_HEX)` = same as Token B tx0 cert

---

### Token D: With Top-Level Nametag

**Purpose:** Tests recursive nametag decomposition. The token has one nametag sub-token in `nametags[]`.

#### Shared Nametag Token (NAMETAG_ALICE)

This nametag token object is shared between Token D and Token E:

```
NAMETAG_ALICE = {
  version: "2.0",
  state: {
    predicate: "eeee0000000000000000000000000000000000000000000000000000eeee0001",
    data: null
  },
  genesis: {
    data: {
      tokenId:           "ddnt000000000000000000000000000000000000000000000000000000000nt1",
      tokenType:         TOKEN_TYPE_NAMETAG,
      coinData:          [],
      tokenData:         "616c696365",   // hex("alice")
      salt:              "ddnt000000000000000000000000000000000000000000000000000000ntslt1",
      recipient:         "DIRECT://alice-address-05",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100ddnt01ddnt01ddnt01ddnt01ddnt01ddnt01ddnt01ddnt01ddnt0102200033003300330033003300330033003300330033003300330033003300330033",
        stateHash:  "ddnt0000000000000000000000000000000000000000000000000000ntshash1"
      },
      merkleTreePath: {
        root:  "ddntroot000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "ddntstep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "ddnttxhash000000000000000000000000000000000000000000000000ntx01",
      unicityCertificate: "ddntcert000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ntcert01"
    }
  },
  transactions: [],
  nametags: []
}
```

**NAMETAG_ALICE produces 8 unique elements** (same structure as Token A).

#### Token D Definition

```
{
  version: "2.0",
  state: {
    predicate: "dd00000000000000000000000000000000000000000000000000000000dd0001",
    data: null
  },
  genesis: {
    data: {
      tokenId:           "dd00000000000000000000000000000000000000000000000000000000000004",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "3000000"]],
      tokenData:         "",
      salt:              "dd00000000000000000000000000000000000000000000000000000000salt04",
      recipient:         "DIRECT://alice-address-04",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01022000440044004400440044004400440044004400440044004400440044004400",
        stateHash:  "dd000000000000000000000000000000000000000000000000000000ddshash1"
      },
      merkleTreePath: {
        root:  "ddroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "ddstep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "ddtxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "ddcert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert06"
    }
  },
  transactions: [],
  nametags: [NAMETAG_ALICE]
}
```

**Expected elements: 8 (Token D own) + 8 (NAMETAG_ALICE sub-DAG) = 16 unique elements.**

---

### Token E: Nametag in Transfer Data

**Purpose:** Tests `nametagRefs` in `transaction-data` and nametag dedup between top-level and transfer-data locations. Token E does NOT have the nametag at top level -- it appears only inside `transactions[0].data.nametags`. When both Token D and Token E are in the same pool, the NAMETAG_ALICE sub-DAG (8 elements) is stored only once.

```
{
  version: "2.0",
  state: {
    predicate: "ee00000000000000000000000000000000000000000000000000000000ee0001",
    data: null
  },
  genesis: {
    data: {
      tokenId:           "ee00000000000000000000000000000000000000000000000000000000000005",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "7500000"]],
      tokenData:         "",
      salt:              "ee00000000000000000000000000000000000000000000000000000000salt05",
      recipient:         "DIRECT://bob-address-03",
      recipientDataHash: null,
      reason:            null
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_BOB,
        signature:  "3045022100ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01022000550055005500550055005500550055005500550055005500550055005500",
        stateHash:  "ee000000000000000000000000000000000000000000000000000000eeshash1"
      },
      merkleTreePath: {
        root:  "eeroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "eestep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "eetxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "eecert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert07"
    }
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: "ee00000000000000000000000000000000000000000000000000000000eesrc1",
          data: null
        },
        recipient:         "DIRECT://alice-address-06",
        salt:              "ee00000000000000000000000000000000000000000000000000000000xslt01",
        recipientDataHash: null,
        message:           "transfer with nametag",
        nametags:          [NAMETAG_ALICE]
      },
      inclusionProof: {
        authenticator: {
          algorithm:  "secp256k1",
          publicKey:  PUBKEY_BOB,
          signature:  "3045022100ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02022000660066006600660066006600660066006600660066006600660066006600",
          stateHash:  "ee000000000000000000000000000000000000000000000000000000eeshash2"
        },
        merkleTreePath: {
          root:  "eeroot00000000000000000000000000000000000000000000000000000000r2",
          steps: [
            { data: "eestep00000000000000000000000000000000000000000000000000000002", path: "1" }
          ]
        },
        transactionHash: "eetxhash0000000000000000000000000000000000000000000000000000tx02",
        unicityCertificate: "eecert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert08"
      }
    }
  ],
  nametags: []
}
```

**State derivation:**
- Genesis destination = `tx[0].data.sourceState` = `{ "ee...src1", null }`
- Tx0: source = `{ "ee...src1", null }`, dest = `token.state` = `{ "ee...ee0001", null }`

**Expected elements for Token E alone:**

| # | Element Type | Notes |
|---|-------------|-------|
| 1-8 | NAMETAG_ALICE sub-DAG | 8 elements (same as in Token D) |
| 9 | `token-root` | tokenId = `ee...05` |
| 10 | `genesis` | |
| 11 | `genesis-data` | |
| 12 | `inclusion-proof` (genesis) | |
| 13 | `authenticator` (genesis) | |
| 14 | `smt-path` (genesis) | |
| 15 | `unicity-certificate` (genesis) | |
| 16 | `token-state` (genesis dest / tx0 source) | `{ "ee...src1", null }` |
| 17 | `transaction` | |
| 18 | `transaction-data` | nametagRefs = [hash of NAMETAG_ALICE root] |
| 19 | `inclusion-proof` (tx0) | |
| 20 | `authenticator` (tx0) | |
| 21 | `smt-path` (tx0) | |
| 22 | `unicity-certificate` (tx0) | |
| 23 | `token-state` (current / tx0 dest) | |

**Total unique elements for Token E alone: 23.**

**Cross-token sharing with Token D:** When both are in the same pool, the 8 NAMETAG_ALICE elements are shared. Token D contributes 16 unique, Token E contributes 23 unique, but together they contribute 16 + 23 - 8 = 31 unique elements (not 39).

---

### Token F: Split Token with Reason

**Purpose:** Tests `reason` encoding/decoding round-trip. The genesis `reason` is an `ISplitMintReasonJson` object containing a reference to a parent token.

```
{
  version: "2.0",
  state: {
    predicate: "ff00000000000000000000000000000000000000000000000000000000ff0001",
    data: null
  },
  genesis: {
    data: {
      tokenId:           "ff00000000000000000000000000000000000000000000000000000000000006",
      tokenType:         TOKEN_TYPE_FUNGIBLE,
      coinData:          [["UCT", "400000"]],
      tokenData:         "",
      salt:              "ff00000000000000000000000000000000000000000000000000000000salt06",
      recipient:         "DIRECT://alice-address-07",
      recipientDataHash: null,
      reason: {
        type: "TOKEN_SPLIT",
        token: {
          version: "2.0",
          state: {
            predicate: "ffparent000000000000000000000000000000000000000000000000ffpred01",
            data: null
          },
          genesis: {
            data: {
              tokenId:           "ffparent000000000000000000000000000000000000000000000000ffprtk01",
              tokenType:         TOKEN_TYPE_FUNGIBLE,
              coinData:          [["UCT", "1000000"]],
              tokenData:         "",
              salt:              "ffparent000000000000000000000000000000000000000000000000ffpslt01",
              recipient:         "DIRECT://alice-address-08",
              recipientDataHash: null,
              reason:            null
            },
            inclusionProof: {
              authenticator: {
                algorithm: "secp256k1",
                publicKey: PUBKEY_ALICE,
                signature: "3045022100ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1ffp1022000770077007700770077007700770077007700770077007700770077007700",
                stateHash: "ffparent000000000000000000000000000000000000000000000000ffpsth01"
              },
              merkleTreePath: {
                root: "ffproot000000000000000000000000000000000000000000000000000000r1",
                steps: []
              },
              transactionHash: "ffptxhash00000000000000000000000000000000000000000000000000ptx01",
              unicityCertificate: "ffpcert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000pcert01"
            }
          },
          transactions: [],
          nametags: []
        },
        proofs: [
          {
            coinId: "UCT",
            aggregationPath: {
              root:  "ffaggroot0000000000000000000000000000000000000000000000000000r1",
              steps: [
                { data: "ffaggstep0000000000000000000000000000000000000000000000000000s1", path: "0" }
              ]
            },
            coinTreePath: {
              root:  "ffcoinroot000000000000000000000000000000000000000000000000000r1",
              steps: [
                { data: "ffcoinstep00000000000000000000000000000000000000000000000000s1", path: "1", value: "1000000" }
              ]
            }
          }
        ]
      }
    },
    inclusionProof: {
      authenticator: {
        algorithm:  "secp256k1",
        publicKey:  PUBKEY_ALICE,
        signature:  "3045022100ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01022000880088008800880088008800880088008800880088008800880088008800",
        stateHash:  "ff000000000000000000000000000000000000000000000000000000ffshash1"
      },
      merkleTreePath: {
        root:  "ffroot00000000000000000000000000000000000000000000000000000000r1",
        steps: [
          { data: "ffstep00000000000000000000000000000000000000000000000000000001", path: "0" }
        ]
      },
      transactionHash: "fftxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "ffcert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cert09"
    }
  },
  transactions: [],
  nametags: []
}
```

**Key test points:**
1. The `reason` field is an object (not null, not string) -- it must be dag-cbor encoded during deconstruction and dag-cbor decoded during reassembly.
2. The decoded `reason` must deeply equal the input `reason` (including the embedded parent token object and the `coinTreePath` with its `value` field).
3. The `reason` is stored as opaque bytes in `genesis-data`; the parent token inside it is NOT recursively deconstructed into the pool (Phase 1 treats reason as opaque).

**Expected elements: 8** (same count as Token A -- `reason` is stored inline as bytes in the `genesis-data` element, not as separate child elements).

---

## 2. Shared Elements and Deduplication Targets

### 2.1 Shared Unicity Certificate

| Token | Transaction | Unicity Certificate Value |
|-------|------------|--------------------------|
| Token B | tx[0] | `SHARED_CERT_HEX` |
| Token C | tx[1] | `SHARED_CERT_HEX` |

When both tokens are in the pool, the `unicity-certificate` element with content `{ raw: SHARED_CERT_HEX }` is stored once. Both inclusion-proof elements reference the same content hash.

### 2.2 Shared Nametag Sub-DAG

| Token | Location | Nametag |
|-------|----------|---------|
| Token D | `nametags[0]` (top-level) | `NAMETAG_ALICE` |
| Token E | `transactions[0].data.nametags[0]` (transfer data) | `NAMETAG_ALICE` |

The 8 elements comprising NAMETAG_ALICE are stored once. Token D's `token-root` references the nametag root hash in its `nametags` children array. Token E's `transaction-data` references the same hash in its `nametagRefs` content array.

### 2.3 Shared Token States

| State Content | Tokens That Produce It |
|--------------|----------------------|
| `{ predicate: PREDICATE_A, data: null }` | Token A (current state), Token B (genesis dest / tx0 source), Token C (genesis dest / tx0 source) |
| `{ predicate: PREDICATE_B, data: null }` | Token B (current state / tx0 dest), Token C (tx0 dest / tx1 source) |

These `token-state` elements are identical across tokens and deduplicated in the pool.

---

## 3. Edge Case Tokens

These tokens test rejection, null handling, and boundary conditions. They are defined separately from the main 6 tokens.

### Edge Case 1: Placeholder Token

```
EDGE_PLACEHOLDER = {
  _placeholder: true
}
```

**Expected behavior:** `deconstructToken(pool, EDGE_PLACEHOLDER)` throws `UxfError` with code `INVALID_PACKAGE`.

### Edge Case 2: Pending Finalization Token

```
EDGE_PENDING_FINALIZATION = {
  _pendingFinalization: {
    stage: "MINT_SUBMITTED",
    requestId: "some-request-id",
    senderPubkey: PUBKEY_ALICE,
    savedAt: 1700000000000,
    attemptCount: 1
  }
}
```

**Expected behavior:** `deconstructToken(pool, EDGE_PENDING_FINALIZATION)` throws `UxfError` with code `INVALID_PACKAGE`.

### Edge Case 3: Token with Null Inclusion Proof on Last Transaction

This token has a committed genesis but an uncommitted (pending) last transaction where `inclusionProof` is `null`.

```
EDGE_NULL_PROOF = {
  version: "2.0",
  state: {
    predicate: "nullproof000000000000000000000000000000000000000000000000npred01",
    data: null
  },
  genesis: {
    data: {
      tokenId:    "nullproof000000000000000000000000000000000000000000000000nprtk01",
      tokenType:  TOKEN_TYPE_FUNGIBLE,
      coinData:   [["UCT", "100000"]],
      tokenData:  "",
      salt:       "nullproof000000000000000000000000000000000000000000000000npslt01",
      recipient:  "DIRECT://alice-address-09",
      recipientDataHash: null,
      reason:     null
    },
    inclusionProof: {
      authenticator: {
        algorithm: "secp256k1",
        publicKey: PUBKEY_ALICE,
        signature: "3045022100np01np01np01np01np01np01np01np01np01np01np01np01np01np01np01np01022000990099009900990099009900990099009900990099009900990099009900",
        stateHash: "nullproof000000000000000000000000000000000000000000000000npshash1"
      },
      merkleTreePath: {
        root: "nproot00000000000000000000000000000000000000000000000000000000r1",
        steps: []
      },
      transactionHash: "nptxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "npcert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ncert01"
    }
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: "nullproof000000000000000000000000000000000000000000000000npsrc01",
          data: null
        },
        recipient:         "DIRECT://bob-address-04",
        salt:              "nullproof000000000000000000000000000000000000000000000000npxslt1",
        recipientDataHash: null,
        message:           null,
        nametags:          []
      },
      inclusionProof: null
    }
  ],
  nametags: []
}
```

**Expected behavior:** `deconstructToken` succeeds. The `transaction` element has `inclusionProof: null` (null child reference). No authenticator, smt-path, or unicity-certificate elements are created for this transaction.

**Expected elements: 12** (8 for genesis structure + 1 transaction + 1 transaction-data + 2 token-states for source/dest).

### Edge Case 4: Token with Null state.data

Token A already covers this (has `data: null`). No separate fixture needed.

### Edge Case 5: Token with Empty Nametags Array

Token A already covers this (has `nametags: []`). No separate fixture needed.

### Edge Case 6: Token with Null coinData

```
EDGE_NULL_COINDATA = {
  version: "2.0",
  state: {
    predicate: "nullcoin000000000000000000000000000000000000000000000000ncpred01",
    data: null
  },
  genesis: {
    data: {
      tokenId:    "nullcoin000000000000000000000000000000000000000000000000ncrtk01",
      tokenType:  TOKEN_TYPE_NAMETAG,
      coinData:   null,
      tokenData:  "626f62",  // hex("bob")
      salt:       "nullcoin000000000000000000000000000000000000000000000000ncslt01",
      recipient:  "DIRECT://bob-address-05",
      recipientDataHash: null,
      reason:     null
    },
    inclusionProof: {
      authenticator: {
        algorithm: "secp256k1",
        publicKey: PUBKEY_BOB,
        signature: "3045022100nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc01nc0102200000aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00",
        stateHash: "nullcoin000000000000000000000000000000000000000000000000ncshash1"
      },
      merkleTreePath: {
        root: "ncroot00000000000000000000000000000000000000000000000000000000r1",
        steps: []
      },
      transactionHash: "nctxhash0000000000000000000000000000000000000000000000000000tx01",
      unicityCertificate: "nccert0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000nccrt01"
    }
  },
  transactions: [],
  nametags: []
}
```

**Expected behavior:** `deconstructToken` succeeds. The `genesis-data` element stores `coinData: []` (null normalized to empty array).

### Edge Case 7: Deeply Nested Nametag Token (depth=5)

This tests the max-depth guard. Build 5 levels of nesting where each level has one nametag containing the next level.

```
EDGE_DEEP_NAMETAG_5 = {
  version: "2.0",
  state: { predicate: "d5lv1pred...", data: null },
  genesis: { /* valid genesis with unique tokenId d5lv1tk... */ },
  transactions: [],
  nametags: [
    {
      version: "2.0",
      state: { predicate: "d5lv2pred...", data: null },
      genesis: { /* valid genesis with unique tokenId d5lv2tk... */ },
      transactions: [],
      nametags: [
        {
          version: "2.0",
          state: { predicate: "d5lv3pred...", data: null },
          genesis: { /* valid genesis with unique tokenId d5lv3tk... */ },
          transactions: [],
          nametags: [
            {
              version: "2.0",
              state: { predicate: "d5lv4pred...", data: null },
              genesis: { /* valid genesis with unique tokenId d5lv4tk... */ },
              transactions: [],
              nametags: [
                {
                  version: "2.0",
                  state: { predicate: "d5lv5pred...", data: null },
                  genesis: { /* valid genesis with unique tokenId d5lv5tk... */ },
                  transactions: [],
                  nametags: []
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

**Expected behavior:** `deconstructToken` succeeds (depth 5 is well under the maxDepth=100 limit). Each level produces 8 elements. Total unique elements = 5 * 8 = 40.

**Implementation note:** The implementer must generate 5 distinct genesis blocks (with unique tokenIds, salts, certs) to avoid accidental dedup collapsing the nesting. A helper function `makeMinimalToken(level: number)` should produce a valid minimal token with level-unique values.

---

## 4. Expected Element Counts

### 4.1 Per-Token Element Counts

| Token | Unique Elements | Element Types Produced |
|-------|----------------|----------------------|
| **A** (simple fungible) | 8 | token-root, genesis, genesis-data, inclusion-proof, authenticator, smt-path, unicity-certificate, token-state(x1) |
| **B** (single transfer) | 15 | token-root, genesis, genesis-data, inclusion-proof(x2), authenticator(x2), smt-path(x2), unicity-certificate(x2), token-state(x2), transaction, transaction-data |
| **C** (3 transfers) | 29 | token-root, genesis, genesis-data, inclusion-proof(x4), authenticator(x4), smt-path(x4), unicity-certificate(x4), token-state(x4), transaction(x3), transaction-data(x3) |
| **D** (with nametag) | 16 | Token D own(8) + NAMETAG_ALICE(8) |
| **E** (nametag in xfer) | 23 | Token E own(15) + NAMETAG_ALICE(8) |
| **F** (split with reason) | 8 | token-root, genesis, genesis-data, inclusion-proof, authenticator, smt-path, unicity-certificate, token-state(x1) |

### 4.2 Full Pool (All 6 Tokens)

**Total elements without dedup (naive sum):** 8 + 15 + 29 + 16 + 23 + 8 = **99 elements**

**Shared elements across tokens:**

| Shared Element | Content | Shared By | Dedup Savings |
|---------------|---------|-----------|---------------|
| `token-state(PREDICATE_A, null)` | predicate=PREDICATE_A, data=null | A, B, C | 2 elements saved |
| `token-state(PREDICATE_B, null)` | predicate=PREDICATE_B, data=null | B, C | 1 element saved |
| `unicity-certificate(SHARED_CERT_HEX)` | raw=SHARED_CERT_HEX | B(tx0), C(tx1) | 1 element saved |
| NAMETAG_ALICE sub-DAG (8 elements) | Entire nametag token | D, E | 8 elements saved |

**Total dedup savings: 2 + 1 + 1 + 8 = 12 elements**

**Total elements with dedup: 99 - 12 = 87 unique elements**

**Dedup savings percentage: 12 / 99 = 12.1%**

### 4.3 Element Type Distribution (Full Pool, Deduplicated)

| Element Type | Count | Notes |
|-------------|-------|-------|
| `token-root` | 7 | A, B, C, D, E, F + NAMETAG_ALICE |
| `genesis` | 7 | One per token-root |
| `genesis-data` | 7 | One per genesis |
| `inclusion-proof` | 12 | 7 genesis + 1(B tx0) + 3(C tx0-2) + 1(E tx0) |
| `authenticator` | 12 | One per inclusion-proof |
| `smt-path` | 12 | One per inclusion-proof |
| `unicity-certificate` | 11 | 12 proofs - 1 shared cert |
| `token-state` | 9 | 9 unique states: PRED_A(shared A/B/C), PRED_B(shared B/C), PRED_C, PRED_D, D-own, NT_ALICE, E-src, E-own, F-own |
| `transaction` | 5 | B(1) + C(3) + E(1) |
| `transaction-data` | 5 | One per transaction |
| **Total** | **87** | |

### 4.4 Verification Checklist

When implementing the test fixtures, validate these invariants:

1. **Deconstruct Token A:** pool.size === 8
2. **Deconstruct Token B into same pool as A:** pool.size === 8 + 15 - 1 = 22 (shared PREDICATE_A state)
3. **Deconstruct Token C into same pool:** pool.size === 22 + 29 - 3 = 48 (shared PREDICATE_A state, PREDICATE_B state, SHARED_CERT)
4. **Deconstruct Token D into same pool:** pool.size === 48 + 16 = 64 (no overlap with A-C)
5. **Deconstruct Token E into same pool:** pool.size === 64 + 23 - 8 = 79 (shared NAMETAG_ALICE)
6. **Deconstruct Token F into same pool:** pool.size === 79 + 8 = 87 (no overlap)
7. **Round-trip each token:** `assembleToken(pool, manifest, tokenId)` deeply equals the original input for all 6 tokens (modulo hex lowercasing). Note: `state.data: null` is faithfully preserved — do NOT normalize null to empty string.
8. **SHARED_CERT content hash:** The content hash of the `unicity-certificate` element from Token B tx0 equals the content hash from Token C tx1.
9. **NAMETAG_ALICE root hash:** The content hash of the nametag `token-root` from Token D equals the nametagRef hash stored in Token E's `transaction-data`.

---

## 5. Implementation Notes

### 5.1 Fixture File Location

Place the fixture implementation at: `tests/fixtures/uxf-mock-tokens.ts`

### 5.2 Export Structure

```typescript
// Named individual tokens
export const TOKEN_A: TokenShape = { ... };
export const TOKEN_B: TokenShape = { ... };
export const TOKEN_C: TokenShape = { ... };
export const TOKEN_D: TokenShape = { ... };
export const TOKEN_E: TokenShape = { ... };
export const TOKEN_F: TokenShape = { ... };

// Shared constants
export const SHARED_CERT_HEX: string = "e5e5...";
export const NAMETAG_ALICE: TokenShape = { ... };

// Edge case tokens
export const EDGE_PLACEHOLDER = { _placeholder: true };
export const EDGE_PENDING_FINALIZATION = { _pendingFinalization: { ... } };
export const EDGE_NULL_PROOF: TokenShape = { ... };
export const EDGE_NULL_COINDATA: TokenShape = { ... };
export const EDGE_DEEP_NAMETAG_5: TokenShape = { ... };

// All main tokens as array for batch operations
export const ALL_TOKENS: TokenShape[] = [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, TOKEN_E, TOKEN_F];

// Expected counts for assertions
export const EXPECTED_POOL_SIZE_ALL = 87;
export const EXPECTED_POOL_SIZE_INCREMENTAL = [8, 22, 48, 64, 79, 87];
```

### 5.3 Round-Trip Normalization

When comparing reassembled tokens to originals, apply these normalizations:
- `state.data: null` is preserved faithfully through round-trip (not coerced to empty string). Assert `null` stays `null`.
- All hex strings must be lowercased before comparison.
- `nametags: undefined` should be treated as `nametags: []`.
- `coinData: null` should be treated as `coinData: []`.
- The `reason` field on Token F must deeply equal after dag-cbor encode/decode round-trip. Note that dag-cbor may reorder object keys; use deep equality, not string comparison.

### 5.4 Signature Hex Lengths

The mock signatures above are 140 hex characters (70 bytes), which is within the valid DER-encoded ECDSA range (70-72 bytes). Real signatures vary. The round-trip test must preserve the exact signature bytes.

---

**End of specification.**
