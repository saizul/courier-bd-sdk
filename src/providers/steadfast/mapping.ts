/**
 * Steadfast Courier merchant API wire format.
 *
 * Every endpoint path, header name, request/response field name and raw
 * status string for Steadfast lives in this file, so corrections are a
 * one-file change.
 *
 * NOTE: these names follow the publicly documented merchant API as best known
 * at the time of writing and are exercised against mocked responses only.
 * Verify them against Steadfast's current documentation before production use.
 */
import { OrderStatus, createStatusMapper, type StatusMapper, type StatusTable } from '../../status.js';
import type { Id, Order, Tracking, WebhookEvent } from '../../types.js';
import { compact, isRecord, pick, toIsoTimestamp, toNumber, toStr } from '../../utils.js';
import type { NormalizedOrderInput } from '../../validation.js';

export const STEADFAST_BASE_URL = 'https://portal.packzy.com/api/v1';

export const STEADFAST_HEADERS = { apiKey: 'Api-Key', secretKey: 'Secret-Key' } as const;

export const STEADFAST_ENDPOINTS = {
  createOrder: '/create_order',
  bulkCreate: '/create_order/bulk-order',
  statusByConsignmentId: (id: Id) => `/status_by_cid/${encodeURIComponent(String(id))}`,
  statusByInvoice: (invoice: string) => `/status_by_invoice/${encodeURIComponent(invoice)}`,
  statusByTrackingCode: (code: string) => `/status_by_trackingcode/${encodeURIComponent(code)}`,
  balance: '/get_balance',
} as const;

/** Maximum items Steadfast accepts in one bulk request. */
export const STEADFAST_BULK_LIMIT = 500;

export const STEADFAST_RULES = {
  nameMinLength: 2,
  nameMaxLength: 100,
  addressMinLength: 5,
  addressMaxLength: 250,
  // Invoice ids may contain letters, digits, hyphens and underscores.
  merchantOrderIdPattern: /^[A-Za-z0-9_-]+$/,
} as const;

/** Raw Steadfast delivery status -> normalized status (keys in normalized form). */
export const STEADFAST_STATUS_MAP: StatusTable = Object.freeze({
  pending: OrderStatus.Pending,
  in_review: OrderStatus.Pending,
  delivered_approval_pending: OrderStatus.Delivered,
  partial_delivered_approval_pending: OrderStatus.PartialDelivered,
  cancelled_approval_pending: OrderStatus.Cancelled,
  unknown_approval_pending: OrderStatus.Unknown,
  delivered: OrderStatus.Delivered,
  partial_delivered: OrderStatus.PartialDelivered,
  cancelled: OrderStatus.Cancelled,
  hold: OrderStatus.OnHold,
  unknown: OrderStatus.Unknown,
});

export const mapSteadfastStatus = createStatusMapper(STEADFAST_STATUS_MAP);

/* ------------------------------- Orders --------------------------------- */

export function buildOrderPayload(order: NormalizedOrderInput): Record<string, unknown> {
  const recipient = order.recipient;
  return {
    ...compact({
      invoice: order.merchantOrderId,
      recipient_name: recipient.name,
      recipient_phone: recipient.phone,
      alternative_phone: recipient.secondaryPhone,
      recipient_address: recipient.address,
      cod_amount: order.codAmount,
      note: order.note,
      item_description: order.itemDescription,
      total_lot: order.quantity > 1 ? order.quantity : undefined,
    }),
    ...(order.extra ?? {}),
  };
}

export function buildBulkPayload(orders: Array<Record<string, unknown>>): Record<string, unknown> {
  return { data: orders };
}

/**
 * Steadfast reports some failures as HTTP 200 with a `status` field inside
 * the body. Returns that embedded status when it signals an error.
 */
export function embeddedErrorStatus(body: unknown): number | undefined {
  const status = toNumber(pick(body, 'status'));
  return status !== undefined && status >= 400 && status <= 599 ? status : undefined;
}

function parseConsignment(consignment: unknown, raw: unknown, mapStatus: StatusMapper): Order | undefined {
  const consignmentId = toStr(pick(consignment, 'consignment_id'));
  if (consignmentId === undefined) return undefined;
  const providerStatus = toStr(pick(consignment, 'status'));
  const order: Order = {
    provider: 'steadfast',
    consignmentId,
    status: providerStatus === undefined ? OrderStatus.Pending : mapStatus(providerStatus),
    raw,
  };
  const trackingCode = toStr(pick(consignment, 'tracking_code'));
  if (trackingCode !== undefined) order.trackingCode = trackingCode;
  const invoice = toStr(pick(consignment, 'invoice'));
  if (invoice !== undefined) order.merchantOrderId = invoice;
  if (providerStatus !== undefined) order.providerStatus = providerStatus;
  const cod = toNumber(pick(consignment, 'cod_amount'));
  if (cod !== undefined) order.codAmount = cod;
  const createdAt = toIsoTimestamp(pick(consignment, 'created_at'));
  if (createdAt !== undefined) order.createdAt = createdAt;
  return order;
}

export function parseOrderResponse(body: unknown, mapStatus: StatusMapper = mapSteadfastStatus): Order | undefined {
  return parseConsignment(pick(body, 'consignment'), body, mapStatus);
}

export interface SteadfastBulkItem {
  invoice?: string;
  ok: boolean;
  order?: Order;
  message?: string;
}

/** Bulk responses are an array of per-order results (optionally wrapped in `data`). */
export function parseBulkResponse(body: unknown, mapStatus: StatusMapper = mapSteadfastStatus): SteadfastBulkItem[] | undefined {
  const list = Array.isArray(body) ? body : pick(body, 'data');
  if (!Array.isArray(list)) return undefined;
  return list.map((item): SteadfastBulkItem => {
    const invoice = toStr(pick(item, 'invoice'));
    const state = toStr(pick(item, 'status'));
    const hasConsignment = toStr(pick(item, 'consignment_id')) !== undefined;
    const ok = hasConsignment && state !== 'error';
    const result: SteadfastBulkItem = { ok };
    if (invoice !== undefined) result.invoice = invoice;
    if (ok) {
      // In bulk results `status` is "success"/"error", not a delivery status.
      const order = parseConsignment({ ...(item as Record<string, unknown>), status: undefined }, item, mapStatus);
      if (order) result.order = order;
    } else {
      result.message = toStr(pick(item, 'message', 'error')) ?? 'Rejected by Steadfast';
    }
    return result;
  });
}

export function parseStatusResponse(
  body: unknown,
  requested: { kind: 'consignmentId' | 'merchantOrderId' | 'trackingCode'; value: string },
  mapStatus: StatusMapper = mapSteadfastStatus,
): Tracking | undefined {
  const providerStatus = toStr(pick(body, 'delivery_status'));
  if (providerStatus === undefined) return undefined;
  const status = mapStatus(providerStatus);
  const tracking: Tracking = {
    provider: 'steadfast',
    consignmentId: requested.kind === 'merchantOrderId' ? '' : requested.value,
    status,
    providerStatus,
    events: [{ status, providerStatus }],
    raw: body,
  };
  if (requested.kind === 'merchantOrderId') tracking.merchantOrderId = requested.value;
  return tracking;
}

export function parseBalance(body: unknown): number | undefined {
  return toNumber(pick(body, 'current_balance'));
}

/* ------------------------------- Webhooks ------------------------------- */

export function parseWebhookPayload(payload: unknown): WebhookEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const consignmentId = toStr(pick(payload, 'consignment_id'));
  const notificationType = toStr(pick(payload, 'notification_type'));
  if (consignmentId === undefined && notificationType === undefined) return undefined;
  const providerStatus = toStr(pick(payload, 'status'));
  const isStatus = notificationType === 'delivery_status' || (notificationType === undefined && providerStatus !== undefined);
  const event: WebhookEvent = {
    provider: 'steadfast',
    type: isStatus ? 'status_update' : notificationType === 'tracking_update' ? 'tracking_update' : 'other',
    consignmentId: consignmentId ?? '',
    status: providerStatus === undefined ? OrderStatus.Unknown : mapSteadfastStatus(providerStatus),
    raw: payload,
  };
  if (providerStatus !== undefined) event.providerStatus = providerStatus;
  const invoice = toStr(pick(payload, 'invoice'));
  if (invoice !== undefined) event.merchantOrderId = invoice;
  const message = toStr(pick(payload, 'tracking_message'));
  if (message !== undefined) event.message = message;
  const timestamp = toIsoTimestamp(pick(payload, 'updated_at'));
  if (timestamp !== undefined) event.timestamp = timestamp;
  const cod = toNumber(pick(payload, 'cod_amount'));
  if (cod !== undefined) event.codAmount = cod;
  const fee = toNumber(pick(payload, 'delivery_charge'));
  if (fee !== undefined) event.deliveryFee = fee;
  return event;
}
