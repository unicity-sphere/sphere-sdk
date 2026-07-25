/**
 * Every accepted request id, with its own bounded host-side timer.
 *
 * The single convergence point for every exit: router resolved, router threw, onIntent
 * settled or threw, host deadline, setLocked, revokeSession, setUnavailable, destroy.
 * Because settle() returns null the second time, "exactly one frame per id" is a property
 * of this class rather than of every call site.
 *
 * SYNCHRONOUS by design — no `await` anywhere inside. Frame-agnostic: it knows deadlines
 * and kinds, never how to send. Same idiom as PaymentsModule.pendingResponseResolvers.
 */

import { logger } from '../../core/logger';

export type InFlightKind = 'query' | 'intent';

export interface InFlightEntry {
  readonly id: string;
  readonly kind: InFlightKind;
  /** Epoch ms. */
  readonly deadline: number;
  /** Aborted by settle() / settleAll() / expiry. Feeds IntentContext.signal. */
  readonly controller: AbortController;
}

export interface InFlightRegistryOptions {
  /** Called when an entry's own timer fires. The entry is ALREADY removed and aborted, so
   *  the sink just sends the frame (INTERNAL_ERROR for a query, INTENT_CANCELLED 4200 for
   *  an intent). */
  readonly onExpire: (entry: InFlightEntry) => void;
}

interface Slot {
  readonly entry: InFlightEntry;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class InFlightRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly onExpire: (entry: InFlightEntry) => void;

  constructor(options: InFlightRegistryOptions) {
    this.onExpire = options.onExpire;
  }

  get size(): number {
    return this.slots.size;
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  /** Register BEFORE the first await and arm the timer AT INSERTION TIME.
   *  A duplicate id is a protocol violation: warn and reuse the existing entry, so a
   *  hostile or buggy client cannot arm unbounded timers by replaying one id. */
  add(id: string, kind: InFlightKind, deadlineMs: number): InFlightEntry {
    const existing = this.slots.get(id);
    if (existing) {
      logger.warn('InFlightRegistry', `Duplicate request id, reusing entry: ${id}`);
      return existing.entry;
    }

    const entry: InFlightEntry = {
      id,
      kind,
      deadline: Date.now() + deadlineMs,
      controller: new AbortController(),
    };
    const timer = setTimeout(() => {
      this.slots.delete(id);
      entry.controller.abort();
      this.onExpire(entry);
    }, deadlineMs);

    this.slots.set(id, { entry, timer });
    return entry;
  }

  /** Remove + abort BEFORE the caller sends. Returns the entry, or null when it was
   *  already settled — in which case the caller MUST send nothing. */
  settle(id: string): InFlightEntry | null {
    const slot = this.slots.get(id);
    if (!slot) {
      logger.warn('InFlightRegistry', `Already settled, dropping second answer: ${id}`);
      return null;
    }
    this.slots.delete(id);
    clearTimeout(slot.timer);
    slot.entry.controller.abort();
    return slot.entry;
  }

  /** Settle every entry, in insertion order, aborting each. The caller sends one frame per
   *  returned entry. Used by setLocked (4009), revokeSession (4001), destroy (4001). */
  settleAll(): InFlightEntry[] {
    const out: InFlightEntry[] = [];
    for (const slot of this.slots.values()) {
      clearTimeout(slot.timer);
      slot.entry.controller.abort();
      out.push(slot.entry);
    }
    this.slots.clear();
    return out;
  }

  /** Clear all timers WITHOUT invoking onExpire. Host teardown only. */
  destroy(): void {
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots.clear();
  }
}
