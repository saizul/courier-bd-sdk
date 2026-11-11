import {
  AuthError,
  CourierError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  type ValidationIssue,
} from './errors.js';
import { Redactor } from './redact.js';
import { isRecord } from './utils.js';
import { VERSION } from './version.js';

/** Minimal fetch signature the SDK relies on; `globalThis.fetch` satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RetryOptions {
  /** Retries after the first attempt. 0 disables retrying. Default 2. */
  retries: number;
  /** First backoff delay. Default 300 ms. */
  baseDelayMs: number;
  /** Upper bound for any single delay, including `Retry-After`. Default 10 000 ms. */
  maxDelayMs: number;
  /** Exponential growth factor. Default 2. */
  factor: number;
  /** Randomize each delay within [50%, 100%] of the computed backoff. Default true. */
  jitter: boolean;
  /**
   * Retry non-idempotent requests (order creation) on network errors,
   * timeouts and every 5xx. Off by default because the courier may have
   * processed the first attempt, which would create a duplicate parcel.
   * When off, such requests are retried only on 429 and 503, where the
   * request is known not to have been processed.
   */
  retryNonIdempotent: boolean;
}

export const DEFAULT_RETRY: Readonly<RetryOptions> = Object.freeze({
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: true,
  retryNonIdempotent: false,
});

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface LogEntry {
  level: 'debug' | 'warn' | 'error';
  event: 'request' | 'response' | 'retry' | 'error';
  provider: string;
  method: string;
  path: string;
  attempt: number;
  status?: number;
  durationMs?: number;
  delayMs?: number;
  message?: string;
}

/** Receives structured, already-redacted log entries. */
export type Logger = (entry: LogEntry) => void;

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  /** Defaults to `globalThis.fetch`. Inject a mock in tests. */
  fetch?: FetchLike;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  logger?: Logger;
  redactor?: Redactor;
  userAgent?: string;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests; must return a value in [0, 1). */
  random?: () => number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Plain objects/arrays are JSON-encoded; strings are sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Whether repeating the request is side-effect free. Defaults to true for
   * GET and false for everything else.
   */
  idempotent?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  /** Number of attempts made, including the successful one. */
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses on which the courier is known not to have processed the request. */
const ALWAYS_SAFE_TO_RETRY: ReadonlySet<number> = new Set([429, 503]);

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Exponential backoff for the given retry number (1-based), optionally with
 * "equal jitter": half the delay is fixed, half is random, so retries from
 * many clients spread out without ever collapsing to zero.
 */
export function computeBackoff(
  retryNumber: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'>,
  random: () => number = Math.random,
): number {
  const exponential = options.baseDelayMs * Math.pow(options.factor, Math.max(0, retryNumber - 1));
  const capped = Math.min(options.maxDelayMs, exponential);
  if (!options.jitter) return Math.round(capped);
  return Math.round(capped / 2 + (capped / 2) * random());
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Join a base URL, path and query without doubling or dropping slashes. */
export function buildUrl(baseUrl: string, path: string, query?: HttpRequest['query']): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return `${base}${suffix}${qs ? `?${qs}` : ''}`;
}

/** Best-effort human message from a courier error body. */
export function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const text = body.trim();
    if (text === '') return undefined;
    // HTML error pages are noise; keep only a short plain-text prefix.
    if (/^<(!doctype|html)/i.test(text)) return 'non-JSON error page';
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  }
  if (!isRecord(body)) return undefined;
  for (const key of ['message', 'error_description', 'error', 'msg', 'detail']) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (isRecord(value) && typeof value.message === 'string') return value.message;
  }
  const issues = extractIssues(body);
  if (issues.length > 0) return issues.map((issue) => issue.message).join('; ');
  return undefined;
}

/** Field-level validation issues from a Laravel-style `errors` object or array. */
export function extractIssues(body: unknown): ValidationIssue[] {
  if (!isRecord(body)) return [];
  const errors = body.errors ?? body.validation_errors;
  const issues: ValidationIssue[] = [];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === 'string') issues.push({ field: '', code: 'provider_rejected', message: item });
      else if (isRecord(item) && typeof item.message === 'string') {
        issues.push({
          field: typeof item.field === 'string' ? item.field : '',
          code: 'provider_rejected',
          message: item.message,
        });
      }
    }
  } else if (isRecord(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      const messages = Array.isArray(value) ? value : [value];
      for (const message of messages) {
        if (typeof message === 'string') issues.push({ field, code: 'provider_rejected', message });
      }
    }
  }
  return issues;
}

export interface ErrorContext {
  provider: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  retryAfterMs?: number;
  redactor?: Redactor;
}

/**
 * Translate an HTTP status + body into the typed error hierarchy. Also used
 * by adapters for couriers that report failures inside a 200 response.
 */
export function errorFromStatus(context: ErrorContext): CourierError {
  const redactor = context.redactor ?? new Redactor();
  const { provider, status } = context;
  const details = redactor.redactValue(context.body);
  const reason = extractErrorMessage(context.body);
  const message = redactor.redact(
    `[${provider}] ${context.method} ${context.path} failed with HTTP ${status}${reason ? `: ${reason}` : ''}`,
  );
  if (status === 401 || status === 403) return new AuthError(message, { provider, status, details });
  if (status === 400 || status === 422) {
    const issues = extractIssues(context.body).map((issue) => ({ ...issue, message: redactor.redact(issue.message) }));
    return new ValidationError(message, { provider, status, details, issues });
  }
  if (status === 429) {
    return new RateLimitError(message, {
      provider,
      status,
      details,
      ...(context.retryAfterMs !== undefined ? { retryAfterMs: context.retryAfterMs } : {}),
    });
  }
  return new ProviderError(message, { provider, status, details });
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Thin fetch wrapper: JSON encoding, per-attempt timeout, retry with
 * exponential backoff and jitter, typed errors and secret redaction.
 */
export class HttpClient {
  readonly provider: string;
  readonly baseUrl: string;
  readonly redactor: Redactor;
  readonly retry: Readonly<RetryOptions>;
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly logger: Logger | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: HttpClientOptions) {
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation available; pass one via the `fetch` option');
    }
    this.provider = options.provider;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? ((url, init) => fetchImpl(url, init));
    this.redactor = options.redactor ?? new Redactor();
    this.retry = Object.freeze({ ...DEFAULT_RETRY, ...stripUndefined(options.retry ?? {}) });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = {
      Accept: 'application/json',
      'User-Agent': options.userAgent ?? `courier-bd-sdk/${VERSION}`,
      ...(options.headers ?? {}),
    };
    this.logger = options.logger;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.retry.retries) || this.retry.retries < 0) {
      throw new RangeError('retry.retries must be a non-negative integer');
    }
    if (!(this.timeoutMs > 0)) throw new RangeError('timeoutMs must be a positive number');
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const method = request.method;
    const idempotent = request.idempotent ?? method === 'GET';
    const url = buildUrl(this.baseUrl, request.path, request.query);
    const headers: Record<string, string> = { ...this.headers, ...(request.headers ?? {}) };
    let body: string | undefined;
    if (request.body !== undefined && request.body !== null) {
      if (typeof request.body === 'string') {
        body = request.body;
      } else {
        body = JSON.stringify(request.body);
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
      }
    }
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const maxAttempts = this.retry.retries + 1;
    const safePath = this.redactor.redact(request.path);

    for (let attempt = 1; ; attempt++) {
      const started = this.now();
      this.log({ level: 'debug', event: 'request', method, path: safePath, attempt });
      let error: CourierError;
      let retryAfterMs: number | undefined;
      try {
        const { response, text } = await this.attempt(url, { method, headers, body }, timeoutMs, request.signal);
        const data = parseBody(text);
        const durationMs = this.now() - started;
        if (response.ok) {
          this.log({ level: 'debug', event: 'response', method, path: safePath, attempt, status: response.status, durationMs });
          return { status: response.status, headers: response.headers, data: data as T, attempts: attempt };
        }
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
        error = errorFromStatus({
          provider: this.provider,
          method,
          path: safePath,
          status: response.status,
          body: data,
          redactor: this.redactor,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      } catch (caught) {
        if (!(caught instanceof CourierError)) throw caught;
        error = caught;
      }

      if (attempt < maxAttempts && this.shouldRetry(error, idempotent)) {
        const backoff = computeBackoff(attempt, this.retry, this.random);
        const delayMs = Math.min(this.retry.maxDelayMs, Math.max(backoff, retryAfterMs ?? 0));
        this.log({
          level: 'warn',
          event: 'retry',
          method,
          path: safePath,
          attempt,
          delayMs,
          message: error.message,
          ...(error.status !== undefined ? { status: error.status } : {}),
        });
        await this.sleep(delayMs);
        continue;
      }
      this.log({
        level: 'error',
        event: 'error',
        method,
        path: safePath,
        attempt,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
      throw error;
    }
  }

  private shouldRetry(error: CourierError, idempotent: boolean): boolean {
    if (error instanceof NetworkError) return !error.aborted && (idempotent || this.retry.retryNonIdempotent);
    if (error instanceof TimeoutError) return idempotent || this.retry.retryNonIdempotent;
    const status = error.status;
    if (status === undefined || !isRetryableStatus(status)) return false;
    return idempotent || this.retry.retryNonIdempotent || ALWAYS_SAFE_TO_RETRY.has(status);
  }

  /** One fetch with a hard deadline that holds even if `fetch` ignores the abort signal. */
  private async attempt(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
    timeoutMs: number,
    userSignal: AbortSignal | undefined,
  ): Promise<{ response: Response; text: string }> {
    const provider = this.provider;
    if (userSignal?.aborted) {
      throw new NetworkError(`[${provider}] request aborted by caller`, { provider, aborted: true });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TimeoutError(`[${provider}] request timed out after ${timeoutMs} ms`, { provider, timeoutMs }));
      }, timeoutMs);
    });
    const onUserAbort = (): void => controller.abort();
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    const run = async (): Promise<{ response: Response; text: string }> => {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        signal: controller.signal,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      const text = await response.text();
      return { response, text };
    };
    try {
      return await Promise.race([run(), deadline]);
    } catch (caught) {
      if (caught instanceof CourierError) throw caught;
      if (timedOut) {
        throw new TimeoutError(`[${provider}] request timed out after ${timeoutMs} ms`, { provider, timeoutMs });
      }
      if (userSignal?.aborted) {
        throw new NetworkError(`[${provider}] request aborted by caller`, { provider, aborted: true, cause: caught });
      }
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new NetworkError(this.redactor.redact(`[${provider}] network error: ${reason}`), { provider, cause: caught });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    }
  }

  private log(entry: Omit<LogEntry, 'provider'>): void {
    if (!this.logger) return;
    try {
      const message = entry.message !== undefined ? this.redactor.redact(entry.message) : undefined;
      this.logger({ ...entry, provider: this.provider, ...(message !== undefined ? { message } : {}) });
    } catch {
      // A throwing logger must never break a courier call.
    }
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out as Partial<T>;
}
