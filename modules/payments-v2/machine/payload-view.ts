import type { CoinIntentPayload, IntentPayload, CoinlessIntentPayload } from './types';

export function isCoinlessIntent(p: IntentPayload): p is CoinlessIntentPayload {
  return p.kind === 'coinless';
}

export function isCoinIntent(p: IntentPayload): p is CoinIntentPayload {
  return p.kind === 'coin';
}

export function splitOf(p: IntentPayload): CoinIntentPayload['split'] {
  return p.kind === 'coin' ? p.split : undefined;
}

/** The coin spent, or undefined when token-addressed. Handle absence, never ''. */
export function coinIdOf(p: IntentPayload): string | undefined {
  return p.kind === 'coin' ? p.coinId : undefined;
}

