// §5.1 restore protocol — THE invariant, stated once: after the server's
// syncEpoch changes, the two non-rebuildable server tables (intents, checkpoint
// progress) are re-seeded from the local §6 backstops BEFORE anything resumes,
// and no stream may resume from a pre-restore cursor. The facade's
// handleEpochChange is the only caller (serialized with the resume machinery).

import { STORE_KEYS, type ScopedKV, type StreamName } from './stores';
import type { AttentionEmitter, MachineStores } from './machine/journal';
import type { IntentPayload } from './machine/types';

/** E.3: a rejected re-seed keeps the backstop and alerts (never a drop/abort). */
export const ATTENTION_RESEED_REJECTED = 'intent:reseed-rejected';

const ALL_STREAMS: readonly StreamName[] = ['inventory', 'mailbox', 'payment_requests', 'history'];

export interface RestoreDeps {
  readonly stores: MachineStores;
  readonly kv: ScopedKV;
  /** Byte-identical intent re-PUT (write-once-while-open server-side). */
  readonly reput: (transferId: string, envelope: string, requiresSeedClose: boolean) => Promise<void>;
  /** CheckpointReseeder.reseedCheckpoint — byte-identical ciphertext re-POST. */
  readonly reseedCheckpoint: (transferId: string, opIndex: number) => Promise<boolean>;
  readonly decryptPayload: (envelope: string) => Promise<unknown>;
  /** Reconciling full re-pull of the inventory view (per-key replace). */
  readonly fullRePull: () => Promise<void>;
  readonly attention: AttentionEmitter;
}

export async function reseedAndReset(deps: RestoreDeps): Promise<void> {
  for (const entry of await deps.stores.backstop.list()) {
    if (entry.disposition !== 'open') continue; // #676: a local abort is never resurrected
    try {
      // Intent before checkpoint: the server accepts progress appends only for
      // an existing OPEN intent.
      await deps.reput(entry.transferId, entry.payloadEnvelope, entry.requiresSeedClose);
      if (entry.requiresSeedClose) {
        await deps.reseedCheckpoint(entry.transferId, await splitOpIndex(deps, entry.payloadEnvelope));
      }
    } catch (err) {
      // E.3: the backstop may be the only copy of a possibly-certified intent —
      // KEEP it and alert; the next epoch signal retries the re-seed.
      deps.attention(entry.transferId, ATTENTION_RESEED_REJECTED, err instanceof Error ? err.message : String(err));
    }
  }
  for (const stream of ALL_STREAMS) await deps.kv.remove(STORE_KEYS.streamCursor(stream));
  await deps.fullRePull();
}

/** E.1: the split op sits at direct.length in the intent's op order. */
async function splitOpIndex(deps: RestoreDeps, envelope: string): Promise<number> {
  const payload = (await deps.decryptPayload(envelope)) as Partial<IntentPayload>;
  return Array.isArray(payload.direct) ? payload.direct.length : 0;
}
