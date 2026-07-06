export * from './Sphere';
export * from './discover';
export * from './crypto';
export * from './encryption';
export * from './currency';
export * from './bech32';
export * from './utils';
export {
  logger,
  getLogger,
  setDebug,
  disableDebug,
  listDebug,
  addSink,
  clearSinks,
  createRingBufferSink,
  withSpan,
} from './logger';
export type {
  LogLevel,
  LogHandler,
  LoggerConfig,
  LogRecord,
  LogSink,
  RingBufferSink,
  Span,
  NamespacedLogger,
} from './logger';
export { SphereError, isSphereError } from './errors';
export type { SphereErrorCode } from './errors';
export { checkNetworkHealth } from './network-health';
export type { CheckNetworkHealthOptions } from './network-health';
// Issue #312 — Connectivity surface
export {
  ConnectivityManager,
  AggregatorPinger,
  IpfsPinger,
  NostrPinger,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_PING_TIMEOUT_MS,
} from './connectivity';
export type {
  ConnectivityBackend,
  ConnectivityBackendStatus,
  ConnectivityStatus,
  ConnectivitySubscriber,
  ConnectivityManagerHandle,
  ConnectivityManagerConfig,
  Pinger,
  PingResult,
  AggregatorPingerProvider,
} from './connectivity';
