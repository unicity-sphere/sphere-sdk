#!/usr/bin/env node
/**
 * smoke-full-stack.mjs — Foundation validation of the local stack.
 *
 * Boots the docker-compose `--profile full` stack (relay + mongo +
 * aggregator + ipfs) and verifies:
 *
 *   1. All four services come up healthy.
 *   2. The aggregator accepts `submit_commitment` directly via
 *      JSON-RPC and returns real Merkle inclusion proofs (block
 *      finalization works in BFT_ENABLED=false standalone mode).
 *   3. The SDK env-override path (`SPHERE_AGGREGATOR_URL`,
 *      `SPHERE_NOSTR_RELAYS`, `SPHERE_IPFS_GATEWAY`,
 *      `SPHERE_ORACLE_SKIP_VERIFICATION`) wires through
 *      `createNodeProviders` correctly and oracle reports skip=true.
 *
 * **NOT validated here** — `Sphere.init({ nametag })` end-to-end.
 * The standalone aggregator emits proofs without a UnicityCertificate
 * field. The SDK's `InclusionProof.fromJSON` deserializer structurally
 * requires that field, so wallet-level mint paths throw
 * `InvalidJsonStructureError` against this stack regardless of
 * `oracle.skipVerification`. Three follow-up paths are tracked in the
 * PR description (full-bft profile, SDK deserializer patch, or
 * aggregator-go emitting a stub cert).
 *
 * Usage:
 *   node tests/e2e/local-infra/smoke-full-stack.mjs
 *
 * Exit codes:
 *   0  — every assertion in scope passed
 *   1  — anything failed; logs explain
 */

import { spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');
const SETUP_SCRIPT = join(__dirname, 'setup-aggregator-src.sh');

const log = (msg) => console.log(`[smoke-full-stack] ${msg}`);

function ensureBftDataDirs() {
  // Pre-create the BFT bind-mount directories with the running
  // user's ownership. Docker would otherwise create them as root on
  // first compose-up, and the BFT containers (which we drop to the
  // host user via USER_UID/USER_GID) can't write into root-owned
  // dirs. mkdirSync from the host process inherits the running
  // user's ownership.
  for (const d of [
    join(__dirname, '.bft-data'),
    join(__dirname, '.bft-data', 'genesis'),
    join(__dirname, '.bft-data', 'genesis-root'),
  ]) {
    spawnSync('mkdir', ['-p', d], { stdio: 'ignore' });
  }
}

function composeEnv() {
  return {
    ...process.env,
    USER_UID: String(process.getuid?.() ?? 1000),
    USER_GID: String(process.getgid?.() ?? 1000),
  };
}

function dockerComposeUp() {
  log('ensuring aggregator-go source…');
  let r = spawnSync('bash', [SETUP_SCRIPT], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 180_000,
  });
  if (r.status !== 0) throw new Error(`setup-aggregator-src.sh failed (exit ${r.status})`);

  ensureBftDataDirs();

  log('booting docker-compose --profile full (relay, mongo, aggregator, ipfs)…');
  r = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'up', '-d'],
    { stdio: 'inherit', timeout: 600_000, env: composeEnv() },
  );
  if (r.status !== 0) throw new Error('docker compose up failed');
}

async function waitForHealth(url, name, { method = 'GET', timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { method, signal: AbortSignal.timeout(2_000) });
      if (resp.ok) {
        log(`${name} ready: ${url}`);
        return;
      }
      lastErr = `HTTP ${resp.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${name} never came up within ${timeoutMs}ms (last: ${lastErr})`);
}

function dockerComposeDown() {
  log('tearing down docker-compose stack…');
  spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'down', '-v'],
    { stdio: 'inherit', timeout: 120_000, env: composeEnv() },
  );
  // Bind-mounted BFT genesis tree isn't removed by `down -v` (named
  // volumes only). Clean via a container so we don't need sudo on
  // host-side rm of root-owned files. CRITICAL: clear CONTENTS only —
  // preserving the bind-mount target dirs themselves. If we rm the
  // dirs, Docker re-creates them as root on next compose-up and the
  // host-user-owned BFT containers fail with "permission denied".
  spawnSync(
    'docker',
    [
      'run', '--rm', '-v',
      `${join(__dirname, '.bft-data')}:/data`,
      'alpine', 'sh', '-c',
      'rm -rf /data/genesis/* /data/genesis/.??* /data/genesis-root/* /data/genesis-root/.??* 2>/dev/null; true',
    ],
    { stdio: 'ignore', timeout: 30_000 },
  );
}

async function runDirectAggregatorProbe() {
  // Direct JSON-RPC submit_commitment + get_inclusion_proof against
  // the local aggregator. This is the lower-level proof: the
  // aggregator-go BFT_ENABLED=false build round-trips real signed
  // commitments and returns real SMT proofs.
  const { randomBytes, createHash } = await import('node:crypto');
  const { secp256k1 } = await import(
    join(SDK_ROOT, 'node_modules', '@noble', 'curves', 'secp256k1.js')
  );

  const SHA256_ALG = new Uint8Array([0x00, 0x00]);
  const sha256 = (b) => Uint8Array.from(createHash('sha256').update(b).digest());
  const imprint = (h) => {
    const o = new Uint8Array(2 + h.length);
    o.set(SHA256_ALG, 0);
    o.set(h, 2);
    return o;
  };
  const toHex = (b) => Buffer.from(b).toString('hex');

  const privateKey = randomBytes(32);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const stateData = sha256(randomBytes(32));
  const stateImprint = imprint(stateData);
  const reqIdInner = sha256(Buffer.concat([publicKey, stateImprint]));
  const requestIdImprint = imprint(reqIdInner);
  const txData = sha256(randomBytes(32));
  const txImprint = imprint(txData);
  // Aggregator wire format: `r || s || recovery` (65 bytes; recovery
  // byte at index 64). @noble/curves API drifted between 1.x and 2.x:
  //   - 1.x:  sign(...) returns { toCompactRawBytes(), recovery } —
  //           we build the wire manually.
  //   - 2.x:  sign(..., { format: 'recovered' }) returns a 65-byte
  //           Uint8Array, but with the recovery byte at INDEX 0
  //           (recovery-first ordering). We swap to the aggregator's
  //           expected layout.
  const sigOut = secp256k1.sign(txData, privateKey, { format: 'recovered', prehash: false });
  let sigWire;
  if (sigOut instanceof Uint8Array) {
    // v2: byte 0 is recovery; bytes 1..64 are r||s. Move recovery to end.
    sigWire = new Uint8Array(65);
    sigWire.set(sigOut.subarray(1), 0); // r||s -> bytes 0..63
    sigWire[64] = sigOut[0];             // recovery -> byte 64
  } else {
    sigWire = new Uint8Array(65);
    sigWire.set(sigOut.toCompactRawBytes(), 0);
    sigWire[64] = sigOut.recovery;
  }

  log('submitting commitment to local aggregator…');
  const submitResp = await fetch('http://127.0.0.1:3001/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'submit_commitment',
      params: {
        requestId: toHex(requestIdImprint),
        transactionHash: toHex(txImprint),
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: toHex(publicKey),
          signature: toHex(sigWire),
          stateHash: toHex(stateImprint),
        },
        receipt: false,
      },
    }),
  });
  const submitText = await submitResp.text();
  const submitJson = JSON.parse(submitText);
  if (submitJson.result?.status !== 'SUCCESS') {
    throw new Error(`submit_commitment did not return SUCCESS: ${submitText}`);
  }
  log(`✓ submit_commitment → SUCCESS`);

  log('waiting ~2s for block finalization…');
  await new Promise((r) => setTimeout(r, 2500));

  log('fetching inclusion proof…');
  const proofResp = await fetch('http://127.0.0.1:3001/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'get_inclusion_proof',
      params: { requestId: toHex(requestIdImprint) },
    }),
  });
  const proofJson = await proofResp.json();
  if (!proofJson.result?.merkleTreePath?.root) {
    throw new Error(`get_inclusion_proof returned no Merkle root: ${JSON.stringify(proofJson)}`);
  }
  log(`✓ get_inclusion_proof → root=${proofJson.result.merkleTreePath.root.slice(0, 24)}…, steps=${proofJson.result.merkleTreePath.steps.length}`);
}

async function runSdkProviderSmoke() {
  // Verify the SDK env-override path threads through. We do NOT call
  // Sphere.init({ nametag }) here — see file-level docstring for the
  // SDK deserializer / UnicityCertificate limitation. This smoke
  // validates everything UP TO the wallet-level mint flow.
  process.env.SPHERE_AGGREGATOR_URL = 'http://127.0.0.1:3001';
  process.env.SPHERE_ORACLE_SKIP_VERIFICATION = '1';
  process.env.SPHERE_NOSTR_RELAYS = 'ws://127.0.0.1:7777';
  process.env.SPHERE_IPFS_GATEWAY = 'http://127.0.0.1:8082';

  const dataDir = mkdtempSync(join(tmpdir(), 'sphere-smoke-'));
  try {
    log(`wallet data dir: ${dataDir}`);

    const implNodePath = join(SDK_ROOT, 'dist', 'impl', 'nodejs', 'index.js');
    const { createNodeProviders } = await import(implNodePath);

    log('creating providers with SPHERE_* env overrides…');
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir,
      tokensDir: join(dataDir, 'tokens'),
    });
    if (!providers.transport) throw new Error('createNodeProviders returned no transport');
    if (!providers.oracle) throw new Error('createNodeProviders returned no oracle');
    if (!providers.storage) throw new Error('createNodeProviders returned no storage');
    log('✓ providers instantiated (transport, oracle, storage)');

    // Initialize the oracle so the trust-base loader runs (or is
    // skipped due to skipVerification:true), then verify the
    // skipVerification accessor reports the expected state.
    if (typeof providers.oracle.initialize === 'function') {
      await providers.oracle.initialize();
    }
    const skipsVerification = providers.oracle.getSkipVerification?.() === true;
    const trustBase = providers.oracle.getTrustBase?.();
    if (!skipsVerification) {
      throw new Error(
        'SPHERE_ORACLE_SKIP_VERIFICATION env override did not flow through to oracle.getSkipVerification()',
      );
    }
    if (trustBase !== null) {
      throw new Error(
        'expected oracle.getTrustBase() === null when skipVerification is on, got ' + String(trustBase),
      );
    }
    log('✓ oracle.getSkipVerification() === true, oracle.getTrustBase() === null');
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

let teardownNeeded = false;
let exitCode = 0;

try {
  dockerComposeUp();
  teardownNeeded = true;

  // Wait for each service to be healthy before driving the SDK.
  // Aggregator first — block production needs ~1s after the first
  // request lands to actually create a proof.
  await waitForHealth('http://127.0.0.1:3001/health', 'aggregator', { timeoutMs: 180_000 });
  await waitForHealth('http://127.0.0.1:7777', 'nostr-relay', { timeoutMs: 60_000 });
  // Kubo's API server is POST-only on /api/v0/* — GET returns 405 even
  // when the daemon is up. Probe the API (POST /api/v0/version) which
  // returns 200 + JSON when ready. The gateway port (8082) and API
  // port (5002) come up together; either being live is sufficient
  // proof the daemon is fully initialized.
  await waitForHealth('http://127.0.0.1:5002/api/v0/version', 'ipfs-api', { method: 'POST', timeoutMs: 60_000 });

  await runDirectAggregatorProbe();
  await runSdkProviderSmoke();
  log('=== SMOKE PASSED ===');
  log('NOTE: Sphere.init({ nametag }) is NOT validated here — see file-level');
  log('      docstring for the UnicityCertificate deserializer limitation.');
} catch (err) {
  log(`=== SMOKE FAILED: ${err.message} ===`);
  // Surface the full stack to aid diagnosis of where in the SDK the
  // failure originates (most "Invalid JSON structure" failures come
  // from Token.fromJSON deep in the mint path; the stack pinpoints
  // which call site triggered it).
  if (err.stack) {
    log('stack trace:');
    for (const line of err.stack.split('\n')) log('  ' + line);
  }
  exitCode = 1;
} finally {
  if (teardownNeeded) {
    dockerComposeDown();
  }
}

process.exit(exitCode);
