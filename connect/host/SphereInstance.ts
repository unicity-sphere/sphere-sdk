/**
 * The minimal Sphere surface ConnectHost depends on, extracted from ConnectHost.ts so
 * WalletSnapshot and the method router can be typed without a circular import.
 *
 * NOT re-exported from connect/index.ts on purpose: ConnectHostConfig.sphere stays
 * `unknown`, and publishing this shape would invite third-party hosts to implement an
 * internal contract.
 */

import type { SphereEventType, SphereEventHandler } from '../../types';
import type { PaymentsV2 } from '../../modules/payments-v2/api';

// Use a minimal interface for the Sphere dependency to avoid circular imports.
// ConnectHost only needs these public methods from Sphere.
export interface SphereInstance {
  readonly identity: { chainPubkey: string; directAddress?: string; nametag?: string } | null;
  readonly networkId?: number;
  /** The §4 facade. Read LAZILY: a real Sphere's getter throws while no vertical
   *  runs (init in flight, mid address-switch, destroyed), and the methods that
   *  need no payments — sphere_getIdentity above all — must still answer. */
  readonly payments: PaymentsV2;
  signMessage(message: string): string;
  resolve(identifier: string): Promise<unknown>;
  on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void;
  readonly communications?: {
    getConversations(): Map<string, ConnectDirectMessage[]>;
    getConversationPage(
      peerPubkey: string,
      options?: { limit?: number; before?: number },
    ): { messages: ConnectDirectMessage[]; hasMore: boolean; oldestTimestamp: number | null };
    getUnreadCount(peerPubkey?: string): number;
    markAsRead(messageIds: string[]): Promise<void>;
    sendDM(recipient: string, content: string): Promise<ConnectDirectMessage>;
    resolvePeerNametag(peerPubkey: string): Promise<string | undefined>;
  };
}

/** Minimal DM type to avoid circular imports with Sphere core types. */
export interface ConnectDirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}
