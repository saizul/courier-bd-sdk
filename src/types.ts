import type { OrderStatus } from './status.js';

/** Built-in provider identifiers. */
export const PROVIDERS = ['pathao', 'steadfast', 'redx'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Provider location/store identifiers are numeric for some couriers and strings for others. */
export type Id = string | number;

export type ItemType = 'parcel' | 'document';
export type DeliveryType = 'normal' | 'express';

export interface Recipient {
  /** Recipient full name. */
  name: string;
  /** Any common Bangladesh mobile format; normalized to `01XXXXXXXXX` before sending. */
  phone: string;
  /** Optional alternative contact number. */
  secondaryPhone?: string;
  /** Full delivery address. */
  address: string;
  /** Provider city id (Pathao). */
  cityId?: Id;
  /** Provider zone id (Pathao). */
  zoneId?: Id;
  /** Provider area id (Pathao area, RedX delivery area). */
  areaId?: Id;
  /** Provider area name (required by RedX alongside `areaId`). */
  areaName?: string;
  /** Postal code, used by coverage rules. */
  postCode?: string;
}

export interface CreateOrderInput {
  /** Your own order/invoice reference. */
  merchantOrderId: string;
  recipient: Recipient;
  /** Cash to collect from the recipient in BDT. Use 0 for prepaid orders. */
  codAmount: number;
  /** Parcel weight in kilograms. Defaults to the provider rule's default (0.5 kg). */
  weightKg?: number;
  /** Number of items in the parcel. Defaults to 1. */
  quantity?: number;
  itemDescription?: string;
  itemType?: ItemType;
  deliveryType?: DeliveryType;
  /** Free-text instruction for the rider. */
  note?: string;
  /** Declared goods value in BDT (RedX). Defaults to `codAmount`. */
  declaredValue?: number;
  /** Pickup store id; overrides the store configured on the client. */
  storeId?: Id;
  /**
   * Provider-specific fields merged into the outgoing payload verbatim.
   * Use this for fields the normalized model does not cover.
   */
  extra?: Record<string, unknown>;
}

export interface Order {
  provider: string;
  /** The courier's primary identifier for the parcel. */
  consignmentId: string;
  /** Public tracking code when it differs from `consignmentId`. */
  trackingCode?: string;
  merchantOrderId?: string;
  status: OrderStatus;
  /** Raw status string as returned by the courier. */
  providerStatus?: string;
  deliveryFee?: number;
  codAmount?: number;
  /** ISO-8601 timestamp. */
  createdAt?: string;
  /** Untouched provider response, for anything the normalized model omits. */
  raw: unknown;
}

export interface BulkItemResult {
  /** Index of the item in the input array. */
  index: number;
  merchantOrderId: string;
  success: boolean;
  /** Present for synchronous providers when the item succeeded. */
  order?: Order;
  /** Present when the item failed validation or was rejected by the courier. */
  error?: { code: string; message: string };
}

export interface BulkCreateResult {
  provider: string;
  /**
   * `sync`: every successful item carries an `order` with its consignment id.
   * `async`: the courier accepted the batch for background processing and
   * does not return consignment ids (Pathao).
   */
  mode: 'sync' | 'async';
  total: number;
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
}

export interface TrackingEvent {
  status: OrderStatus;
  providerStatus?: string;
  message?: string;
  /** Bangla message when the courier provides one. */
  messageBn?: string;
  /** ISO-8601 timestamp. */
  timestamp?: string;
}

export interface Tracking {
  provider: string;
  consignmentId: string;
  merchantOrderId?: string;
  status: OrderStatus;
  providerStatus?: string;
  /** ISO-8601 timestamp of the latest known update. */
  updatedAt?: string;
  /** Oldest first. Couriers that only expose the current status yield a single event. */
  events: TrackingEvent[];
  raw: unknown;
}

/** A bare string is treated as a consignment id. */
export type TrackQuery =
  | string
  | { consignmentId: Id }
  | { merchantOrderId: string }
  | { trackingCode: string };

export interface CancelResult {
  provider: string;
  consignmentId: string;
  cancelled: boolean;
  message?: string;
  raw: unknown;
}

export interface ChargeInput {
  weightKg: number;
  codAmount?: number;
  /** Destination city id (Pathao). */
  cityId?: Id;
  /** Destination zone id (Pathao). */
  zoneId?: Id;
  /** Destination area id (RedX). */
  areaId?: Id;
  /** Pickup area id (RedX). */
  pickupAreaId?: Id;
  itemType?: ItemType;
  deliveryType?: DeliveryType;
  storeId?: Id;
  /** Zone key for static rate cards, e.g. `inside_dhaka`. */
  rateZone?: string;
}

export interface Charge {
  provider: string;
  /** Delivery charge before COD fee, after discounts. */
  deliveryCharge: number;
  codCharge: number;
  discount: number;
  /** `deliveryCharge + codCharge`. */
  total: number;
  currency: 'BDT';
  /** True when computed locally from a static rate card instead of the courier API. */
  estimated: boolean;
  raw: unknown;
}

export interface City {
  id: Id;
  name: string;
}

export interface Zone {
  id: Id;
  name: string;
  cityId?: Id;
}

export interface Area {
  id: Id;
  name: string;
  zoneId?: Id;
  postCode?: string;
  districtName?: string;
  homeDeliveryAvailable?: boolean;
  pickupAvailable?: boolean;
}

export interface AreaQuery {
  /** Zone to list areas for (required by Pathao). */
  zoneId?: Id;
  /** Filter by postal code (RedX). */
  postCode?: string | number;
  /** Filter by district name (RedX). */
  districtName?: string;
}

export interface Capabilities {
  cancelOrder: boolean;
  /** `api`: live quote; `rate_card`: local estimate from configuration; `false`: unavailable. */
  calculateCharge: 'api' | 'rate_card' | false;
  /** `native`: one bulk request; `emulated`: sequential single creates. */
  bulkCreate: 'native' | 'emulated';
  listCities: boolean;
  listZones: boolean;
  listAreas: boolean;
  trackByMerchantOrderId: boolean;
  trackByTrackingCode: boolean;
}

/**
 * The unified courier interface. Operations a courier does not offer reject
 * with `UnsupportedOperationError`; check `capabilities` to branch up front.
 */
export interface CourierClient {
  readonly provider: string;
  readonly capabilities: Readonly<Capabilities>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult>;
  trackOrder(query: TrackQuery): Promise<Tracking>;
  cancelOrder(consignmentId: Id, reason?: string): Promise<CancelResult>;
  calculateCharge(input: ChargeInput): Promise<Charge>;
  listCities(): Promise<City[]>;
  listZones(cityId: Id): Promise<Zone[]>;
  listAreas(query: AreaQuery): Promise<Area[]>;
}

export type WebhookEventType = 'status_update' | 'tracking_update' | 'other';

/** A provider webhook delivery normalized into a tracking event. */
export interface WebhookEvent {
  provider: string;
  type: WebhookEventType;
  consignmentId: string;
  merchantOrderId?: string;
  status: OrderStatus;
  /** Raw event/status name from the courier. */
  providerStatus?: string;
  message?: string;
  messageBn?: string;
  /** ISO-8601 timestamp. */
  timestamp?: string;
  codAmount?: number;
  deliveryFee?: number;
  raw: unknown;
}
