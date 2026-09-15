import { SphereError } from '../../core/errors';

const MAX_SLUG_LENGTH = 24;
const RANDOM_BYTES = 8;

export function groupIdSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const head = slug.slice(0, MAX_SLUG_LENGTH + 1);
  const hyphen = head.lastIndexOf('-');
  return hyphen > 0 ? head.slice(0, hyphen) : slug.slice(0, MAX_SLUG_LENGTH);
}

export function newGroupId(name: string): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues !== 'function') {
    // Math.random is predictable, and a predictable id lets a hidden group be guessed.
    throw new SphereError('Creating a group requires crypto.getRandomValues', 'INVALID_CONFIG');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${groupIdSlug(name) || 'group'}-${random}`;
}
