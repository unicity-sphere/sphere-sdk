# Sphere SDK
[![npm](https://img.shields.io/npm/v/@unicitylabs/sphere-sdk.svg)](https://www.npmjs.com/package/@unicitylabs/sphere-sdk)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

The SDK for **autonomous economic agents**. Give an agent an identity, a wallet, and the ability to find, negotiate with, and settle with other agents — peer-to-peer, with perfect privacy and ultra-fast finality.

An agent using Sphere can hold value, discover a counterparty, message them, trade with them atomically, and invoice and settle - all over peer-to-peer rails where assets are self-contained bearer objects that move directly between parties, carrying their own proof of validity. No broadcast, no mempool, no gas auction.
It runs the same way in a browser, in Node.js, and on the command line. 


---


## Install

```bash
npm install @unicitylabs/sphere-sdk
# Node.js also needs a WebSocket library:
npm install @unicitylabs/sphere-sdk ws
```

## Why it's built this way
On Unicity, assets aren't rows in a global database that validators take turns updating. They're self-contained cryptographic objects — bearer instruments — that carry their own history and validity proofs and move directly between two parties.

That property is what makes agent-to-agent commerce practical. An autonomous agent can't wait on block space or pay a gas auction for every micro-interaction, and it can't depend on a trusted indexer to know whether it got paid — the proof of the transfer is the payment. Sphere is the client-side toolkit that turns that substrate into the things an agent actually needs: identity, discovery, messaging, trade, and settlement.

## What you can build with it

| Capability | Module | What it gives your agent |
| --- | --- | --- |
| **Identity** | `identity` | A cryptographic identity (`@nametag` + secp256k1 keypair)  — HD multi-address, one nametag per address |
| **Payments** | `payments` | Send and receive bearer tokens  |
| **Payment requests** | `payments` | Request money from a counterparty and track the response asynchronously |
| **Invoicing & settlement** | `accounting` | Issue invoices, take payment, and process returns — the bill-and-collect half of commerce |
| **Discovery** | `market` | Post an intent to transact and search for matching counterparties — how agents *find* each other |
| **Atomic swaps** | `swap` | Trade peer-to-peer with signed swap manifests and nametag bindings — settle a two-sided deal without a trusted middleman |
| **Direct messaging** | `communications` | P2P direct messages and broadcasts over Nostr (NIP-04 encryption) |
| **Group chat** | `groupChat` | NIP-29 relay-based group messaging with roles and moderation |
| **Token backup** | token sync | Decentralized sync to IPFS/IPNS, browser and Node.js |
| **dApp ↔ wallet** | Connect | `ConnectClient` / `ConnectHost` for browser-extension integration |





## Quick start

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
// Node.js: import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// 1. Create a wallet (testnet is for experimenting)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...createBrowserProviders({ network: 'testnet' }),
  autoGenerate: true,   // make a new wallet if one doesn't exist yet
  nametag: 'alice',     // claim the Unicity ID @alice (receiving via @alice also needs an on-chain mint — see docs/UNICITY-ID.md)
});

// 2. First run? Show the user their recovery phrase to back up.
if (created && generatedMnemonic) {
  console.log('Save this recovery phrase:', generatedMnemonic);
}

// 3. Who am I?
console.log('My handle: @' + sphere.identity?.nametag);

// 4. Send 1,000,000 base units to @bob (= 1 UCT when the token has 6 decimals)
await sphere.payments.send({
  recipient: '@bob',
  coinId: 'UCT',       // which token to send
  amount: '1000000',   // amount in the token's smallest unit, written as a string
});
```

That is a real transfer between two users — verified cryptographically, with no backend of your own required.

> **Getting test tokens.** On testnet you must claim a Unicity ID first, then request from the faucet. See the [Node.js](docs/QUICKSTART-NODEJS.md) and [Browser](docs/QUICKSTART-BROWSER.md) quick‑start guides.

## Core concepts

You only need four ideas to use the Sphere SDK.

- **Token** — a unit of digital value (like `UCT`). A user's wallet can hold many tokens of different kinds.
- **Wallet** — created from a 12‑word *recovery phrase*. The phrase is the only thing a user needs to back up; lose it and the wallet is gone.
- **Unicity ID** — a human‑friendly handle (like `@alice`) that people use to pay or message you. Each wallet can claim one. (In the SDK's API this is the `nametag`.)
- **Network** — `testnet` for building and experimenting, `mainnet` for real value. Pick one when you create the wallet; everything else is configured for you.

That's enough to send and receive. Everything below is built on top of these.

## Common tasks

**Send tokens**
```typescript
await sphere.payments.send({ recipient: '@bob', coinId: 'UCT', amount: '1000000' });
```

**Check balances and holdings**
```typescript
const assets  = await sphere.payments.getAssets();      // grouped by token, with prices if enabled
const tokens  = sphere.payments.getTokens();            // individual tokens
const balance = sphere.payments.getBalance();           // Asset[] breakdown (synchronous)
const usd     = await sphere.payments.getFiatBalance(); // total in USD, or null if prices are off
```

**Receive tokens**
```typescript
await sphere.payments.receive();                     // pull anything sent to you

sphere.on('transfer:incoming', (t) => {
  console.log(`Got ${t.tokens.length} token(s) from ${t.senderNametag ?? t.senderPubkey}`);
});
```

**Request a payment from someone**
```typescript
const req = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000', coinId: 'UCT', message: 'Invoice #1234',
});
const res = await sphere.payments.waitForPaymentResponse(req.requestId!, 120000);
```

**Send a direct message**
```typescript
await sphere.communications.sendDM('@alice', 'Hello!');
sphere.communications.onDirectMessage((m) => console.log(m.senderNametag, m.content));
```

**Send the ALPHA coin** (Unicity's base‑chain coin)
```typescript
```

## Going further

The root README stays short on purpose. Deeper guides live alongside it:

| You want to… | Read |
|---|---|
| Get running in the browser | [docs/QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) |
| Get running in Node.js | [docs/QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) |
| Use Unicity IDs (register, recover, troubleshoot) | [docs/UNICITY-ID.md](docs/UNICITY-ID.md) |
| Request payments from others | [docs/PAYMENT-REQUESTS.md](docs/PAYMENT-REQUESTS.md) |
| Send encrypted direct messages | [docs/DIRECT-MESSAGES.md](docs/DIRECT-MESSAGES.md) |
| Run group chat | [docs/GROUP-CHAT.md](docs/GROUP-CHAT.md) |
| Send the ALPHA coin | [docs/L1-ALPHA.md](docs/L1-ALPHA.md) |
| Use multiple addresses per wallet | [docs/MULTI-ADDRESS.md](docs/MULTI-ADDRESS.md) |
| Configure providers, networks, prices, relays | [docs/PROVIDERS-AND-CONFIG.md](docs/PROVIDERS-AND-CONFIG.md) |
| Import/export wallets and recover legacy files | [docs/WALLET-IMPORT-EXPORT.md](docs/WALLET-IMPORT-EXPORT.md) |
| Derive keys / sign messages directly (low‑level) | [docs/IDENTITY-CRYPTO.md](docs/IDENTITY-CRYPTO.md) |
| Let a dApp connect to a wallet | [docs/CONNECT.md](docs/CONNECT.md) |
| Invoicing and token swaps | [docs/API.md](docs/API.md) |
| Full API reference | [docs/API.md](docs/API.md) |
| Understand how it actually works under the hood | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Back up tokens to IPFS | [docs/IPFS-STORAGE.md](docs/IPFS-STORAGE.md) |

There is also a command‑line tool in a separate package, [`@unicity-sphere/cli`](https://github.com/unicity-sphere/sphere-cli).

## Glossary

- **Recovery phrase (mnemonic)** — 12 words that *are* the wallet. Back them up; never share them.
- **Token** — a unit of digital value held in a wallet (e.g. `UCT`).
- **Unicity ID** — a human‑readable handle for a wallet (e.g. `@alice`). Lowercase letters/digits with `-` or `_`, 3–20 characters. Called `nametag` in the SDK's API.
- **Wallet address** — the machine‑readable address behind a Unicity ID. People rarely type it; they use the handle (e.g. `@alice`).
- **Smallest unit** — token amounts are integers in the token's smallest denomination, passed as strings (so `"1000000"`, not `1.0`).
- **Provider** — a pluggable backend (storage, messaging, etc.). `createBrowserProviders()` / `createNodeProviders()` set these up for you.
- **Network** — `testnet` (free, for building) or `mainnet` (real value).

## Platforms

| Platform | Storage | Notes |
|---|---|---|
| Browser | IndexedDB | Native WebSocket; may need `Buffer`/`process` polyfills — see [bundling notes](docs/PROVIDERS-AND-CONFIG.md#browser-bundling) |
| Node.js | Files | Requires the `ws` package |

## License

MIT
