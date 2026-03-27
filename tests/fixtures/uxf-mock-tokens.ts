/**
 * UXF Test Fixtures -- Mock Token Definitions
 *
 * Implements the 6 mock tokens (A-F) plus edge cases from TEST-FIXTURES-SPEC.md.
 * All hex values use only valid hex characters [0-9a-f].
 *
 * Naming convention for hex values:
 * - Token prefixes use the token letter repeated (aa, bb, cc, dd, ee, ff)
 * - Field-type suffixes are encoded as hex: 5a16=salt, 4a54=hash, 400e=root,
 *   56e5=step, ce46=cert, da6a=data, 5646=state
 */

// ---------------------------------------------------------------------------
// Reusable Hex Constants
// ---------------------------------------------------------------------------

export const TOKEN_TYPE_FUNGIBLE =
  '0000000000000000000000000000000000000000000000000000000000000001';
export const TOKEN_TYPE_NAMETAG =
  'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

export const PUBKEY_ALICE =
  '02a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const PUBKEY_BOB =
  '03b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';

export const PREDICATE_A =
  'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
export const PREDICATE_B =
  'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
export const PREDICATE_C =
  'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
export const PREDICATE_D =
  'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';

export const SHARED_CERT_HEX =
  'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5';

// ---------------------------------------------------------------------------
// Shared Nametag Token (NAMETAG_ALICE)
// ---------------------------------------------------------------------------

export const NAMETAG_ALICE: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: 'eeee0000000000000000000000000000000000000000000000000000eeee0001',
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'dd26000000000000000000000000000000000000000000000000000000000261',
      tokenType: TOKEN_TYPE_NAMETAG,
      coinData: [],
      tokenData: '616c696365', // hex("alice")
      salt: 'dd26000000000000000000000000000000000000000000000000000000265161',
      recipient: 'DIRECT://alice-address-05',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100dd2601dd2601dd2601dd2601dd2601dd2601dd2601dd2601dd260102200033003300330033003300330033003300330033003300330033003300330033',
        stateHash: 'dd26000000000000000000000000000000000000000000000000000026544a01',
      },
      merkleTreePath: {
        root: 'dd26400e000000000000000000000000000000000000000000000000000000a1',
        steps: [
          {
            data: 'dd2656e500000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'dd2669004a000000000000000000000000000000000000000000000000269001',
      unicityCertificate:
        'dd26ce460000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000026ce401',
    },
  },
  transactions: [],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Token A: Simple Fungible (0 Transactions)
// ---------------------------------------------------------------------------

export const TOKEN_A: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: PREDICATE_A,
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'aa00000000000000000000000000000000000000000000000000000000000001',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '1000000']],
      tokenData: '',
      salt: 'aa000000000000000000000000000000000000000000000000000000005a1601',
      recipient: 'DIRECT://alice-address-01',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01aa01022000bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00bb',
        stateHash: 'aa0000000000000000000000000000000000000000000000000000aa004a5401',
      },
      merkleTreePath: {
        root: 'aa400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'aa56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
          {
            data: 'aa56e50000000000000000000000000000000000000000000000000000000002',
            path: '1',
          },
          { data: null, path: '9999999999999999999' },
        ],
      },
      transactionHash: 'aa694a540000000000000000000000000000000000000000000000000000a901',
      unicityCertificate:
        'aace46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460001',
    },
  },
  transactions: [],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Token B: Single Transfer (1 Transaction)
// ---------------------------------------------------------------------------

export const TOKEN_B: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: PREDICATE_B,
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'bb00000000000000000000000000000000000000000000000000000000000002',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '5000000']],
      tokenData: '',
      salt: 'bb000000000000000000000000000000000000000000000000000000005a1602',
      recipient: 'DIRECT://alice-address-02',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01bb01022000cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc',
        stateHash: 'bb0000000000000000000000000000000000000000000000000000bb004a5401',
      },
      merkleTreePath: {
        root: 'bb400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'bb56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'bb694a540000000000000000000000000000000000000000000000000000b901',
      unicityCertificate:
        'bbce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460002',
    },
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: PREDICATE_A,
          data: null,
        },
        recipient: 'DIRECT://bob-address-01',
        salt: 'bb00000000000000000000000000000000000000000000000000000000955101',
        recipientDataHash: null,
        message: null,
        nametags: [],
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_ALICE,
          signature:
            '3045022100bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02bb02022000dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd',
          stateHash: 'bb0000000000000000000000000000000000000000000000000000bb004a5402',
        },
        merkleTreePath: {
          root: 'bb400e0000000000000000000000000000000000000000000000000000000042',
          steps: [
            {
              data: 'bb56e50000000000000000000000000000000000000000000000000000000002',
              path: '1',
            },
          ],
        },
        transactionHash: 'bb694a540000000000000000000000000000000000000000000000000000b902',
        unicityCertificate: SHARED_CERT_HEX,
      },
    },
  ],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Token C: Multiple Transfers (3 Transactions)
// ---------------------------------------------------------------------------

export const TOKEN_C: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: PREDICATE_D,
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'cc00000000000000000000000000000000000000000000000000000000000003',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '2000000']],
      tokenData: '',
      salt: 'cc000000000000000000000000000000000000000000000000000000005a1603',
      recipient: 'DIRECT://alice-address-03',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01cc01022000ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee00ee',
        stateHash: 'cc0000000000000000000000000000000000000000000000000000cc004a5401',
      },
      merkleTreePath: {
        root: 'cc400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'cc56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'cc694a540000000000000000000000000000000000000000000000000000c901',
      unicityCertificate:
        'ccce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460003',
    },
  },
  transactions: [
    // Transaction 0: PREDICATE_A -> PREDICATE_B
    {
      data: {
        sourceState: { predicate: PREDICATE_A, data: null },
        recipient: 'DIRECT://bob-address-02',
        salt: 'cc00000000000000000000000000000000000000000000000000000000955101',
        recipientDataHash: null,
        message: 'first transfer',
        nametags: [],
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_ALICE,
          signature:
            '3045022100cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02cc02022000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff',
          stateHash: 'cc0000000000000000000000000000000000000000000000000000cc004a5402',
        },
        merkleTreePath: {
          root: 'cc400e0000000000000000000000000000000000000000000000000000000042',
          steps: [
            {
              data: 'cc56e50000000000000000000000000000000000000000000000000000000002',
              path: '1',
            },
          ],
        },
        transactionHash: 'cc694a540000000000000000000000000000000000000000000000000000c902',
        unicityCertificate:
          'ccce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460004',
      },
    },
    // Transaction 1: PREDICATE_B -> PREDICATE_C (uses SHARED_CERT_HEX)
    {
      data: {
        sourceState: { predicate: PREDICATE_B, data: null },
        recipient: 'DIRECT://charlie-address-01',
        salt: 'cc00000000000000000000000000000000000000000000000000000000955102',
        recipientDataHash: null,
        message: null,
        nametags: [],
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_BOB,
          signature:
            '3045022100cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03cc03022001110111011101110111011101110111011101110111011101110111011101',
          stateHash: 'cc0000000000000000000000000000000000000000000000000000cc004a5403',
        },
        merkleTreePath: {
          root: 'cc400e0000000000000000000000000000000000000000000000000000000043',
          steps: [
            {
              data: 'cc56e50000000000000000000000000000000000000000000000000000000003',
              path: '0',
            },
          ],
        },
        transactionHash: 'cc694a540000000000000000000000000000000000000000000000000000c903',
        unicityCertificate: SHARED_CERT_HEX,
      },
    },
    // Transaction 2: PREDICATE_C -> PREDICATE_D
    {
      data: {
        sourceState: { predicate: PREDICATE_C, data: null },
        recipient: 'DIRECT://alice-address-04',
        salt: 'cc00000000000000000000000000000000000000000000000000000000955103',
        recipientDataHash: null,
        message: 'returned',
        nametags: [],
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_BOB,
          signature:
            '3045022100cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04cc04022002220222022202220222022202220222022202220222022202220222022202',
          stateHash: 'cc0000000000000000000000000000000000000000000000000000cc004a5404',
        },
        merkleTreePath: {
          root: 'cc400e0000000000000000000000000000000000000000000000000000000044',
          steps: [
            {
              data: 'cc56e50000000000000000000000000000000000000000000000000000000004',
              path: '1',
            },
          ],
        },
        transactionHash: 'cc694a540000000000000000000000000000000000000000000000000000c904',
        unicityCertificate:
          'ccce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460005',
      },
    },
  ],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Token D: With Top-Level Nametag
// ---------------------------------------------------------------------------

export const TOKEN_D: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: 'dd00000000000000000000000000000000000000000000000000000000dd0001',
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'dd00000000000000000000000000000000000000000000000000000000000004',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '3000000']],
      tokenData: '',
      salt: 'dd000000000000000000000000000000000000000000000000000000005a1604',
      recipient: 'DIRECT://alice-address-04',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01dd01022000440044004400440044004400440044004400440044004400440044004400',
        stateHash: 'dd0000000000000000000000000000000000000000000000000000dd004a5401',
      },
      merkleTreePath: {
        root: 'dd400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'dd56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'dd694a540000000000000000000000000000000000000000000000000000d901',
      unicityCertificate:
        'ddce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460006',
    },
  },
  transactions: [],
  nametags: [NAMETAG_ALICE],
};

// ---------------------------------------------------------------------------
// Token E: Nametag in Transfer Data
// ---------------------------------------------------------------------------

export const TOKEN_E: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: 'ee00000000000000000000000000000000000000000000000000000000ee0001',
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'ee00000000000000000000000000000000000000000000000000000000000005',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '7500000']],
      tokenData: '',
      salt: 'ee000000000000000000000000000000000000000000000000000000005a1605',
      recipient: 'DIRECT://bob-address-03',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_BOB,
        signature:
          '3045022100ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01ee01022000550055005500550055005500550055005500550055005500550055005500',
        stateHash: 'ee0000000000000000000000000000000000000000000000000000ee004a5401',
      },
      merkleTreePath: {
        root: 'ee400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'ee56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'ee694a540000000000000000000000000000000000000000000000000000e901',
      unicityCertificate:
        'eece46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460007',
    },
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: 'ee00000000000000000000000000000000000000000000000000000000ee5ac1',
          data: null,
        },
        recipient: 'DIRECT://alice-address-06',
        salt: 'ee00000000000000000000000000000000000000000000000000000000955101',
        recipientDataHash: null,
        message: 'transfer with nametag',
        nametags: [NAMETAG_ALICE],
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_BOB,
          signature:
            '3045022100ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02ee02022000660066006600660066006600660066006600660066006600660066006600',
          stateHash: 'ee0000000000000000000000000000000000000000000000000000ee004a5402',
        },
        merkleTreePath: {
          root: 'ee400e0000000000000000000000000000000000000000000000000000000042',
          steps: [
            {
              data: 'ee56e50000000000000000000000000000000000000000000000000000000002',
              path: '1',
            },
          ],
        },
        transactionHash: 'ee694a540000000000000000000000000000000000000000000000000000e902',
        unicityCertificate:
          'eece46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460008',
      },
    },
  ],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Token F: Split Token with Reason
// ---------------------------------------------------------------------------

export const TOKEN_F: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: 'ff00000000000000000000000000000000000000000000000000000000ff0001',
    data: null,
  },
  genesis: {
    data: {
      tokenId: 'ff00000000000000000000000000000000000000000000000000000000000006',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '400000']],
      tokenData: '',
      salt: 'ff000000000000000000000000000000000000000000000000000000005a1606',
      recipient: 'DIRECT://alice-address-07',
      recipientDataHash: null,
      reason: {
        type: 'TOKEN_SPLIT',
        token: {
          version: '2.0',
          state: {
            predicate: 'ff5a4e26000000000000000000000000000000000000000000000000ff54ed01',
            data: null,
          },
          genesis: {
            data: {
              tokenId: 'ff5a4e26000000000000000000000000000000000000000000000000ff546001',
              tokenType: TOKEN_TYPE_FUNGIBLE,
              coinData: [['UCT', '1000000']],
              tokenData: '',
              salt: 'ff5a4e26000000000000000000000000000000000000000000000000ff555101',
              recipient: 'DIRECT://alice-address-08',
              recipientDataHash: null,
              reason: null,
            },
            inclusionProof: {
              authenticator: {
                algorithm: 'secp256k1',
                publicKey: PUBKEY_ALICE,
                signature:
                  '3045022100ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51ff51022000770077007700770077007700770077007700770077007700770077007700',
                stateHash: 'ff5a4e26000000000000000000000000000000000000000000000000ff556401',
              },
              merkleTreePath: {
                root: 'ff5400e0000000000000000000000000000000000000000000000000000000a1',
                steps: [],
              },
              transactionHash:
                'ff5694a5400000000000000000000000000000000000000000000000005690a1',
              unicityCertificate:
                'ff5ce4600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005ce4601',
            },
          },
          transactions: [],
          nametags: [],
        },
        proofs: [
          {
            coinId: 'UCT',
            aggregationPath: {
              root: 'ffa99400e00000000000000000000000000000000000000000000000000000a1',
              steps: [
                {
                  data: 'ffa9956e50000000000000000000000000000000000000000000000000000051',
                  path: '0',
                },
              ],
            },
            coinTreePath: {
              root: 'ffc012400e00000000000000000000000000000000000000000000000000a0a1',
              steps: [
                {
                  data: 'ffc01256e500000000000000000000000000000000000000000000000000a051',
                  path: '1',
                  value: '1000000',
                },
              ],
            },
          },
        ],
      },
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01ff01022000880088008800880088008800880088008800880088008800880088008800',
        stateHash: 'ff0000000000000000000000000000000000000000000000000000ff004a5401',
      },
      merkleTreePath: {
        root: 'ff400e0000000000000000000000000000000000000000000000000000000041',
        steps: [
          {
            data: 'ff56e50000000000000000000000000000000000000000000000000000000001',
            path: '0',
          },
        ],
      },
      transactionHash: 'ff694a540000000000000000000000000000000000000000000000000000f901',
      unicityCertificate:
        'ffce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ce460009',
    },
  },
  transactions: [],
  nametags: [],
};

// ---------------------------------------------------------------------------
// Edge Case Tokens
// ---------------------------------------------------------------------------

export const EDGE_PLACEHOLDER: Record<string, unknown> = {
  _placeholder: true,
};

export const EDGE_PENDING_FINALIZATION: Record<string, unknown> = {
  _pendingFinalization: {
    stage: 'MINT_SUBMITTED',
    requestId: 'some-request-id',
    senderPubkey: PUBKEY_ALICE,
    savedAt: 1700000000000,
    attemptCount: 1,
  },
};

export const EDGE_NULL_PROOF: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: '2011540000000000000000000000000000000000000000000000000000254ed1',
    data: null,
  },
  genesis: {
    data: {
      tokenId: '2011540000000000000000000000000000000000000000000000000000256001',
      tokenType: TOKEN_TYPE_FUNGIBLE,
      coinData: [['UCT', '100000']],
      tokenData: '',
      salt: '20115400000000000000000000000000000000000000000000000000255a1601',
      recipient: 'DIRECT://alice-address-09',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_ALICE,
        signature:
          '3045022100250125012501250125012501250125012501250125012501250125012501022000990099009900990099009900990099009900990099009900990099009900',
        stateHash: '201154000000000000000000000000000000000000000000000000002554a501',
      },
      merkleTreePath: {
        root: '25400e0000000000000000000000000000000000000000000000000000000041',
        steps: [],
      },
      transactionHash: '25694a5400000000000000000000000000000000000000000000000000002501',
      unicityCertificate:
        '25ce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ce401',
    },
  },
  transactions: [
    {
      data: {
        sourceState: {
          predicate: '20115400000000000000000000000000000000000000000000000000255a4c01',
          data: null,
        },
        recipient: 'DIRECT://bob-address-04',
        salt: '201154000000000000000000000000000000000000000000000000002595a161',
        recipientDataHash: null,
        message: null,
        nametags: [],
      },
      inclusionProof: null,
    },
  ],
  nametags: [],
};

export const EDGE_NULL_COINDATA: Record<string, unknown> = {
  version: '2.0',
  state: {
    predicate: '2011c012000000000000000000000000000000000000000000000000005c54ed',
    data: null,
  },
  genesis: {
    data: {
      tokenId: '2011c012000000000000000000000000000000000000000000000000005c6001',
      tokenType: TOKEN_TYPE_NAMETAG,
      coinData: null,
      tokenData: '626f62', // hex("bob")
      salt: '2011c0120000000000000000000000000000000000000000000000005c5a1601',
      recipient: 'DIRECT://bob-address-05',
      recipientDataHash: null,
      reason: null,
    },
    inclusionProof: {
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: PUBKEY_BOB,
        signature:
          '30450221002c012c012c012c012c012c012c012c012c012c012c012c012c012c012c012c0102200000aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00',
        stateHash: '2011c012000000000000000000000000000000000000000000000000005c4a54',
      },
      merkleTreePath: {
        root: '2c400e0000000000000000000000000000000000000000000000000000000041',
        steps: [],
      },
      transactionHash: '2c694a540000000000000000000000000000000000000000000000000000c601',
      unicityCertificate:
        '2cce46000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002cc401',
    },
  },
  transactions: [],
  nametags: [],
};

// ---------------------------------------------------------------------------
// ALL_TOKENS array and expected counts
// ---------------------------------------------------------------------------

export const ALL_TOKENS: Record<string, unknown>[] = [
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  TOKEN_D,
  TOKEN_E,
  TOKEN_F,
];

/** Total unique elements when all 6 tokens are in the pool (with dedup). */
export const EXPECTED_POOL_SIZE_ALL = 87;

/**
 * Expected pool size after incrementally adding tokens A through F.
 * [after A, after A+B, after A+B+C, after A+B+C+D, after A+B+C+D+E, after all]
 */
export const EXPECTED_POOL_SIZE_INCREMENTAL = [8, 22, 48, 64, 79, 87];
