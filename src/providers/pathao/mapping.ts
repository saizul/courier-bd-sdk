/**
 * Pathao Courier merchant API ("Aladdin") wire format.
 *
 * Every endpoint path, request field name, response field name and raw status
 * string for Pathao lives in this file. If Pathao changes its API, or a name
 * here turns out to differ from the current merchant documentation, this is
 * the only file that needs to change.
 *
 * NOTE: these names follow the publicly documented merchant API as best known
 * at the time of writing and are exercised against mocked responses only.
 * Verify them against Pathao's current documentation before production use.
 */
import { OrderStatus, createStatusMapper, type StatusTable } from '../../status.js';
import type { Area, Charge, ChargeInput, City, Id, Order, Tracking, WebhookEvent, Zone } from '../../types.js';
import { compact, isRecord, numericId, pick, roundMoney, toBool, toIsoTimestamp, toNumber, toStr } from '../../utils.js';
import type { NormalizedOrderInput } from '../../validation.js';

export const PATHAO_BASE_URLS = {
  production: 'https://api-hermes.pathao.com',
  sandbox: 'https://courier-api-sandbox.pathao.com',
} as const;

export const PATHAO_ENDPOINTS = {
  issueToken: '/aladdin/api/v1/issue-token',
  createOrder: '/aladdin/api/v1/orders',
  bulkCreate: '/aladdin/api/v1/orders/bulk',
  orderInfo: (consignmentId: Id) => `/aladdin/api/v1/orders/${encodeURIComponent(String(consignmentId))}/info`,
  cities: '/aladdin/api/v1/city-list',
  zones: (cityId: Id) => `/aladdin/api/v1/cities/${encodeURIComponent(String(cityId))}/zone-list`,
  areas: (zoneId: Id) => `/aladdin/api/v1/zones/${encodeURIComponent(String(zoneId))}/area-list`,
  pricePlan: '/aladdin/api/v1/merchant/price-plan',
  stores: '/aladdin/api/v1/stores',
} as const;

/** Pathao delivery type codes. */
export const PATHAO_DELIVERY_TYPE = { normal: 48, express: 12 } as const;
/** Pathao item type codes. */
export const PATHAO_ITEM_TYPE = { document: 1, parcel: 2 } as const;

/** Limits Pathao documents for order creation. */
export const PATHAO_RULES = {
  nameMinLength: 3,
  nameMaxLength: 100,
  addressMinLength: 10,
  addressMaxLength: 220,
  weightMinKg: 0.5,
  weightMaxKg: 10,
  codInteger: true,
} as const;

/** Webhook header carrying the shared secret configured in the merchant panel. */
export const PATHAO_WEBHOOK_SIGNATURE_HEADER = 'x-pathao-signature';
/** Header Pathao expects in the response when a webhook URL is being registered. */
export const PATHAO_WEBHOOK_INTEGRATION_HEADER = 'X-Pathao-Merchant-Webhook-Integration-Secret';

/**
 * Raw Pathao status -> normalized status. Keys are in normalized form (see
 * `normalizeStatusKey`), so "Assigned for Delivery", "assigned-for-delivery"
 * and the webhook event "order.assigned-for-delivery" (prefix stripped) all
 * resolve through the same table.
 */
export const PATHAO_STATUS_MAP: StatusTable = Object.freeze({
  pending: OrderStatus.Pending,
  created: OrderStatus.Pending,
  pickup_requested: OrderStatus.Pending,
  assigned_for_pickup: OrderStatus.Pending,
  pickup_failed: OrderStatus.OnHold,
  pickup_cancelled: OrderStatus.Cancelled,
  pickup_cancel: OrderStatus.Cancelled,
  cancelled: OrderStatus.Cancelled,
  picked: OrderStatus.PickedUp,
  picked_up: OrderStatus.PickedUp,
  at_the_sorting_hub: OrderStatus.InTransit,
  in_transit: OrderStatus.InTransit,
  received_at_last_mile_hub: OrderStatus.InTransit,
  assigned_for_delivery: OrderStatus.OutForDelivery,
  delivered: OrderStatus.Delivered,
  partial_delivery: OrderStatus.PartialDelivered,
  partial_delivered: OrderStatus.PartialDelivered,
  exchange: OrderStatus.Delivered,
  exchanged: OrderStatus.Delivered,
  payment_invoice: OrderStatus.Delivered,
  paid: OrderStatus.Delivered,
  return: OrderStatus.Returned,
  returned: OrderStatus.Returned,
  paid_return: OrderStatus.Returned,
  delivery_failed: OrderStatus.OnHold,
  on_hold: OrderStatus.OnHold,
  hold: OrderStatus.OnHold,
});

export const mapPathaoStatus = createStatusMapper(PATHAO_STATUS_MAP);

/* ------------------------------- Auth ----------------------------------- */

export interface PathaoCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export function buildTokenRequest(credentials: PathaoCredentials): Record<string, unknown> {
  return {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'password',
    username: credentials.username,
    password: credentials.password,
  };
}

export function buildRefreshRequest(credentials: PathaoCredentials, refreshToken: string): Record<string, unknown> {
  return {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
}

export interface PathaoTokenPayload {
  accessToken: string;
  refreshToken?: string;
  /** Lifetime in seconds, when the response states one. */
  expiresInSec?: number;
}

export function parseTokenResponse(body: unknown): PathaoTokenPayload | undefined {
  const accessToken = toStr(pick(body, 'access_token'));
  if (accessToken === undefined) return undefined;
  const payload: PathaoTokenPayload = { accessToken };
  const refreshToken = toStr(pick(body, 'refresh_token'));
  if (refreshToken !== undefined) payload.refreshToken = refreshToken;
  const expiresIn = toNumber(pick(body, 'expires_in'));
  if (expiresIn !== undefined && expiresIn > 0) payload.expiresInSec = expiresIn;
  return payload;
}

/* ------------------------------ Envelope -------------------------------- */

/** Pathao wraps results as `{ message, type, code, data }`. */
export function unwrapData(body: unknown): unknown {
  return isRecord(body) && 'data' in body ? body.data : body;
}

/** Lists arrive as `{ data: { data: [...] } }`; tolerate a bare array too. */
function unwrapList(body: unknown): unknown[] {
  const data = unwrapData(body);
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.data)) return data.data;
  return [];
}

/* ------------------------------- Orders --------------------------------- */

export function buildOrderPayload(order: NormalizedOrderInput, storeId: Id): Record<string, unknown> {
  const recipient = order.recipient;
  return {
    ...compact({
      store_id: numericId(storeId),
      merchant_order_id: order.merchantOrderId,
      recipient_name: recipient.name,
      recipient_phone: recipient.phone,
      recipient_secondary_phone: recipient.secondaryPhone,
      recipient_address: recipient.address,
      recipient_city: numericId(recipient.cityId),
      recipient_zone: numericId(recipient.zoneId),
      recipient_area: numericId(recipient.areaId),
      delivery_type: PATHAO_DELIVERY_TYPE[order.deliveryType],
      item_type: PATHAO_ITEM_TYPE[order.itemType],
      special_instruction: order.note,
      item_quantity: order.quantity,
      item_weight: order.weightKg,
      item_description: order.itemDescription,
      amount_to_collect: order.codAmount,
    }),
    ...(order.extra ?? {}),
  };
}

export function buildBulkPayload(orders: Array<Record<string, unknown>>): Record<string, unknown> {
  return { orders };
}

export function parseOrderResponse(body: unknown, order?: NormalizedOrderInput): Order | undefined {
  const data = unwrapData(body);
  const consignmentId = toStr(pick(data, 'consignment_id'));
  if (consignmentId === undefined) return undefined;
  const providerStatus = toStr(pick(data, 'order_status'));
  const result: Order = {
    provider: 'pathao',
    consignmentId,
    status: providerStatus === undefined ? OrderStatus.Pending : mapPathaoStatus(providerStatus),
    raw: body,
  };
  const merchantOrderId = toStr(pick(data, 'merchant_order_id')) ?? order?.merchantOrderId;
  if (merchantOrderId !== undefined) result.merchantOrderId = merchantOrderId;
  if (providerStatus !== undefined) result.providerStatus = providerStatus;
  const fee = toNumber(pick(data, 'delivery_fee'));
  if (fee !== undefined) result.deliveryFee = fee;
  if (order) result.codAmount = order.codAmount;
  return result;
}

export function parseBulkResponse(body: unknown): { accepted: boolean; message?: string } {
  const code = toNumber(pick(body, 'code'));
  const type = toStr(pick(body, 'type'));
  const accepted = type === 'success' || code === 200 || code === 202 || pick(body, 'data') === true;
  const message = toStr(pick(body, 'message'));
  return message !== undefined ? { accepted, message } : { accepted };
}

export function parseOrderInfo(body: unknown, requestedId: string, mapStatus = mapPathaoStatus): Tracking | undefined {
  const data = unwrapData(body);
  if (!isRecord(data)) return undefined;
  const providerStatus = toStr(pick(data, 'order_status_slug', 'order_status'));
  const label = toStr(pick(data, 'order_status'));
  const status = providerStatus === undefined ? OrderStatus.Unknown : mapStatus(providerStatus);
  const updatedAt = toIsoTimestamp(pick(data, 'updated_at'));
  const tracking: Tracking = {
    provider: 'pathao',
    consignmentId: toStr(pick(data, 'consignment_id')) ?? requestedId,
    status,
    events: [],
    raw: body,
  };
  const merchantOrderId = toStr(pick(data, 'merchant_order_id'));
  if (merchantOrderId !== undefined) tracking.merchantOrderId = merchantOrderId;
  if (providerStatus !== undefined) tracking.providerStatus = providerStatus;
  if (updatedAt !== undefined) tracking.updatedAt = updatedAt;
  if (providerStatus !== undefined) {
    tracking.events.push(
      compact({ status, providerStatus, message: label, timestamp: updatedAt }) as Tracking['events'][number],
    );
  }
  return tracking;
}

/* ------------------------------ Locations ------------------------------- */

export function parseCities(body: unknown): City[] {
  const out: City[] = [];
  for (const item of unwrapList(body)) {
    const id = pick(item, 'city_id');
    const name = toStr(pick(item, 'city_name'));
    if ((typeof id === 'number' || typeof id === 'string') && name !== undefined) out.push({ id, name });
  }
  return out;
}

export function parseZones(body: unknown, cityId: Id): Zone[] {
  const out: Zone[] = [];
  for (const item of unwrapList(body)) {
    const id = pick(item, 'zone_id');
    const name = toStr(pick(item, 'zone_name'));
    if ((typeof id === 'number' || typeof id === 'string') && name !== undefined) out.push({ id, name, cityId });
  }
  return out;
}

export function parseAreas(body: unknown, zoneId: Id): Area[] {
  const out: Area[] = [];
  for (const item of unwrapList(body)) {
    const id = pick(item, 'area_id');
    const name = toStr(pick(item, 'area_name'));
    if ((typeof id !== 'number' && typeof id !== 'string') || name === undefined) continue;
    const area: Area = { id, name, zoneId };
    const home = toBool(pick(item, 'home_delivery_available'));
    if (home !== undefined) area.homeDeliveryAvailable = home;
    const pickup = toBool(pick(item, 'pickup_available'));
    if (pickup !== undefined) area.pickupAvailable = pickup;
    out.push(area);
  }
  return out;
}

export interface PathaoStore {
  id: Id;
  name: string;
  address?: string;
  cityId?: Id;
  zoneId?: Id;
  isActive?: boolean;
  isDefault?: boolean;
}

export function parseStores(body: unknown): PathaoStore[] {
  const out: PathaoStore[] = [];
  for (const item of unwrapList(body)) {
    const id = pick(item, 'store_id');
    const name = toStr(pick(item, 'store_name'));
    if ((typeof id !== 'number' && typeof id !== 'string') || name === undefined) continue;
    const store: PathaoStore = { id, name };
    const address = toStr(pick(item, 'store_address'));
    if (address !== undefined) store.address = address;
    const cityId = pick(item, 'city_id');
    if (typeof cityId === 'number' || typeof cityId === 'string') store.cityId = cityId;
    const zoneId = pick(item, 'zone_id');
    if (typeof zoneId === 'number' || typeof zoneId === 'string') store.zoneId = zoneId;
    const active = toBool(pick(item, 'is_active'));
    if (active !== undefined) store.isActive = active;
    const isDefault = toBool(pick(item, 'is_default_store'));
    if (isDefault !== undefined) store.isDefault = isDefault;
    out.push(store);
  }
  return out;
}

/* ------------------------------- Pricing -------------------------------- */

export function buildPricePayload(input: ChargeInput, storeId: Id): Record<string, unknown> {
  return compact({
    store_id: numericId(storeId),
    item_type: PATHAO_ITEM_TYPE[input.itemType ?? 'parcel'],
    delivery_type: PATHAO_DELIVERY_TYPE[input.deliveryType ?? 'normal'],
    item_weight: input.weightKg,
    recipient_city: numericId(input.cityId),
    recipient_zone: numericId(input.zoneId),
  });
}

/**
 * `final_price` is taken as the delivery charge after discounts. The COD fee
 * is derived from `cod_percentage`, which is treated as a fraction of the
 * collected amount (0.01 means 1%).
 */
export function parsePriceResponse(body: unknown, codAmount: number): Charge | undefined {
  const data = unwrapData(body);
  const price = toNumber(pick(data, 'price'));
  const finalPrice = toNumber(pick(data, 'final_price')) ?? price;
  if (finalPrice === undefined) return undefined;
  const discount = (toNumber(pick(data, 'discount')) ?? 0) + (toNumber(pick(data, 'promo_discount')) ?? 0);
  const codEnabled = toBool(pick(data, 'cod_enabled')) ?? false;
  const codFraction = toNumber(pick(data, 'cod_percentage')) ?? 0;
  const codCharge = codEnabled ? roundMoney(codAmount * codFraction) : 0;
  const deliveryCharge = roundMoney(finalPrice);
  return {
    provider: 'pathao',
    deliveryCharge,
    codCharge,
    discount: roundMoney(discount),
    total: roundMoney(deliveryCharge + codCharge),
    currency: 'BDT',
    estimated: false,
    raw: body,
  };
}

/* ------------------------------- Webhooks ------------------------------- */

/** Events that describe something other than a parcel status change. */
const NON_STATUS_EVENTS = new Set(['webhook_integration', 'order_updated', 'store_created', 'store_updated']);

export function parseWebhookPayload(payload: unknown): WebhookEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const rawEvent = toStr(pick(payload, 'event', 'order_status_slug', 'order_status'));
  const consignmentId = toStr(pick(payload, 'consignment_id'));
  if (rawEvent === undefined && consignmentId === undefined) return undefined;
  const eventKey = (rawEvent ?? '').replace(/^order[._-]/i, '');
  const status = mapPathaoStatus(eventKey);
  const isOther = rawEvent === undefined || NON_STATUS_EVENTS.has(eventKey.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  const event: WebhookEvent = {
    provider: 'pathao',
    type: isOther ? 'other' : 'status_update',
    consignmentId: consignmentId ?? '',
    status,
    raw: payload,
  };
  if (rawEvent !== undefined) event.providerStatus = rawEvent;
  const merchantOrderId = toStr(pick(payload, 'merchant_order_id'));
  if (merchantOrderId !== undefined) event.merchantOrderId = merchantOrderId;
  const timestamp = toIsoTimestamp(pick(payload, 'updated_at', 'timestamp'));
  if (timestamp !== undefined) event.timestamp = timestamp;
  const message = toStr(pick(payload, 'reason', 'message'));
  if (message !== undefined) event.message = message;
  const cod = toNumber(pick(payload, 'collected_amount'));
  if (cod !== undefined) event.codAmount = cod;
  const fee = toNumber(pick(payload, 'delivery_fee'));
  if (fee !== undefined) event.deliveryFee = fee;
  return event;
}
