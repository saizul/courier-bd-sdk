import { AuthError, CourierError, UnsupportedOperationError } from './errors.js';
import { HttpClient, type FetchLike, type Logger, type RetryOptions } from './http.js';
import { Redactor } from './redact.js';
import type { StatusTable } from './status.js';
import type {
  Area,
  AreaQuery,
  BulkCreateResult,
  BulkItemResult,
  CancelResult,
  Capabilities,
  Charge,
  ChargeInput,
  City,
  CourierClient,
  CreateOrderInput,
  Id,
  Order,
  Tracking,
  TrackQuery,
  Zone,
} from './types.js';
import { mapWithConcurrency } from './utils.js';
import { DEFAULT_ORDER_RULES, type OrderRules } from './validation.js';

/** Options accepted by every provider adapter. */
export interface CommonConfig {
  /** Override the API base URL (useful for proxies and tests). */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-attempt timeout. Default 15 000 ms. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  /** Receives structured, redacted log entries for every request, retry and failure. */
  logger?: Logger;
  userAgent?: string;
  /** Override individual validation rules for this client. */
  rules?: Partial<OrderRules>;
  /**
   * Extra or corrected raw-status mappings, keyed in normalized form
   * (lower-case, underscores). Takes precedence over the built-in table.
   */
  statusOverrides?: StatusTable;
  /** Injectable timing/randomness for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Shared plumbing for provider adapters. */
export abstract class BaseCourier implements CourierClient {
  readonly provider: string;
  abstract readonly capabilities: Readonly<Capabilities>;
  /** Effective validation rules (defaults, provider limits, then user overrides). */
  readonly rules: Readonly<OrderRules>;
  protected readonly http: HttpClient;
  protected readonly redactor: Redactor;
  protected readonly now: () => number;

  protected constructor(
    provider: string,
    config: CommonConfig,
    defaults: { baseUrl: string; rules?: Partial<OrderRules>; headers?: Record<string, string> },
  ) {
    this.provider = provider;
    this.redactor = new Redactor();
    this.now = config.now ?? Date.now;
    this.rules = Object.freeze({ ...DEFAULT_ORDER_RULES, ...(defaults.rules ?? {}), ...(config.rules ?? {}) });
    this.http = new HttpClient({
      provider,
      baseUrl: config.baseUrl ?? defaults.baseUrl,
      redactor: this.redactor,
      now: this.now,
      ...(defaults.headers ? { headers: defaults.headers } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.retry ? { retry: config.retry } : {}),
      ...(config.logger ? { logger: config.logger } : {}),
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
      ...(config.sleep ? { sleep: config.sleep } : {}),
      ...(config.random ? { random: config.random } : {}),
    });
  }

  abstract createOrder(input: CreateOrderInput): Promise<Order>;
  abstract bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult>;
  abstract trackOrder(query: TrackQuery): Promise<Tracking>;

  cancelOrder(_consignmentId: Id, _reason?: string): Promise<CancelResult> {
    return this.unsupported('cancelOrder');
  }

  calculateCharge(_input: ChargeInput): Promise<Charge> {
    return this.unsupported('calculateCharge');
  }

  listCities(): Promise<City[]> {
    return this.unsupported('listCities');
  }

  listZones(_cityId: Id): Promise<Zone[]> {
    return this.unsupported('listZones');
  }

  listAreas(_query: AreaQuery): Promise<Area[]> {
    return this.unsupported('listAreas');
  }

  protected unsupported(operation: string, hint?: string): Promise<never> {
    return Promise.reject(new UnsupportedOperationError(this.provider, operation, hint));
  }

  /**
   * Bulk creation for couriers without a bulk endpoint: runs single creates
   * with bounded concurrency and collects per-item outcomes. An auth failure
   * aborts the batch, since every remaining item would fail the same way.
   */
  protected async emulateBulk(inputs: readonly CreateOrderInput[], concurrency: number): Promise<BulkCreateResult> {
    let fatal: AuthError | undefined;
    const results = await mapWithConcurrency(inputs, concurrency, async (input, index): Promise<BulkItemResult> => {
      const merchantOrderId = String(input?.merchantOrderId ?? '');
      if (fatal) return { index, merchantOrderId, success: false, error: toBulkError(fatal) };
      try {
        const order = await this.createOrder(input);
        return { index, merchantOrderId, success: true, order };
      } catch (error) {
        if (error instanceof AuthError) fatal = error;
        return { index, merchantOrderId, success: false, error: toBulkError(error) };
      }
    });
    if (fatal && results.every((result) => !result.success)) throw fatal;
    return summarizeBulk(this.provider, 'sync', results);
  }
}

export function toBulkError(error: unknown): { code: string; message: string } {
  if (error instanceof CourierError) return { code: error.code, message: error.message };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

export function summarizeBulk(provider: string, mode: 'sync' | 'async', results: BulkItemResult[]): BulkCreateResult {
  const succeeded = results.filter((result) => result.success).length;
  return { provider, mode, total: results.length, succeeded, failed: results.length - succeeded, results };
}

/** Resolve a {@link TrackQuery} into its kind and value. */
export function resolveTrackQuery(query: TrackQuery): { kind: 'consignmentId' | 'merchantOrderId' | 'trackingCode'; value: string } | undefined {
  if (typeof query === 'string' || typeof query === 'number') {
    const value = String(query).trim();
    return value === '' ? undefined : { kind: 'consignmentId', value };
  }
  if (query === null || typeof query !== 'object') return undefined;
  for (const kind of ['consignmentId', 'merchantOrderId', 'trackingCode'] as const) {
    const raw = (query as Record<string, unknown>)[kind];
    if (typeof raw === 'string' || typeof raw === 'number') {
      const value = String(raw).trim();
      if (value !== '') return { kind, value };
    }
  }
  return undefined;
}
