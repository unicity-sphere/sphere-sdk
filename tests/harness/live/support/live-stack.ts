/**
 * tests/harness/live/support/live-stack.ts — the S5 LIVE stack contract.
 *
 * Same backend surface as the phase-2 harness (the wallet-api compose stack on
 * loopback), but the aggregator is the REAL testnet2 gateway and the trustbase
 * is the REAL pinned testnet2 root (the backend boots with the same pins via
 * wallet-api's docker-compose.live.yml override — see that repo's
 * development-workflow.md).
 *
 * The gateway API key lives in the wallet-api checkout's gitignored `.env`
 * (`AGGREGATOR_KEY`). It is read here at runtime, handed to engines/child
 * runners via process env, and NEVER logged, committed, or echoed — error
 * messages name missing KEYS only, never values.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { stackFromEnv, walletApiDir, type HarnessStack } from '../../support/stack';

const DEFAULT_AGGREGATOR_URL = 'https://gateway.testnet2.unicity.network';
const DEFAULT_TRUSTBASE_URL =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet2.json';

/** Node's own dotenv parser (handles inline comments/quoting exactly like --env-file). */
function parseEnvFile(path: string): Record<string, string> {
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * Resolve the live stack, exporting HARNESS_LIVE_* into this process's env so
 * spawned child runners (the crash drill) rebuild the same stack through the
 * standard `stackFromEnv()`. Idempotent — safe to call from every suite file
 * and from the global setup.
 */
export function liveStackFromEnv(): HarnessStack {
  if (!process.env.HARNESS_LIVE_AGGREGATOR_URL) {
    const envPath = resolve(walletApiDir(), '.env');
    let vars: Record<string, string>;
    try {
      vars = parseEnvFile(envPath);
    } catch {
      throw new Error(
        `live e2e needs the wallet-api .env at ${envPath} (it carries AGGREGATOR_KEY — ` +
          'see wallet-api/development-workflow.md). This suite is LOCAL-ONLY.'
      );
    }
    if (!vars.AGGREGATOR_KEY) {
      throw new Error(`live e2e: AGGREGATOR_KEY is missing from ${envPath} — populate it (value never logged).`);
    }
    process.env.HARNESS_LIVE_AGGREGATOR_URL = vars.AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL;
    process.env.HARNESS_LIVE_TRUSTBASE_URL = vars.TRUSTBASE_URL || DEFAULT_TRUSTBASE_URL;
    process.env.HARNESS_LIVE_AGGREGATOR_KEY = vars.AGGREGATOR_KEY;
  }
  return stackFromEnv();
}
