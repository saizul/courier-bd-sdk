import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigError, ValidationError, WebhookVerificationError } from './errors.js';
import {
  PATHAO_WEBHOOK_INTEGRATION_HEADER,
  PATHAO_WEBHOOK_SIGNATURE_HEADER,
  parseWebhookPayload as parsePathaoPayload,
} from './providers/pathao/mapping.js';
import { parseWebhookPayload as parseRedxPayload } from './providers/redx/mapping.js';
import { parseWebhookPayload as parseSteadfastPayload } from './providers/steadfast/mapping.js';
import type { ProviderName, WebhookEvent } from './types.js';
import { isRecord } from './utils.js';

export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Framework-agnostic view of an incoming webhook request. */
export interface WebhookRequest {
  headers?: WebhookHeaders;
  /** Raw body (string/bytes) or an already-parsed JSON object. */
  body: unknown;
  /** Parsed query string, used by RedX token verification. */
  query?: Readonly<Record<string, string | readonly string[] | undefined>> | URLSearchParams;
}

export interface WebhookOptions {
  /**
   * Shared secret to verify against:
   * - Pathao: the webhook secret from the merchant panel, sent in `X-PATHAO-Signature`.
   * - Steadfast: the bearer token configured for the webhook, sent in `Authorization`.
   * - RedX: a token of your own choosing, embedded in the callback URL you
   *   register (`?token=...`) or sent in the `x-redx-token` header by a proxy.
   */
  secret?: string;
  /** Skip verification. Only for local development or when a gateway already authenticates the caller. */
  allowUnverified?: boolean;
  /** RedX only: header to read the token from. Default `x-redx-token`. */
  tokenHeader?: string;
  /** RedX only: query parameter to read the token from. Default `token`. */
  tokenQueryParam?: string;
}

/** Case-insensitive header lookup across `Headers` and plain objects. */
export function getHeader(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return undefined;
}

function getQueryParam(query: WebhookRequest['query'], name: string): string | undefined {
  if (!query) return undefined;
  if (query instanceof URLSearchParams) return query.get(name) ?? undefined;
  const value = (query as Record<string, string | readonly string[] | undefined>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison leaks neither content nor length.
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** Decode a webhook body into a JSON object. */
export function parseWebhookBody(body: unknown, provider?: string): Record<string, unknown> {
  let value: unknown = body;
  if (body instanceof Uint8Array) value = Buffer.from(body).toString('utf8');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (cause) {
      throw new ValidationError(`${provider ? `[${provider}] ` : ''}webhook body is not valid JSON`, {
        cause,
        ...(provider !== undefined ? { provider } : {}),
      });
    }
  }
  if (!isRecord(value)) {
    throw new ValidationError(`${provider ? `[${provider}] ` : ''}webhook body must be a JSON object`, {
      ...(provider !== undefined ? { provider } : {}),
    });
  }
  return value;
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '').trim();
}

/** True when the Pathao signature header equals the configured webhook secret. */
export function verifyPathaoWebhook(request: Pick<WebhookRequest, 'headers'>, secret: string): boolean {
  const received = getHeader(request.headers, PATHAO_WEBHOOK_SIGNATURE_HEADER);
  return typeof received === 'string' && secret !== '' && safeEqual(received.trim(), secret);
}

/** True when the `Authorization: Bearer` token equals the configured Steadfast webhook token. */
export function verifySteadfastWebhook(request: Pick<WebhookRequest, 'headers'>, secret: string): boolean {
  const received = getHeader(request.headers, 'authorization');
  return typeof received === 'string' && secret !== '' && safeEqual(stripBearer(received), stripBearer(secret));
}

/**
 * RedX callbacks are not signed. This checks a token you control, taken from
 * a header (default `x-redx-token`) or the callback URL query (default `token`).
 */
export function verifyRedxWebhook(
  request: Pick<WebhookRequest, 'headers' | 'query'>,
  secret: string,
  options: Pick<WebhookOptions, 'tokenHeader' | 'tokenQueryParam'> = {},
): boolean {
  const received =
    getHeader(request.headers, options.tokenHeader ?? 'x-redx-token') ??
    getQueryParam(request.query, options.tokenQueryParam ?? 'token');
  return typeof received === 'string' && secret !== '' && safeEqual(received.trim(), secret);
}

/**
 * Verify an HMAC signature over the raw request body. None of the three
 * couriers sign payloads this way today; this is provided for setups where a
 * gateway or queue in front of your handler adds its own signature.
 */
export function verifyHmacSignature(
  rawBody: string | Uint8Array,
  secret: string,
  signature: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): boolean {
  if (secret === '' || typeof signature !== 'string' || signature === '') return false;
  const expected = createHmac(algorithm, secret).update(rawBody).digest('hex');
  const received = signature.trim().replace(/^sha(256|512)=/i, '').toLowerCase();
  return safeEqual(received, expected);
}

/** Verify a webhook for the given provider. */
export function verifyWebhook(provider: ProviderName, request: WebhookRequest, options: WebhookOptions): boolean {
  const secret = options.secret ?? '';
  switch (provider) {
    case 'pathao':
      return verifyPathaoWebhook(request, secret);
    case 'steadfast':
      return verifySteadfastWebhook(request, secret);
    case 'redx':
      return verifyRedxWebhook(request, secret, options);
    default:
      throw new ConfigError(`Unknown webhook provider: ${String(provider)}`);
  }
}

const PARSERS: Record<ProviderName, (payload: unknown) => WebhookEvent | undefined> = {
  pathao: parsePathaoPayload,
  steadfast: parseSteadfastPayload,
  redx: parseRedxPayload,
};

/**
 * Verify and parse a provider webhook into a normalized {@link WebhookEvent}.
 *
 * Verification is mandatory unless `allowUnverified` is set: calling this
 * without a `secret` throws a {@link ConfigError} rather than silently
 * trusting the request.
 */
export function parseWebhook(provider: ProviderName, request: WebhookRequest, options: WebhookOptions = {}): WebhookEvent {
  const parser = PARSERS[provider];
  if (!parser) throw new ConfigError(`Unknown webhook provider: ${String(provider)}`);
  if (!options.allowUnverified) {
    if (typeof options.secret !== 'string' || options.secret === '') {
      throw new ConfigError(`[${provider}] a webhook secret is required (or set allowUnverified explicitly)`, { provider });
    }
    if (!verifyWebhook(provider, request, options)) {
      throw new WebhookVerificationError(`[${provider}] webhook verification failed`, { provider });
    }
  }
  const payload = parseWebhookBody(request.body, provider);
  const event = parser(payload);
  if (!event) {
    throw new ValidationError(`[${provider}] webhook payload is missing its identifying fields`, { provider });
  }
  return event;
}

export function parsePathaoWebhook(request: WebhookRequest, options: WebhookOptions = {}): WebhookEvent {
  return parseWebhook('pathao', request, options);
}

export function parseSteadfastWebhook(request: WebhookRequest, options: WebhookOptions = {}): WebhookEvent {
  return parseWebhook('steadfast', request, options);
}

export function parseRedxWebhook(request: WebhookRequest, options: WebhookOptions = {}): WebhookEvent {
  return parseWebhook('redx', request, options);
}

/**
 * Response Pathao expects from a webhook endpoint: HTTP 202 carrying the
 * integration secret shown in the merchant panel when the URL is registered.
 */
export function pathaoWebhookResponse(integrationSecret: string): { status: 202; headers: Record<string, string> } {
  return { status: 202, headers: { [PATHAO_WEBHOOK_INTEGRATION_HEADER]: integrationSecret } };
}
