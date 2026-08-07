// §5.1 restore — THE invariant, once: after a syncEpoch change, intents and
// checkpoint progress re-seed from the §6 backstops BEFORE anything resumes;
// no stream resumes a pre-restore cursor; a rejected re-seed KEEPS+alerts (E.3).

import { STORE_KEYS, type ScopedKV, type StreamName } from './stores';
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
}

export async function reseedAndReset(deps: RestoreDeps): Promise<void> {
  for (const entry of await deps.stores.backstop.list()) {
    if (entry.disposition !== 'open') continue; // #676: a local abort is never resurrected
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

// E.1: split = direct.length.
async function splitOpIndex(deps: RestoreDeps, envelope: string): Promise<number> {
  const payload = (await deps.decryptPayload(envelope)) as Partial<IntentPayload>;
  return Array.isArray(payload.direct) ? payload.direct.length : 0;
}
