/**
 * Sphere Connect — Core (transport-agnostic)
 *
 * Host (wallet side):
 *   import { ConnectHost } from '@unicitylabs/sphere-sdk/connect';
 *
 * Client (dApp side):
 *   import { ConnectClient } from '@unicitylabs/sphere-sdk/connect';
 */

export { ConnectHost } from './host/ConnectHost';
export { ConnectClient, ConnectError } from './client/ConnectClient';

// Protocol
export {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
  RPC_METHODS,
  INTENT_ACTIONS,
  ERROR_CODES,
  WALLET_EVENTS,
  AUTO_PUSHED_EVENTS,
  isAutoPushedEvent,
  SPHERE_NETWORKS,
  isSphereConnectMessage,
  createRequestId,
} from './protocol';

export type {
  RpcMethod,
  IntentAction,
  ErrorCode,
  WalletEvent,
  SphereRpcRequest,
  SphereRpcResponse,
  SphereIntentRequest,
  SphereIntentResult,
  SphereEventMessage,
  SphereHandshake,
  SphereRpcError,
  SphereConnectMessage,
  DAppMetadata,
  PublicIdentity,
  WalletLockedData,
  WalletLockedPayload,
  WalletUnlockedPayload,
  WalletDisconnectedPayload,
  WalletIdentityChangedPayload,
  NetworkInfo,
} from './protocol';

// Permissions
export {
  PERMISSION_SCOPES,
  ALL_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  METHOD_PERMISSIONS,
  INTENT_PERMISSIONS,
  hasMethodPermission,
  hasIntentPermission,
  validatePermissions,
} from './permissions';

export type { PermissionScope } from './permissions';

// NFT wire form (mint_nft intent)
export { nftContentToWire, nftContentFromWire } from './nft-wire';
export type {
  MintNftIntentParams,
  MintNftIntentResult,
  WireNftContent,
  WireNftMedia,
  WireNftMetadata,
} from './nft-wire';
export type {
  NftAttribute,
  NftContent,
  NftLink,
  NftMedia,
  NftMediaRef,
  NftMetadata,
} from '../token-engine/nft-payload';

// Types
export type {
  ConnectTransport,
  ConnectSession,
  ConnectHostConfig,
  ConnectClientConfig,
  ConnectResult,
  ConnectEventHandler,
  WalletState,
  LockedRequestContext,
  IntentContext,
} from './types';
