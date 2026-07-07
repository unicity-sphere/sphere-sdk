/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * v1 on-chain nametag minting facade (now atop the v2 anti-corruption layer).
 *
 * Phase 6.P2.3 rewrote {@link NametagMinter} to take an `ITokenEngine`. This
 * facade continues to bridge `PaymentsModule.mintNametag` into that helper so
 * the public API and event-emission side-effects stay backward-compatible.
 * When Phase 6.P2.4 wires `tokenEngine` on PaymentsModule deps, this file
 * becomes a pass-through and is scheduled for deletion.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NametagMinter, type MintNametagResult } from '../NametagMinter';
import { logger } from '../../../core/logger';

export async function mintNametagImpl(this: any, nametag: string): Promise<MintNametagResult> {
  this.ensureInitialized();

  const tokenEngine = this.deps!.tokenEngine;
  if (!tokenEngine) {
    return {
      success: false,
      error: 'Token engine not available. Sphere must wire deps.tokenEngine (Phase 6.P2.4).',
    };
  }

  try {
    const minter = new NametagMinter({
      tokenEngine,
      debug: this.moduleConfig.debug,
    });

    const result = await minter.mintNametag(nametag);

    if (result.success && result.nametagData) {
      await this.setNametag(result.nametagData);
      logger.debug('Payments', `Unicity ID minted and saved: ${result.nametagData.name}`);

      this.deps!.emitEvent('nametag:registered', {
        nametag: result.nametagData.name,
        addressIndex: 0,
      });
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.debug('Payments', 'mintNametag failed:', errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}
