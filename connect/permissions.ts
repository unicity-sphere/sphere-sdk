/**
 * Sphere Connect Permission System
 * Defines scopes, maps methods/intents to required permissions.
 */

import { RPC_METHODS, INTENT_ACTIONS } from './protocol';

// =============================================================================
// Permission Scopes
// =============================================================================

export const PERMISSION_SCOPES = {
  IDENTITY_READ: 'identity:read',
  BALANCE_READ: 'balance:read',
  TOKENS_READ: 'tokens:read',
  HISTORY_READ: 'history:read',
  L1_READ: 'l1:read',
  EVENTS_SUBSCRIBE: 'events:subscribe',
  RESOLVE_PEER: 'resolve:peer',
  TRANSFER_REQUEST: 'transfer:request',
  L1_TRANSFER: 'l1:transfer',
  DM_REQUEST: 'dm:request',
  DM_READ: 'dm:read',
  PAYMENT_REQUEST: 'payment:request',
  SIGN_REQUEST: 'sign:request',
} as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[keyof typeof PERMISSION_SCOPES];

/** All available permission scopes */
export const ALL_PERMISSIONS: readonly PermissionScope[] = Object.values(PERMISSION_SCOPES);

/** Permissions always granted on connect */
export const DEFAULT_PERMISSIONS: readonly PermissionScope[] = [
  PERMISSION_SCOPES.IDENTITY_READ,
];

// =============================================================================
// Method → Permission Mapping
// =============================================================================

export const METHOD_PERMISSIONS: Record<string, PermissionScope> = {
  [RPC_METHODS.GET_IDENTITY]: PERMISSION_SCOPES.IDENTITY_READ,
  [RPC_METHODS.GET_BALANCE]: PERMISSION_SCOPES.BALANCE_READ,
  [RPC_METHODS.GET_ASSETS]: PERMISSION_SCOPES.BALANCE_READ,
  [RPC_METHODS.GET_FIAT_BALANCE]: PERMISSION_SCOPES.BALANCE_READ,
  [RPC_METHODS.GET_TOKENS]: PERMISSION_SCOPES.TOKENS_READ,
  [RPC_METHODS.GET_HISTORY]: PERMISSION_SCOPES.HISTORY_READ,
  [RPC_METHODS.L1_GET_BALANCE]: PERMISSION_SCOPES.L1_READ,
  [RPC_METHODS.L1_GET_HISTORY]: PERMISSION_SCOPES.L1_READ,
  [RPC_METHODS.RESOLVE]: PERMISSION_SCOPES.RESOLVE_PEER,
  [RPC_METHODS.SUBSCRIBE]: PERMISSION_SCOPES.EVENTS_SUBSCRIBE,
  [RPC_METHODS.UNSUBSCRIBE]: PERMISSION_SCOPES.EVENTS_SUBSCRIBE,
  [RPC_METHODS.GET_CONVERSATIONS]: PERMISSION_SCOPES.DM_READ,
  [RPC_METHODS.GET_MESSAGES]: PERMISSION_SCOPES.DM_READ,
  [RPC_METHODS.GET_DM_UNREAD_COUNT]: PERMISSION_SCOPES.DM_READ,
  [RPC_METHODS.MARK_AS_READ]: PERMISSION_SCOPES.DM_READ,
};

// =============================================================================
// Intent → Permission Mapping
// =============================================================================

export const INTENT_PERMISSIONS: Record<string, PermissionScope> = {
  [INTENT_ACTIONS.SEND]: PERMISSION_SCOPES.TRANSFER_REQUEST,
  [INTENT_ACTIONS.L1_SEND]: PERMISSION_SCOPES.L1_TRANSFER,
  [INTENT_ACTIONS.DM]: PERMISSION_SCOPES.DM_REQUEST,
  [INTENT_ACTIONS.PAYMENT_REQUEST]: PERMISSION_SCOPES.PAYMENT_REQUEST,
  [INTENT_ACTIONS.RECEIVE]: PERMISSION_SCOPES.IDENTITY_READ,
  [INTENT_ACTIONS.SIGN_MESSAGE]: PERMISSION_SCOPES.SIGN_REQUEST,
};

// =============================================================================
// Helpers
// =============================================================================

/** Check if granted permissions allow calling a method */
export function hasMethodPermission(granted: ReadonlySet<string>, method: string): boolean {
  const required = METHOD_PERMISSIONS[method];
  if (!required) return false;
  return granted.has(required);
}

/** Check if granted permissions allow an intent action */
export function hasIntentPermission(granted: ReadonlySet<string>, action: string): boolean {
  const required = INTENT_PERMISSIONS[action];
  if (!required) return false;
  return granted.has(required);
}

/** Validate that all requested permissions are known scopes */
export function validatePermissions(permissions: string[]): permissions is PermissionScope[] {
  const validScopes = new Set<string>(ALL_PERMISSIONS);
  return permissions.every((p) => validScopes.has(p));
}
