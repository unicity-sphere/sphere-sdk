/**
 * Smoke test: mint a fresh coin token on testnet2 via the v2 token-engine.
 *
 * Purpose: quickest possible signal that the Phase-6 v1→v2 migration
 * actually talks to gateway.testnet2.unicity.network and produces a
 * verifiable token. Bypasses Sphere.ts entirely — constructs
 * SphereTokenEngine directly — so a wiring gap in the facade doesn't
 * mask a real network/auth problem.
 *
 * Run:
 *   npx tsx scripts/smoke-testnet2-mint.ts
 *
 * Env:
 *   TESTNET2_API_KEY — gateway API key (optional; a warning fires if unset
 *                      and the gateway may reject unauthenticated requests)
 *   SMOKE_PRIVKEY   — 64-hex secp256k1 privkey (optional; else a fresh
 *                      random key is generated per run)
 *
 * Exit code: 0 on success, non-zero on any failure. Diagnostic output
 * printed to stderr; the minted token's opaque handle summary to stdout.
 */

import { randomBytes } from 'node:crypto';
import {
  TESTNET2_GATEWAY_URL,
  TESTNET2_TRUST_BASE_URL,
} from '../constants';
import { createSphereTokenEngine } from '../token-engine';
import type { CoinId, EngineIdentity } from '../token-engine';

const UCT_COIN_ID = 'UCT' as CoinId;
const MINT_AMOUNT = BigInt(1000);

function log(step: string, detail?: unknown): void {
  const suffix = detail !== undefined ? ` — ${JSON.stringify(detail)}` : '';
  process.stderr.write(`[smoke] ${step}${suffix}\n`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeHex(hexStr: string): Uint8Array {
  if (hexStr.length % 2 !== 0) throw new Error(`odd-length hex: ${hexStr.length} chars`);
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function main(): Promise<void> {
  log('start', { gateway: TESTNET2_GATEWAY_URL, trustBaseUrl: TESTNET2_TRUST_BASE_URL });

  const apiKey = process.env.TESTNET2_API_KEY;
  if (!apiKey) {
    log('WARN: TESTNET2_API_KEY is unset — gateway may reject requests');
  } else {
    log('apiKey', { length: apiKey.length });
  }

  const privkeyHex = process.env.SMOKE_PRIVKEY ?? hex(randomBytes(32));
  const privateKey = decodeHex(privkeyHex);
  if (privateKey.length !== 32) throw new Error(`privkey must be 32 bytes, got ${privateKey.length}`);
  log('privateKey', { source: process.env.SMOKE_PRIVKEY ? 'env' : 'random', bytes: privateKey.length });

  // Step 1: fetch trust base
  log('fetching trust base');
  const trustBaseResp = await fetch(TESTNET2_TRUST_BASE_URL);
  if (!trustBaseResp.ok) {
    throw new Error(`trust base fetch ${trustBaseResp.status} ${trustBaseResp.statusText}`);
  }
  const trustBaseJson: unknown = await trustBaseResp.json();
  log('trust base loaded', {
    // narrow to the well-known fields without importing the SDK type here
    networkId: (trustBaseJson as { networkId?: number }).networkId,
    version: (trustBaseJson as { version?: number }).version,
  });

  // Step 2: construct the engine
  log('constructing SphereTokenEngine');
  const engine = await createSphereTokenEngine({
    aggregatorUrl: TESTNET2_GATEWAY_URL,
    apiKey,
    privateKey,
    trustBaseJson,
  });
  const identity: EngineIdentity = engine.getIdentity();
  log('engine ready', {
    chainPubkey: hex(identity.chainPubkey),
  });

  // Step 3: derive the DIRECT address (sanity)
  const directAddress = await engine.deriveIdentityAddress();
  log('DIRECT address', { address: directAddress });

  // Step 4: mint a UCT coin token to self
  log('minting', { coinId: UCT_COIN_ID, amount: MINT_AMOUNT.toString() });
  const t0 = Date.now();
  const minted = await engine.mint({
    recipientPubkey: identity.chainPubkey,
    value: {
      assets: [{ coinId: UCT_COIN_ID, amount: MINT_AMOUNT }],
    },
  });
  log('minted', {
    ms: Date.now() - t0,
    tokenId: engine.tokenId(minted),
    balance: engine.balanceOf(minted, UCT_COIN_ID).toString(),
  });

  // Step 5: verify the minted token round-trips
  log('verifying');
  const verifyResult = await engine.verify(minted);
  log('verify result', verifyResult);

  const isOwned = engine.isOwnedBy(minted, identity.chainPubkey);
  log('isOwnedBy', { owned: isOwned });

  if (!isOwned) {
    throw new Error('minted token is not owned by our identity — engine bug or migration error');
  }

  // Step 6: encode + decode round-trip
  const blob = engine.encodeToken(minted);
  const decoded = await engine.decodeToken(blob);
  log('encode/decode round-trip', {
    encodedBytes: blob.token.length,
    network: blob.network,
    blobVersion: blob.v,
    decodedTokenId: engine.tokenId(decoded),
    idsMatch: engine.tokenId(minted) === engine.tokenId(decoded),
  });

  log('SMOKE PASSED');
  process.stdout.write(
    JSON.stringify(
      {
        result: 'PASSED',
        gateway: TESTNET2_GATEWAY_URL,
        chainPubkey: hex(identity.chainPubkey),
        directAddress,
        tokenId: engine.tokenId(minted),
        balance: engine.balanceOf(minted, UCT_COIN_ID).toString(),
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  log('SMOKE FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  process.exit(1);
});
