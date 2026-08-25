/**
 * The optional `ackBatch` on DeliveryPort (#757) is only implementable by a
 * consumer who can NAME its contract. The method shipped on the exported
 * interface while its request/outcome shapes and the retryable signal stayed
 * internal, so a custom port could satisfy the compiler only by duplicating the
 * unions or deep-importing a path the export map does not expose.
 */
import { describe, expect, it } from 'vitest';

import * as paymentsV2 from '../../../modules/payments-v2/index';
import type { AckOutcome, AckRequest, DeliveryPort, RetryableAckError } from '../../../modules/payments-v2/index';

describe('payments-v2 public surface — the ackBatch contract', () => {
  it('lets a consumer implement ackBatch using only the public barrel', () => {
    // Compiles only while every type the signature mentions is exported.
    const port: Pick<DeliveryPort, 'ackBatch'> = {
      ackBatch: async (acks: readonly AckRequest[]): Promise<readonly AckOutcome[]> =>
        acks.map((a) => ({ deliveryId: a.deliveryId, status: 'settled' as const })),
    };

    expect(port.ackBatch).toBeTypeOf('function');
  });

  it('exports the retryable signal, not just the shape of a failure', () => {
    // Without this a custom port cannot tell the caller "a per-entry retry hits
    // the same wall" — which is what stops one 429 becoming N of them.
    const err: RetryableAckError = Object.assign(new Error('rate limited'), { retryable: true as const });

    expect(paymentsV2.isRetryableAckError(err)).toBe(true);
    expect(paymentsV2.isRetryableAckError(new Error('plain'))).toBe(false);
  });
});
