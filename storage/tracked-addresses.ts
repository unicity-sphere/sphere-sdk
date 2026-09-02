import type { TrackedAddressEntry } from '../types';

/** On-disk shape of the global `tracked_addresses` key. */
export interface TrackedAddressesFile {
  version: 1;
  addresses: TrackedAddressEntry[];
}

/** A BIP32 child number is a uint32 — see the port docstring for why. */
function isDerivableIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Repair, don't drop — except an underivable index, which would alias a real address. */
function toEntry(value: unknown): TrackedAddressEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (!isDerivableIndex(e.index)) return null;
  return {
    ...e,
    index: e.index,
    hidden: e.hidden === true,
    createdAt: num(e.createdAt, 0),
    updatedAt: num(e.updatedAt, 0),
  } as TrackedAddressEntry;
}

/** Tolerant read: unusable JSON and a wrong top-level shape both read as absent. */
export function parseTrackedAddresses(raw: string | null): TrackedAddressEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const addresses = (parsed as { addresses?: unknown }).addresses;
  if (!Array.isArray(addresses)) return [];
  const entries: TrackedAddressEntry[] = [];
  for (const row of addresses) {
    const entry = toEntry(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Union `incoming` (one writer's snapshot) into `onDisk` by `index`, sorted by index.
 * On a conflict the greater `updatedAt` supplies `hidden` (ties keep `incoming`) and the
 * earlier `createdAt` survives — safe because nothing removes a single entry; see
 * `StorageProvider.saveTrackedAddresses` (#766 item 5).
 */
export function mergeTrackedAddresses(
  onDisk: readonly TrackedAddressEntry[],
  incoming: readonly TrackedAddressEntry[],
): TrackedAddressEntry[] {
  const merged = new Map<number, TrackedAddressEntry>();
  for (const entry of onDisk) merged.set(entry.index, entry);

  for (const entry of incoming) {
    const existing = merged.get(entry.index);
    if (!existing) {
      merged.set(entry.index, entry);
      continue;
    }
    const winner = entry.updatedAt >= existing.updatedAt ? entry : existing;
    merged.set(entry.index, {
      ...existing,
      ...winner,
      index: entry.index,
      createdAt: Math.min(existing.createdAt, entry.createdAt),
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.index - b.index);
}
