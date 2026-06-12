import { describe, it, expect } from 'vitest';

import * as vaultAead from '../../../vault-aead/index';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';

describe('vault module skeleton', () => {
  it('vault-aead/index re-exports the module surface', () => {
    expect(typeof vaultAead.seal).toBe('function');
    expect(typeof vaultAead.open).toBe('function');
    expect(typeof vaultAead.deriveVaultKey).toBe('function');
    expect(typeof vaultAead.deriveCourierKey).toBe('function');
    expect(typeof vaultAead.lengthDelim).toBe('function');
    expect(typeof vaultAead.u64be).toBe('function');
    expect(typeof vaultAead.assertOnCurve).toBe('function');
    expect(typeof vaultAead.ecdhX).toBe('function');
    expect(typeof vaultAead.sealVaultEntry).toBe('function');
    expect(typeof vaultAead.openVaultEntry).toBe('function');
    expect(typeof vaultAead.sealCourierEnvelope).toBe('function');
    expect(typeof vaultAead.openCourierEnvelope).toBe('function');
    expect(typeof vaultAead.packCourier).toBe('function');
    expect(typeof vaultAead.unpackCourier).toBe('function');
  });

  it('CourierDeliveryProvider is a constructable class', () => {
    expect(typeof CourierDeliveryProvider).toBe('function');
  });

  it('RemoteTokenStorageProvider is a constructable class', () => {
    expect(typeof RemoteTokenStorageProvider).toBe('function');
  });
});
