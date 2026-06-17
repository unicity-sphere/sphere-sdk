/**
 * Test vectors for cryptographic functions
 * Based on BIP39, BIP32, and Bitcoin standards
 */

// =============================================================================
// BIP39 Test Vectors
// =============================================================================

// BIP39 test vectors - seeds computed WITHOUT passphrase (empty string)
// The first vector is the canonical "all abandon" test case
export const BIP39_VECTORS = [
  {
    entropy: '00000000000000000000000000000000',
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    // Seed with empty passphrase (canonical BIP39 test vector)
    seed: '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  },
];

// =============================================================================
// BIP32 Test Vectors
// =============================================================================

export const BIP32_VECTORS = [
  {
    seed: '000102030405060708090a0b0c0d0e0f',
    masterPrivateKey: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
    masterChainCode: '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508',
    children: [
      {
        path: "m/0'",
        privateKey: 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea',
        chainCode: '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141',
      },
    ],
  },
];

// =============================================================================
// Address Test Vectors
// =============================================================================

export const ADDRESS_VECTORS = [
  {
    privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
    publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    // hash160 of pubkey: 751e76e8199196d454941c45d1b3a323f1433bd6
    address: 'test1qw508d6qejxtdg4y5r3zarvary0c5xw7kxw29v6',
  },
];

// =============================================================================
// Bech32 Test Vectors
// =============================================================================

export const BECH32_VECTORS = [
  {
    hrp: 'test',
    witnessVersion: 0,
    program: new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]),
    // Expected address when witness version is 0
  },
  {
    // Test decode
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    hrp: 'bc',
    witnessVersion: 0,
    program: new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]),
  },
];

// =============================================================================
// Hash Test Vectors
// =============================================================================

export const HASH_VECTORS = {
  sha256: [
    { input: '', expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    {
      input: '68656c6c6f', // "hello" in hex
      expected: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    },
  ],
  ripemd160: [
    { input: '', expected: '9c1185a5c5e9fc54612808977ee8f548b2258d31' },
    {
      input: '68656c6c6f', // "hello" in hex
      expected: '108f07b8382412612c048d07d13f814118445acd',
    },
  ],
  hash160: [
    // SHA256 then RIPEMD160
    {
      input: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // compressed pubkey
      expected: '751e76e8199196d454941c45d1b3a323f1433bd6',
    },
  ],
  doubleSha256: [
    {
      input: '68656c6c6f', // "hello" in hex
      expected: '9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50',
    },
  ],
};

// =============================================================================
// Base58 Test Vectors
// =============================================================================

// Base58 test vectors - raw Base58 encoding WITHOUT checksum
// Note: Bitcoin addresses include a 4-byte checksum, but this is raw Base58
export const BASE58_VECTORS = [
  {
    hex: '00',
    base58: '1',
  },
  {
    hex: '0000',
    base58: '11',
  },
  {
    // "Hello World" in hex
    hex: '48656c6c6f20576f726c64',
    base58: 'JxF12TrwUP45BMd',
  },
  {
    hex: 'ff',
    base58: '5Q',
  },
];

// =============================================================================
// Currency Test Vectors
// =============================================================================

export const CURRENCY_VECTORS = [
  { human: '1', smallestUnit: 1000000000000000000n, decimals: 18 },
  { human: '1.5', smallestUnit: 1500000000000000000n, decimals: 18 },
  { human: '0.000000000000000001', smallestUnit: 1n, decimals: 18 },
  { human: '100', smallestUnit: 100000000n, decimals: 6 },
  { human: '1.23', smallestUnit: 1230000n, decimals: 6 },
  { human: '0', smallestUnit: 0n, decimals: 18 },
];

// =============================================================================
// Private Key Validation Vectors
// =============================================================================

export const PRIVATE_KEY_VECTORS = {
  valid: [
    '0000000000000000000000000000000000000000000000000000000000000001', // min valid
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140', // max valid
    'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
  ],
  invalid: [
    '0000000000000000000000000000000000000000000000000000000000000000', // zero
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', // curve order
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142', // > curve order
    'invalid', // not hex
    'abc', // too short
  ],
};
