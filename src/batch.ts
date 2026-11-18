/**
 * Batch tracking: poll many parcels with bounded concurrency and report which
 * ones changed status since the last run.
 *
 * Typical use is a scheduled job that re-tracks every open parcel, writes the
 * new statuses back to the order database and notifies customers about the
 * parcels that moved.
 */
import { isTerminalStatus, type OrderStatus } from './status.js';
import type { CourierClient, Tracking, TrackQuery } from './types.js';

/** Default number of tracking requests in flight at once. */
export const DEFAULT_TRACK_CONCURRENCY = 4;

export interface TrackManyOptions {
  /** Maximum number of requests in flight at once. Default {@link DEFAULT_TRACK_CONCURRENCY}. */
  concurrency?: number;
  /**
   * Last known status per key (see {@link trackQueryKey}). Parcels whose stored
   * status is terminal are skipped without a request, and the result reports
   * which parcels changed status.
   */
  previous?: ReadonlyMap<string, OrderStatus> | Readonly<Record<string, OrderStatus>>;
  /** Abort the remaining work. Requests already in flight finish normally. */
  signal?: AbortSignal;
  /** Called after each parcel is settled, in completion order. */
  onResult?: (result: TrackResult) => void;
}

/** The outcome of tracking a single parcel. */
export type TrackResult =
  | { key: string; query: TrackQuery; ok: true; tracking: Tracking; previousStatus?: OrderStatus; changed: boolean }
  | { key: string; query: TrackQuery; ok: false; error: unknown; previousStatus?: OrderStatus }
  | { key: string; query: TrackQuery; ok: false; skipped: 'terminal' | 'aborted'; previousStatus?: OrderStatus };

export interface TrackManyResult {
  /** One entry per input query, in input order. */
  results: TrackResult[];
  /** Successful lookups whose status differs from `previous` (or that had no previous status). */
  changed: Extract<TrackResult, { ok: true }>[];
  /** Lookups that threw. */
  failed: Extract<TrackResult, { error: unknown }>[];
  /** Queries not sent: already terminal, or aborted. */
  skipped: Extract<TrackResult, { skipped: string }>[];
  /** Latest known status per key, ready to be passed back as `previous` next time. */
  statuses: Map<string, OrderStatus>;
}

/** Stable string key for a tracking query, used to match `previous` statuses. */
export function trackQueryKey(query: TrackQuery): string {
  if (typeof query === 'string') return query;
  if ('consignmentId' in query) return String(query.consignmentId);
  if ('merchantOrderId' in query) return `merchant:${query.merchantOrderId}`;
  return `code:${query.trackingCode}`;
}

function lookupPrevious(
  previous: TrackManyOptions['previous'],
  key: string,
): OrderStatus | undefined {
  if (!previous) return undefined;
  if (previous instanceof Map) return previous.get(key);
  return Object.prototype.hasOwnProperty.call(previous, key) ? (previous as Record<string, OrderStatus>)[key] : undefined;
}

/**
 * Track many parcels with one client. Never rejects because of a single
 * failed lookup: errors are collected per parcel in the result.
 *
 * ```ts
 * const { changed, statuses } = await trackMany(courier, openConsignmentIds, { previous: lastStatuses });
 * for (const item of changed) notifyCustomer(item.tracking);
 * saveStatuses(statuses);
 * ```
 */
export async function trackMany(
  client: Pick<CourierClient, 'trackOrder'>,
  queries: readonly TrackQuery[],
  options: TrackManyOptions = {},
): Promise<TrackManyResult> {
  const concurrency = options.concurrency ?? DEFAULT_TRACK_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(concurrency)}`);
  }
  const results: TrackResult[] = new Array(queries.length);
  const statuses = new Map<string, OrderStatus>();
  const pending: number[] = [];

  queries.forEach((query, index) => {
    const key = trackQueryKey(query);
    const previousStatus = lookupPrevious(options.previous, key);
    if (previousStatus !== undefined) statuses.set(key, previousStatus);
    if (previousStatus !== undefined && isTerminalStatus(previousStatus)) {
      results[index] = { key, query, ok: false, skipped: 'terminal', previousStatus };
      options.onResult?.(results[index] as TrackResult);
    } else {
      pending.push(index);
    }
  });

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const index = pending[cursor++] as number;
      const query = queries[index] as TrackQuery;
      const key = trackQueryKey(query);
      const previousStatus = statuses.get(key);
      let result: TrackResult;
      if (options.signal?.aborted) {
        result = { key, query, ok: false, skipped: 'aborted', ...(previousStatus !== undefined ? { previousStatus } : {}) };
      } else {
        try {
          const tracking = await client.trackOrder(query);
          statuses.set(key, tracking.status);
          result = {
            key,
            query,
            ok: true,
            tracking,
            changed: tracking.status !== previousStatus,
            ...(previousStatus !== undefined ? { previousStatus } : {}),
          };
        } catch (error) {
          result = { key, query, ok: false, error, ...(previousStatus !== undefined ? { previousStatus } : {}) };
        }
      }
      results[index] = result;
      options.onResult?.(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  return {
    results,
    changed: results.filter((r): r is Extract<TrackResult, { ok: true }> => r.ok && r.changed),
    failed: results.filter((r): r is Extract<TrackResult, { error: unknown }> => !r.ok && 'error' in r),
    skipped: results.filter((r): r is Extract<TrackResult, { skipped: string }> => !r.ok && 'skipped' in r),
    statuses,
  };
}
