/**
 * courier-bd-sdk: one interface over Bangladesh courier APIs.
 *
 * @packageDocumentation
 */
export { VERSION } from './version.js';

export * from './types.js';
export {
  OrderStatus,
  ORDER_STATUSES,
  isOrderStatus,
  isTerminalStatus,
  isDeliveredStatus,
  normalizeStatusKey,
  createStatusMapper,
  type StatusTable,
  type StatusMapper,
} from './status.js';

export {
  CourierError,
  AuthError,
  ValidationError,
  RateLimitError,
  ProviderError,
  NetworkError,
  TimeoutError,
  UnsupportedOperationError,
  ConfigError,
  WebhookVerificationError,
  NoCourierAvailableError,
  IdempotencyError,
  isCourierError,
  type CourierErrorCode,
  type CourierErrorOptions,
  type ValidationIssue,
  type RouteAttempt,
  type IdempotencyErrorReason,
} from './errors.js';

export {
  HttpClient,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  computeBackoff,
  parseRetryAfter,
  buildUrl,
  isRetryableStatus,
  type FetchLike,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
  type HttpMethod,
  type RetryOptions,
  type LogEntry,
  type Logger,
} from './http.js';

export { Redactor, REDACTED, maskSecret } from './redact.js';

export {
  normalizePhone,
  isValidPhone,
  toE164,
  toAsciiDigits,
  detectOperator,
  checkCodAmount,
  checkWeight,
  checkCreateOrder,
  validateCreateOrder,
  validateChargeInput,
  DEFAULT_ORDER_RULES,
  type OrderRules,
  type NormalizedOrderInput,
  type MobileOperator,
} from './validation.js';

export { BaseCourier, type CommonConfig } from './base.js';
export { chargeFromRateCard, assertRateCard, type RateCard } from './ratecard.js';

export * from './providers/pathao/index.js';
export * from './providers/steadfast/index.js';
export * from './providers/redx/index.js';

export {
  createCourier,
  createCourierFromEnv,
  configFromEnv,
  isProviderName,
  ENV_VARS,
  type ProviderConfigMap,
  type ProviderClientMap,
} from './factory.js';

export {
  parseWebhook,
  parsePathaoWebhook,
  parseSteadfastWebhook,
  parseRedxWebhook,
  verifyWebhook,
  verifyPathaoWebhook,
  verifySteadfastWebhook,
  verifyRedxWebhook,
  verifyHmacSignature,
  parseWebhookBody,
  pathaoWebhookResponse,
  getHeader,
  safeEqual,
  type WebhookRequest,
  type WebhookOptions,
  type WebhookHeaders,
} from './webhooks.js';

export {
  CourierRouter,
  coversCities,
  coversZones,
  coversAreas,
  coversPostCodes,
  maxCod,
  maxWeight,
  allOf,
  anyOf,
  not,
  type RouterOptions,
  type RouteCandidate,
  type CoverageRule,
  type CircuitBreakerOptions,
  type RouterEvent,
  type RouteQuote,
  type RoutePlan,
  type RoutePlanEntry,
  type RoutedOrder,
} from './router.js';

export {
  IdempotentCourier,
  MemoryIdempotencyStore,
  withIdempotency,
  orderFingerprint,
  isAmbiguousCreateFailure,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_PENDING_TIMEOUT_MS,
  type IdempotencyOptions,
  type IdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyEvent,
  type OrderLookup,
} from './idempotency.js';

export { toIsoTimestamp } from './utils.js';
