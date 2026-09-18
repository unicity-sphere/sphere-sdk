import { bytesToHex, hexToBytes } from '../../core/crypto';
import { SphereError } from '../../core/errors';

import type { MintCustomRequest, MintResult } from './api';
import type { ListStore } from './machine/journal';
import { messageOf } from './machine/payload';
import { finalizeMint, type FinalizeMintDeps, type MintReplayDeps } from './mint';
import type { CustomMintJournalEntry } from './stores';

export interface CustomMintDeps extends FinalizeMintDeps {
  readonly customMintJournal: ListStore<CustomMintJournalEntry>;
  readonly armHeartbeat: () => void;
  readonly ownPubkeyBytes: Uint8Array;
  readonly now: () => number;
}

export type CustomReplayDeps = CustomMintDeps & MintReplayDeps;

const HEX32 = /^[0-9a-f]{64}$/;

function assertRequest(request: MintCustomRequest): void {
  if (request.tokenType.length !== 32) {
    throw new SphereError('mintCustom: tokenType must be 32 bytes', 'VALIDATION_ERROR');
  }
  if (request.salt.length < 16 || request.salt.length > 64) {
    throw new SphereError('mintCustom: salt must be 16 to 64 bytes', 'VALIDATION_ERROR');
  }
  if (request.data.length === 0) {
    throw new SphereError('mintCustom: data must not be empty', 'VALIDATION_ERROR');
  }
  for (const asset of request.assets) {
    if (!HEX32.test(asset.coinId) || asset.amount <= 0n) {
      throw new SphereError('mintCustom: assets need a 64-hex coinId and a positive amount', 'VALIDATION_ERROR');
    }
  }
}

export async function runCustomMintUnderJournal(
  deps: CustomMintDeps,
  input: { mintId: string; request: MintCustomRequest }
): Promise<MintResult> {
  try {
    assertRequest(input.request);
  } catch (err) {
    return { success: false, error: messageOf(err) };
  }
  const entry = journalEntryOf(input.mintId, input.request, deps.now());
  await deps.customMintJournal.upsert(entry);
  let tokenId: string;
  try {
    tokenId = await mintJournaled(deps, entry, input.request.mintJustificationVerifiers);
  } catch (err) {
    deps.armHeartbeat();
    return { success: false, error: messageOf(err) };
  }
  return { success: true, tokenId };
}

export async function replayCustomMints(deps: CustomReplayDeps): Promise<number> {
  let resolved = 0;
  for (const entry of await deps.customMintJournal.list()) {
    if (deps.isActiveOp(entry.mintId)) continue;
    try {
      if (entry.tokenId !== '' && (await deps.tokenInServerInventory(entry.tokenId))) {
        await deps.customMintJournal.removeByKey(entry.mintId);
      } else {
        await mintJournaled(deps, entry, undefined);
      }
      resolved += 1;
    } catch {
      continue;
    }
  }
  return resolved;
}

function journalEntryOf(mintId: string, request: MintCustomRequest, createdAt: number): CustomMintJournalEntry {
  return {
    mintId,
    tokenId: '',
    dataHex: bytesToHex(request.data),
    saltHex: bytesToHex(request.salt),
    tokenTypeHex: bytesToHex(request.tokenType),
    justificationHex: request.justification ? bytesToHex(request.justification) : null,
    assets: request.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })),
    createdAt,
  };
}

async function mintJournaled(
  deps: CustomMintDeps,
  entry: CustomMintJournalEntry,
  mintJustificationVerifiers: MintCustomRequest['mintJustificationVerifiers']
): Promise<string> {
  const token = await deps.engine.mintDataToken(
    {
      recipientPubkey: deps.ownPubkeyBytes,
      data: hexToBytes(entry.dataHex),
      tokenType: hexToBytes(entry.tokenTypeHex),
      salt: hexToBytes(entry.saltHex),
      ...(entry.justificationHex !== null ? { justification: hexToBytes(entry.justificationHex) } : {}),
      ...(mintJustificationVerifiers ? { mintJustificationVerifiers } : {}),
    },
    { transferId: entry.mintId }
  );
  if (entry.tokenId !== '' && token.blob.tokenId !== entry.tokenId) {
    throw new SphereError(`minted token ${token.blob.tokenId}, but the journal names ${entry.tokenId}`, 'VALIDATION_ERROR');
  }
  if (entry.tokenId === '') {
    await deps.customMintJournal.upsert({ ...entry, tokenId: token.blob.tokenId });
  }
  await finalizeMint(deps, {
    mintId: entry.mintId,
    token,
    assets: entry.assets,
    journal: deps.customMintJournal,
  });
  return token.blob.tokenId;
}
