import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex } from '../../core/crypto';
import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';
import type { SphereToken } from '../../token-engine/types';

import type { MintResult } from './api';
import { supportsDeterministicMint } from './compose';
import type { RecordMintInput } from './history/History';
import { messageOf } from './machine/payload';
import { mintParams } from './mint-params';
import type { ListStore } from './machine/journal';
import type { MintJournalEntry } from './stores';
import type { StoragePort } from './ports';

export const ATTENTION_MINT_UNRESOLVED = 'mint:unresolved';
export const INVENTORY_SCAN_PAGE_LIMIT = 50;

/** What finalising a certified mint needs — shared by the coin and the NFT mint. */
export interface FinalizeMintDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'uploadBlobs' | 'applyDelta'>;
  readonly recordMint: (input: RecordMintInput) => Promise<void>;
  readonly noteHeldState: (tokenId: string, stateHash: string) => void;
  readonly refreshView: () => void;
}

/** Everything the journal-first mint needs, injected so the path stays testable. */
export interface MintDeps extends FinalizeMintDeps {
  readonly mintJournal: ListStore<MintJournalEntry>;
  readonly armHeartbeat: () => void;
  readonly ownPubkeyBytes: Uint8Array;
  readonly now: () => number;
}

/** What replaying a mint journal needs on top of minting. */
export interface MintReplayDeps {
  /** §7 ownership: an entry whose live call is still running is never replayed. */
  readonly isActiveOp: (mintId: string) => boolean;
  readonly tokenInServerInventory: (tokenId: string) => Promise<boolean>;
}

export interface CoinReplayDeps extends MintDeps, MintReplayDeps {
  readonly emit: (event: string, payload: unknown) => void;
}

export interface FinalizeMintInput {
  readonly mintId: string;
  readonly token: SphereToken;
  /** `[]` for an NFT: a mint that names no coin never writes `coinId: ''` (wallet-api#151). */
  readonly assets: RecordMintInput['assets'];
  /** The journal holding `mintId`; its entry goes only after the apply and the record. */
  readonly journal: { removeByKey(key: string): Promise<void> };
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
    const assets = [{ coinId, amount: amount.toString() }];
    await finalizeMint(deps, { mintId, token, assets, journal: deps.mintJournal });
  } catch (err) {
    deps.armHeartbeat();
    return { success: false, tokenId: token.blob.tokenId, error: messageOf(err) };
  }
  return { success: true, tokenId: token.blob.tokenId };
}

export async function finalizeMint(deps: FinalizeMintDeps, input: FinalizeMintInput): Promise<void> {
  const { mintId, token } = input;
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
  await deps.recordMint({ tokenId: token.blob.tokenId, assets: input.assets });
  await input.journal.removeByKey(mintId);
  deps.noteHeldState(token.blob.tokenId, (await deps.engine.deliveryKeys(bytes)).stateHash);
  deps.refreshView();
}

export async function tokenInServerInventory(
  storagePort: Pick<StoragePort, 'listInventory'>,
  tokenId: string
): Promise<boolean> {
  let page = await storagePort.listInventory();
  for (let i = 0; i < INVENTORY_SCAN_PAGE_LIMIT; i++) {
    if (page.items.some((item) => item.tokenId === tokenId && item.status === 'active')) return true;
    if (!page.more) return false;
    page = await storagePort.listInventory(page.cursor);
  }
  return false;
}

/** @returns how many coin journal entries were RESOLVED (cleared) — heartbeat progress. */
export async function replayCoinMints(deps: CoinReplayDeps): Promise<number> {
  let resolved = 0;
  for (const entry of await deps.mintJournal.list()) {
    if (deps.isActiveOp(entry.mintId)) continue; // its live mint still owns it
    try {
      if (await replayCoinMint(deps, entry)) resolved += 1;
    } catch {
      // Entry retained — replayed again at the next pass / start().
    }
  }
  return resolved;
}

async function replayCoinMint(deps: CoinReplayDeps, entry: MintJournalEntry): Promise<boolean> {
  if (entry.tokenId !== '' && (await deps.tokenInServerInventory(entry.tokenId))) {
    await deps.mintJournal.removeByKey(entry.mintId);
    return true;
  }
  if (!supportsDeterministicMint(deps.engine)) {
    // Without the F13 seed a re-mint would create a SECOND token: hold + alert.
    deps.emit('transfer:attention', { transferId: entry.mintId, code: ATTENTION_MINT_UNRESOLVED });
    return false; // held, not resolved — never counts as heartbeat progress
  }
  const token = await deps.engine.mint(mintParams(deps.ownPubkeyBytes, entry.coinId, BigInt(entry.amount)), {
    transferId: entry.mintId,
  });
  if (token.blob.tokenId !== entry.tokenId) {
    await deps.mintJournal.upsert({ ...entry, tokenId: token.blob.tokenId });
  }
  const assets = [{ coinId: entry.coinId, amount: entry.amount }];
  await finalizeMint(deps, { mintId: entry.mintId, token, assets, journal: deps.mintJournal });
  return true;
}
