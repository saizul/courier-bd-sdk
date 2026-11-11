import { isRecord } from './utils.js';

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always masked, regardless of content. */
const SENSITIVE_KEY =
  /(secret|password|passwd|authorization|api[-_]?key|token|signature|credential)/i;

/** `Bearer <token>` anywhere in free text. */
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

/** `key=value` / `"key": "value"` pairs for well-known credential names in free text. */
const KEY_VALUE =
  /((?:client[-_]?secret|secret[-_]?key|api[-_]?key|api[-_]?access[-_]?token|access[-_]?token|refresh[-_]?token|password|passwd|token)["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi;

const MIN_SECRET_LENGTH = 4;
const MAX_DEPTH = 8;

/**
 * Removes credentials from strings and structured values before they are
 * placed in error messages or handed to a logger.
 *
 * Two layers are applied: exact-match replacement of every secret registered
 * with {@link Redactor.add} (catches secrets echoed back in arbitrary places)
 * and pattern-based masking of bearer tokens and credential-looking
 * `key=value` pairs (catches secrets the SDK was never told about).
 */
export class Redactor {
  private secrets: string[] = [];

  constructor(secrets: Iterable<string | undefined> = []) {
    this.add(...secrets);
  }

  /** Register secret values. Very short values are ignored to avoid mangling unrelated text. */
  add(...values: Array<string | undefined | null>): this {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length < MIN_SECRET_LENGTH || this.secrets.includes(trimmed)) continue;
      this.secrets.push(trimmed);
    }
    // Longest first so a secret that contains another is masked whole.
    this.secrets.sort((a, b) => b.length - a.length);
    return this;
  }

  /** Number of registered secrets (useful in tests). */
  get size(): number {
    return this.secrets.length;
  }

  /** Mask secrets in free text. */
  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    out = out.replace(BEARER, `$1 ${REDACTED}`);
    out = out.replace(KEY_VALUE, (_match, prefix: string) => `${prefix}${REDACTED}`);
    return out;
  }

  /** Deep-copy `value`, masking sensitive keys and secret substrings. Safe on cycles. */
  redactValue<T>(value: T): T {
    return this.walk(value, 0, new WeakSet()) as T;
  }

  private walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, depth + 1, seen));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = SENSITIVE_KEY.test(key) && item !== null && item !== undefined && typeof item !== 'boolean';
      out[key] = masked ? REDACTED : this.walk(item, depth + 1, seen);
    }
    return out;
  }
}

/** Show only the edges of a secret, e.g. for "which key is configured" diagnostics. */
export function maskSecret(secret: string, visible = 2): string {
  if (secret.length <= visible * 2 + 2) return '*'.repeat(Math.max(secret.length, 4));
  return `${secret.slice(0, visible)}${'*'.repeat(secret.length - visible * 2)}${secret.slice(-visible)}`;
}
