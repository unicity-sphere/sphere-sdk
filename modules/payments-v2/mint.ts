import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex } from '../../core/crypto';
import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';
import type { SphereToken } from '../../token-engine/types';

import type { MintResult } from './api';
import type { RecordMintInput } from './history/History';
import { messageOf } from './machine/payload';
import { mintParams } from './mint-params';
import type { ListStore } from './machine/journal';
import type { MintJournalEntry } from './stores';
import type { StoragePort } from './ports';

/** Everything the journal-first mint needs, injected so the path stays testable. */
export interface MintDeps {
  readonly engine: ITokenEngine;
  readonly mintJournal: ListStore<MintJournalEntry>;
  readonly storagePort: Pick<StoragePort, 'uploadBlobs' | 'applyDelta'>;
  readonly recordMint: (input: RecordMintInput) => Promise<void>;
  readonly armHeartbeat: () => void;
  readonly noteHeldState: (tokenId: string, stateHash: string) => void;
  readonly refreshView: () => void;
  readonly ownPubkeyBytes: Uint8Array;
  readonly now: () => number;
}

/**
 * Journal-first self-mint: the entry is durable BEFORE the chain op, so a crash
 * converges by the F13 same-seed re-call rather than minting twice.
 */
export function runMintUnderJournal(
  deps: MintDeps,
  input: { mintId: string; coinId: string; amount: bigint }
): Promise<MintResult> {
  return mintUnderJournal(deps, input);
}

async function mintUnderJournal(
deps: MintDeps,
input: { mintId: string; coinId: string; amount: bigint }
): Promise<MintResult> {
const { mintId, coinId, amount } = input;
const engine = deps.engine;
  // tokenId stays '' until mint returns; replay converges via the F13 same-seed re-call.
  const entry: MintJournalEntry = {
    mintId,
    coinId,
    amount: amount.toString(),
    tokenId: '',
    createdAt: deps.now(),
  };
  await deps.mintJournal.upsert(entry);
  let token: SphereToken;
  try {
    token = await engine.mint(mintParams(deps.ownPubkeyBytes, coinId, amount), { transferId: mintId });
  } catch (err) {
    // Entry retained: the heartbeat / start() replay resolves it (inventory check / F13 seed).
    deps.armHeartbeat();
    return { success: false, error: messageOf(err) };
  }
  if (token.blob.tokenId !== entry.tokenId) {
    await deps.mintJournal.upsert({ ...entry, tokenId: token.blob.tokenId });
  }
  try {
    await finalizeMint(deps, mintId, token, coinId, amount.toString());
  } catch (err) {
    deps.armHeartbeat();
    return { success: false, tokenId: token.blob.tokenId, error: messageOf(err) };
  }
  return { success: true, tokenId: token.blob.tokenId };
}

export async function finalizeMint(
deps: MintDeps,
mintId: string,
token: SphereToken,
coinId: string,
amount: string
): Promise<void> {
const engine = deps.engine;
  const bytes = token.blob.token;
  const digest = bytesToHex(sha256(bytes));
  const keys = await deps.storagePort.uploadBlobs([{ sha256: digest, bytes }]);
  const key = keys.get(digest);
  if (key === undefined) {
    throw new SphereError(`no upload key returned for mint blob ${digest}`, 'STORAGE_ERROR');
  }
  await deps.storagePort.applyDelta({
    transferId: mintId,
    spent: [],
    added: [{ tokenId: token.blob.tokenId, key }],
  });
  await deps.recordMint({
    tokenId: token.blob.tokenId,
    assets: [{ coinId, amount }],
  });
  await deps.mintJournal.removeByKey(mintId);
  deps.noteHeldState(token.blob.tokenId, (await engine.deliveryKeys(bytes)).stateHash);
  deps.refreshView();
}
