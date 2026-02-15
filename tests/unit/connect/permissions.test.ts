import { describe, it, expect } from 'vitest';
import {
  PERMISSION_SCOPES,
  ALL_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  METHOD_PERMISSIONS,
  INTENT_PERMISSIONS,
  hasMethodPermission,
  hasIntentPermission,
  validatePermissions,
} from '../../../connect/permissions';
import { RPC_METHODS, INTENT_ACTIONS } from '../../../connect/protocol';

describe('Permissions', () => {
  describe('hasMethodPermission', () => {
    it('returns true when permission is granted', () => {
      const granted = new Set(['balance:read']);
      expect(hasMethodPermission(granted, RPC_METHODS.GET_BALANCE)).toBe(true);
    });

    it('returns false when permission is not granted', () => {
      const granted = new Set(['identity:read']);
      expect(hasMethodPermission(granted, RPC_METHODS.GET_BALANCE)).toBe(false);
    });

    it('returns false for unknown methods', () => {
      const granted = new Set(ALL_PERMISSIONS);
      expect(hasMethodPermission(granted, 'unknown_method')).toBe(false);
    });

    it('identity:read allows getIdentity', () => {
      const granted = new Set([PERMISSION_SCOPES.IDENTITY_READ]);
      expect(hasMethodPermission(granted, RPC_METHODS.GET_IDENTITY)).toBe(true);
    });
  });

  describe('hasIntentPermission', () => {
    it('returns true when permission is granted', () => {
      const granted = new Set([PERMISSION_SCOPES.TRANSFER_REQUEST]);
      expect(hasIntentPermission(granted, INTENT_ACTIONS.SEND)).toBe(true);
    });

    it('returns false when permission is not granted', () => {
      const granted = new Set([PERMISSION_SCOPES.IDENTITY_READ]);
      expect(hasIntentPermission(granted, INTENT_ACTIONS.SEND)).toBe(false);
    });

    it('dm:request allows dm intent', () => {
      const granted = new Set([PERMISSION_SCOPES.DM_REQUEST]);
      expect(hasIntentPermission(granted, INTENT_ACTIONS.DM)).toBe(true);
    });

    it('returns false for unknown actions', () => {
      const granted = new Set(ALL_PERMISSIONS);
      expect(hasIntentPermission(granted, 'unknown_action')).toBe(false);
    });
  });

  describe('validatePermissions', () => {
    it('returns true for valid permissions', () => {
      expect(validatePermissions(['identity:read', 'balance:read'])).toBe(true);
    });

    it('returns false for invalid permissions', () => {
      expect(validatePermissions(['identity:read', 'bogus:perm'])).toBe(false);
    });

    it('returns true for empty array', () => {
      expect(validatePermissions([])).toBe(true);
    });
  });

  describe('mappings', () => {
    it('every RPC method has a permission mapping', () => {
      for (const method of Object.values(RPC_METHODS)) {
        if (method === RPC_METHODS.DISCONNECT) continue;
        expect(METHOD_PERMISSIONS[method]).toBeDefined();
      }
    });

    it('every intent action has a permission mapping', () => {
      for (const action of Object.values(INTENT_ACTIONS)) {
        expect(INTENT_PERMISSIONS[action]).toBeDefined();
      }
    });

    it('default permissions include identity:read', () => {
      expect(DEFAULT_PERMISSIONS).toContain(PERMISSION_SCOPES.IDENTITY_READ);
    });
  });
});
