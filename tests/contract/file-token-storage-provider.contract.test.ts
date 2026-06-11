/**
 * S7: the existing local whole-blob provider (FileTokenStorageProvider) passes
 * the shared storage-provider contract via the default whole-blob adapters
 * (storage/whole-blob-inventory-adapter.ts) — the S2 port extension keeps
 * existing providers conformant, preserving swappability (covenant §3.1-6).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { FullIdentity } from '../../types';
import { buildTxfData, testIdentity } from '../support/wallet-api-test-helpers';
import { describeStorageProviderContract } from './storage-provider.contract';

describeStorageProviderContract('FileTokenStorageProvider (default whole-blob adapters)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-storage-contract-'));
  const identity = testIdentity(1);
  const provider = new FileTokenStorageProvider({ tokensDir: dir });
  provider.setIdentity({
    privateKey: identity.privateKey,
    chainPubkey: identity.chainPubkey,
    l1Address: 'alpha1contracttest',
  } as FullIdentity);
  await provider.initialize();

  return {
    provider,
    async seed(tokens) {
      const result = await provider.save(buildTxfData(tokens));
      if (!result.success) throw new Error(`seed failed: ${result.error}`);
    },
    async cleanup() {
      await provider.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
});
