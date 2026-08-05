import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FAKE_UNKNOWN_STATUS, FakeGateway, FakeGatewayTimeoutError } from './FakeGateway';
import {
  ConflictError,
  encodeFakeBlob,
  entryIdFor,
  FakeWalletApi,
  fakeSeedSignature,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationFailedError,
  completeMessageFor,
  ownerIdOf,
  progressMessageFor,
  sha256Hex,
  type FakeBlobMeta,
  type FakeCaller,
  type WakeEvent,
} from './FakeWalletApi';
import {
  CertificationData,
  CertificationStatus,
  HexConverter,
  MintTransaction,
  NetworkId,
  SignaturePredicate,
  SigningService,
  StateId,
  TokenSalt,
  TokenType,
} from '../../../../token-engine/sdk';
import { createTestEngine } from '../../token-engine/test-engine';
import { freshHex } from '../support';

const NET = 'testnet2';
const A: FakeCaller = { chainPubkey: `02${'aa'.repeat(32)}`, network: NET };
const B: FakeCaller = { chainPubkey: `02${'bb'.repeat(32)}`, network: NET };
const C: FakeCaller = { chainPubkey: `02${'cc'.repeat(32)}`, network: NET };
const COIN = 'f0'.repeat(32);

function makeMeta(partial: Partial<FakeBlobMeta> & { ownerPubkey: string }): FakeBlobMeta {
  return {
    tokenId: partial.tokenId ?? freshHex(),
    stateHash: partial.stateHash ?? freshHex(),
    consumedStates: partial.consumedStates ?? [],
    ownerPubkey: partial.ownerPubkey,
    assets: partial.assets ?? [{ coinId: COIN, amount: '100' }],
    ...(partial.splitEvidence === undefined ? {} : { splitEvidence: partial.splitEvidence }),
  };
}

async function storeBlob(api: FakeWalletApi, meta: FakeBlobMeta): Promise<string> {
  const bytes = encodeFakeBlob(meta);
  const key = sha256Hex(bytes);
  await api.putBlob(key, bytes);
  return key;
}

async function seedToken(
  api: FakeWalletApi,
  owner: FakeCaller,
  overrides: Partial<FakeBlobMeta> = {}
): Promise<FakeBlobMeta> {
  const meta = makeMeta({ ...overrides, ownerPubkey: owner.chainPubkey });
  const key = await storeBlob(api, meta);
  await api.apply(owner, { transferId: `seed-${randomUUID()}`, spent: [], added: [{ tokenId: meta.tokenId, key }] });
  return meta;
}

describe('FakeWalletApi — inventory reads (inventory/repository.ts readSnapshot)', () => {
  it('lists active rows only when no since is given', async () => {
    const api = new FakeWalletApi();
    const kept = await seedToken(api, A);
    const spent = await seedToken(api, A);
    await api.apply(A, { transferId: randomUUID(), spent: [spent.tokenId], added: [] });
    const page = await api.listInventory(A);
    expect(page.items.map((item) => item.tokenId)).toEqual([kept.tokenId]);
    expect(page.items[0]?.status).toBe('active');
  });

  it('includes tombstones in the ?since= delta with seq and stateHash', async () => {
    const api = new FakeWalletApi();
    const meta = await seedToken(api, A);
    const before = await api.listInventory(A);
    await api.apply(A, { transferId: randomUUID(), spent: [meta.tokenId], added: [] });
    const delta = await api.listInventory(A, before.cursor);
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]?.status).toBe('removed');
    expect(delta.items[0]?.tokenId).toBe(meta.tokenId);
    expect(delta.items[0]?.stateHash).toBe(meta.stateHash);
    expect(delta.items[0]?.seq).toBeGreaterThan(before.cursor);
  });

  it('caps pages at pageLimit, sets more and a last-seq cursor, and finishes at the owner cursor', async () => {
    const api = new FakeWalletApi({ pageLimit: 2 });
    await seedToken(api, A);
    await seedToken(api, A);
    await seedToken(api, A);
    const first = await api.listInventory(A);
    expect(first.more).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBe(first.items[1]?.seq);
    const second = await api.listInventory(A, first.cursor);
    expect(second.more).toBe(false);
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBe(second.items[0]?.seq);
  });

  it('aggregates balances over active rows only', async () => {
    const api = new FakeWalletApi();
    await seedToken(api, A, { assets: [{ coinId: COIN, amount: '70' }] });
    const spent = await seedToken(api, A, { assets: [{ coinId: COIN, amount: '30' }] });
    await api.apply(A, { transferId: randomUUID(), spent: [spent.tokenId], added: [] });
    expect(await api.balances(A)).toEqual([{ coinId: COIN, total: '70', tokenCount: 1 }]);
  });
});

describe('FakeWalletApi — apply (inventory/service.ts + inventory/plan.ts)', () => {
  it('replays a transferId idempotently: recorded cursor returned, nothing mutated', async () => {
    const api = new FakeWalletApi();
    const meta = await seedToken(api, A);
    const first = await api.apply(A, { transferId: 'tx-replay', spent: [meta.tokenId], added: [] });
    const rowAfter = api.inspectInventoryRow(A, meta.tokenId);
    const replay = await api.apply(A, { transferId: 'tx-replay', spent: [meta.tokenId], added: [] });
    expect(replay.cursor).toBe(first.cursor);
    expect(api.inspectInventoryRow(A, meta.tokenId)).toEqual(rowAfter);
  });

  it('422s a tokenId appearing in both spent and added (assertDisjointTokenSets)', async () => {
    const api = new FakeWalletApi();
    const meta = await seedToken(api, A);
    const next = makeMeta({ tokenId: meta.tokenId, consumedStates: [meta.stateHash], ownerPubkey: A.chainPubkey });
    const key = await storeBlob(api, next);
    await expect(
      api.apply(A, { transferId: randomUUID(), spent: [meta.tokenId], added: [{ tokenId: meta.tokenId, key }] })
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('classes a spend evidenced when a same-transferId mailbox deposit consumes the spent state', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: B.chainPubkey });
    const key = await storeBlob(api, out);
    await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key,
      transferId: 'tx-ev',
      stateHash: out.stateHash,
      tokenId: out.tokenId,
    });
    await api.apply(A, { transferId: 'tx-ev', spent: [source.tokenId], added: [] });
    expect(api.inspectInventoryRow(A, source.tokenId)?.removalClass).toBe('evidenced');
  });

  it('classes a spend evidenced when an added change blob carries matching splitEvidence', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const change = makeMeta({
      ownerPubkey: A.chainPubkey,
      splitEvidence: { burntTokenId: source.tokenId, preBurnState: source.stateHash },
    });
    const key = await storeBlob(api, change);
    await api.apply(A, { transferId: randomUUID(), spent: [source.tokenId], added: [{ tokenId: change.tokenId, key }] });
    expect(api.inspectInventoryRow(A, source.tokenId)?.removalClass).toBe('evidenced');
    expect(api.inspectInventoryRow(A, change.tokenId)?.status).toBe('active');
  });

  it('classes an evidence-free spend unevidenced, or external when externalDelivery is declared', async () => {
    const api = new FakeWalletApi();
    const bare = await seedToken(api, A);
    await api.apply(A, { transferId: randomUUID(), spent: [bare.tokenId], added: [] });
    expect(api.inspectInventoryRow(A, bare.tokenId)?.removalClass).toBe('unevidenced');
    const declared = await seedToken(api, A);
    await api.apply(A, { transferId: randomUUID(), spent: [declared.tokenId], added: [], externalDelivery: true });
    expect(api.inspectInventoryRow(A, declared.tokenId)?.removalClass).toBe('external');
  });

  it('409s an added blob that does not strictly extend another owner’s recorded state (validation/lineage.ts)', async () => {
    const api = new FakeWalletApi();
    const held = await seedToken(api, A);
    const stale = makeMeta({ tokenId: held.tokenId, consumedStates: [], ownerPubkey: B.chainPubkey });
    const key = await storeBlob(api, stale);
    await expect(
      api.apply(B, { transferId: randomUUID(), spent: [], added: [{ tokenId: stale.tokenId, key }] })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('hands off a strictly-extended other-owner active row as an evidenced tombstone (executeAdds)', async () => {
    const api = new FakeWalletApi();
    const held = await seedToken(api, A);
    const next = makeMeta({ tokenId: held.tokenId, consumedStates: [held.stateHash], ownerPubkey: B.chainPubkey });
    const key = await storeBlob(api, next);
    await api.apply(B, { transferId: randomUUID(), spent: [], added: [{ tokenId: next.tokenId, key }] });
    expect(api.inspectInventoryRow(A, held.tokenId)).toMatchObject({ status: 'removed', removalClass: 'evidenced' });
    expect(api.inspectInventoryRow(B, held.tokenId)).toMatchObject({ status: 'active', stateHash: next.stateHash });
  });

  it('converges a duplicate add over the own active equal-state row as a noop (#39, plan.ts planAdd)', async () => {
    const api = new FakeWalletApi();
    const meta = await seedToken(api, A);
    const seqBefore = api.inspectInventoryRow(A, meta.tokenId)?.seq;
    const key = sha256Hex(encodeFakeBlob(meta));
    await api.apply(A, { transferId: randomUUID(), spent: [], added: [{ tokenId: meta.tokenId, key }] });
    expect(api.inspectInventoryRow(A, meta.tokenId)?.seq).toBe(seqBefore);
  });

  it('422s a spent token with no inventory row for the caller (plan.ts planSpend)', async () => {
    const api = new FakeWalletApi();
    await expect(api.apply(A, { transferId: randomUUID(), spent: [freshHex()], added: [] })).rejects.toBeInstanceOf(
      ValidationFailedError
    );
  });

  it('422s an added blob whose final-state predicate is not the caller’s (validation pipeline §8.2)', async () => {
    const api = new FakeWalletApi();
    const foreign = makeMeta({ ownerPubkey: B.chainPubkey });
    const key = await storeBlob(api, foreign);
    await expect(
      api.apply(A, { transferId: randomUUID(), spent: [], added: [{ tokenId: foreign.tokenId, key }] })
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('completes a flag-less intent unconditionally in the same apply (repository completeIntent)', async () => {
    const api = new FakeWalletApi();
    const meta = await seedToken(api, A);
    await api.putIntent(A, { transferId: 'tx-close', payload: 'p' });
    await api.apply(A, { transferId: 'tx-close', spent: [meta.tokenId], added: [] });
    expect(api.inspectIntent(A, 'tx-close')?.status).toBe('completed');
  });

  it('completes a requiresSeedClose intent only when the apply carries an evidenced removal (§16/#87)', async () => {
    const api = new FakeWalletApi();
    const bare = await seedToken(api, A);
    await api.putIntent(A, { transferId: 'tx-unev', payload: 'p', requiresSeedClose: true });
    await api.apply(A, { transferId: 'tx-unev', spent: [bare.tokenId], added: [] });
    expect(api.inspectIntent(A, 'tx-unev')?.status).toBe('open');
    const source = await seedToken(api, A);
    await api.putIntent(A, { transferId: 'tx-evd', payload: 'p', requiresSeedClose: true });
    const out = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: B.chainPubkey });
    const key = await storeBlob(api, out);
    await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key,
      transferId: 'tx-evd',
      stateHash: out.stateHash,
      tokenId: out.tokenId,
    });
    await api.apply(A, { transferId: 'tx-evd', spent: [source.tokenId], added: [] });
    expect(api.inspectIntent(A, 'tx-evd')?.status).toBe('completed');
  });

  it('noops the spend of a row a self-send claim already advanced in place (#70, plan.ts depositFinalStates)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const advanced = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: A.chainPubkey });
    const key = await storeBlob(api, advanced);
    await api.deposit(A, {
      recipientPubkey: A.chainPubkey,
      key,
      transferId: 'tx-self',
      stateHash: advanced.stateHash,
      tokenId: advanced.tokenId,
    });
    const entryId = entryIdFor(advanced.tokenId, advanced.stateHash);
    const claim = await api.claim(A, { entryIds: [entryId], intoInventory: true });
    expect(claim.claimed).toEqual([entryId]);
    await api.apply(A, { transferId: 'tx-self', spent: [source.tokenId], added: [] });
    expect(api.inspectInventoryRow(A, source.tokenId)).toMatchObject({ status: 'active', stateHash: advanced.stateHash });
  });
});

describe('FakeWalletApi — blobs (Appendix B: presigned PUT semantics)', () => {
  it('treats a re-upload of an existing blob as success (S3 412 = exists = success)', async () => {
    const api = new FakeWalletApi();
    const bytes = encodeFakeBlob(makeMeta({ ownerPubkey: A.chainPubkey }));
    const key = sha256Hex(bytes);
    await api.putBlob(key, bytes);
    await expect(api.putBlob(key, bytes)).resolves.toEqual({ key });
    expect(await api.getBlob(key)).toEqual(bytes);
  });

  it('422s bytes that do not match the pinned sha256 checksum (x-amz-checksum-sha256)', async () => {
    const api = new FakeWalletApi();
    await expect(api.putBlob('ab'.repeat(32), new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('FakeWalletApi — intents (intents/service.ts + intents/repository.ts)', () => {
  it('is write-once while open: a second PUT with a different payload is a silent no-op', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't1', payload: 'original' });
    await api.putIntent(A, { transferId: 't1', payload: 'imposter' });
    expect(api.inspectIntent(A, 't1')?.payload).toBe('original');
    expect(api.inspectIntent(A, 't1')?.status).toBe('open');
  });

  it('is a no-op on a completed intent: PUT neither reopens nor rewrites (judgeExisting)', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't2', payload: 'original' });
    await api.completeIntent(A, { transferId: 't2' });
    await api.putIntent(A, { transferId: 't2', payload: 'other' });
    expect(api.inspectIntent(A, 't2')).toMatchObject({ status: 'completed', payload: 'original' });
  });

  it('re-opens an aborted intent only byte-equal; a different payload is 409 (§16)', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't3', payload: 'original' });
    await api.abortIntent(A, 't3');
    await api.putIntent(A, { transferId: 't3', payload: 'original' });
    expect(api.inspectIntent(A, 't3')?.status).toBe('open');
    await api.abortIntent(A, 't3');
    await expect(api.putIntent(A, { transferId: 't3', payload: 'other' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists open and aborted only — a completed intent is absent from both (absence means closed)', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 'open-1', payload: 'p' });
    await api.putIntent(A, { transferId: 'aborted-1', payload: 'p' });
    await api.abortIntent(A, 'aborted-1');
    await api.putIntent(A, { transferId: 'done-1', payload: 'p' });
    await api.completeIntent(A, { transferId: 'done-1' });
    expect((await api.listIntents(A, 'open')).map((intent) => intent.transferId)).toEqual(['open-1']);
    expect((await api.listIntents(A, 'aborted')).map((intent) => intent.transferId)).toEqual(['aborted-1']);
  });

  it('aborts softly and idempotently; completion wins — abort of a completed intent is a no-op', async () => {
    const api = new FakeWalletApi();
    await expect(api.abortIntent(A, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    await api.putIntent(A, { transferId: 't4', payload: 'p' });
    await api.completeIntent(A, { transferId: 't4' });
    await api.abortIntent(A, 't4');
    expect(api.inspectIntent(A, 't4')?.status).toBe('completed');
    await api.putIntent(A, { transferId: 't5', payload: 'p' });
    await api.abortIntent(A, 't5');
    await api.abortIntent(A, 't5');
    expect(api.inspectIntent(A, 't5')?.status).toBe('aborted');
  });

  it('completes idempotently; a requires_seed_close intent refuses an unsigned close (403)', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't6', payload: 'p', requiresSeedClose: true });
    await expect(api.completeIntent(A, { transferId: 't6' })).rejects.toBeInstanceOf(ForbiddenError);
    const signature = fakeSeedSignature(A.chainPubkey, completeMessageFor('t6'));
    await api.completeIntent(A, { transferId: 't6', signature });
    await api.completeIntent(A, { transferId: 't6', signature });
    expect(api.inspectIntent(A, 't6')?.status).toBe('completed');
  });

  it('verifies a PRESENT complete signature even on a flag-less intent — garbage is never accepted', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't7', payload: 'p' });
    await expect(api.completeIntent(A, { transferId: 't7', signature: 'garbage' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('appends progress insert-once first-write-wins: the loser receives the STORED record', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't8', payload: 'p', requiresSeedClose: true });
    const sign = (opIndex: number, payload: string): string =>
      fakeSeedSignature(A.chainPubkey, progressMessageFor('t8', opIndex, payload));
    const first = await api.appendProgress(A, { transferId: 't8', opIndex: 0, payload: 'winner', signature: sign(0, 'winner') });
    expect(first.created).toBe(true);
    const second = await api.appendProgress(A, { transferId: 't8', opIndex: 0, payload: 'loser', signature: sign(0, 'loser') });
    expect(second.created).toBe(false);
    expect(second.record.payload).toBe('winner');
    expect((await api.listProgress(A, 't8')).map((record) => record.payload)).toEqual(['winner']);
  });

  it('gates progress: 404 unknown parent, 409 not-open, 409 not-guarded, 403 bad signature, 422 opIndex bound', async () => {
    const api = new FakeWalletApi();
    const sign = (transferId: string, opIndex: number, payload: string): string =>
      fakeSeedSignature(A.chainPubkey, progressMessageFor(transferId, opIndex, payload));
    await expect(
      api.appendProgress(A, { transferId: 'nope', opIndex: 0, payload: 'p', signature: sign('nope', 0, 'p') })
    ).rejects.toBeInstanceOf(NotFoundError);
    await api.putIntent(A, { transferId: 'unguarded', payload: 'p' });
    await expect(
      api.appendProgress(A, { transferId: 'unguarded', opIndex: 0, payload: 'p', signature: sign('unguarded', 0, 'p') })
    ).rejects.toBeInstanceOf(ConflictError);
    await api.putIntent(A, { transferId: 'closed', payload: 'p', requiresSeedClose: true });
    await api.abortIntent(A, 'closed');
    await expect(
      api.appendProgress(A, { transferId: 'closed', opIndex: 0, payload: 'p', signature: sign('closed', 0, 'p') })
    ).rejects.toBeInstanceOf(ConflictError);
    await api.putIntent(A, { transferId: 'guarded', payload: 'p', requiresSeedClose: true });
    await expect(
      api.appendProgress(A, { transferId: 'guarded', opIndex: 0, payload: 'p', signature: 'garbage' })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      api.appendProgress(A, { transferId: 'guarded', opIndex: 256, payload: 'p', signature: sign('guarded', 256, 'p') })
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('binds the progress signature to wallet-api.progress.v1:{transferId}:{opIndex}:{sha256(payload)}', async () => {
    const api = new FakeWalletApi();
    await api.putIntent(A, { transferId: 't9', payload: 'p', requiresSeedClose: true });
    const wrongDigest = fakeSeedSignature(A.chainPubkey, `wallet-api.progress.v1:t9:0:${sha256Hex(new TextEncoder().encode('other'))}`);
    await expect(
      api.appendProgress(A, { transferId: 't9', opIndex: 0, payload: 'payload', signature: wrongDigest })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const digest = sha256Hex(new TextEncoder().encode('payload'));
    const right = fakeSeedSignature(A.chainPubkey, `wallet-api.progress.v1:t9:0:${digest}`);
    const outcome = await api.appendProgress(A, { transferId: 't9', opIndex: 0, payload: 'payload', signature: right });
    expect(outcome.created).toBe(true);
  });
});

describe('FakeWalletApi — mailbox (mailbox/service.ts + mailbox/repository.ts)', () => {
  async function depositTransfer(
    api: FakeWalletApi,
    sender: FakeCaller,
    recipient: FakeCaller,
    source: FakeBlobMeta,
    transferId = randomUUID()
  ): Promise<FakeBlobMeta> {
    const out = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: recipient.chainPubkey });
    const key = await storeBlob(api, out);
    await api.deposit(sender, {
      recipientPubkey: recipient.chainPubkey,
      key,
      transferId,
      stateHash: out.stateHash,
      tokenId: out.tokenId,
    });
    return out;
  }

  it('derives entryId as hex(sha256(tokenIdBytes ‖ stateHashBytes)) (entryIdFor)', () => {
    const tokenId = 'ab'.repeat(32);
    const stateHash = 'cd'.repeat(32);
    const expected = createHash('sha256')
      .update(Buffer.from(tokenId, 'hex'))
      .update(Buffer.from(stateHash, 'hex'))
      .digest('hex');
    expect(entryIdFor(tokenId, stateHash)).toBe(expected);
  });

  it('deposits idempotently by entryId in ANY status when recipient and key match (insertResolved)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source, 'tx-dup-a-b-c');
    const entryId = entryIdFor(out.tokenId, out.stateHash);
    await api.claim(B, { entryIds: [entryId], intoInventory: true });
    const key = sha256Hex(encodeFakeBlob(out));
    const again = await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key,
      transferId: 'tx-dup-a-b-c',
      stateHash: out.stateHash,
      tokenId: out.tokenId,
    });
    expect(again.entryId).toBe(entryId);
    const listed = await api.listMailbox(B);
    expect(listed.entries.filter((entry) => entry.entryId === entryId)).toHaveLength(1);
    expect(listed.entries[0]?.status).toBe('claimed');
  });

  it('409s a re-deposit whose stored entry has a different recipient or key (assertMatchesExisting)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    const key = sha256Hex(encodeFakeBlob(out));
    const otherNet: FakeCaller = { chainPubkey: A.chainPubkey, network: 'othernet' };
    await expect(
      api.deposit(otherNet, {
        recipientPubkey: B.chainPubkey,
        key,
        transferId: 'tx-x',
        stateHash: out.stateHash,
        tokenId: out.tokenId,
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rolls the whole batch back when one entry conflicts — all-or-nothing (depositBatchTx)', async () => {
    const api = new FakeWalletApi();
    const held = await seedToken(api, A);
    const good = makeMeta({ ownerPubkey: B.chainPubkey });
    const goodKey = await storeBlob(api, good);
    const stale = makeMeta({ tokenId: held.tokenId, consumedStates: [], ownerPubkey: B.chainPubkey });
    const staleKey = await storeBlob(api, stale);
    await expect(
      api.depositBatch(A, [
        { recipientPubkey: B.chainPubkey, key: goodKey, transferId: 'tb', stateHash: good.stateHash, tokenId: good.tokenId },
        { recipientPubkey: B.chainPubkey, key: staleKey, transferId: 'tb', stateHash: stale.stateHash, tokenId: stale.tokenId },
      ])
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await api.listMailbox(B)).entries).toHaveLength(0);
  });

  it('lets a per-entry idempotent duplicate succeed inside a batch alongside a fresh entry', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source, 'tx-mixed-a-b-c');
    const dupKey = sha256Hex(encodeFakeBlob(out));
    const fresh = makeMeta({ ownerPubkey: B.chainPubkey });
    const freshKey = await storeBlob(api, fresh);
    const result = await api.depositBatch(A, [
      { recipientPubkey: B.chainPubkey, key: dupKey, transferId: 'tx-mixed-a-b-c', stateHash: out.stateHash, tokenId: out.tokenId },
      { recipientPubkey: B.chainPubkey, key: freshKey, transferId: 'tx-mixed-a-b-c', stateHash: fresh.stateHash, tokenId: fresh.tokenId },
    ]);
    expect(result.entries[0]?.seq).toBe(1);
    expect(result.entries[1]?.seq).toBe(2);
  });

  it('429s over the recipient caps, per-(sender,recipient) sub-cap binding first (assertInboxCaps)', async () => {
    const api = new FakeWalletApi({ maxRecipientEntries: 5, maxSenderRecipientEntries: 1 });
    const first = makeMeta({ ownerPubkey: B.chainPubkey });
    await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key: await storeBlob(api, first),
      transferId: 'q1',
      stateHash: first.stateHash,
      tokenId: first.tokenId,
    });
    const second = makeMeta({ ownerPubkey: B.chainPubkey });
    const error = await api
      .deposit(A, {
        recipientPubkey: B.chainPubkey,
        key: await storeBlob(api, second),
        transferId: 'q2',
        stateHash: second.stateHash,
        tokenId: second.tokenId,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).limitName).toBe('max_sender_recipient_entries');
  });

  it('lists entries of EVERY status and a readPointer at the highest contiguous claimed-or-rejected seq', async () => {
    const api = new FakeWalletApi();
    const sources = [await seedToken(api, A), await seedToken(api, A), await seedToken(api, A)];
    const outs = [];
    for (const source of sources) outs.push(await depositTransfer(api, A, B, source));
    const ids = outs.map((out) => entryIdFor(out.tokenId, out.stateHash));
    await api.claim(B, { entryIds: [ids[0] as string], intoInventory: false });
    await api.reject(B, { entryIds: [ids[2] as string], reason: 'invalid' });
    const page = await api.listMailbox(B);
    expect(page.entries.map((entry) => entry.status)).toEqual(['claimed', 'unclaimed', 'rejected']);
    expect(page.readPointer).toBe(1);
    await api.claim(B, { entryIds: [ids[1] as string], intoInventory: false });
    expect((await api.listMailbox(B)).readPointer).toBe(3);
  });

  it('403s a claim by anyone but the addressee (requireAddressee)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    await expect(
      api.claim(C, { entryIds: [entryIdFor(out.tokenId, out.stateHash)], intoInventory: true })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('performs the intoInventory handoff: sender row tombstoned evidenced, recipient row inserted (materialize)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    const result = await api.claim(B, { entryIds: [entryIdFor(out.tokenId, out.stateHash)], intoInventory: true });
    expect(result.claimed).toHaveLength(1);
    expect(api.inspectInventoryRow(A, source.tokenId)).toMatchObject({ status: 'removed', removalClass: 'evidenced' });
    expect(api.inspectInventoryRow(B, out.tokenId)).toMatchObject({ status: 'active', stateHash: out.stateHash });
  });

  it('buckets a re-claim as alreadyClaimed with the STORED disposition, and upgrades false→true (claimAgain)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    const entryId = entryIdFor(out.tokenId, out.stateHash);
    await api.claim(B, { entryIds: [entryId], intoInventory: false });
    expect(api.inspectInventoryRow(B, out.tokenId)).toBeUndefined();
    const upgraded = await api.claim(B, { entryIds: [entryId], intoInventory: true });
    expect(upgraded.alreadyClaimed).toEqual([{ entryId, intoInventory: true }]);
    expect(api.inspectInventoryRow(B, out.tokenId)).toMatchObject({ status: 'active' });
    const again = await api.claim(B, { entryIds: [entryId], intoInventory: false });
    expect(again.alreadyClaimed).toEqual([{ entryId, intoInventory: true }]);
  });

  it('fails a claim that now violates lineage into the CONFLICT bucket, leaving the entry unclaimed', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const toR1 = await depositTransfer(api, A, B, source);
    const toR2 = await depositTransfer(api, A, C, source);
    await api.claim(B, { entryIds: [entryIdFor(toR1.tokenId, toR1.stateHash)], intoInventory: true });
    const entryId = entryIdFor(toR2.tokenId, toR2.stateHash);
    const result = await api.claim(C, { entryIds: [entryId], intoInventory: true });
    expect(result.failed).toEqual([{ entryId, code: 'CONFLICT' }]);
    expect((await api.listMailbox(C)).entries[0]?.status).toBe('unclaimed');
  });

  it('claims a self-send as one in-place reactivating UPDATE — no tombstone anywhere (§6 step 3)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const advanced = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: A.chainPubkey });
    const key = await storeBlob(api, advanced);
    await api.deposit(A, {
      recipientPubkey: A.chainPubkey,
      key,
      transferId: randomUUID(),
      stateHash: advanced.stateHash,
      tokenId: advanced.tokenId,
    });
    await api.claim(A, { entryIds: [entryIdFor(advanced.tokenId, advanced.stateHash)], intoInventory: true });
    expect(api.inspectInventoryRow(A, source.tokenId)).toMatchObject({ status: 'active', stateHash: advanced.stateHash });
    const delta = await api.listInventory(A, 0);
    expect(delta.items.filter((item) => item.tokenId === source.tokenId)).toHaveLength(1);
  });

  it('rejects terminally for discovery but never downgrades a claim (rejectTx)', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    const entryId = entryIdFor(out.tokenId, out.stateHash);
    await api.claim(B, { entryIds: [entryId], intoInventory: false });
    const rejected = await api.reject(B, { entryIds: [entryId], reason: 'other', detail: 'nope' });
    expect(rejected.rejected).toEqual([]);
    expect((await api.listMailbox(B)).entries[0]?.status).toBe('claimed');
  });

  it('rolls back the whole reject batch when one entry is not the caller’s — one transaction (repository transact)', async () => {
    const api = new FakeWalletApi();
    let mine = await depositTransfer(api, A, B, await seedToken(api, A));
    const foreign = await depositTransfer(api, A, C, await seedToken(api, A));
    while (entryIdFor(mine.tokenId, mine.stateHash) > entryIdFor(foreign.tokenId, foreign.stateHash)) {
      mine = await depositTransfer(api, A, B, await seedToken(api, A));
    }
    await expect(
      api.reject(B, {
        entryIds: [entryIdFor(mine.tokenId, mine.stateHash), entryIdFor(foreign.tokenId, foreign.stateHash)],
        reason: 'invalid',
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const statuses = (await api.listMailbox(B)).entries.map((entry) => entry.status);
    expect(statuses.every((status) => status === 'unclaimed')).toBe(true);
  });

  it('re-reports an already-rejected entry as rejected (idempotent), and a rejected entry stays claimable', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = await depositTransfer(api, A, B, source);
    const entryId = entryIdFor(out.tokenId, out.stateHash);
    await api.reject(B, { entryIds: [entryId], reason: 'invalid' });
    const again = await api.reject(B, { entryIds: [entryId] });
    expect(again.rejected).toEqual([entryId]);
    const claim = await api.claim(B, { entryIds: [entryId], intoInventory: true });
    expect(claim.claimed).toEqual([entryId]);
    expect(api.inspectInventoryRow(B, out.tokenId)).toMatchObject({ status: 'active' });
  });
});

describe('FakeWalletApi — history (history/service.ts + history/repository.ts)', () => {
  const record = (dedupKey: string, ts: string, id = randomUUID()): Parameters<FakeWalletApi['appendHistory']>[1][number] => ({
    dedupKey,
    id,
    type: 'SENT',
    assets: [{ coinId: COIN, amount: '1' }],
    ts,
  });

  it('deduplicates POSTs by (owner, dedupKey) with conflict-do-nothing', async () => {
    const api = new FakeWalletApi();
    const first = await api.appendHistory(A, [record('k1', '2026-02-01T00:00:00Z')]);
    expect(first).toEqual({ inserted: 1, deduped: 0 });
    const replay = await api.appendHistory(A, [record('k1', '2026-03-01T00:00:00Z')]);
    expect(replay).toEqual({ inserted: 0, deduped: 1 });
    const page = await api.listHistory(A);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.ts).toBe('2026-02-01T00:00:00.000Z');
  });

  it('serves newest-first keyset pages via before/limit (readPage: ts DESC, id ASC)', async () => {
    const api = new FakeWalletApi();
    await api.appendHistory(A, [
      record('k1', '2026-02-01T00:00:00Z'),
      record('k2', '2026-02-02T00:00:00Z'),
      record('k3', '2026-02-03T00:00:00Z'),
    ]);
    const first = await api.listHistory(A, { limit: 2 });
    expect(first.records.map((entry) => entry.dedupKey)).toEqual(['k3', 'k2']);
    expect(first.more).toBe(true);
    expect(first.cursor).not.toBeNull();
    const second = await api.listHistory(A, { before: first.cursor as string, limit: 2 });
    expect(second.records.map((entry) => entry.dedupKey)).toEqual(['k1']);
    expect(second.more).toBe(false);
    expect(second.cursor).toBeNull();
  });
});

describe('FakeWalletApi — payment requests (payments/service.ts + workers/pr-expiry.ts)', () => {
  it('auto-provisions a never-authenticated payer on create (createTx provisionAccount)', async () => {
    const api = new FakeWalletApi();
    const created = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '5' }] });
    expect(created.status).toBe('open');
    expect(created.seq).toBe(1);
    const incoming = await api.listRequests(B, { role: 'incoming', since: 0 });
    expect(incoming.requests.map((request) => request.id)).toEqual([created.id]);
  });

  it('streams incoming by seq and re-stamps seq on respond so the resolved row re-surfaces (respondTx)', async () => {
    const api = new FakeWalletApi();
    const created = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '5' }] });
    const first = await api.listRequests(B, { role: 'incoming', since: 0 });
    expect(first.cursor).toBe(1);
    await api.respondRequest(B, created.id, { action: 'declined' });
    const delta = await api.listRequests(B, { role: 'incoming', since: first.cursor as number });
    expect(delta.requests).toHaveLength(1);
    expect(delta.requests[0]).toMatchObject({ id: created.id, status: 'declined', seq: 2 });
  });

  it('rejects before on the incoming stream and since on the outgoing backfill (§16)', async () => {
    const api = new FakeWalletApi();
    await expect(api.listRequests(B, { role: 'incoming', before: 'x' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(api.listRequests(A, { role: 'outgoing', since: 0 })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('serves outgoing newest-first with before-backfill pagination only (readOutgoing)', async () => {
    const api = new FakeWalletApi({ pageLimit: 2 });
    const first = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '1' }] });
    const second = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '2' }] });
    const third = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '3' }] });
    const page = await api.listRequests(A, { role: 'outgoing' });
    expect(page.requests.map((request) => request.id)).toEqual([third.id, second.id]);
    expect(page.more).toBe(true);
    const rest = await api.listRequests(A, { role: 'outgoing', before: page.cursor as string });
    expect(rest.requests.map((request) => request.id)).toEqual([first.id]);
  });

  it('guards respond: addressee-only 403, non-open 409, paid requires transferId, declined forbids it', async () => {
    const api = new FakeWalletApi();
    const created = await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '5' }] });
    await expect(api.respondRequest(C, created.id, { action: 'declined' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(api.respondRequest(B, created.id, { action: 'paid' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(api.respondRequest(B, created.id, { action: 'declined', transferId: 't' })).rejects.toBeInstanceOf(
      ValidationFailedError
    );
    const paid = await api.respondRequest(B, created.id, { action: 'paid', transferId: 'tx-pay' });
    expect(paid).toMatchObject({ status: 'paid', transferId: 'tx-pay' });
    await expect(api.respondRequest(B, created.id, { action: 'declined' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('caps open requests per payer at 429 (max_payer_open_requests)', async () => {
    const api = new FakeWalletApi({ maxPayerOpenRequests: 1 });
    await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '1' }] });
    await expect(
      api.createRequest(C, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '2' }] })
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('flips overdue open requests to expired with a re-stamped seq via the test-invokable sweep (expireDue)', async () => {
    const api = new FakeWalletApi();
    const created = await api.createRequest(A, {
      toPubkey: B.chainPubkey,
      assets: [{ coinId: COIN, amount: '5' }],
      expiresAt: '2026-01-01T00:00:00Z',
    });
    const flipped = await api.runExpirySweep();
    expect(flipped).toBe(1);
    const delta = await api.listRequests(B, { role: 'incoming', since: 1 });
    expect(delta.requests[0]).toMatchObject({ id: created.id, status: 'expired', seq: 2 });
    expect(await api.runExpirySweep()).toBe(0);
  });
});

describe('FakeWalletApi — syncEpoch + wakes (restore/rebuild.ts + ws/events.ts)', () => {
  it('bumpEpoch simulates a DB restore: new epoch, intents lost, counters reset, inventory rebuilt from tip blobs', async () => {
    const api = new FakeWalletApi();
    const source = await seedToken(api, A);
    const out = makeMeta({ tokenId: source.tokenId, consumedStates: [source.stateHash], ownerPubkey: B.chainPubkey });
    await storeBlob(api, out);
    await api.putIntent(A, { transferId: 'doomed', payload: 'p' });
    await api.appendHistory(A, [
      { dedupKey: 'k', id: randomUUID(), type: 'SENT', assets: [{ coinId: COIN, amount: '1' }], ts: '2026-02-01T00:00:00Z' },
    ]);
    expect(api.bumpEpoch()).toBe(2);
    expect(api.syncEpoch).toBe(2);
    expect(await api.listIntents(A, 'open')).toEqual([]);
    expect(api.inspectIntent(A, 'doomed')).toBeUndefined();
    expect((await api.listHistory(A)).records).toEqual([]);
    const rebuiltB = await api.listInventory(B);
    expect(rebuiltB.items).toEqual([
      expect.objectContaining({ tokenId: out.tokenId, stateHash: out.stateHash, status: 'active', seq: 1 }),
    ]);
    expect((await api.listInventory(A)).items).toEqual([]);
    const mailbox = await api.listMailbox(B);
    expect(mailbox.entries).toEqual([
      expect.objectContaining({ entryId: entryIdFor(out.tokenId, out.stateHash), status: 'unclaimed', seq: 1 }),
    ]);
  });

  it('delivers wake frames as {stream, syncEpoch} per affected owner, and the lossy toggle drops them', async () => {
    const api = new FakeWalletApi();
    const framesB: WakeEvent[] = [];
    const unsubscribe = api.onWake(ownerIdOf(B), (event) => framesB.push(event));
    const fresh = makeMeta({ ownerPubkey: B.chainPubkey });
    await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key: await storeBlob(api, fresh),
      transferId: 'w1',
      stateHash: fresh.stateHash,
      tokenId: fresh.tokenId,
    });
    expect(framesB).toEqual([{ stream: 'mailbox', syncEpoch: 1 }]);
    await api.claim(B, { entryIds: [entryIdFor(fresh.tokenId, fresh.stateHash)], intoInventory: true });
    expect(framesB).toEqual([
      { stream: 'mailbox', syncEpoch: 1 },
      { stream: 'inventory', syncEpoch: 1 },
    ]);
    api.setLossyWakes(true);
    const dropped = makeMeta({ ownerPubkey: B.chainPubkey });
    await api.deposit(A, {
      recipientPubkey: B.chainPubkey,
      key: await storeBlob(api, dropped),
      transferId: 'w2',
      stateHash: dropped.stateHash,
      tokenId: dropped.tokenId,
    });
    expect(framesB).toHaveLength(2);
    api.setLossyWakes(false);
    unsubscribe();
    await api.createRequest(A, { toPubkey: B.chainPubkey, assets: [{ coinId: COIN, amount: '1' }] });
    expect(framesB).toHaveLength(2);
  });
});

describe('FakeGateway — observed M7 gateway semantics (CLAUDE.md E.2 note, 2026-06-12)', () => {
  async function conflictingMints(): Promise<{
    certA: CertificationData;
    certB: CertificationData;
    stateId: StateId;
  }> {
    const tokenType = new TokenType(Uint8Array.from(Buffer.from('11'.repeat(32), 'hex')));
    const salt = TokenSalt.fromBytes(Uint8Array.from(Buffer.from('22'.repeat(32), 'hex')));
    const recipientA = SignaturePredicate.create(new SigningService(SigningService.generatePrivateKey()).publicKey);
    const recipientB = SignaturePredicate.create(new SigningService(SigningService.generatePrivateKey()).publicKey);
    const txA = await MintTransaction.create(NetworkId.LOCAL, recipientA, new TextEncoder().encode('A'), tokenType, salt);
    const txB = await MintTransaction.create(NetworkId.LOCAL, recipientB, new TextEncoder().encode('B'), tokenType, salt);
    const certA = await CertificationData.fromMintTransaction(txA);
    const certB = await CertificationData.fromMintTransaction(txB);
    const stateIdA = await StateId.fromCertificationData(certA);
    const stateIdB = await StateId.fromCertificationData(certB);
    expect(HexConverter.encode(stateIdA.data)).toBe(HexConverter.encode(stateIdB.data));
    expect(HexConverter.encode(certA.transactionHash.data)).not.toBe(HexConverter.encode(certB.transactionHash.data));
    return { certA, certB, stateId: stateIdA };
  }

  it('answers SUCCESS for duplicate AND conflicting submits — the status carries no conflict signal', async () => {
    const gateway = FakeGateway.create();
    const { certA, certB } = await conflictingMints();
    expect((await gateway.submitCertificationRequest(certA)).status).toBe(CertificationStatus.SUCCESS);
    expect((await gateway.submitCertificationRequest(certA)).status).toBe(CertificationStatus.SUCCESS);
    expect((await gateway.submitCertificationRequest(certB)).status).toBe(CertificationStatus.SUCCESS);
    expect(gateway.submits.map((submit) => submit.kind)).toEqual(['first', 'duplicate', 'conflict']);
  });

  it('is first-write-wins per stateId: the proof carries the FIRST transaction, not the conflicting one', async () => {
    const gateway = FakeGateway.create();
    const { certA, certB, stateId } = await conflictingMints();
    await gateway.submitCertificationRequest(certA);
    await gateway.submitCertificationRequest(certB);
    const proof = await gateway.getInclusionProof(stateId);
    expect(proof.inclusionProof.certificationData).not.toBeNull();
    expect(proof.inclusionProof.certificationData?.toCBOR()).toEqual(certA.toCBOR());
  });

  it('re-encodes refetched proofs byte-unstably: same certificationData, different proof bytes', async () => {
    const gateway = FakeGateway.create();
    const { certA, stateId } = await conflictingMints();
    await gateway.submitCertificationRequest(certA);
    const first = await gateway.getInclusionProof(stateId);
    const second = await gateway.getInclusionProof(stateId);
    expect(Buffer.from(first.inclusionProof.toCBOR()).equals(Buffer.from(second.inclusionProof.toCBOR()))).toBe(false);
    expect(first.inclusionProof.certificationData?.toCBOR()).toEqual(second.inclusionProof.certificationData?.toCBOR());
    expect(first.inclusionProof.certificationData?.toCBOR()).toEqual(certA.toCBOR());
  });

  it('unknown-status mode certifies the request but answers a status outside CertificationStatus', async () => {
    const gateway = FakeGateway.create();
    const { certA, stateId } = await conflictingMints();
    gateway.setSubmitMode('unknown-status');
    const response = await gateway.submitCertificationRequest(certA);
    expect(response.status).toBe(FAKE_UNKNOWN_STATUS);
    expect(Object.values(CertificationStatus)).not.toContain(response.status);
    gateway.setSubmitMode('normal');
    const proof = await gateway.getInclusionProof(stateId);
    expect(proof.inclusionProof.certificationData?.toCBOR()).toEqual(certA.toCBOR());
  });

  it('timeout mode rejects the proof fetch (the ProofUnconfirmed keep-open path)', async () => {
    const gateway = FakeGateway.create();
    const { certA, stateId } = await conflictingMints();
    await gateway.submitCertificationRequest(certA);
    gateway.setProofMode('timeout');
    await expect(gateway.getInclusionProof(stateId)).rejects.toBeInstanceOf(FakeGatewayTimeoutError);
    gateway.setProofMode('normal');
    await expect(gateway.getInclusionProof(stateId)).resolves.toBeDefined();
  });

  it('is a drop-in aggregator client: the real engine mints and verifies over churned proofs', async () => {
    const gateway = FakeGateway.create();
    const engine = createTestEngine({ aggregator: gateway.inner, wireClient: gateway });
    const token = await engine.mint({ recipientPubkey: engine.getIdentity().chainPubkey, value: null });
    expect(token.blob.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(await engine.isOwnedBy(token, engine.getIdentity().chainPubkey)).toBe(true);
  });
});
