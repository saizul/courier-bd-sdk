import { AuthError, CourierError, ProviderError, ValidationError } from '../../errors.js';
import type { HttpClient } from '../../http.js';
import type { Redactor } from '../../redact.js';
import {
  PATHAO_ENDPOINTS,
  buildRefreshRequest,
  buildTokenRequest,
  parseTokenResponse,
  type PathaoCredentials,
} from './mapping.js';

export interface PathaoToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds after which the access token must not be used. */
  expiresAt: number;
}

/**
 * Optional persistence for tokens, so short-lived processes (serverless
 * functions, CLI runs) can share one token instead of issuing a new one each
 * time. Implement it with a file, Redis, a database row, etc.
 */
export interface PathaoTokenStore {
  load(): Promise<PathaoToken | undefined> | PathaoToken | undefined;
  save(token: PathaoToken): Promise<void> | void;
}

export interface PathaoTokenManagerOptions {
  http: HttpClient;
  credentials: PathaoCredentials;
  redactor: Redactor;
  now?: () => number;
  /** Treat tokens as expired this long before their real expiry. Default 60 s. */
  skewMs?: number;
  /** Lifetime assumed when the token response omits `expires_in`. Default 1 h. */
  defaultTtlMs?: number;
  store?: PathaoTokenStore;
}

const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 3_600_000;

/**
 * Issues, caches and refreshes Pathao OAuth tokens.
 *
 * - The access token is cached until shortly before it expires.
 * - An expired token is renewed with the refresh token when one is available,
 *   falling back to the password grant if the refresh is rejected.
 * - Concurrent callers share a single in-flight token request.
 */
export class PathaoTokenManager {
  private readonly http: HttpClient;
  private readonly credentials: PathaoCredentials;
  private readonly redactor: Redactor;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly defaultTtlMs: number;
  private readonly store: PathaoTokenStore | undefined;
  private token: PathaoToken | undefined;
  private inflight: Promise<PathaoToken> | undefined;
  private storeLoaded = false;

  constructor(options: PathaoTokenManagerOptions) {
    this.http = options.http;
    this.credentials = options.credentials;
    this.redactor = options.redactor;
    this.now = options.now ?? Date.now;
    this.skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.store = options.store;
  }

  /** A valid access token, issuing or refreshing one if needed. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.isFresh(this.token)) return this.token.accessToken;
    if (!this.inflight) {
      this.inflight = this.acquire().finally(() => {
        this.inflight = undefined;
      });
    }
    return (await this.inflight).accessToken;
  }

  /**
   * Discard the cached access token (e.g. after the API answered 401). The
   * refresh token is kept so the next call can try a cheap refresh first,
   * unless `dropRefreshToken` is set.
   */
  invalidate(dropRefreshToken = false): void {
    if (!this.token) return;
    if (dropRefreshToken || this.token.refreshToken === undefined) {
      this.token = undefined;
      return;
    }
    this.token = { ...this.token, expiresAt: 0 };
  }

  /** The cached token, if any (exposed for diagnostics and tests). */
  peek(): Readonly<PathaoToken> | undefined {
    return this.token;
  }

  private isFresh(token: PathaoToken): boolean {
    return token.expiresAt - this.skewMs > this.now();
  }

  private async acquire(): Promise<PathaoToken> {
    if (this.store && !this.storeLoaded) {
      this.storeLoaded = true;
      const stored = await this.loadFromStore();
      if (stored) {
        this.remember(stored);
        if (this.isFresh(stored)) return stored;
      }
    }
    const refreshToken = this.token?.refreshToken;
    if (refreshToken !== undefined) {
      try {
        return await this.issue(buildRefreshRequest(this.credentials, refreshToken), 'refresh');
      } catch (error) {
        // A rejected refresh token is expected once it expires; fall back to
        // the password grant. Anything else (network, 5xx) is a real failure.
        const rejected =
          error instanceof AuthError ||
          error instanceof ValidationError ||
          (error instanceof ProviderError && error.status !== undefined && error.status < 500);
        if (!rejected) throw error;
        this.token = undefined;
      }
    }
    return this.issue(buildTokenRequest(this.credentials), 'password');
  }

  private async issue(body: Record<string, unknown>, grant: 'password' | 'refresh'): Promise<PathaoToken> {
    let data: unknown;
    try {
      // Requesting a token twice is harmless, so allow full retry behaviour.
      const response = await this.http.request({ method: 'POST', path: PATHAO_ENDPOINTS.issueToken, body, idempotent: true });
      data = response.data;
    } catch (error) {
      if (grant === 'password' && error instanceof ValidationError) {
        // Pathao answers bad credentials with 400; surface that as an auth problem.
        throw new AuthError(error.message, {
          provider: 'pathao',
          cause: error,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      throw error;
    }
    const payload = parseTokenResponse(data);
    if (!payload) {
      throw new AuthError('[pathao] token response did not contain an access token', {
        provider: 'pathao',
        details: this.redactor.redactValue(data),
      });
    }
    this.redactor.add(payload.accessToken, payload.refreshToken);
    const token: PathaoToken = {
      accessToken: payload.accessToken,
      expiresAt: this.now() + (payload.expiresInSec !== undefined ? payload.expiresInSec * 1000 : this.defaultTtlMs),
    };
    const refreshToken = payload.refreshToken ?? (grant === 'refresh' ? this.token?.refreshToken : undefined);
    if (refreshToken !== undefined) token.refreshToken = refreshToken;
    this.remember(token);
    await this.saveToStore(token);
    return token;
  }

  private remember(token: PathaoToken): void {
    this.token = token;
    this.redactor.add(token.accessToken, token.refreshToken);
  }

  private async loadFromStore(): Promise<PathaoToken | undefined> {
    try {
      const stored = await this.store?.load();
      if (!stored || typeof stored.accessToken !== 'string' || typeof stored.expiresAt !== 'number') return undefined;
      return stored;
    } catch {
      // A broken store must not prevent authentication; issue a fresh token instead.
      return undefined;
    }
  }

  private async saveToStore(token: PathaoToken): Promise<void> {
    try {
      await this.store?.save(token);
    } catch (error) {
      if (error instanceof CourierError) throw error;
      // Persisting is best-effort.
    }
  }
}
