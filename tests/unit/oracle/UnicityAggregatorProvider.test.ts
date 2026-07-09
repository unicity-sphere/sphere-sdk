import { describe, it, expect } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';

/**
 * Runtime API-key swap on the oracle (feat: oracle-api-key-setter). Lets a
 * consumer inject a per-wallet subscription key provisioned AFTER init without
 * rebuilding the whole Sphere. (Sphere.setOracleApiKey() rebuilds the token
 * engine so the change also reaches money ops — covered by Sphere/PaymentsModule
 * tests; here we lock the provider-level accessor.)
 */
describe('UnicityAggregatorProvider.setApiKey', () => {
  const make = (apiKey?: string) =>
    new UnicityAggregatorProvider({ url: 'https://gateway.example', apiKey });

  it('updates the live key read by getApiKey()', () => {
    const p = make('sk_old');
    expect(p.getApiKey()).toBe('sk_old');
    p.setApiKey('sk_new');
    expect(p.getApiKey()).toBe('sk_new');
  });

  it('can set a key on a provider that started without one', () => {
    const p = make();
    expect(p.getApiKey()).toBeUndefined();
    p.setApiKey('sk_first');
    expect(p.getApiKey()).toBe('sk_first');
  });

  it('an empty key clears back to undefined (no auth header)', () => {
    const p = make('sk_old');
    p.setApiKey('');
    expect(p.getApiKey()).toBeUndefined();
  });
});
