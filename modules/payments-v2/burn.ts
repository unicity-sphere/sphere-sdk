import { bytesToHex, hexToBytes } from '../../core/crypto';
import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';
import type { SphereToken } from '../../token-engine/types';

import type { BurnRequest, BurnResult, PendingBurn } from './api';
import type { RecordSentInput } from './history/History';
import type { ListStore } from './machine/journal';
import { messageOf } from './machine/payload';
import type { StoragePort } from './ports';
import type { BurnJournalEntry } from './stores';

export interface BurnDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'getBlobs' | 'applyDelta'>;
  readonly burnJournal: ListStore<BurnJournalEntry>;
  readonly recordSent: (input: RecordSentInput) => Promise<void>;
  readonly armHeartbeat: () => void;
  readonly refreshView: () => void;
  readonly now: () => number;
}

export interface BurnReplayDeps extends BurnDeps {
  readonly isActiveOp: (burnId: string) => boolean;
  readonly tokenInServerInventory: (tokenId: string) => Promise<boolean>;
}

const HEX32 = /^[0-9a-f]{64}$/;

async function heldToken(deps: BurnDeps, tokenId: string): Promise<SphereToken> {
  const bytes = (await deps.storagePort.getBlobs([tokenId])).get(tokenId);
  if (bytes === undefined) {
    throw new SphereError(`Token ${tokenId} has no blob in storage; it is not held here`, 'STORAGE_ERROR');
  }
  return deps.engine.decodeToken({ tokenId, token: bytes });
}

function assetsOf(token: SphereToken): { coinId: string; amount: string }[] {
  return (token.value?.assets ?? []).map((a) => ({ coinId: a.coinId, amount: a.amount.toString() }));
}

export async function runBurnUnderJournal(
  deps: BurnDeps,
  input: { burnId: string; request: BurnRequest }
): Promise<BurnResult> {
  const { burnId } = input;
  const { tokenId, reasonBytes } = input.request;
  if (!HEX32.test(tokenId) || reasonBytes.length === 0) {
    return { success: false, burnId, tokenId, error: 'burn: tokenId must be 64 hex and reasonBytes non-empty' };
  }
  let token: SphereToken;
  try {
    token = await heldToken(deps, tokenId);
    if (!deps.engine.isOwnedBy(token, deps.engine.getIdentity().chainPubkey)) {
      throw new SphereError(`Token ${tokenId} is not owned by this wallet`, 'VALIDATION_ERROR');
    }
  } catch (err) {
    return { success: false, burnId, tokenId, error: messageOf(err) };
  }
  const entry: BurnJournalEntry = {
    burnId,
    tokenId,
    reasonHex: bytesToHex(reasonBytes),
    burnedTokenHex: null,
    settled: false,
    assets: assetsOf(token),
    createdAt: deps.now(),
  };
  await deps.burnJournal.upsert(entry);
  try {
    const settled = await burnJournaled(deps, entry, token, { applied: false });
    return { success: true, burnId, tokenId, burnedToken: hexToBytes(settled.burnedTokenHex ?? '') };
  } catch (err) {
    deps.armHeartbeat();
    return { success: false, burnId, tokenId, error: messageOf(err) };
  }
}

export async function replayBurns(deps: BurnReplayDeps): Promise<number> {
  let progressed = 0;
  for (const entry of await deps.burnJournal.list()) {
    if (entry.settled || deps.isActiveOp(entry.burnId)) continue;
    try {
      const token = entry.burnedTokenHex === null ? await heldToken(deps, entry.tokenId) : null;
      const applied = entry.burnedTokenHex !== null && !(await deps.tokenInServerInventory(entry.tokenId));
      await burnJournaled(deps, entry, token, { applied });
      progressed += 1;
    } catch {
      continue;
    }
  }
  return progressed;
}

export async function pendingBurns(deps: Pick<BurnDeps, 'burnJournal'>): Promise<PendingBurn[]> {
  return (await deps.burnJournal.list()).map((entry) => ({
    burnId: entry.burnId,
    tokenId: entry.tokenId,
    reasonBytes: hexToBytes(entry.reasonHex),
    burnedToken: entry.burnedTokenHex === null ? null : hexToBytes(entry.burnedTokenHex),
    settled: entry.settled,
    createdAt: entry.createdAt,
  }));
}

export async function acknowledgeBurn(deps: Pick<BurnDeps, 'burnJournal'>, burnId: string): Promise<void> {
  const entry = await deps.burnJournal.getByKey(burnId);
  if (entry === undefined) return;
  if (!entry.settled) {
    throw new SphereError(`Burn ${burnId} is not settled yet; it cannot be acknowledged`, 'VALIDATION_ERROR');
  }
  await deps.burnJournal.removeByKey(burnId);
}

async function burnJournaled(
  deps: BurnDeps,
  entry: BurnJournalEntry,
  token: SphereToken | null,
  state: { applied: boolean }
): Promise<BurnJournalEntry> {
  let current = entry;
  if (current.burnedTokenHex === null) {
    if (token === null) throw new SphereError('burn replay needs the held token to certify', 'VALIDATION_ERROR');
    const burned = await deps.engine.burn(
      { token, reasonBytes: hexToBytes(current.reasonHex) },
      { transferId: current.burnId }
    );
    if (burned.blob.tokenId !== current.tokenId) {
      throw new SphereError(`burned token ${burned.blob.tokenId}, but the journal names ${current.tokenId}`, 'VALIDATION_ERROR');
    }
    current = { ...current, burnedTokenHex: bytesToHex(burned.blob.token) };
    await deps.burnJournal.upsert(current);
  }
  if (!state.applied) {
    await deps.storagePort.applyDelta({ transferId: current.burnId, spent: [current.tokenId], added: [] });
  }
  await deps.recordSent({ transferId: current.burnId, assets: current.assets, tokenId: current.tokenId });
  current = { ...current, settled: true };
  await deps.burnJournal.upsert(current);
  deps.refreshView();
  return current;
}
