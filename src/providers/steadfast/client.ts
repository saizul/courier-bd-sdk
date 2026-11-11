import { BaseCourier, resolveTrackQuery, summarizeBulk, toBulkError, type CommonConfig } from '../../base.js';
import { AuthError, ConfigError, ProviderError } from '../../errors.js';
import { errorFromStatus, type HttpRequest, type HttpResponse } from '../../http.js';
import { assertRateCard, chargeFromRateCard, type RateCard } from '../../ratecard.js';
import { createStatusMapper, type StatusMapper } from '../../status.js';
import type {
  BulkCreateResult,
  BulkItemResult,
  Capabilities,
  Charge,
  ChargeInput,
  CreateOrderInput,
  Order,
  Tracking,
  TrackQuery,
} from '../../types.js';
import { chunk } from '../../utils.js';
import { throwIssues, validateChargeInput, validateCreateOrder } from '../../validation.js';
import {
  STEADFAST_BASE_URL,
  STEADFAST_BULK_LIMIT,
  STEADFAST_ENDPOINTS,
  STEADFAST_HEADERS,
  STEADFAST_RULES,
  STEADFAST_STATUS_MAP,
  buildBulkPayload,
  buildOrderPayload,
  embeddedErrorStatus,
  parseBalance,
  parseBulkResponse,
  parseOrderResponse,
  parseStatusResponse,
} from './mapping.js';

export interface SteadfastConfig extends CommonConfig {
  apiKey: string;
  secretKey: string;
  /**
   * Steadfast has no pricing endpoint. Supply your own rate card to enable
   * `calculateCharge` (and "cheapest" routing) as a local estimate.
   */
  rateCard?: RateCard;
  /** Items per bulk request. Default and maximum 500. */
  bulkChunkSize?: number;
}

export class SteadfastCourier extends BaseCourier {
  readonly capabilities: Readonly<Capabilities>;
  private readonly rateCard: RateCard | undefined;
  private readonly bulkChunkSize: number;
  private readonly mapStatus: StatusMapper;

  constructor(config: SteadfastConfig) {
    const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
    const secretKey = typeof config?.secretKey === 'string' ? config.secretKey.trim() : '';
    super('steadfast', config ?? {}, {
      baseUrl: STEADFAST_BASE_URL,
      rules: STEADFAST_RULES,
      headers: { [STEADFAST_HEADERS.apiKey]: apiKey, [STEADFAST_HEADERS.secretKey]: secretKey },
    });
    const missing = [apiKey === '' ? 'apiKey' : '', secretKey === '' ? 'secretKey' : ''].filter(Boolean);
    if (missing.length > 0) {
      throw new ConfigError(`[steadfast] missing required config: ${missing.join(', ')}`, { provider: 'steadfast' });
    }
    this.redactor.add(apiKey, secretKey);
    if (config.rateCard) assertRateCard(config.rateCard, 'steadfast');
    this.rateCard = config.rateCard;
    const size = config.bulkChunkSize ?? STEADFAST_BULK_LIMIT;
    if (!Number.isInteger(size) || size < 1 || size > STEADFAST_BULK_LIMIT) {
      throw new ConfigError(`[steadfast] bulkChunkSize must be an integer between 1 and ${STEADFAST_BULK_LIMIT}`, {
        provider: 'steadfast',
      });
    }
    this.bulkChunkSize = size;
    this.mapStatus = createStatusMapper(STEADFAST_STATUS_MAP, config.statusOverrides);
    this.capabilities = Object.freeze({
      cancelOrder: false,
      calculateCharge: config.rateCard ? 'rate_card' : false,
      bulkCreate: 'native',
      listCities: false,
      listZones: false,
      listAreas: false,
      trackByMerchantOrderId: true,
      trackByTrackingCode: true,
    });
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const order = validateCreateOrder(input, this.rules, this.provider);
    const response = await this.send({ method: 'POST', path: STEADFAST_ENDPOINTS.createOrder, body: buildOrderPayload(order) });
    const parsed = parseOrderResponse(response.data, this.mapStatus);
    if (!parsed) throw this.unexpected('create order', response);
    parsed.merchantOrderId ??= order.merchantOrderId;
    parsed.codAmount ??= order.codAmount;
    return parsed;
  }

  /**
   * Create many orders through the bulk endpoint, in chunks of up to 500.
   * Items failing local validation are reported individually and never sent.
   * A failed chunk marks only its own items as failed; other chunks proceed.
   */
  async bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult> {
    const results: BulkItemResult[] = [];
    const pending: Array<{ index: number; invoice: string; payload: Record<string, unknown> }> = [];
    inputs.forEach((input, index) => {
      const merchantOrderId = String(input?.merchantOrderId ?? '');
      try {
        const order = validateCreateOrder(input, this.rules, this.provider);
        pending.push({ index, invoice: order.merchantOrderId, payload: buildOrderPayload(order) });
        results.push({ index, merchantOrderId: order.merchantOrderId, success: false });
      } catch (error) {
        results.push({ index, merchantOrderId, success: false, error: toBulkError(error) });
      }
    });

    for (const group of chunk(pending, this.bulkChunkSize)) {
      try {
        const response = await this.send({
          method: 'POST',
          path: STEADFAST_ENDPOINTS.bulkCreate,
          body: buildBulkPayload(group.map((item) => item.payload)),
        });
        const items = parseBulkResponse(response.data, this.mapStatus);
        if (!items) throw this.unexpected('bulk create', response);
        const byInvoice = new Map(items.filter((item) => item.invoice !== undefined).map((item) => [item.invoice as string, item]));
        group.forEach((entry, position) => {
          // Match by invoice; fall back to position when the courier omits it.
          const item = byInvoice.get(entry.invoice) ?? (items[position]?.invoice === undefined ? items[position] : undefined);
          const result = results[entry.index] as BulkItemResult;
          if (item?.ok && item.order) {
            item.order.merchantOrderId ??= entry.invoice;
            result.success = true;
            result.order = item.order;
          } else {
            result.error = {
              code: 'PROVIDER',
              message: item?.message ?? 'Steadfast did not return a result for this order',
            };
          }
        });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        for (const entry of group) (results[entry.index] as BulkItemResult).error = toBulkError(error);
      }
    }
    return summarizeBulk(this.provider, 'sync', results);
  }

  /** Track by consignment id (default), invoice (`merchantOrderId`) or tracking code. */
  async trackOrder(query: TrackQuery): Promise<Tracking> {
    const resolved = resolveTrackQuery(query);
    if (!resolved) {
      throwIssues(
        [{ field: 'consignmentId', code: 'required', message: 'A consignment id, merchant order id or tracking code is required' }],
        this.provider,
      );
    }
    const path =
      resolved.kind === 'merchantOrderId'
        ? STEADFAST_ENDPOINTS.statusByInvoice(resolved.value)
        : resolved.kind === 'trackingCode'
          ? STEADFAST_ENDPOINTS.statusByTrackingCode(resolved.value)
          : STEADFAST_ENDPOINTS.statusByConsignmentId(resolved.value);
    const response = await this.send({ method: 'GET', path });
    const tracking = parseStatusResponse(response.data, resolved, this.mapStatus);
    if (!tracking) throw this.unexpected('status', response);
    return tracking;
  }

  /** Local estimate from the configured rate card. */
  override async calculateCharge(input: ChargeInput): Promise<Charge> {
    if (!this.rateCard) {
      return this.unsupported('calculateCharge', 'Steadfast has no pricing endpoint; configure a `rateCard` to estimate locally');
    }
    const charge = validateChargeInput(input, { ...this.rules, weightMinKg: 0.01 }, this.provider);
    return chargeFromRateCard(this.provider, this.rateCard, charge);
  }

  /** Current merchant account balance in BDT. */
  async getBalance(): Promise<number> {
    const response = await this.send({ method: 'GET', path: STEADFAST_ENDPOINTS.balance });
    const balance = parseBalance(response.data);
    if (balance === undefined) throw this.unexpected('balance', response);
    return balance;
  }

  /** Send a request, converting Steadfast's "HTTP 200 with error status in body" into typed errors. */
  private async send(request: HttpRequest): Promise<HttpResponse<unknown>> {
    const response = await this.http.request(request);
    const embedded = embeddedErrorStatus(response.data);
    if (embedded !== undefined) {
      throw errorFromStatus({
        provider: this.provider,
        method: request.method,
        path: request.path,
        status: embedded,
        body: response.data,
        redactor: this.redactor,
      });
    }
    return response;
  }

  private unexpected(what: string, response: HttpResponse<unknown>): ProviderError {
    return new ProviderError(`[steadfast] unexpected ${what} response`, {
      provider: this.provider,
      status: response.status,
      details: this.redactor.redactValue(response.data),
    });
  }
}
