// §5.1 restore — THE invariant, once: after a syncEpoch change, intents and
// checkpoint progress re-seed from the §6 backstops BEFORE anything resumes;
// no stream resumes a pre-restore cursor; a rejected re-seed KEEPS+alerts (E.3).

import { STORE_KEYS, type IntentBackstopEntry, type ScopedKV, type StreamName } from './stores';
import type { AttentionEmitter, MachineStores } from './machine/journal';
import type { IntentPayload } from './machine/types';

export const ATTENTION_RESEED_REJECTED = 'intent:reseed-rejected';

const ALL_STREAMS: readonly StreamName[] = ['inventory', 'mailbox', 'payment_requests', 'history'];

export interface RestoreDeps {
  readonly stores: MachineStores;
  readonly kv: ScopedKV;
  readonly reput: (transferId: string, envelope: string, requiresSeedClose: boolean) => Promise<void>;
  readonly reseedCheckpoint: (transferId: string, opIndex: number) => Promise<boolean>;
  readonly decryptPayload: (envelope: string) => Promise<unknown>;
  readonly fullRePull: () => Promise<void>;
  readonly attention: AttentionEmitter;
  readonly onReseedStart?: () => void; // #835: before the read, so a send it overlaps never reports clean
}

export async function reseedAndReset(deps: RestoreDeps): Promise<void> {
  deps.onReseedStart?.();
  for (const listed of await deps.stores.backstop.list()) {
    const entry = await deps.stores.backstop.getByKey(listed.transferId).catch(() => listed);
    if (!isReseedable(entry)) continue;
    try {
      await deps.reput(entry.transferId, entry.payloadEnvelope, entry.requiresSeedClose);
      if (entry.requiresSeedClose) {
        await deps.reseedCheckpoint(entry.transferId, await splitOpIndex(deps, entry.payloadEnvelope));
      }
    } catch (err) {
      deps.attention(entry.transferId, ATTENTION_RESEED_REJECTED, err instanceof Error ? err.message : String(err));
    }
  }
  for (const stream of ALL_STREAMS) await deps.kv.remove(STORE_KEYS.streamCursor(stream));
  await deps.fullRePull();
}

/** Re-read fresh (a send may fence it mid-reseed): never a local abort (#676), nor a PUT never acked (#835). */
function isReseedable(entry: IntentBackstopEntry | undefined): entry is IntentBackstopEntry {
  return entry !== undefined && entry.disposition === 'open' && entry.intentPut === undefined;
}

// E.1: split = direct.length.
async function splitOpIndex(deps: RestoreDeps, envelope: string): Promise<number> {
  const payload = (await deps.decryptPayload(envelope)) as Partial<IntentPayload>;
  return Array.isArray(payload.direct) ? payload.direct.length : 0;
}
