// §5.9 NFT mint (#785): journal-first like the coin mint, but the journal holds the
// planned BYTES — payload, salt and type — so a resume re-submits exactly what the
// first attempt did, whatever the engine's signing or salt source.

import { bytesToHex, hexToBytes } from '../../core/crypto';
import { SphereError } from '../../core/errors';
import type { NftMintPlan } from '../../token-engine/types';

import type { MintNftRequest, MintResult } from './api';
import type { ListStore } from './machine/journal';
import { messageOf } from './machine/payload';
import { finalizeMint, type FinalizeMintDeps, type MintReplayDeps } from './mint';
import type { NftMintJournalEntry } from './stores';

export interface NftMintDeps extends FinalizeMintDeps {
  readonly nftMintJournal: ListStore<NftMintJournalEntry>;
  readonly armHeartbeat: () => void;
  /** The first owner: an NFT always mints to the wallet itself. */
  readonly ownPubkeyBytes: Uint8Array;
  /** The composed network's NFT vessel token type, 64 hex. */
  readonly nftTokenType: string;
  readonly now: () => number;
}

export type NftReplayDeps = NftMintDeps & MintReplayDeps;

/** Genesis payload cap, NftSigned wrapper included: wallet-api refuses an oversize blob only after the mint certified. */
export const NFT_MAX_PAYLOAD_BYTES = 1024 * 1024;

function assertPayloadSize(data: Uint8Array): void {
  if (data.length <= NFT_MAX_PAYLOAD_BYTES) return;
  throw new SphereError(
    `NFT payload is ${data.length} bytes, over the ${NFT_MAX_PAYLOAD_BYTES}-byte limit: link large files with NftLink`,
    'VALIDATION_ERROR'
  );
}

/** Plan, journal, mint, finalise. A refused payload fails with nothing journaled and nothing minted. */
export async function runNftMintUnderJournal(
  deps: NftMintDeps,
  input: { mintId: string; request: MintNftRequest }
): Promise<MintResult> {
  let plan: NftMintPlan;
  try {
    plan = await deps.engine.buildNftMint({
      recipientPubkey: deps.ownPubkeyBytes,
      content: input.request.content,
      sign: input.request.sign ?? true,
      tokenType: hexToBytes(deps.nftTokenType),
    });
    // Before the journal: a blob the server will refuse must never reach the chain.
    assertPayloadSize(plan.data);
  } catch (err) {
    return { success: false, error: messageOf(err) };
  }
  const entry = journalEntryOf(input.mintId, plan, deps.now());
  await deps.nftMintJournal.upsert(entry);
  try {
    await mintJournaled(deps, entry);
  } catch (err) {
    // Entry retained: the heartbeat / start() replay re-submits these same bytes.
    deps.armHeartbeat();
    return { success: false, tokenId: entry.tokenId, error: messageOf(err) };
  }
  return { success: true, tokenId: entry.tokenId };
}

/** @returns how many NFT journal entries were RESOLVED (cleared) — heartbeat progress. */
export async function replayNftMints(deps: NftReplayDeps): Promise<number> {
  let resolved = 0;
  for (const entry of await deps.nftMintJournal.list()) {
    if (deps.isActiveOp(entry.mintId)) continue; // its live mintNft still owns it
    try {
      if (await deps.tokenInServerInventory(entry.tokenId)) {
        await deps.nftMintJournal.removeByKey(entry.mintId);
      } else {
        await mintJournaled(deps, entry);
      }
      resolved += 1;
    } catch {
      // Entry retained — replayed again at the next pass / start().
    }
  }
  return resolved;
}

function journalEntryOf(mintId: string, plan: NftMintPlan, createdAt: number): NftMintJournalEntry {
  return {
    mintId,
    tokenId: plan.tokenId,
    dataHex: bytesToHex(plan.data),
    saltHex: bytesToHex(plan.salt),
    tokenTypeHex: bytesToHex(plan.tokenType),
    createdAt,
  };
}

/** Mint exactly the journaled bytes, then finalise. A throw leaves the entry journaled. */
async function mintJournaled(deps: NftMintDeps, entry: NftMintJournalEntry): Promise<void> {
  const params = {
    recipientPubkey: deps.ownPubkeyBytes,
    data: hexToBytes(entry.dataHex),
    tokenType: hexToBytes(entry.tokenTypeHex),
    salt: hexToBytes(entry.saltHex),
  };
  const token = await deps.engine.mintDataToken(params, { transferId: entry.mintId });
  if (token.blob.tokenId !== entry.tokenId) {
    // Never finalise a token the plan did not name.
    throw new SphereError(`minted token ${token.blob.tokenId}, but the plan names ${entry.tokenId}`, 'VALIDATION_ERROR');
  }
  await finalizeMint(deps, { mintId: entry.mintId, token, assets: [], journal: deps.nftMintJournal });
}
