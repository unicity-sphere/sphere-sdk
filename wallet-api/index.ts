/**
 * wallet-api — public entry point (sdk-changes S1).
 *
 * The typed client for the wallet-api backend (auth, §16 REST, WS wake
 * channel) plus its error and wire types. The storage provider built on it
 * lives in impl/shared/wallet-api (platform-neutral over this client).
 */

export { WalletApiClient } from './client';
export { WalletApiError, ChallengeTemplateError } from './errors';
export type { WalletApiErrorCode } from './errors';
export { AUTH_CHALLENGE_PREFIX, verifyChallengeTemplate } from './challenge';
export type { ChallengeExpectation } from './challenge';

export type {
  KeyValueStore,
  FetchLike,
  FetchResponseLike,
  HeadersLike,
  WebSocketLike,
  WebSocketFactoryLike,
  WalletApiClientConfig,
  WalletApiRetryConfig,
  WalletApiIdentity,
  InventoryPage,
  CoinBalance,
  BlobUrlEntry,
  UploadUrlRequest,
  UploadUrlEntry,
  ApplyDeltaRequest,
  IntentRecord,
  MailboxDepositRequest,
  MailboxEntry,
  MailboxEntryStatus,
  MailboxPage,
  MailboxClaimResult,
  HistoryWireRecord,
  HistoryPage,
  PaymentRequestWireStatus,
  PaymentRequestRecord,
  CreatePaymentRequestInput,
  ListPaymentRequestsParams,
  PaymentRequestsPage,
  RespondPaymentRequestInput,
  WakeEvent,
  WakeCallback,
  WakeSocketHandle,
  WakeSocketStatus,
  SuperviseWakeOptions,
  SupervisedWakeSocketHandle,
} from './types';
