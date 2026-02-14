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
export { ConnectClient } from './client/ConnectClient';

// Protocol
export {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  INTENT_ACTIONS,
  ERROR_CODES,
  isSphereConnectMessage,
  createRequestId,
} from './protocol';

export type {
  RpcMethod,
  IntentAction,
  ErrorCode,
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

// Types
export type {
  ConnectTransport,
  ConnectSession,
  ConnectHostConfig,
  ConnectClientConfig,
  ConnectResult,
  ConnectEventHandler,
} from './types';
