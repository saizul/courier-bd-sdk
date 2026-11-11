import type { FetchLike } from '../../src/http.js';

export interface RecordedCall {
  url: string;
  method: string;
  path: string;
  query: URLSearchParams;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string when it is not JSON. */
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

interface Route {
  method: string;
  match: string | RegExp;
  responders: Responder[];
  served: number;
}

/**
 * A scriptable fetch replacement. Routes are matched by method and path;
 * each route serves its responders in order and repeats the last one.
 * Requests with no matching route reject, which fails the test loudly.
 */
export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[] = [];

  on(method: string, match: string | RegExp, ...responders: Responder[]): this {
    if (responders.length === 0) throw new Error('MockFetch.on needs at least one responder');
    this.routes.push({ method: method.toUpperCase(), match, responders, served: 0 });
    return this;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body,
      signal: init?.signal ?? undefined,
    };
    this.calls.push(call);
    const route = this.routes.find(
      (candidate) =>
        candidate.method === call.method &&
        (typeof candidate.match === 'string' ? call.path.endsWith(candidate.match) : candidate.match.test(call.path)),
    );
    if (!route) throw new Error(`MockFetch: no route for ${call.method} ${call.path}`);
    const responder = route.responders[Math.min(route.served, route.responders.length - 1)] as Responder;
    route.served += 1;
    return responder(call);
  };

  /** Calls whose path ends with (string) or matches (RegExp) `match`. */
  callsTo(match: string | RegExp, method?: string): RecordedCall[] {
    return this.calls.filter(
      (call) =>
        (method === undefined || call.method === method.toUpperCase()) &&
        (typeof match === 'string' ? call.path.endsWith(match) : match.test(call.path)),
    );
  }

  get last(): RecordedCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('MockFetch: no calls recorded');
    return call;
  }
}

/** JSON response factory. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Responder {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Plain-text response factory. */
export function text(body: string, status = 200, headers: Record<string, string> = {}): Responder {
  return () => new Response(body, { status, headers });
}

/** Simulates a connection-level failure. */
export function networkFailure(message = 'fetch failed'): Responder {
  return () => {
    throw new TypeError(message);
  };
}

/** Never answers; resolves only by rejecting when the request is aborted. */
export function hang(): Responder {
  return (call) =>
    new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), {
        once: true,
      });
    });
}

/** Options that make retries instant and deterministic. */
export function instant(delays: number[] = []): { sleep: (ms: number) => Promise<void>; random: () => number } {
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    random: () => 0.5,
  };
}

/** A valid order usable with every provider. */
export function sampleOrder(overrides: Record<string, unknown> = {}): import('../../src/types.js').CreateOrderInput {
  const { recipient, ...rest } = overrides as { recipient?: Record<string, unknown> };
  return {
    merchantOrderId: 'INV-1001',
    recipient: {
      name: 'Test Customer',
      phone: '01712345678',
      address: 'House 1, Road 2, Dhanmondi, Dhaka',
      cityId: 1,
      zoneId: 10,
      areaId: 100,
      areaName: 'Dhanmondi',
      ...(recipient ?? {}),
    },
    codAmount: 1200,
    weightKg: 1,
    ...rest,
  } as import('../../src/types.js').CreateOrderInput;
}
