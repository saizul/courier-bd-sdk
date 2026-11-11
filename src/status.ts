/**
 * Normalized delivery status shared by every provider adapter.
 *
 * Each adapter owns a mapping table from its raw status strings to one of
 * these values. Anything the table does not know maps to `unknown` and the raw
 * value is always preserved on the result as `providerStatus`.
 */
export const OrderStatus = {
  Pending: 'pending',
  PickedUp: 'picked_up',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  Delivered: 'delivered',
  PartialDelivered: 'partial_delivered',
  Returned: 'returned',
  Cancelled: 'cancelled',
  OnHold: 'on_hold',
  Unknown: 'unknown',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** All normalized statuses, in lifecycle order. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.freeze(Object.values(OrderStatus));

const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.Delivered,
  OrderStatus.PartialDelivered,
  OrderStatus.Returned,
  OrderStatus.Cancelled,
]);

/** True when `value` is one of the normalized status strings. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** True when no further status changes are expected for the parcel. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

/** True when the parcel reached the customer (fully or partially). */
export function isDeliveredStatus(status: OrderStatus): boolean {
  return status === OrderStatus.Delivered || status === OrderStatus.PartialDelivered;
}

/**
 * Canonical lookup key for a raw provider status: lower-cased, with every run
 * of non-alphanumeric characters collapsed to a single underscore.
 *
 * `"Assigned for Delivery"`, `"assigned-for-delivery"` and
 * `"ASSIGNED_FOR_DELIVERY"` all become `"assigned_for_delivery"`.
 */
export function normalizeStatusKey(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export type StatusTable = Readonly<Record<string, OrderStatus>>;
export type StatusMapper = (raw: unknown) => OrderStatus;

/**
 * Build a mapper from a provider status table. Table keys must already be in
 * {@link normalizeStatusKey} form; this is asserted eagerly so a typo in a
 * mapping table fails at import time rather than silently mapping to unknown.
 */
export function createStatusMapper(table: StatusTable, overrides: StatusTable = {}): StatusMapper {
  const merged = new Map<string, OrderStatus>();
  for (const source of [table, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (normalizeStatusKey(key) !== key) {
        throw new Error(`Status table key "${key}" is not normalized (expected "${normalizeStatusKey(key)}")`);
      }
      if (!isOrderStatus(value)) {
        throw new Error(`Status table value "${String(value)}" for key "${key}" is not a normalized status`);
      }
      merged.set(key, value);
    }
  }
  return (raw: unknown) => merged.get(normalizeStatusKey(raw)) ?? OrderStatus.Unknown;
}
