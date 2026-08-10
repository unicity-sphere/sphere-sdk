import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import { JsonRpcNetworkError } from '@unicitylabs/state-transition-sdk/lib/api/json-rpc/JsonRpcNetworkError.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { CborSerializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';

const hash = new DataHash(HashAlgorithm.SHA256, new Uint8Array(32));
const tx = {
  sourceStateHash: hash,
  lockScript: { toCBOR: () => CborSerializer.encodeByteString(new Uint8Array(4)) },
  calculateTransactionHash: async () => hash,
};

async function run(rttMs, timeoutMs = 10_000, interval = 300) {
  let polls = 0;
  const client = {
    getInclusionProof: async () => {
      polls++;
      await new Promise((r) => setTimeout(r, rttMs));
      throw new JsonRpcNetworkError(404, 'not found'); // the ONLY poll failure the loop tolerates
    },
  };
  const t0 = Date.now();
  const outcome = await Promise.race([
    waitInclusionProof(client, null, null, tx, AbortSignal.timeout(timeoutMs), interval)
      .then(() => 'resolved', (e) => `threw ${e.name}: ${String(e.message).slice(0, 40)}`),
    new Promise((r) => setTimeout(() => r('STILL POLLING — deadline lost (hang)'), timeoutMs + 4_000)),
  ]);
  console.log(`rtt=${String(rttMs).padStart(4)}ms polls=${String(polls).padStart(3)} elapsed=${String(Date.now()-t0).padStart(5)}ms -> ${outcome}`);
  return outcome;
}

let hangs = 0, n = 0;
for (const rtt of [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300]) {
  n++; if ((await run(rtt)) !== 'resolved' && (await Promise.resolve(0), false)) {}
}
