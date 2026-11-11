/**
 * RedX merchant Open API wire format.
 *
 * Every endpoint path, header name, request/response field name and raw
 * status string for RedX lives in this file, so corrections are a one-file
 * change.
 *
 * NOTE: these names follow the publicly documented Open API as best known at
 * the time of writing and are exercised against mocked responses only.
 * Verify them against RedX's current documentation before production use.
 */
import { OrderStatus, createStatusMapper, type StatusMapper, type StatusTable } from '../../status.js';
import type { Area, AreaQuery, Charge, ChargeInput, Id, Order, Tracking, TrackingEvent, WebhookEvent } from '../../types.js';
import { compact, isRecord, numericId, pick, roundMoney, toIsoTimestamp, toNumber, toStr } from '../../utils.js';
import type { NormalizedOrderInput } from '../../validation.js';

export const REDX_BASE_URLS = {
  production: 'https://openapi.redx.com.bd/v1.0.0-beta',
  sandbox: 'https://sandbox.redx.com.bd/v1.0.0-beta',
} as const;

/** RedX sends the token in a custom header, with a `Bearer ` prefix. */
export const REDX_AUTH_HEADER = 'API-ACCESS-TOKEN';

export const REDX_ENDPOINTS = {
  createParcel: '/parcel',
  trackParcel: (trackingId: Id) => `/parcel/track/${encodeURIComponent(String(trackingId))}`,
  parcelInfo: (trackingId: Id) => `/parcel/info/${encodeURIComponent(String(trackingId))}`,
  updateParcel: '/parcels',
  areas: '/areas',
  chargeCalculator: '/charge/charge_calculator',
  pickupStores: '/pickup/stores',
} as const;

export const REDX_RULES = {
  nameMinLength: 2,
  nameMaxLength: 100,
  addressMinLength: 5,
  addressMaxLength: 250,
  weightMinKg: 0.05,
  weightMaxKg: 25,
} as const;

/** Raw RedX parcel status -> normalized status (keys in normalized form). */
export const REDX_STATUS_MAP: StatusTable = Object.freeze({
  pickup_pending: OrderStatus.Pending,
  pickup_requested: OrderStatus.Pending,
  pickup_assigned: OrderStatus.Pending,
  pending: OrderStatus.Pending,
  picked_up: OrderStatus.PickedUp,
  pickup_done: OrderStatus.PickedUp,
  received_at_hub: OrderStatus.InTransit,
  in_transit: OrderStatus.InTransit,
  ready_for_delivery: OrderStatus.InTransit,
  agent_area_change: OrderStatus.InTransit,
  delivery_in_progress: OrderStatus.OutForDelivery,
  out_for_delivery: OrderStatus.OutForDelivery,
  delivered: OrderStatus.Delivered,
  partial_delivered: OrderStatus.PartialDelivered,
  partially_delivered: OrderStatus.PartialDelivered,
  agent_hold: OrderStatus.OnHold,
  hold: OrderStatus.OnHold,
  on_hold: OrderStatus.OnHold,
  // A return in progress is reported as `returned`; inspect `providerStatus` to tell them apart.
  agent_returning: OrderStatus.Returned,
  returning: OrderStatus.Returned,
  returned: OrderStatus.Returned,
  cancelled: OrderStatus.Cancelled,
  canceled: OrderStatus.Cancelled,
  deleted: OrderStatus.Cancelled,
});

export const mapRedxStatus = createStatusMapper(REDX_STATUS_MAP);

/**
 * RedX tracking history entries carry only free-text messages. This derives a
 * best-effort status from the English message; unmatched text is `unknown`.
 */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, OrderStatus]> = [
  [/cancel/i, OrderStatus.Cancelled],
  [/partial/i, OrderStatus.PartialDelivered],
  [/return/i, OrderStatus.Returned],
  [/hold/i, OrderStatus.OnHold],
  [/out for delivery|delivery in progress|on the way to (the )?customer/i, OrderStatus.OutForDelivery],
  [/(not|could ?n.t be|failed to be) delivered|delivery failed/i, OrderStatus.OnHold],
  [/delivered/i, OrderStatus.Delivered],
  [/picked ?up|has been picked|pickup (done|complete)/i, OrderStatus.PickedUp],
  [/pickup (pending|request)|created|placed/i, OrderStatus.Pending],
  [/received at|hub|transit|ready for delivery|sorting/i, OrderStatus.InTransit],
];

export function statusFromMessage(message: unknown): OrderStatus {
  if (typeof message !== 'string') return OrderStatus.Unknown;
  for (const [pattern, status] of MESSAGE_PATTERNS) if (pattern.test(message)) return status;
  return OrderStatus.Unknown;
}

/* ------------------------------- Orders --------------------------------- */

export function kgToGrams(weightKg: number): number {
  return Math.round(weightKg * 1000);
}

export function buildParcelPayload(order: NormalizedOrderInput, pickupStoreId?: Id): Record<string, unknown> {
  const recipient = order.recipient;
  return {
    ...compact({
      customer_name: recipient.name,
      customer_phone: recipient.phone,
      delivery_area: recipient.areaName,
      delivery_area_id: numericId(recipient.areaId),
      customer_address: recipient.address,
      merchant_invoice_id: order.merchantOrderId,
      cash_collection_amount: order.codAmount,
      parcel_weight: kgToGrams(order.weightKg),
      instruction: order.note,
      value: order.declaredValue ?? order.codAmount,
      pickup_store_id: numericId(order.storeId ?? pickupStoreId),
      parcel_details_json: order.itemDescription
        ? [{ name: order.itemDescription, category: order.itemType, value: order.declaredValue ?? order.codAmount }]
        : undefined,
    }),
    ...(order.extra ?? {}),
  };
}

export function parseCreateResponse(body: unknown, order: NormalizedOrderInput): Order | undefined {
  const trackingId = toStr(pick(body, 'tracking_id'));
  if (trackingId === undefined) return undefined;
  return {
    provider: 'redx',
    consignmentId: trackingId,
    trackingCode: trackingId,
    merchantOrderId: order.merchantOrderId,
    status: OrderStatus.Pending,
    codAmount: order.codAmount,
    raw: body,
  };
}

export interface RedxParcelInfo {
  trackingId: string;
  status: OrderStatus;
  providerStatus?: string;
  merchantOrderId?: string;
  codAmount?: number;
  charge?: number;
  createdAt?: string;
  raw: unknown;
}

export function parseParcelInfo(body: unknown, requestedId: string, mapStatus: StatusMapper = mapRedxStatus): RedxParcelInfo | undefined {
  const parcel = pick(body, 'parcel');
  if (!isRecord(parcel)) return undefined;
  const providerStatus = toStr(pick(parcel, 'status'));
  const info: RedxParcelInfo = {
    trackingId: toStr(pick(parcel, 'tracking_id')) ?? requestedId,
    status: providerStatus === undefined ? OrderStatus.Unknown : mapStatus(providerStatus),
    raw: body,
  };
  if (providerStatus !== undefined) info.providerStatus = providerStatus;
  const invoice = toStr(pick(parcel, 'merchant_invoice_id'));
  if (invoice !== undefined) info.merchantOrderId = invoice;
  const cod = toNumber(pick(parcel, 'cash_collection_amount'));
  if (cod !== undefined) info.codAmount = cod;
  const charge = toNumber(pick(parcel, 'charge'));
  if (charge !== undefined) info.charge = charge;
  const createdAt = toIsoTimestamp(pick(parcel, 'created_at'));
  if (createdAt !== undefined) info.createdAt = createdAt;
  return info;
}

/** Tracking history, sorted oldest first. Returns undefined when the body has no `tracking` array. */
export function parseTrackingEvents(body: unknown): TrackingEvent[] | undefined {
  const list = pick(body, 'tracking');
  if (!Array.isArray(list)) return undefined;
  const events: TrackingEvent[] = [];
  for (const item of list) {
    const message = toStr(pick(item, 'message_en'));
    const event: TrackingEvent = { status: statusFromMessage(message) };
    if (message !== undefined) event.message = message;
    const messageBn = toStr(pick(item, 'message_bn'));
    if (messageBn !== undefined) event.messageBn = messageBn;
    const timestamp = toIsoTimestamp(pick(item, 'time'));
    if (timestamp !== undefined) event.timestamp = timestamp;
    events.push(event);
  }
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = a.event.timestamp ? Date.parse(a.event.timestamp) : Number.NaN;
      const tb = b.event.timestamp ? Date.parse(b.event.timestamp) : Number.NaN;
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.index - b.index;
      return ta - tb;
    })
    .map(({ event }) => event);
}

export function buildTracking(requestedId: string, info: RedxParcelInfo | undefined, events: TrackingEvent[], raw: unknown): Tracking {
  const latest = events[events.length - 1];
  const status = info && info.status !== OrderStatus.Unknown ? info.status : (latest?.status ?? OrderStatus.Unknown);
  const tracking: Tracking = {
    provider: 'redx',
    consignmentId: info?.trackingId ?? requestedId,
    status,
    events,
    raw,
  };
  if (info?.providerStatus !== undefined) tracking.providerStatus = info.providerStatus;
  if (info?.merchantOrderId !== undefined) tracking.merchantOrderId = info.merchantOrderId;
  if (latest?.timestamp !== undefined) tracking.updatedAt = latest.timestamp;
  return tracking;
}

/* ------------------------------- Cancel --------------------------------- */

export function buildCancelPayload(trackingId: Id, reason?: string): Record<string, unknown> {
  return {
    entity_type: 'parcel-tracking-id',
    entity_id: String(trackingId),
    update_details: compact({ property_name: 'status', new_value: 'cancelled', reason }),
  };
}

export function parseCancelResponse(body: unknown): { cancelled: boolean; message?: string } {
  const success = pick(body, 'success');
  const message = toStr(pick(body, 'message'));
  const cancelled = success === true || success === 'true' || success === 1;
  return message !== undefined ? { cancelled, message } : { cancelled };
}

/* ------------------------------ Locations ------------------------------- */

export function buildAreaQuery(query: AreaQuery): Record<string, string | number | undefined> {
  return { post_code: query.postCode, district_name: query.districtName, zone_id: query.zoneId };
}

export function parseAreas(body: unknown): Area[] {
  const list = pick(body, 'areas');
  if (!Array.isArray(list)) return [];
  const out: Area[] = [];
  for (const item of list) {
    const id = pick(item, 'id');
    const name = toStr(pick(item, 'name'));
    if ((typeof id !== 'number' && typeof id !== 'string') || name === undefined) continue;
    const area: Area = { id, name };
    const zoneId = pick(item, 'zone_id');
    if (typeof zoneId === 'number' || typeof zoneId === 'string') area.zoneId = zoneId;
    const postCode = toStr(pick(item, 'post_code'));
    if (postCode !== undefined) area.postCode = postCode;
    const district = toStr(pick(item, 'district_name', 'division_name'));
    if (district !== undefined) area.districtName = district;
    out.push(area);
  }
  return out;
}

export interface RedxPickupStore {
  id: Id;
  name: string;
  address?: string;
  areaId?: Id;
  areaName?: string;
  phone?: string;
}

export function parsePickupStores(body: unknown): RedxPickupStore[] {
  const list = pick(body, 'pickup_stores');
  if (!Array.isArray(list)) return [];
  const out: RedxPickupStore[] = [];
  for (const item of list) {
    const id = pick(item, 'id');
    const name = toStr(pick(item, 'name'));
    if ((typeof id !== 'number' && typeof id !== 'string') || name === undefined) continue;
    const store: RedxPickupStore = { id, name };
    const address = toStr(pick(item, 'address'));
    if (address !== undefined) store.address = address;
    const areaId = pick(item, 'area_id');
    if (typeof areaId === 'number' || typeof areaId === 'string') store.areaId = areaId;
    const areaName = toStr(pick(item, 'area_name'));
    if (areaName !== undefined) store.areaName = areaName;
    const phone = toStr(pick(item, 'phone'));
    if (phone !== undefined) store.phone = phone;
    out.push(store);
  }
  return out;
}

/* ------------------------------- Pricing -------------------------------- */

export function buildChargeQuery(input: ChargeInput & { codAmount: number }): Record<string, string | number | undefined> {
  return {
    delivery_area_id: input.areaId,
    pickup_area_id: input.pickupAreaId,
    cash_collection_amount: input.codAmount,
    weight: kgToGrams(input.weightKg),
  };
}

export function parseChargeResponse(body: unknown): Charge | undefined {
  const delivery = toNumber(pick(body, 'deliveryCharge', 'delivery_charge'));
  if (delivery === undefined) return undefined;
  const cod = toNumber(pick(body, 'codCharge', 'cod_charge')) ?? 0;
  return {
    provider: 'redx',
    deliveryCharge: roundMoney(delivery),
    codCharge: roundMoney(cod),
    discount: 0,
    total: roundMoney(delivery + cod),
    currency: 'BDT',
    estimated: false,
    raw: body,
  };
}

/* ------------------------------- Webhooks ------------------------------- */

export function parseWebhookPayload(payload: unknown): WebhookEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const trackingId = toStr(pick(payload, 'tracking_number', 'tracking_id'));
  if (trackingId === undefined) return undefined;
  const providerStatus = toStr(pick(payload, 'status'));
  const message = toStr(pick(payload, 'message_en'));
  let status = providerStatus === undefined ? OrderStatus.Unknown : mapRedxStatus(providerStatus);
  if (status === OrderStatus.Unknown && providerStatus === undefined) status = statusFromMessage(message);
  const event: WebhookEvent = {
    provider: 'redx',
    type: providerStatus !== undefined ? 'status_update' : 'tracking_update',
    consignmentId: trackingId,
    status,
    raw: payload,
  };
  if (providerStatus !== undefined) event.providerStatus = providerStatus;
  const invoice = toStr(pick(payload, 'invoice_number', 'merchant_invoice_id'));
  if (invoice !== undefined) event.merchantOrderId = invoice;
  if (message !== undefined) event.message = message;
  const messageBn = toStr(pick(payload, 'message_bn'));
  if (messageBn !== undefined) event.messageBn = messageBn;
  const timestamp = toIsoTimestamp(pick(payload, 'timestamp', 'time'));
  if (timestamp !== undefined) event.timestamp = timestamp;
  return event;
}
