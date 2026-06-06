import { describe, it, expect } from 'vitest';
import { isV2TransferPayload } from '../../../types/v2-transfer';

describe('isV2TransferPayload', () => {
  it('accepts a well-formed v2 transfer payload', () => {
    expect(isV2TransferPayload({ type: 'V2_TRANSFER', version: '2.0', tokenBlob: 'ab12cd' })).toBe(true);
    expect(isV2TransferPayload({ type: 'V2_TRANSFER', version: '2.0', tokenBlob: 'ff', memo: 'hi' })).toBe(true);
  });

  it('rejects legacy / malformed / non-v2 payloads', () => {
    expect(isV2TransferPayload({ sourceToken: 'x', transferTx: 'y' })).toBe(false); // v1 Sphere wallet
    expect(isV2TransferPayload({ type: 'INSTANT_SPLIT', tokenBlob: 'ab' })).toBe(false); // wrong type
    expect(isV2TransferPayload({ type: 'V2_TRANSFER', version: '2.0' })).toBe(false); // no tokenBlob
    expect(isV2TransferPayload({ type: 'V2_TRANSFER', tokenBlob: '' })).toBe(false); // empty tokenBlob
    expect(isV2TransferPayload(null)).toBe(false);
    expect(isV2TransferPayload('V2_TRANSFER')).toBe(false);
  });
});
