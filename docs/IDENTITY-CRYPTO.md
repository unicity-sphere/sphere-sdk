# Identity & Crypto (low‑level)

> **Audience:** developers working *below* the `Sphere` facade — deriving keys directly, signing messages for backend auth, or minting custom tokens. If you only call `sphere.payments` / `sphere.communications`, you don't need this.

These helpers are exported from the package root (`@unicitylabs/sphere-sdk`).

## ⚠️ Two keypairs: raw vs. hashed

This is the single most important thing to know, and the easiest to get wrong.

The token engine's `SigningService.createFromSecret(secret)` **SHA‑256‑hashes the secret before using it.** So a wallet's private key produces *two different* secp256k1 keypairs depending on how you use it:

| Use the key… | How | Public key | Used for |
|---|---|---|---|
| **Raw** | `getPublicKey(privKey)` / `new SigningService(privKey)` | `chainPubkey` | messaging/transport identity, Unicity-ID binding, `signMessage`, ALPHA address |
| **Hashed** | `SigningService.createFromSecret(privKey)` | different point | the `DIRECT://` token address, token ownership, token signatures |

```typescript
import { getPublicKey } from '@unicitylabs/sphere-sdk';

const raw  = getPublicKey(privKeyHex);                          // == identity.chainPubkey
// token key = SigningService.createFromSecret(privKeyBytes).publicKey  // ≠ raw

// The wallet's DIRECT:// address is derived from the HASHED key (createFromSecret),
// NOT from chainPubkey. Using `new SigningService(privKey)` (raw) will NOT match it.
```

If you mint or transfer tokens by hand, build the signer with `createFromSecret`. If you verify a `signMessage` signature or resolve a peer, use the raw `chainPubkey`.

## Mnemonic → keys

```typescript
import {
  generateMnemonic, validateMnemonic,
  identityFromMnemonicSync,   // async variant: identityFromMnemonic
  generateMasterKey, deriveKeyAtPath,
  getPublicKey, createKeyPair,
} from '@unicitylabs/sphere-sdk';

const mnemonic = generateMnemonic();                 // 12 words (or generateMnemonic(256) for 24)
validateMnemonic(mnemonic);                          // boolean

const master = identityFromMnemonicSync(mnemonic);   // { privateKey, chainCode } (BIP-32 root)

// Derive a key at a path (BIP-32; default base m/44'/0'/0')
const child = deriveKeyAtPath(master.privateKey, master.chainCode, "m/44'/0'/0'/0/0");

const pub = getPublicKey(child.privateKey);          // 33-byte compressed (chainPubkey form)
const kp  = createKeyPair(child.privateKey);         // { privateKey, publicKey }
```

### Legacy (non‑BIP32) derivation

For wallets imported from older formats that derive addresses by HMAC rather than BIP‑32:

```typescript
import { generateAddressFromMasterKey } from '@unicitylabs/sphere-sdk';
const addr0 = generateAddressFromMasterKey(masterPrivateKeyHex, 0);
```

This corresponds to `derivationMode: 'wif_hmac' | 'legacy_hmac'` in `Sphere.import` (see [WALLET-IMPORT-EXPORT.md](WALLET-IMPORT-EXPORT.md)).

## Message signing (backend auth)

Bitcoin‑style signed messages over the **raw** key, useful for proving "this request came from the holder of `@alice`" without trusting a client‑supplied identifier.

```typescript
import { signMessage, verifySignedMessage, recoverPubkeyFromSignature } from '@unicitylabs/sphere-sdk';

const sig = signMessage(privKeyHex, 'login: 2026-05-22');     // 130-hex string: v(2) + r(64) + s(64)

verifySignedMessage('login: 2026-05-22', sig, expectedChainPubkey);   // boolean

// Identify the signer without knowing them up front, then resolve who they are:
const pubkey = recoverPubkeyFromSignature('login: 2026-05-22', sig);   // 66-hex compressed
const peer   = await sphere.resolve(pubkey);                            // → @alice (Unicity ID), addresses
```

- The hash is `SHA-256(SHA-256(varint(prefix) + "Sphere Signed Message:\n" + varint(msg) + msg))`.
- The recovery byte `v = 31 + recoveryParam`.
- The recovered/expected public key is the **raw** `chainPubkey` (not the hashed token key).
