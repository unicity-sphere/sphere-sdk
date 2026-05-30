import { describe, expect, it, vi } from 'vitest';
import { createTransportAddressResolver } from '../../../core/transport-resolver';

describe('createTransportAddressResolver', () => {
  it('resolves DIRECT addresses with lowercase scheme fallback', async () => {
    const resolver = createTransportAddressResolver({
      resolve: vi.fn().mockResolvedValue(null),
      resolveAddressInfo: vi.fn().mockResolvedValue(null),
    });

    await expect(resolver.resolve('direct://' + '02' + 'a'.repeat(64))).resolves.toEqual({
      pubkey: 'a'.repeat(64),
    });
  });
});
