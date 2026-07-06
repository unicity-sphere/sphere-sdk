/**
 * Helper re-exports for the worker's concurrency-cap defaults so tests
 * can pin the §6.1 / W14 normative values without re-importing
 * `limits.ts`.
 */

import {
  MAX_CONCURRENT_POLLS_PER_AGGREGATOR,
  MAX_CONCURRENT_POLLS_PER_TOKEN,
} from '../../../../extensions/uxf/pipeline/limits';

export const MAX_CONCURRENT_POLLS_PER_AGGREGATOR_DEFAULT =
  MAX_CONCURRENT_POLLS_PER_AGGREGATOR;
export const MAX_CONCURRENT_POLLS_PER_TOKEN_DEFAULT =
  MAX_CONCURRENT_POLLS_PER_TOKEN;

export { CountingSemaphore } from '../../../../extensions/uxf/pipeline/finalization-worker-sender';
