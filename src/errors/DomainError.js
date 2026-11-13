'use strict';

/**
 * Canonical Domain Error Taxonomy (MASTER_SPEC.md §6 & ARCHITECTURE.md §2.1).
 * Never exposes stack traces or internal file paths in external envelopes.
 */
const ERROR_REGISTRY = Object.freeze({
  UNAUTHENTICATED: { httpStatus: 401, retryable: false },
  FORBIDDEN: { httpStatus: 403, retryable: false },
  CSRF_INVALID: { httpStatus: 403, retryable: false },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  PROTOCOL_VERSION_UNSUPPORTED: { httpStatus: 400, retryable: false },
  SCHEMA_VALIDATION_FAILED: { httpStatus: 400, retryable: false },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false },
  SEMANTIC_VALIDATION_FAILED: { httpStatus: 422, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  NOT_IMPLEMENTED: { httpStatus: 501, retryable: false },
  CONFLICT: { httpStatus: 409, retryable: true },
  INVALID_STATE_TRANSITION: { httpStatus: 409, retryable: false },
  STALE_ALLOCATION_EPOCH: { httpStatus: 409, retryable: false },
  LEASE_EXPIRED: { httpStatus: 409, retryable: false },
  GLOBAL_BOT_CAP_EXCEEDED: { httpStatus: 409, retryable: false },
  CAPACITY_EXCEEDED: { httpStatus: 409, retryable: true },
  WORKLOAD_CONSTRAINED: { httpStatus: 503, retryable: true },
  AI_UNAVAILABLE: { httpStatus: 503, retryable: true },
  AI_INVALID_RESPONSE: { httpStatus: 502, retryable: false },
  AI_POLICY_VIOLATION: { httpStatus: 400, retryable: false },
  AI_LOCAL_HOST_FORBIDDEN: { httpStatus: 400, retryable: false },
  AI_PAID_PROVIDER_FORBIDDEN: { httpStatus: 400, retryable: false },
  CHAT_DISABLED_IN_OFFLINE_MODE: { httpStatus: 403, retryable: false },
  PERSISTENCE_ERROR: { httpStatus: 500, retryable: true },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false }
});

class DomainError extends Error {
  /**
   * @param {keyof typeof ERROR_REGISTRY} code
   * @param {string} message
   * @param {{ details?: object, cause?: unknown, retryable?: boolean, httpStatus?: number }} [options]
   */
  constructor(code, message, options = {}) {
    const spec = ERROR_REGISTRY[code] || ERROR_REGISTRY.INTERNAL_ERROR;
    super(String(message || code), options.cause ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = ERROR_REGISTRY[code] ? code : 'INTERNAL_ERROR';
    this.httpStatus =
      typeof options.httpStatus === 'number' ? options.httpStatus : spec.httpStatus;
    this.retryable =
      typeof options.retryable === 'boolean' ? options.retryable : spec.retryable;
    this.details =
      options.details && typeof options.details === 'object' && !Array.isArray(options.details)
        ? { ...options.details }
        : {};
    Error.captureStackTrace?.(this, DomainError);
  }
}

function isDomainError(err) {
  return Boolean(err && (err instanceof DomainError || (err.name === 'DomainError' && typeof err.code === 'string')));
}

/**
 * Format any error into the canonical ARCHITECTURE.md §2.1 JSON wire envelope.
 * Never leaks stack traces, tokens or filesystem paths.
 *
 * @param {unknown} err
 * @param {string} requestId
 */
function toErrorEnvelope(err, requestId) {
  if (isDomainError(err)) {
    return {
      schemaVersion: 1,
      requestId: String(requestId || 'unknown'),
      httpStatus: err.httpStatus,
      body: {
        schemaVersion: 1,
        requestId: String(requestId || 'unknown'),
        error: {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          details: err.details || {}
        }
      }
    };
  }

  return {
    schemaVersion: 1,
    requestId: String(requestId || 'unknown'),
    httpStatus: 500,
    body: {
      schemaVersion: 1,
      requestId: String(requestId || 'unknown'),
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred',
        retryable: false,
        details: {}
      }
    }
  };
}

module.exports = {
  DomainError,
  ERROR_REGISTRY,
  isDomainError,
  toErrorEnvelope
};
