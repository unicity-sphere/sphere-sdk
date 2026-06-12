/**
 * Epoch + account-delete vectors (§8.1) — server-key cross-plan interop.
 *
 * The epoch vector is signed with `SERVER_SIGN_PRIV = 'a'.repeat(64)`, whose
 * compressed pubkey IS `NETWORKS.testnet2.vaultServerKey`. So the SDK can verify
 * the server's exact `epochSig` against the PINNED network key — proving the
 * cross-plan epoch attestation holds without trusting any client-supplied key.
 *
 * The account-delete vector (shared with Task 2.1) is a SCHEME fixture for the
 * `account-delete:v1` literal; the runtime delete template (Phase 7) is
 * `unicity:vault:delete:v1` (see `vault-aead/canon.ts`).
 */

import { describe, it, expect } from 'vitest';

import { epochCanon } from '../../../vault-aead/canon';
import { signMessage, verifySignedMessage } from '../../../core/crypto';
import { NETWORKS } from '../../../constants';
import vectors from '../../fixtures/vault-signing-vectors.json';

const { epoch, accountDelete } = vectors;

describe('vault epoch + account-delete vectors', () => {
  it('epochCanon literal is exact', () => {
    expect(epochCanon('testnet2', 7)).toBe('unicity:vault:epoch:v1\ntestnet2\n7');
  });

  it('signMessage(SERVER_SIGN_PRIV, epochCanon) === pinned epochSig', () => {
    expect(signMessage(epoch.serverPriv, epochCanon(epoch.network, epoch.epoch))).toBe(
      epoch.epochSig,
    );
  });

  it('SDK verifies the server epoch sig under the PINNED NETWORKS.testnet2.vaultServerKey', () => {
    expect(NETWORKS.testnet2.vaultServerKey).toBe(epoch.serverPubkey);
    expect(
      verifySignedMessage(
        epochCanon(epoch.network, epoch.epoch),
        epoch.epochSig,
        NETWORKS.testnet2.vaultServerKey,
      ),
    ).toBe(true);
  });

  it('account-delete scheme vector verifies under its keypair', () => {
    expect(
      verifySignedMessage(accountDelete.message, accountDelete.signature, accountDelete.pubkey),
    ).toBe(true);
  });
});
