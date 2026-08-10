import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import { JsonRpcNetworkError } from '@unicitylabs/state-transition-sdk/lib/api/json-rpc/JsonRpcNetworkError.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { CborSerializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';

const hash = new DataHash(HashAlgorithm.SHA256, new Uint8Array(32));
const tx = { sourceStateHash: hash, lockScript: { toCBOR: () => CborSerializer.encodeByteString(new Uint8Array(4)) }, calculateTransactionHash: async () => hash };
const TIMEOUT = 2_000, INTERVAL = 300;

async function trial() {
  const client = { getInclusionProof: async () => { await new Promise((r) => setTimeout(r, 40 + Math.random() * 260)); throw new JsonRpcNetworkError(404, 'nf'); } };
  return Promise.race([
    waitInclusionProof(client, null, null, tx, AbortSignal.timeout(TIMEOUT), INTERVAL).then(() => 'resolved', (e) => e.name),
    new Promise((r) => setTimeout(() => r('HANG'), TIMEOUT + 3_000)),
  ]);
}
let hang = 0, sleepErr = 0;
for (let i = 0; i < 30; i++) { const o = await trial(); if (o === 'HANG') hang++; else if (o === 'SleepError') sleepErr++; }
console.log(`30 trials (jittered RTT 40-300ms, 300ms poll, 2s deadline): SleepError=${sleepErr}  UNBOUNDED-HANG=${hang}`);
