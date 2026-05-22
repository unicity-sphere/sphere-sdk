# Sphere SDK

**A TypeScript SDK for apps where users hold their own tokens and pay each other by name — no payment backend to build, no custody of anyone's funds.**

[![npm](https://img.shields.io/npm/v/@unicitylabs/sphere-sdk.svg)](https://www.npmjs.com/package/@unicitylabs/sphere-sdk)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

The Sphere SDK gives your app a self‑custody wallet: each user holds their own keys, pays others by `@name`, and every transfer is settled on Unicity's network and backed by cryptographic proof. You get the wallet, transfers, encrypted messaging, and invoicing out of the box — without building or operating a payment backend, and without ever holding users' funds. It runs in the browser and in Node.js.

## Why Sphere SDK

Most apps that move money put a custodial server in the middle: it holds everyone's balances, clears the payments, and can freeze or lose them — and it's yours to build, secure, and keep online.

The Sphere SDK splits those jobs apart:

- **Custody moves to the user.** Their wallet holds its own keys; your app never touches their funds.
- **Settlement moves to Unicity's network** — a shared ledger run across many validator nodes — which records every transfer and lets the recipient verify it cryptographically.

There is still infrastructure doing the clearing (a settlement network, messaging relays, and the base chain), but **you don't run it**, and no single company sits on top of users' balances. Your app just creates a wallet and asks it to do things.

## What you can build

**Send and receive tokens.** Move value between users by `@name` — no account numbers, and no backend of your own to operate.

**Invoices and payment requests.** Ask another user to pay, and track whether they did, automatically.

**Encrypted messaging.** One‑to‑one direct messages and group chat, end‑to‑end encrypted, built in.

**Peer‑to‑peer swaps.** Two users trade one token for another, with an escrow service handling the exchange safely.

**Wallet connections.** Let a web app ask a user's wallet to pay or sign something — without the app ever touching their keys.

> The user holds the keys. The app just asks.

## Install

```bash
npm install @unicitylabs/sphere-sdk
# Node.js also needs a WebSocket library:
npm install @unicitylabs/sphere-sdk ws
```

## Quick start

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
// Node.js: import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// 1. Create a wallet (testnet is for experimenting)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...createBrowserProviders({ network: 'testnet' }),
  autoGenerate: true,   // make a new wallet if one doesn't exist yet
  nametag: 'alice',     // claim @alice (receiving via @name also needs an on-chain mint — see docs/NAMETAGS.md)
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

That is a real transfer between two users — settled on Unicity's network, with no backend of your own required.

> **Getting test tokens.** On testnet you must claim a `@nametag` first, then request from the faucet. See the [Node.js](docs/QUICKSTART-NODEJS.md) and [Browser](docs/QUICKSTART-BROWSER.md) quick‑start guides.

## Core concepts

You only need four ideas to use the Sphere SDK.

- **Token** — a unit of digital value (like `UCT`). A user's wallet can hold many tokens of different kinds.
- **Wallet** — created from a 12‑word *recovery phrase*. The phrase is the only thing a user needs to back up; lose it and the wallet is gone.
- **`@nametag`** — a human‑friendly handle (like `@alice`) that people use to pay or message you. Each wallet can claim one.
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
const r = await sphere.payments.l1!.send({ to: 'alpha1...', amount: '100000' /* in satoshis */ });
```

## Going further

The root README stays short on purpose. Deeper guides live alongside it:

| You want to… | Read |
|---|---|
| Get running in the browser | [docs/QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) |
| Get running in Node.js | [docs/QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) |
| Use `@nametags` (register, recover, troubleshoot) | [docs/NAMETAGS.md](docs/NAMETAGS.md) |
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
- **`@nametag`** — a human‑readable handle for a wallet. Lowercase letters/digits with `-` or `_`, 3–20 characters.
- **Wallet address** — the machine‑readable address behind a `@nametag`. People rarely type it; they use the `@name`.
- **ALPHA coin** — the coin of Unicity's base blockchain. Sent through `sphere.payments.l1`.
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
