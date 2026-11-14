/**
 * Idempotent order creation: a wrapper around any `CourierClient` that books
 * each merchant order id at most once, even across retries, restarts and
 * processes that share a store.
 */
import { createHash } from 'node:crypto';
import {
  ConfigError,
  CourierError,
  IdempotencyError,
  NetworkError,
  ProviderError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import type {
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
  Area,
} from './types.js';

/**
 * What the guard knows about one idempotency key.
 *
 * - `pending`: an attempt is in flight (or its process died mid-request).
 * - `created`: the courier confirmed the order.
 * - `submitted`: the courier accepted the order for background processing
 *   without returning a consignment id (Pathao bulk).
 * - `unknown`: the last attempt failed in a way that leaves the outcome open.
 */
export type IdempotencyRecord =
  | { state: 'pending'; fingerprint?: string; at: number }
  | { state: 'created'; fingerprint?: string; at: number; order: Order }
  | { state: 'submitted'; fingerprint?: string; at: number }
  | { state: 'unknown'; fingerprint?: string; at: number; error: { code: string; message: string } };

/**
 * Persistence for idempotency records. Implement it over Redis, a database
 * table or anything else shared between your workers; every method may be
 * synchronous or return a promise. Records must survive at least `ttlMs`.
 */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** In-process store with lazy expiry. Not shared between processes. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): IdempotencyRecord | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.record;
  }

  set(key: string, record: IdempotencyRecord, ttlMs: number): void {
    this.entries.set(key, { record, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Number of live (unexpired) records. */
  get size(): number {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    return this.entries.size;
  }
}

/**
 * Finds an order that may already exist on the courier side. Resolve with the
 * order when it exists, `null` when it definitely does not, and throw when
 * that cannot be determined.
 */
export type OrderLookup = (input: CreateOrderInput, client: CourierClient) => Promise<Order | null>;

export type IdempotencyEvent =
  | { type: 'replay'; key: string; merchantOrderId: string }
  | { type: 'recovered'; key: string; merchantOrderId: string }
  | { type: 'stored'; key: string; merchantOrderId: string; state: 'created' | 'submitted' }
  | { type: 'ambiguous'; key: string; merchantOrderId: string; error: unknown }
  | { type: 'released'; key: string; merchantOrderId: string; error: unknown }
  | { type: 'blocked'; key: string; merchantOrderId: string; reason: IdempotencyError['reason'] };

export interface IdempotencyOptions {
  /** Where records live. Defaults to a new `MemoryIdempotencyStore`. */
  store?: IdempotencyStore;
  /** How long records are kept. Default 7 days. */
  ttlMs?: number;
  /**
   * A `pending` record older than this is treated as an attempt whose process
   * died, and is resolved like an ambiguous failure. Default 2 minutes; keep
   * it above your HTTP timeout times the number of retries.
   */
  pendingTimeoutMs?: number;
  /** Builds the store key. Default `` `${provider}:${merchantOrderId}` ``. */
  keyFor?: (merchantOrderId: string, provider: string) => string;
  /**
   * Fingerprint of the order contents, used to reject a key reused for a
   * different order. Default: hash of COD amount, recipient phone and address,
   * weight and quantity. `false` disables the check.
   */
  fingerprint?: ((input: CreateOrderInput) => string) | false;
  /**
   * How to look up an order after an ambiguous failure. Default: track by
   * merchant order id when the courier supports it (Steadfast), treating a
   * 404 as "not found". `false` disables lookups.
   */
  lookup?: OrderLookup | false;
  onEvent?: (event: IdempotencyEvent) => void;
  now?: () => number;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PENDING_TIMEOUT_MS = 2 * 60 * 1000;

/** Default fingerprint: the fields whose change would make a "retry" a different parcel. */
export function orderFingerprint(input: CreateOrderInput): string {
  const recipient = input.recipient ?? ({} as CreateOrderInput['recipient']);
  const material = JSON.stringify([
    input.codAmount,
    String(recipient.phone ?? '').replace(/\D/g, '').slice(-10),
    String(recipient.address ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
    input.weightKg ?? null,
    input.quantity ?? null,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Whether a create failure leaves open the possibility that the courier booked
 * the parcel anyway. Errors that are not SDK errors count as ambiguous.
 */
export function isAmbiguousCreateFailure(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof NetworkError) return true;
  if (error instanceof ProviderError) return error.status === undefined || error.status < 400 || error.status >= 500;
  return !(error instanceof CourierError);
}

const AMBIGUOUS_BULK_CODES = new Set(['TIMEOUT', 'NETWORK']);

/** Default lookup; `undefined` when the courier cannot look orders up by merchant order id. */
function defaultLookup(client: CourierClient): OrderLookup | undefined {
  if (!client.capabilities.trackByMerchantOrderId) return undefined;
  return async (input, target) => {
    let tracking: Tracking;
    try {
      tracking = await target.trackOrder({ merchantOrderId: input.merchantOrderId });
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
    return trackingToOrder(tracking, input);
  };
}

function trackingToOrder(tracking: Tracking, input: CreateOrderInput): Order {
  const order: Order = {
    provider: tracking.provider,
    consignmentId: tracking.consignmentId,
    merchantOrderId: tracking.merchantOrderId ?? input.merchantOrderId,
    status: tracking.status,
    codAmount: input.codAmount,
    raw: tracking.raw,
  };
  if (tracking.providerStatus !== undefined) order.providerStatus = tracking.providerStatus;
  return order;
}

function errorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof CourierError) return { code: error.code, message: error.message };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

type Resolution =
  | { kind: 'send' }
  | { kind: 'replay'; record: Extract<IdempotencyRecord, { state: 'created' | 'submitted' }> }
  | { kind: 'blocked'; error: IdempotencyError };

/**
 * A `CourierClient` that books each merchant order id at most once.
 *
 * - A confirmed order is returned from the store on every later call, without
 *   a request.
 * - Concurrent calls for the same key in one process share one request.
 * - After an ambiguous failure the next call looks the order up first (where
 *   the courier supports it) and only creates it when it does not exist;
 *   otherwise it rejects with `IdempotencyError` (`outcome_unknown`) until you
 *   resolve the key with `markCreated` or `forget`.
 * - A definite rejection (validation, auth, rate limit, 4xx) releases the key
 *   so the order can be corrected and sent again.
 *
 * Every other operation is passed through to the wrapped client unchanged.
 */
export class IdempotentCourier implements CourierClient {
  readonly client: CourierClient;
  private readonly store: IdempotencyStore;
  private readonly ttlMs: number;
  private readonly pendingTimeoutMs: number;
  private readonly keyFn: (merchantOrderId: string, provider: string) => string;
  private readonly fingerprintFn: ((input: CreateOrderInput) => string) | undefined;
  private readonly lookupFn: OrderLookup | undefined;
  private readonly onEvent: ((event: IdempotencyEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly inflight = new Map<string, { fingerprint: string | undefined; promise: Promise<Order> }>();

  constructor(client: CourierClient, options: IdempotencyOptions = {}) {
    this.client = client;
    this.store = options.store ?? new MemoryIdempotencyStore(options.now ? { now: options.now } : {});
    this.ttlMs = positive(options.ttlMs, DEFAULT_IDEMPOTENCY_TTL_MS, 'ttlMs');
    this.pendingTimeoutMs = positive(options.pendingTimeoutMs, DEFAULT_PENDING_TIMEOUT_MS, 'pendingTimeoutMs');
    this.keyFn = options.keyFor ?? ((merchantOrderId, provider) => `${provider}:${merchantOrderId}`);
    this.fingerprintFn = options.fingerprint === false ? undefined : (options.fingerprint ?? orderFingerprint);
    this.lookupFn = options.lookup === false ? undefined : (options.lookup ?? defaultLookup(client));
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
  }

  get provider(): string {
    return this.client.provider;
  }

  get capabilities(): Readonly<Capabilities> {
    return this.client.capabilities;
  }

  /** Store key for a merchant order id. */
  keyFor(merchantOrderId: string): string {
    return this.keyFn(merchantOrderId, this.client.provider);
  }

  /** The stored record for a merchant order id, if any. */
  async status(merchantOrderId: string): Promise<IdempotencyRecord | undefined> {
    return (await this.store.get(this.keyFor(merchantOrderId))) ?? undefined;
  }

  /** Drop the record so the next `createOrder` sends the order again. */
  async forget(merchantOrderId: string): Promise<void> {
    await this.store.delete(this.keyFor(merchantOrderId));
  }

  /** Record an order you confirmed by other means (merchant panel, webhook). */
  async markCreated(order: Order & { merchantOrderId: string }): Promise<void> {
    await this.store.set(this.keyFor(order.merchantOrderId), { state: 'created', at: this.now(), order }, this.ttlMs);
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const merchantOrderId = requireMerchantOrderId(input, this.client.provider);
    const key = this.keyFor(merchantOrderId);
    const fingerprint = this.fingerprintFn?.(input);

    const running = this.inflight.get(key);
    if (running) {
      if (conflicts(running.fingerprint, fingerprint)) throw this.block(key, merchantOrderId, 'conflict');
      return running.promise;
    }

    const promise = this.createOnce(input, key, merchantOrderId, fingerprint);
    this.inflight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult> {
    const results = new Array<BulkItemResult>(inputs.length);
    const toSend: Array<{ index: number; key: string; merchantOrderId: string; fingerprint: string | undefined }> = [];
    const seen = new Set<string>();

    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index] as CreateOrderInput;
      const merchantOrderId = typeof input?.merchantOrderId === 'string' ? input.merchantOrderId.trim() : '';
      if (merchantOrderId === '') {
        results[index] = { index, merchantOrderId, success: false, error: { code: 'VALIDATION', message: 'merchantOrderId is required' } };
        continue;
      }
      const key = this.keyFor(merchantOrderId);
      const fingerprint = this.fingerprintFn?.(input);
      if (seen.has(key) || this.inflight.has(key)) {
        const error = this.block(key, merchantOrderId, 'in_progress');
        results[index] = { index, merchantOrderId, success: false, error: errorSummary(error) };
        continue;
      }
      seen.add(key);
      const resolution = await this.resolve(input, key, merchantOrderId, fingerprint);
      if (resolution.kind === 'blocked') {
        results[index] = { index, merchantOrderId, success: false, error: errorSummary(resolution.error) };
      } else if (resolution.kind === 'replay') {
        const item: BulkItemResult = { index, merchantOrderId, success: true };
        if (resolution.record.state === 'created') item.order = resolution.record.order;
        results[index] = item;
      } else {
        toSend.push({ index, key, merchantOrderId, fingerprint });
      }
    }

    let mode: BulkCreateResult['mode'] = 'sync';
    if (toSend.length > 0) {
      for (const entry of toSend) {
        await this.store.set(entry.key, { state: 'pending', fingerprint: entry.fingerprint, at: this.now() }, this.ttlMs);
      }
      let outcome: BulkCreateResult;
      try {
        outcome = await this.client.bulkCreate(toSend.map((entry) => inputs[entry.index] as CreateOrderInput));
      } catch (error) {
        const ambiguous = isAmbiguousCreateFailure(error);
        for (const entry of toSend) await this.settleFailure(entry.key, entry.merchantOrderId, entry.fingerprint, error, ambiguous);
        throw error;
      }
      mode = outcome.mode;
      for (let position = 0; position < toSend.length; position++) {
        const entry = toSend[position] as (typeof toSend)[number];
        const item = outcome.results.find((candidate) => candidate.index === position);
        const result: BulkItemResult = { ...(item ?? { merchantOrderId: entry.merchantOrderId, success: false }), index: entry.index };
        if (!item) result.error = { code: 'PROVIDER', message: 'No result returned for this item' };
        if (result.success) {
          const state = result.order ? 'created' : 'submitted';
          const record: IdempotencyRecord = result.order
            ? { state: 'created', fingerprint: entry.fingerprint, at: this.now(), order: result.order }
            : { state: 'submitted', fingerprint: entry.fingerprint, at: this.now() };
          await this.store.set(entry.key, record, this.ttlMs);
          this.emit({ type: 'stored', key: entry.key, merchantOrderId: entry.merchantOrderId, state });
        } else {
          const ambiguous = !item || AMBIGUOUS_BULK_CODES.has(result.error?.code ?? '');
          await this.settleFailure(entry.key, entry.merchantOrderId, entry.fingerprint, result.error, ambiguous);
        }
        results[entry.index] = result;
      }
    }

    const succeeded = results.filter((item) => item.success).length;
    return {
      provider: this.client.provider,
      mode,
      total: inputs.length,
      succeeded,
      failed: inputs.length - succeeded,
      results,
    };
  }

  trackOrder(query: TrackQuery): Promise<Tracking> {
    return this.client.trackOrder(query);
  }

  cancelOrder(consignmentId: Id, reason?: string): Promise<CancelResult> {
    return this.client.cancelOrder(consignmentId, reason);
  }

  calculateCharge(input: ChargeInput): Promise<Charge> {
    return this.client.calculateCharge(input);
  }

  listCities(): Promise<City[]> {
    return this.client.listCities();
  }

  listZones(cityId: Id): Promise<Zone[]> {
    return this.client.listZones(cityId);
  }

  listAreas(query: AreaQuery): Promise<Area[]> {
    return this.client.listAreas(query);
  }

  private async createOnce(
    input: CreateOrderInput,
    key: string,
    merchantOrderId: string,
    fingerprint: string | undefined,
  ): Promise<Order> {
    const resolution = await this.resolve(input, key, merchantOrderId, fingerprint);
    if (resolution.kind === 'blocked') throw resolution.error;
    if (resolution.kind === 'replay') {
      if (resolution.record.state === 'created') return resolution.record.order;
      throw this.block(key, merchantOrderId, 'outcome_unknown', 'it was accepted for background processing and has no consignment id yet');
    }

    await this.store.set(key, { state: 'pending', fingerprint, at: this.now() }, this.ttlMs);
    let order: Order;
    try {
      order = await this.client.createOrder(input);
    } catch (error) {
      await this.settleFailure(key, merchantOrderId, fingerprint, error, isAmbiguousCreateFailure(error));
      throw error;
    }
    await this.store.set(key, { state: 'created', fingerprint, at: this.now(), order }, this.ttlMs);
    this.emit({ type: 'stored', key, merchantOrderId, state: 'created' });
    return order;
  }

  /** Decide what to do with a key based on its stored record. */
  private async resolve(
    input: CreateOrderInput,
    key: string,
    merchantOrderId: string,
    fingerprint: string | undefined,
  ): Promise<Resolution> {
    const record = (await this.store.get(key)) ?? undefined;
    if (!record) return { kind: 'send' };
    if (conflicts(record.fingerprint, fingerprint)) {
      return { kind: 'blocked', error: this.block(key, merchantOrderId, 'conflict') };
    }
    if (record.state === 'created' || record.state === 'submitted') {
      this.emit({ type: 'replay', key, merchantOrderId });
      return { kind: 'replay', record };
    }
    if (record.state === 'pending' && this.now() - record.at < this.pendingTimeoutMs) {
      return { kind: 'blocked', error: this.block(key, merchantOrderId, 'in_progress') };
    }

    // Stale pending or unknown: the parcel may exist. Look before booking again.
    if (!this.lookupFn) {
      return {
        kind: 'blocked',
        error: this.block(key, merchantOrderId, 'outcome_unknown', `${this.client.provider} cannot look orders up by merchant order id`),
      };
    }
    let found: Order | null;
    try {
      found = await this.lookupFn(input, this.client);
    } catch (error) {
      return {
        kind: 'blocked',
        error: this.block(key, merchantOrderId, 'outcome_unknown', 'the lookup failed', error),
      };
    }
    if (found === null) return { kind: 'send' };
    const recovered: IdempotencyRecord = { state: 'created', fingerprint: record.fingerprint ?? fingerprint, at: this.now(), order: found };
    await this.store.set(key, recovered, this.ttlMs);
    this.emit({ type: 'recovered', key, merchantOrderId });
    return { kind: 'replay', record: recovered };
  }

  private async settleFailure(
    key: string,
    merchantOrderId: string,
    fingerprint: string | undefined,
    error: unknown,
    ambiguous: boolean,
  ): Promise<void> {
    if (ambiguous) {
      const summary = isSummary(error) ? error : errorSummary(error);
      await this.store.set(key, { state: 'unknown', fingerprint, at: this.now(), error: summary }, this.ttlMs);
      this.emit({ type: 'ambiguous', key, merchantOrderId, error });
    } else {
      await this.store.delete(key);
      this.emit({ type: 'released', key, merchantOrderId, error });
    }
  }

  private block(
    key: string,
    merchantOrderId: string,
    reason: IdempotencyError['reason'],
    detail?: string,
    cause?: unknown,
  ): IdempotencyError {
    const base =
      reason === 'conflict'
        ? `merchant order ${merchantOrderId} was already used for an order with different contents`
        : reason === 'in_progress'
          ? `an attempt to create merchant order ${merchantOrderId} is still in progress`
          : `merchant order ${merchantOrderId} may already exist on ${this.client.provider}`;
    const message = `[${this.client.provider}] ${base}${detail ? `: ${detail}` : ''}`;
    this.emit({ type: 'blocked', key, merchantOrderId, reason });
    return new IdempotencyError(message, {
      provider: this.client.provider,
      reason,
      key,
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  private emit(event: IdempotencyEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // Observers must never break order creation.
    }
  }
}

/** Wrap a client so each merchant order id is booked at most once. */
export function withIdempotency(client: CourierClient, options: IdempotencyOptions = {}): IdempotentCourier {
  return new IdempotentCourier(client, options);
}

function requireMerchantOrderId(input: CreateOrderInput, provider: string): string {
  const value = typeof input?.merchantOrderId === 'string' ? input.merchantOrderId.trim() : '';
  if (value === '') {
    throw new ValidationError(`[${provider}] merchantOrderId is required for idempotent order creation`, {
      provider,
      issues: [{ field: 'merchantOrderId', code: 'required', message: 'merchantOrderId is required' }],
    });
  }
  return value;
}

function conflicts(stored: string | undefined, current: string | undefined): boolean {
  return stored !== undefined && current !== undefined && stored !== current;
}

function isSummary(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
  return value;
}
