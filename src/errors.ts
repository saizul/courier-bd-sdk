export type CourierErrorCode =
  | 'AUTH'
  | 'VALIDATION'
  | 'RATE_LIMIT'
  | 'PROVIDER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'CONFIG'
  | 'WEBHOOK'
  | 'NO_COURIER'
  | 'IDEMPOTENCY';

export interface CourierErrorOptions {
  /** Provider the error originated from. */
  provider?: string;
  /** HTTP status code, when the error came from a response. */
  status?: number;
  /** Parsed (and redacted) response body or other diagnostic payload. */
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class of every error thrown by the SDK. Messages and `details` never
 * contain configured secrets: they pass through the redactor before the error
 * is constructed.
 */
export class CourierError extends Error {
  readonly code: CourierErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: CourierErrorCode, message: string, options: CourierErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }

  /** Whether repeating the same request later could plausibly succeed. */
  get retryable(): boolean {
    return false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      status: this.status,
      details: this.details,
    };
  }
}

/** Credentials were rejected (HTTP 401/403) or a token could not be issued. */
export class AuthError extends CourierError {
  constructor(message: string, options: CourierErrorOptions = {}) {
    super('AUTH', message, options);
  }
}

export interface ValidationIssue {
  /** Dotted path of the offending field, e.g. `recipient.phone`. */
  field: string;
  /** Stable machine-readable code, e.g. `invalid_phone`. */
  code: string;
  message: string;
}

/** Input failed local validation, or the courier rejected it (HTTP 400/422). */
export class ValidationError extends CourierError {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, options: CourierErrorOptions & { issues?: readonly ValidationIssue[] } = {}) {
    super('VALIDATION', message, options);
    this.issues = Object.freeze([...(options.issues ?? [])]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), issues: this.issues };
  }
}

/** The courier throttled the request (HTTP 429) and retries were exhausted. */
export class RateLimitError extends CourierError {
  /** Delay suggested by the courier's `Retry-After` header, if any. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: CourierErrorOptions & { retryAfterMs?: number } = {}) {
    super('RATE_LIMIT', message, options);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  override get retryable(): boolean {
    return true;
  }
}

/** The courier returned an error response that is not auth, validation or throttling. */
export class ProviderError extends CourierError {
  constructor(message: string, options: CourierErrorOptions = {}) {
    super('PROVIDER', message, options);
  }

  override get retryable(): boolean {
    return this.status !== undefined && this.status >= 500;
  }
}

/** The request never produced an HTTP response (DNS, connection reset, abort...). */
export class NetworkError extends CourierError {
  /** True when the caller's own AbortSignal cancelled the request. */
  readonly aborted: boolean;

  constructor(message: string, options: CourierErrorOptions & { aborted?: boolean } = {}) {
    super('NETWORK', message, options);
    this.aborted = options.aborted ?? false;
  }

  override get retryable(): boolean {
    return !this.aborted;
  }
}

/** The request exceeded the configured timeout. The outcome on the courier side is unknown. */
export class TimeoutError extends CourierError {
  readonly timeoutMs: number;

  constructor(message: string, options: CourierErrorOptions & { timeoutMs: number }) {
    super('TIMEOUT', message, options);
    this.timeoutMs = options.timeoutMs;
  }

  override get retryable(): boolean {
    return true;
  }
}

/** The courier has no equivalent for the requested operation. */
export class UnsupportedOperationError extends CourierError {
  readonly operation: string;

  constructor(provider: string, operation: string, hint?: string) {
    super('UNSUPPORTED', `${provider} does not support ${operation}${hint ? `: ${hint}` : ''}`, { provider });
    this.operation = operation;
  }
}

/** The SDK was configured incorrectly (missing credentials, bad options). */
export class ConfigError extends CourierError {
  constructor(message: string, options: CourierErrorOptions = {}) {
    super('CONFIG', message, options);
  }
}

/** A webhook delivery failed signature/secret verification. */
export class WebhookVerificationError extends CourierError {
  constructor(message: string, options: CourierErrorOptions = {}) {
    super('WEBHOOK', message, options);
  }
}

export interface RouteAttempt {
  provider: string;
  outcome: 'success' | 'failed' | 'skipped';
  /** Why the candidate was skipped, e.g. `not_covered` or `circuit_open`. */
  reason?: string;
  error?: unknown;
}

/** The router ran out of candidates. `attempts` explains what happened to each. */
export class NoCourierAvailableError extends CourierError {
  readonly attempts: readonly RouteAttempt[];

  constructor(message: string, attempts: readonly RouteAttempt[]) {
    super('NO_COURIER', message, { details: attempts.map(summarizeAttempt) });
    this.attempts = Object.freeze([...attempts]);
  }
}

function summarizeAttempt(attempt: RouteAttempt): Record<string, unknown> {
  const error = attempt.error;
  return {
    provider: attempt.provider,
    outcome: attempt.outcome,
    reason: attempt.reason,
    error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
  };
}

export type IdempotencyErrorReason = 'in_progress' | 'outcome_unknown' | 'conflict';

/**
 * The idempotency guard refused to send an order because doing so could book
 * a duplicate parcel. `reason` says why:
 *
 * - `in_progress`: another attempt for the same key has not finished yet.
 * - `outcome_unknown`: an earlier attempt failed ambiguously (timeout, network
 *   error, 5xx) and the order could not be looked up.
 * - `conflict`: the key was already used for an order with different contents.
 */
export class IdempotencyError extends CourierError {
  readonly reason: IdempotencyErrorReason;
  /** The idempotency key the guard refused to reuse. */
  readonly key: string;

  constructor(
    message: string,
    options: CourierErrorOptions & { reason: IdempotencyErrorReason; key: string },
  ) {
    super('IDEMPOTENCY', message, options);
    this.reason = options.reason;
    this.key = options.key;
  }

  override get retryable(): boolean {
    return this.reason === 'in_progress';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reason: this.reason, key: this.key };
  }
}

/** Type guard for errors raised by this SDK. */
export function isCourierError(error: unknown): error is CourierError {
  return error instanceof CourierError;
}
