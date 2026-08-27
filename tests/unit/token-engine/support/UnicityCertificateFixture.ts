/**
 * VENDORED (test-only) from @unicitylabs/state-transition-sdk
 * tests/utils/UnicityCertificateFixture.ts. Copied with imports re-pointed at
 * the installed lib/ (the package ships only lib/, not tests/). Faithful
 * relocation, not reimplemented logic — orchestrates installed SDK classes to
 * build a single-node BFT unicity certificate for the in-memory aggregator.
 *
 * `timestamp` is ours, not upstream's. v3 verification rejects a leaf whose
 * reference time postdates the round that certified it
 * (REFERENCE_TIME_AFTER_ROUND), so a certificate stuck at `0n` fails every
 * proof the moment the aggregator records a non-zero reference time. The
 * caller supplies the round's own clock; TestAggregatorClient passes its
 * current reference time.
 */

import { numberToBytesBE } from '@noble/curves/utils.js';

import { InputRecord } from '@unicitylabs/state-transition-sdk/lib/api/bft/InputRecord.js';
import { ShardId } from '@unicitylabs/state-transition-sdk/lib/api/bft/ShardId.js';
import { ShardTreeCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/ShardTreeCertificate.js';
import { UnicityCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicityCertificate.js';
import { UnicitySeal } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicitySeal.js';
import { UnicityTreeCertificate } from '@unicitylabs/state-transition-sdk/lib/api/bft/UnicityTreeCertificate.js';
import { NetworkId } from '@unicitylabs/state-transition-sdk/lib/api/NetworkId.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { CborSerializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';

export async function createUnicityCertificate(
  rootHash: DataHash,
  signingService: SigningService,
  timestamp = 0n,
): Promise<UnicityCertificate> {
  const inputRecord = new InputRecord(0n, 0n, null, rootHash.data, new Uint8Array(0), timestamp, null, 0n, null);
  const technicalRecordHash = null;
  const shardConfigurationHash = new Uint8Array(32);
  const shardTreeCertificate = new ShardTreeCertificate(ShardId.decode(new Uint8Array([0b10000000])), []);

  const shardTreeCertificateRootHash = await UnicityCertificate.calculateShardTreeCertificateRootHash(
    inputRecord,
    technicalRecordHash,
    shardConfigurationHash,
    shardTreeCertificate,
  );

  const partitionIdentifier = 0n;

  const key = numberToBytesBE(partitionIdentifier, 4);
  const shardTreeCertificateRootCborHash = await new DataHasher(HashAlgorithm.SHA256)
    .update(CborSerializer.encodeByteString(shardTreeCertificateRootHash.data))
    .digest();

  const unicitySealHash = await new DataHasher(HashAlgorithm.SHA256)
    .update(CborSerializer.encodeByteString(new Uint8Array([0x01])))
    .update(CborSerializer.encodeByteString(key))
    .update(CborSerializer.encodeByteString(shardTreeCertificateRootCborHash.data))
    .digest();

  const seal = await UnicitySeal.create(
    NetworkId.LOCAL,
    0n,
    0n,
    timestamp,
    null,
    unicitySealHash.data,
    new Map([['NODE', signingService]]),
  );

  return new UnicityCertificate(
    inputRecord,
    technicalRecordHash,
    shardConfigurationHash,
    shardTreeCertificate,
    new UnicityTreeCertificate(partitionIdentifier, []),
    seal,
  );
}
