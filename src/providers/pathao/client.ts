import { BaseCourier, resolveTrackQuery, summarizeBulk, toBulkError, type CommonConfig } from '../../base.js';
import { AuthError, ConfigError, ProviderError, ValidationError } from '../../errors.js';
import type { HttpRequest, HttpResponse } from '../../http.js';
import { createStatusMapper, type StatusMapper } from '../../status.js';
import type {
  Area,
  AreaQuery,
  BulkCreateResult,
  BulkItemResult,
  Capabilities,
  Charge,
  ChargeInput,
  City,
  CreateOrderInput,
  Id,
  Order,
  Tracking,
  TrackQuery,
  Zone,
} from '../../types.js';
import { checkCreateOrder, throwIssues, validateChargeInput, type NormalizedOrderInput } from '../../validation.js';
import { PathaoTokenManager, type PathaoTokenStore } from './auth.js';
import {
  PATHAO_BASE_URLS,
  PATHAO_ENDPOINTS,
  PATHAO_RULES,
  PATHAO_STATUS_MAP,
  buildBulkPayload,
  buildOrderPayload,
  buildPricePayload,
  parseAreas,
  parseBulkResponse,
  parseCities,
  parseOrderInfo,
  parseOrderResponse,
  parsePriceResponse,
  parseStores,
  parseZones,
  type PathaoStore,
} from './mapping.js';

export interface PathaoConfig extends CommonConfig {
  clientId: string;
  clientSecret: string;
  /** Merchant account email. */
  username: string;
  password: string;
  /** Default pickup store for orders and price quotes. */
  storeId?: Id;
  /** Use the sandbox base URL. */
  sandbox?: boolean;
  /** Persist tokens across processes. */
  tokenStore?: PathaoTokenStore;
  /** Treat tokens as expired this long before real expiry. Default 60 000 ms. */
  tokenSkewMs?: number;
}

const REQUIRED: ReadonlyArray<keyof PathaoConfig> = ['clientId', 'clientSecret', 'username', 'password'];

export class PathaoCourier extends BaseCourier {
  readonly capabilities: Readonly<Capabilities> = Object.freeze({
    cancelOrder: false,
    calculateCharge: 'api',
    bulkCreate: 'native',
    listCities: true,
    listZones: true,
    listAreas: true,
    trackByMerchantOrderId: false,
    trackByTrackingCode: false,
  });

  private readonly tokens: PathaoTokenManager;
  private readonly storeId: Id | undefined;
  private readonly mapStatus: StatusMapper;

  constructor(config: PathaoConfig) {
    super('pathao', config ?? {}, {
      baseUrl: config?.sandbox ? PATHAO_BASE_URLS.sandbox : PATHAO_BASE_URLS.production,
      rules: PATHAO_RULES,
    });
    const missing = REQUIRED.filter((key) => typeof config?.[key] !== 'string' || (config[key] as string).trim() === '');
    if (missing.length > 0) {
      throw new ConfigError(`[pathao] missing required config: ${missing.join(', ')}`, { provider: 'pathao' });
    }
    this.redactor.add(config.clientSecret, config.password);
    this.storeId = config.storeId;
    this.mapStatus = createStatusMapper(PATHAO_STATUS_MAP, config.statusOverrides);
    this.tokens = new PathaoTokenManager({
      http: this.http,
      redactor: this.redactor,
      now: this.now,
      credentials: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        username: config.username,
        password: config.password,
      },
      ...(config.tokenSkewMs !== undefined ? { skewMs: config.tokenSkewMs } : {}),
      ...(config.tokenStore ? { store: config.tokenStore } : {}),
    });
  }

  /** Token manager, exposed for pre-warming (`getAccessToken()`) or forced invalidation. */
  get auth(): PathaoTokenManager {
    return this.tokens;
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const { order, storeId } = this.prepare(input);
    const response = await this.authed({
      method: 'POST',
      path: PATHAO_ENDPOINTS.createOrder,
      body: buildOrderPayload(order, storeId),
    });
    const parsed = parseOrderResponse(response.data, order);
    if (!parsed) throw this.unexpected('create order', response);
    if (parsed.providerStatus !== undefined) parsed.status = this.mapStatus(parsed.providerStatus);
    return parsed;
  }

  /**
   * Submit a batch through Pathao's bulk endpoint. Pathao processes the batch
   * in the background and does not return consignment ids, so the result has
   * `mode: 'async'`: successful items mean "accepted", not "created". Items
   * failing local validation are reported individually and left out of the
   * request.
   */
  async bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult> {
    const results: BulkItemResult[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const accepted: number[] = [];
    inputs.forEach((input, index) => {
      const merchantOrderId = String(input?.merchantOrderId ?? '');
      try {
        const { order, storeId } = this.prepare(input);
        payloads.push(buildOrderPayload(order, storeId));
        accepted.push(index);
        results.push({ index, merchantOrderId: order.merchantOrderId, success: true });
      } catch (error) {
        results.push({ index, merchantOrderId, success: false, error: toBulkError(error) });
      }
    });
    if (payloads.length > 0) {
      try {
        const response = await this.authed({
          method: 'POST',
          path: PATHAO_ENDPOINTS.bulkCreate,
          body: buildBulkPayload(payloads),
        });
        const outcome = parseBulkResponse(response.data);
        if (!outcome.accepted) throw this.unexpected('bulk create', response);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        for (const index of accepted) {
          const result = results[index] as BulkItemResult;
          result.success = false;
          result.error = toBulkError(error);
        }
      }
    }
    return summarizeBulk(this.provider, 'async', results);
  }

  async trackOrder(query: TrackQuery): Promise<Tracking> {
    const resolved = resolveTrackQuery(query);
    if (!resolved) {
      throwIssues([{ field: 'consignmentId', code: 'required', message: 'A consignment id is required' }], this.provider);
    }
    if (resolved.kind !== 'consignmentId') {
      return this.unsupported(`trackOrder by ${resolved.kind}`, 'Pathao order info is looked up by consignment id');
    }
    const response = await this.authed({ method: 'GET', path: PATHAO_ENDPOINTS.orderInfo(resolved.value) });
    const tracking = parseOrderInfo(response.data, resolved.value, this.mapStatus);
    if (!tracking) throw this.unexpected('order info', response);
    return tracking;
  }

  override async calculateCharge(input: ChargeInput): Promise<Charge> {
    const charge = validateChargeInput(input, { ...this.rules, weightMinKg: 0.01 }, this.provider);
    const storeId = charge.storeId ?? this.storeId;
    const issues = [];
    if (storeId === undefined) issues.push({ field: 'storeId', code: 'required', message: 'storeId is required for a Pathao price quote' });
    if (charge.cityId === undefined) issues.push({ field: 'cityId', code: 'required', message: 'cityId is required for a Pathao price quote' });
    if (charge.zoneId === undefined) issues.push({ field: 'zoneId', code: 'required', message: 'zoneId is required for a Pathao price quote' });
    if (issues.length > 0 || storeId === undefined) throwIssues(issues, this.provider);
    const response = await this.authed({
      method: 'POST',
      path: PATHAO_ENDPOINTS.pricePlan,
      body: buildPricePayload(charge, storeId),
      idempotent: true,
    });
    const parsed = parsePriceResponse(response.data, charge.codAmount);
    if (!parsed) throw this.unexpected('price plan', response);
    return parsed;
  }

  override async listCities(): Promise<City[]> {
    const response = await this.authed({ method: 'GET', path: PATHAO_ENDPOINTS.cities });
    return parseCities(response.data);
  }

  override async listZones(cityId: Id): Promise<Zone[]> {
    if (cityId === undefined || cityId === null || String(cityId).trim() === '') {
      throwIssues([{ field: 'cityId', code: 'required', message: 'cityId is required' }], this.provider);
    }
    const response = await this.authed({ method: 'GET', path: PATHAO_ENDPOINTS.zones(cityId) });
    return parseZones(response.data, cityId);
  }

  override async listAreas(query: AreaQuery): Promise<Area[]> {
    const zoneId = query?.zoneId;
    if (zoneId === undefined || String(zoneId).trim() === '') {
      throwIssues([{ field: 'zoneId', code: 'required', message: 'zoneId is required to list Pathao areas' }], this.provider);
    }
    const response = await this.authed({ method: 'GET', path: PATHAO_ENDPOINTS.areas(zoneId) });
    return parseAreas(response.data, zoneId);
  }

  /** Pickup stores registered on the merchant account. */
  async listStores(): Promise<PathaoStore[]> {
    const response = await this.authed({ method: 'GET', path: PATHAO_ENDPOINTS.stores });
    return parseStores(response.data);
  }

  private prepare(input: CreateOrderInput): { order: NormalizedOrderInput; storeId: Id } {
    const { issues, normalized } = checkCreateOrder(input, this.rules);
    const storeId = normalized.storeId ?? this.storeId;
    if (storeId === undefined || String(storeId).trim() === '') {
      issues.push({
        field: 'storeId',
        code: 'required',
        message: 'A Pathao store id is required (set `storeId` on the client or the order)',
      });
    }
    if (issues.length > 0 || storeId === undefined) throwIssues(issues, this.provider);
    return { order: normalized, storeId };
  }

  /**
   * Send an authenticated request. If the API rejects the token, the cached
   * token is discarded and the request is replayed once with a new one.
   */
  private async authed<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const send = (token: string): Promise<HttpResponse<T>> =>
      this.http.request<T>({ ...request, headers: { ...(request.headers ?? {}), Authorization: `Bearer ${token}` } });
    // Token acquisition failures propagate as-is; only a 401 from the API call itself triggers a replay.
    const token = await this.tokens.getAccessToken();
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 401) throw error;
      this.tokens.invalidate();
      return send(await this.tokens.getAccessToken());
    }
  }

  private unexpected(what: string, response: HttpResponse<unknown>): ProviderError | ValidationError {
    return new ProviderError(`[pathao] unexpected ${what} response`, {
      provider: this.provider,
      status: response.status,
      details: this.redactor.redactValue(response.data),
    });
  }
}
