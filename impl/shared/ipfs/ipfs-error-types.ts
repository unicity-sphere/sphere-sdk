/**
 * IPFS Error Classification
 * Categorizes errors for proper handling (e.g., NOT_FOUND should not trigger circuit breaker)
 */

// =============================================================================
// Error Categories
// =============================================================================

export type IpfsErrorCategory =
  | 'NOT_FOUND'        // IPNS record never published (expected for new wallets)
  | 'NETWORK_ERROR'    // Connectivity / server issues
  | 'TIMEOUT'          // Request timed out
  | 'GATEWAY_ERROR'    // Gateway returned error (5xx, etc.)
  | 'INVALID_RESPONSE' // Response parsing failed
  | 'CID_MISMATCH'    // Content hash doesn't match CID
  | 'SEQUENCE_DOWNGRADE'; // Remote sequence < local (stale data)

// =============================================================================
// Error Class
// =============================================================================

export class IpfsError extends Error {
  readonly category: IpfsErrorCategory;
  readonly gateway?: string;
  readonly cause?: Error;

  constructor(
    message: string,
    category: IpfsErrorCategory,
    gateway?: string,
    cause?: Error,
  ) {
    super(message);
    this.name = 'IpfsError';
    this.category = category;
    this.gateway = gateway;
    this.cause = cause;
  }

  /** Whether this error should trigger the circuit breaker */
  get shouldTriggerCircuitBreaker(): boolean {
    // NOT_FOUND is expected for new wallets, don't penalize the gateway
    return this.category !== 'NOT_FOUND' && this.category !== 'SEQUENCE_DOWNGRADE';
  }
}

// =============================================================================
// Error Classification Helpers
// =============================================================================

/**
 * Classify a fetch exception into an IpfsErrorCategory
 */
export function classifyFetchError(error: unknown): IpfsErrorCategory {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'TIMEOUT';
  }
  if (error instanceof TypeError) {
    // TypeError typically means network failure (DNS, connection refused, etc.)
    return 'NETWORK_ERROR';
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'TIMEOUT';
  }
  return 'NETWORK_ERROR';
}

/**
 * Classify an HTTP status code into an IpfsErrorCategory
 * @param status - HTTP status code
 * @param responseBody - Optional response body for additional context
 */
export function classifyHttpStatus(
  status: number,
  responseBody?: string,
): IpfsErrorCategory {
  if (status === 404) {
    return 'NOT_FOUND';
  }

  if (status === 500 && responseBody) {
    // Kubo returns 500 with "routing: not found" for IPNS records that don't exist
    if (/routing:\s*not\s*found/i.test(responseBody)) {
      return 'NOT_FOUND';
    }
  }

  if (status >= 500) {
    return 'GATEWAY_ERROR';
  }

  if (status >= 400) {
    return 'GATEWAY_ERROR';
  }

  return 'GATEWAY_ERROR';
}
