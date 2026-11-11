/** Small dependency-free helpers shared across the SDK. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lenient numeric coercion for provider payloads ("120.50", "1,200", 60). */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (cleaned === '') return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Non-empty string coercion; numbers are stringified, everything else is undefined. */
export function toStr(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** First defined, non-null value among `keys` of `source`. */
export function pick(source: unknown, ...keys: string[]): unknown {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/;

/**
 * Convert a provider timestamp to ISO-8601 UTC.
 *
 * Couriers commonly return zone-less local times such as
 * `"2026-01-15 14:30:00"`. Those are interpreted as Asia/Dhaka (UTC+06:00,
 * no daylight saving). Epoch seconds and milliseconds are both accepted.
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d{10,13}$/.test(text)) return toIsoTimestamp(Number(text));
  const naive = NAIVE_TIMESTAMP.exec(text);
  const parsed = Date.parse(naive ? `${naive[1]}T${naive[2]}+06:00` : text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Round to two decimal places, avoiding binary float artifacts for money. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map with bounded concurrency, preserving input order. Rejections propagate;
 * callers that need per-item results should catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** Drop keys whose value is `undefined` so they never reach the wire. */
export function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** Send numeric-looking ids as numbers, everything else unchanged. */
export function numericId(id: string | number | undefined): string | number | undefined {
  if (id === undefined) return undefined;
  if (typeof id === 'number') return id;
  return /^\d+$/.test(id.trim()) ? Number(id.trim()) : id;
}
