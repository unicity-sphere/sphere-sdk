// #847 phase 1: a DIRECT:// identifier is the wallet's Sphere Quests account id,
// never a payment recipient. Resolving one goes through a relay-supplied identity
// binding, so whatever the relay returned decided who got paid. The money gates
// now refuse it BEFORE any resolution, reservation, blob read or intent PUT.
//
// Every world here resolves ANY identifier to a valid same-network peer, which is
// exactly what made the old path dangerous: without the refusal each of these
// sends would deliver.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPossiblyCommittedSendOutcome, SphereError } from '../../../core/errors';
import {
  DIRECT_RECIPIENT_REFUSED_MESSAGE,
  isDirectAddressRecipient,
} from '../../../modules/payments-v2';
import type { PeerInfo } from '../../../transport';
import { COIN, NET, PEER_PUB, cleanupWorlds, eventsOf, makeWorld, peerBinding, type World } from './facade-harness';

afterEach(cleanupWorlds);

const DIRECT = 'DIRECT://0000' + 'ab'.repeat(32) + '01020304';
const SPELLINGS: readonly [string, string][] = [
  ['upper case', DIRECT],
  ['lower case', DIRECT.toLowerCase()],
  ['leading whitespace', `  ${DIRECT}`],
  ['an @ prefix', `@${DIRECT}`],
];

/** A world whose relay answers every lookup with a valid, same-network peer binding. */
function anyIdentifierResolves(): { world: World; resolvePeer: ReturnType<typeof vi.fn> } {
  const resolvePeer = vi.fn(async (_identifier: string): Promise<PeerInfo | null> => peerBinding({ network: NET }));
  return { world: makeWorld({ resolvePeer }), resolvePeer };
}

async function refusalOf(send: Promise<unknown>): Promise<SphereError> {
  const caught = await send.then(
    () => undefined,
    (err: unknown) => err
  );
  expect(caught).toBeInstanceOf(SphereError);
  return caught as SphereError;
}

/** The refusal is clean and early: nothing resolved, reserved, read, PUT or signed. */
function expectCleanEarlyRefusal(world: World, resolvePeer: ReturnType<typeof vi.fn>, err: SphereError): void {
  expect(err.code).toBe('INVALID_RECIPIENT');
  expect(err.message).toBe(DIRECT_RECIPIENT_REFUSED_MESSAGE);
  expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
  expect(err.transferId).toBeUndefined();
  expect(resolvePeer).not.toHaveBeenCalled();
  expect(world.counters.putIntent).toBe(0);
  expect(world.engine.transferCalls).toHaveLength(0);
  expect(world.facade.tokens().every((t) => t.status === 'confirmed')).toBe(true);
  expect(world.facade.coinless().every((t) => !t.transferring)).toBe(true);
}

describe('#847 DIRECT:// is not a payment recipient — send', () => {
  it.each(SPELLINGS)('send() to a DIRECT:// recipient (%s) is refused before resolution', async (_label, recipient) => {
    const { world, resolvePeer } = anyIdentifierResolves();
    await world.seed(100n);
    await world.facade.start();

    const err = await refusalOf(world.facade.send({ recipient, amount: '100', coinId: COIN }));

    expectCleanEarlyRefusal(world, resolvePeer, err);
    // The same clean-failure emission an unresolvable recipient gets: no transferId exists yet.
    expect(eventsOf(world, 'transfer:updated')).toEqual([
      expect.objectContaining({ id: '', status: 'failed', error: DIRECT_RECIPIENT_REFUSED_MESSAGE }),
    ]);
    // Nothing stayed reserved: the whole balance still goes to a real recipient.
    const ok = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(ok.status).toBe('delivered');
  });

  it.each(SPELLINGS)('sendWholeToken() to a DIRECT:// recipient (%s) is refused before resolution', async (_label, recipient) => {
    const { world, resolvePeer } = anyIdentifierResolves();
    const token = await world.seed(100n);
    await world.facade.start();

    const err = await refusalOf(world.facade.sendWholeToken({ recipient, tokenId: token.blob.tokenId }));

    expectCleanEarlyRefusal(world, resolvePeer, err);
  });

  it.each(SPELLINGS)('sendCoinless() to a DIRECT:// recipient (%s) is refused before resolution', async (_label, recipient) => {
    const { world, resolvePeer } = anyIdentifierResolves();
    const token = await world.seedCoinless();
    await world.facade.start();

    const err = await refusalOf(world.facade.sendCoinless({ recipient, tokenId: token.blob.tokenId }));

    expectCleanEarlyRefusal(world, resolvePeer, err);
  });

  it.each(SPELLINGS)('prewarmSend() for a DIRECT:// recipient (%s) reads nothing and throws nothing', async (_label, recipient) => {
    const { world, resolvePeer } = anyIdentifierResolves();
    await world.seed(100n);
    await world.facade.start();
    const reads: string[][] = [];
    world.hooks.getBlobs = async (ids) => {
      reads.push(ids);
    };

    await expect(world.facade.prewarmSend({ recipient, amount: '100', coinId: COIN })).resolves.toBeUndefined();

    expect(reads).toEqual([]);
    expect(resolvePeer).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: a 66-hex chain pubkey and an @nametag still send', async () => {
    const { world } = anyIdentifierResolves();
    await world.seed(50n);
    await world.seed(50n);
    await world.facade.start();

    const byPubkey = await world.facade.send({ recipient: PEER_PUB, amount: '50', coinId: COIN });
    const byNametag = await world.facade.send({ recipient: '@peer', amount: '50', coinId: COIN });

    expect([byPubkey.status, byNametag.status]).toEqual(['delivered', 'delivered']);
  });
});

describe('#847 DIRECT:// is not a payment recipient — requests.create', () => {
  it.each(SPELLINGS)('requests.create() for a DIRECT:// recipient (%s) fails without a lookup or a server call', async (_label, to) => {
    const { world, resolvePeer } = anyIdentifierResolves();
    const created = vi.spyOn(world.innerClient, 'createPaymentRequest');

    const result = await world.facade.requests.create(to, { coinId: COIN, amount: '100' });

    expect(result).toEqual({ success: false, error: DIRECT_RECIPIENT_REFUSED_MESSAGE });
    expect(resolvePeer).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: an @nametag request is still created', async () => {
    const { world } = anyIdentifierResolves();

    const result = await world.facade.requests.create('@peer', { coinId: COIN, amount: '100' });

    expect(result.success).toBe(true);
  });
});

describe('#847 isDirectAddressRecipient', () => {
  it('matches every DIRECT spelling and nothing that is a real recipient', () => {
    for (const [, spelling] of SPELLINGS) expect(isDirectAddressRecipient(spelling)).toBe(true);
    expect(isDirectAddressRecipient('@ direct:x')).toBe(true);
    for (const other of ['@alice', 'alice', PEER_PUB, PEER_PUB.slice(2), '@directory', 'directory', '', undefined, 7]) {
      expect(isDirectAddressRecipient(other)).toBe(false);
    }
  });
});
