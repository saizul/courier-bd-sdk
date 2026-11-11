import { BaseCourier, resolveTrackQuery, type CommonConfig } from '../../base.js';
import { ConfigError, ProviderError } from '../../errors.js';
import type { HttpResponse } from '../../http.js';
import { createStatusMapper, type StatusMapper } from '../../status.js';
import type {
  Area,
  AreaQuery,
  BulkCreateResult,
  CancelResult,
  Capabilities,
  Charge,
  ChargeInput,
  CreateOrderInput,
  Id,
  Order,
  Tracking,
  TrackQuery,
} from '../../types.js';
import { checkCreateOrder, throwIssues, validateChargeInput } from '../../validation.js';
import {
  REDX_AUTH_HEADER,
  REDX_BASE_URLS,
  REDX_ENDPOINTS,
  REDX_RULES,
  REDX_STATUS_MAP,
  buildAreaQuery,
  buildCancelPayload,
  buildChargeQuery,
  buildParcelPayload,
  buildTracking,
  parseAreas,
  parseCancelResponse,
  parseChargeResponse,
  parseCreateResponse,
  parseParcelInfo,
  parsePickupStores,
  parseTrackingEvents,
  type RedxParcelInfo,
  type RedxPickupStore,
} from './mapping.js';

export interface RedxConfig extends CommonConfig {
  /** API access token from the RedX merchant panel (without the `Bearer ` prefix). */
  accessToken: string;
  /** Use the sandbox base URL. */
  sandbox?: boolean;
  /** Default pickup store for new parcels. */
  pickupStoreId?: Id;
  /** Default pickup area for charge calculation. */
  pickupAreaId?: Id;
  /** Parallel requests used by `bulkCreate`. Default 3. */
  bulkConcurrency?: number;
}

export class RedxCourier extends BaseCourier {
  readonly capabilities: Readonly<Capabilities> = Object.freeze({
    cancelOrder: true,
    calculateCharge: 'api',
    bulkCreate: 'emulated',
    listCities: false,
    listZones: false,
    listAreas: true,
    trackByMerchantOrderId: false,
    trackByTrackingCode: true,
  });

  private readonly pickupStoreId: Id | undefined;
  private readonly pickupAreaId: Id | undefined;
  private readonly bulkConcurrency: number;
  private readonly mapStatus: StatusMapper;

  constructor(config: RedxConfig) {
    const token = typeof config?.accessToken === 'string' ? config.accessToken.trim().replace(/^Bearer\s+/i, '') : '';
    super('redx', config ?? {}, {
      baseUrl: config?.sandbox ? REDX_BASE_URLS.sandbox : REDX_BASE_URLS.production,
      rules: REDX_RULES,
      headers: { [REDX_AUTH_HEADER]: `Bearer ${token}` },
    });
    if (token === '') throw new ConfigError('[redx] missing required config: accessToken', { provider: 'redx' });
    this.redactor.add(token);
    this.pickupStoreId = config.pickupStoreId;
    this.pickupAreaId = config.pickupAreaId;
    const concurrency = config.bulkConcurrency ?? 3;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new ConfigError('[redx] bulkConcurrency must be a positive integer', { provider: 'redx' });
    }
    this.bulkConcurrency = concurrency;
    this.mapStatus = createStatusMapper(REDX_STATUS_MAP, config.statusOverrides);
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const { issues, normalized } = checkCreateOrder(input, this.rules);
    const areaId = normalized.recipient.areaId;
    if (areaId === undefined || String(areaId).trim() === '') {
      issues.push({ field: 'recipient.areaId', code: 'required', message: 'RedX requires a delivery area id (see listAreas)' });
    }
    if (!normalized.recipient.areaName) {
      issues.push({ field: 'recipient.areaName', code: 'required', message: 'RedX requires the delivery area name (see listAreas)' });
    }
    if (issues.length > 0) throwIssues(issues, this.provider);
    const response = await this.http.request({
      method: 'POST',
      path: REDX_ENDPOINTS.createParcel,
      body: buildParcelPayload(normalized, this.pickupStoreId),
    });
    const order = parseCreateResponse(response.data, normalized);
    if (!order) throw this.unexpected('create parcel', response);
    return order;
  }

  /** RedX has no bulk endpoint; parcels are created one by one with bounded concurrency. */
  bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult> {
    return this.emulateBulk(inputs, this.bulkConcurrency);
  }

  /**
   * Combines the parcel info endpoint (current status) with the tracking
   * endpoint (history). If the info lookup fails for a non-auth reason, the
   * status falls back to a best-effort reading of the latest tracking message.
   */
  async trackOrder(query: TrackQuery): Promise<Tracking> {
    const resolved = resolveTrackQuery(query);
    if (!resolved) {
      throwIssues([{ field: 'consignmentId', code: 'required', message: 'A tracking id is required' }], this.provider);
    }
    if (resolved.kind === 'merchantOrderId') {
      return this.unsupported('trackOrder by merchantOrderId', 'RedX parcels are looked up by tracking id');
    }
    const id = resolved.value;
    const [trackResult, infoResult] = await Promise.allSettled([
      this.http.request({ method: 'GET', path: REDX_ENDPOINTS.trackParcel(id) }),
      this.http.request({ method: 'GET', path: REDX_ENDPOINTS.parcelInfo(id) }),
    ]);
    if (trackResult.status === 'rejected') throw trackResult.reason;
    const events = parseTrackingEvents(trackResult.value.data);
    if (!events) throw this.unexpected('tracking', trackResult.value);
    let info: RedxParcelInfo | undefined;
    if (infoResult.status === 'fulfilled') {
      info = parseParcelInfo(infoResult.value.data, id, this.mapStatus);
    } else if (!(infoResult.reason instanceof ProviderError)) {
      throw infoResult.reason;
    }
    return buildTracking(id, info, events, {
      tracking: trackResult.value.data,
      info: infoResult.status === 'fulfilled' ? infoResult.value.data : undefined,
    });
  }

  /** Full parcel details as RedX reports them. */
  async getParcelInfo(trackingId: Id): Promise<RedxParcelInfo> {
    const response = await this.http.request({ method: 'GET', path: REDX_ENDPOINTS.parcelInfo(trackingId) });
    const info = parseParcelInfo(response.data, String(trackingId), this.mapStatus);
    if (!info) throw this.unexpected('parcel info', response);
    return info;
  }

  override async cancelOrder(consignmentId: Id, reason?: string): Promise<CancelResult> {
    const id = consignmentId === undefined || consignmentId === null ? '' : String(consignmentId).trim();
    if (id === '') {
      throwIssues([{ field: 'consignmentId', code: 'required', message: 'A tracking id is required' }], this.provider);
    }
    const response = await this.http.request({
      method: 'PATCH',
      path: REDX_ENDPOINTS.updateParcel,
      body: buildCancelPayload(id, reason?.trim() || undefined),
      // Cancelling an already-cancelled parcel is harmless, so retries are safe.
      idempotent: true,
    });
    const outcome = parseCancelResponse(response.data);
    const result: CancelResult = { provider: this.provider, consignmentId: id, cancelled: outcome.cancelled, raw: response.data };
    if (outcome.message !== undefined) result.message = outcome.message;
    return result;
  }

  override async calculateCharge(input: ChargeInput): Promise<Charge> {
    const charge = validateChargeInput(input, { ...this.rules, weightMinKg: 0.01 }, this.provider);
    const pickupAreaId = charge.pickupAreaId ?? this.pickupAreaId;
    const issues = [];
    if (charge.areaId === undefined) issues.push({ field: 'areaId', code: 'required', message: 'areaId (delivery area) is required for a RedX charge' });
    if (pickupAreaId === undefined) issues.push({ field: 'pickupAreaId', code: 'required', message: 'pickupAreaId is required for a RedX charge' });
    if (issues.length > 0) throwIssues(issues, this.provider);
    const response = await this.http.request({
      method: 'GET',
      path: REDX_ENDPOINTS.chargeCalculator,
      query: buildChargeQuery({ ...charge, ...(pickupAreaId !== undefined ? { pickupAreaId } : {}) }),
    });
    const parsed = parseChargeResponse(response.data);
    if (!parsed) throw this.unexpected('charge calculator', response);
    return parsed;
  }

  /** All delivery areas, optionally filtered by post code, district name or zone. */
  override async listAreas(query: AreaQuery = {}): Promise<Area[]> {
    const response = await this.http.request({ method: 'GET', path: REDX_ENDPOINTS.areas, query: buildAreaQuery(query ?? {}) });
    return parseAreas(response.data);
  }

  /** Pickup stores registered on the merchant account. */
  async listPickupStores(): Promise<RedxPickupStore[]> {
    const response = await this.http.request({ method: 'GET', path: REDX_ENDPOINTS.pickupStores });
    return parsePickupStores(response.data);
  }

  private unexpected(what: string, response: HttpResponse<unknown>): ProviderError {
    return new ProviderError(`[redx] unexpected ${what} response`, {
      provider: this.provider,
      status: response.status,
      details: this.redactor.redactValue(response.data),
    });
  }
}
