import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';
import type { Token } from '../../types';

import { buildWholePayload } from './machine/payload';
import { buildOps, type MachinePlan } from './machine/TransferMachine';
import type { SendWholeTokenRequest } from './api';
import { transferringToken, type RegistryReader } from './inventory/presentation';
import type { StoragePort } from './ports';

export interface WholeSpendDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
  readonly registry: RegistryReader;
  readonly now: number;
}

export interface WholeSpendInput {
  readonly transferId: string;
  readonly recipientPubkey: string;
  readonly request: SendWholeTokenRequest;
  readonly sourceIds: readonly string[];
  /** NFT-scoped entry point sets this: `nft:transfer` must not move coins. */
  readonly requireCoinless: boolean;
}

/**
 * The token-addressed twin of the facade's `materialize`: one named source, never a
 * split. `sourceTokens` become the result's `tokens`, so they list every asset the
 * named token carries — empty only for a coinless one, which moves no amount.
 */
export async function materializeWholeSpend(
  deps: WholeSpendDeps,
  input: WholeSpendInput
): Promise<{
  transferId: string;
  coinId: string;
  plan: MachinePlan;
  sourceIds: readonly string[];
  sourceTokens: Token[];
}> {
  const { engine } = deps;
  const tokenId = input.request.tokenId;
  const bytes = (await deps.storagePort.getBlobs([tokenId])).get(tokenId);
  if (bytes === undefined) {
    throw new SphereError(`Selected source ${tokenId} has no blob in storage`, 'STORAGE_ERROR');
  }
  const token = await engine.decodeToken({ tokenId, token: bytes });
  // A whole spend moves the token AS IS, so a valued source is fine. `bare_collection`
  // is not: its coins are real but undecodable here, so the move would happen while
  // history could only say `assets: []`. The BLOB decides, never the mirror.
  if (token.valueEnvelope === 'bare_collection') {
    throw new SphereError(
      `Token ${tokenId} carries a value envelope this SDK cannot read, so its coins ` +
        'cannot be accounted for; it cannot be sent',
      'VALIDATION_ERROR'
    );
  }
  if (input.requireCoinless && token.value !== null) {
    throw new SphereError(
      `Token ${tokenId} carries coin value and cannot be sent with sendCoinless — use ` +
        'sendWholeToken, which requires coin-transfer authority',
      'VALIDATION_ERROR'
    );
  }
  const keys = await engine.deliveryKeys(bytes);
  const payload = buildWholePayload(input.recipientPubkey, input.request, {
    [tokenId]: { local: keys.stateHash, protocol: keys.stateHash },
  });
  const plan: MachinePlan = {
    transferId: input.transferId,
    recipientPubkey: input.recipientPubkey,
    payload,
    ops: buildOps(payload),
    sources: new Map([[tokenId, token]]),
    ...(input.request.memo !== undefined ? { memo: input.request.memo } : {}),
  };
  const sourceTokens = (token.value?.assets ?? []).map((asset) =>
    transferringToken(tokenId, asset.coinId, asset.amount, deps.registry, deps.now)
  );
  return { transferId: input.transferId, coinId: '', plan, sourceIds: input.sourceIds, sourceTokens };
}
