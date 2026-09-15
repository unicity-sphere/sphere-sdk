/**
 * New group ids: a slug of the group's name and a random part.
 *
 * A name-only id is reused when a group is deleted and one with the same name is created, and it
 * lets anyone guess a hidden group's id from its name. The random part prevents both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupIdSlug, newGroupId } from '../../../modules/groupchat/group-id';

function stubRandomBytes(bytes: number[]): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    array.set(bytes.slice(0, array.length));
    return array;
  }) as typeof globalThis.crypto.getRandomValues);
}

describe('groupIdSlug', () => {
  it.each([
    ['General', 'general'],
    ['Unicity Devs', 'unicity-devs'],
    ['My Team’s Chat!!!', 'my-teams-chat'],
    ["Rock 'n' Roll", 'rock-n-roll'],
    ['Café Crème ☕', 'cafe-creme'],
    ['  --Hello__World--  ', 'hello-world'],
    // 24 characters exactly: kept whole.
    ['abcdefghij klmnopqrstuvw', 'abcdefghij-klmnopqrstuvw'],
    // The 25th character is a hyphen: cut right before it.
    ['abcdefghij klmnopqrstuvw x', 'abcdefghij-klmnopqrstuvw'],
    // A word crossing the 24th character is dropped whole.
    ['Unicity Network Community Discussion Group', 'unicity-network'],
    // A single word longer than 24 characters is cut at 24.
    ['Supercalifragilisticexpialidocious', 'supercalifragilisticexpi'],
    ['Кофейня', ''],
    ['日本語チャット', ''],
    ['🚀🚀🚀', ''],
  ])('%j → %j', (name, want) => {
    expect(groupIdSlug(name)).toBe(want);
  });
});

describe('newGroupId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('appends 16 hex characters from crypto.getRandomValues to the slug', () => {
    stubRandomBytes([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67]);
    expect(newGroupId('Unicity Devs')).toBe('unicity-devs-deadbeef01234567');
  });

  it('uses "group" when the name has no Latin letters or digits', () => {
    stubRandomBytes([0x00, 0x0f, 0xa0, 0xff, 0x10, 0x20, 0x30, 0x40]);
    expect(newGroupId('Кофейня')).toBe('group-000fa0ff10203040');
  });

  it('gives two groups with the same name different ids', () => {
    expect(newGroupId('General')).not.toBe(newGroupId('General'));
  });

  it('refuses to build an id without crypto.getRandomValues', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => newGroupId('General')).toThrow();
  });
});
