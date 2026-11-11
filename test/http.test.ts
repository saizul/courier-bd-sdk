import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../src/errors.js';
import {
  DEFAULT_RETRY,
  HttpClient,
  buildUrl,
  computeBackoff,
  extractErrorMessage,
  extractIssues,
  isRetryableStatus,
  parseRetryAfter,
  type LogEntry,
} from '../src/http.js';
import { Redactor } from '../src/redact.js';
import { MockFetch, hang, instant, json, networkFailure, text } from './helpers/mock-fetch.js';

function client(mock: MockFetch, extra: Record<string, unknown> = {}, delays: number[] = []): HttpClient {
  return new HttpClient({
    provider: 'test',
    baseUrl: 'https://courier.example/api/',
    fetch: mock.fetch,
    ...instant(delays),
    ...extra,
  });
}

describe('pure helpers', () => {
  test('buildUrl joins slashes and skips empty query values', () => {
    assert.equal(buildUrl('https://x.example/api/', '/orders'), 'https://x.example/api/orders');
    assert.equal(buildUrl('https://x.example/api', 'orders'), 'https://x.example/api/orders');
    assert.equal(
      buildUrl('https://x.example', '/a', { zone: 5, skip: undefined, none: null, q: 'a b' }),
      'https://x.example/a?zone=5&q=a+b',
    );
  });

  test('isRetryableStatus covers 429 and 5xx only', () => {
    for (const status of [429, 500, 502, 503, 504, 599]) assert.ok(isRetryableStatus(status), String(status));
    for (const status of [200, 400, 401, 404, 422, 600]) assert.ok(!isRetryableStatus(status), String(status));
  });

  test('computeBackoff grows exponentially without jitter', () => {
    const options = { baseDelayMs: 100, maxDelayMs: 10_000, factor: 2, jitter: false };
    assert.deepEqual([1, 2, 3, 4].map((n) => computeBackoff(n, options)), [100, 200, 400, 800]);
  });

  test('computeBackoff is capped by maxDelayMs', () => {
    assert.equal(computeBackoff(10, { baseDelayMs: 100, maxDelayMs: 1500, factor: 2, jitter: false }), 1500);
  });

  test('computeBackoff jitter stays within the upper half of the delay', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 10_000, factor: 2, jitter: true };
    assert.equal(computeBackoff(1, options, () => 0), 500);
    assert.equal(computeBackoff(1, options, () => 1), 1000);
    assert.equal(computeBackoff(2, options, () => 0.5), 1500);
  });

  test('parseRetryAfter reads seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('7'), 7000);
    assert.equal(parseRetryAfter('1.5'), 1500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(''), undefined);
  });

  test('extractErrorMessage understands the common body shapes', () => {
    assert.equal(extractErrorMessage({ message: ' Invalid store ' }), 'Invalid store');
    assert.equal(extractErrorMessage({ error: { message: 'nested' } }), 'nested');
    assert.equal(extractErrorMessage({ error_description: 'bad grant' }), 'bad grant');
    assert.equal(extractErrorMessage({ errors: { phone: ['Phone is invalid'] } }), 'Phone is invalid');
    assert.equal(extractErrorMessage('<html><body>502</body></html>'), 'non-JSON error page');
    assert.equal(extractErrorMessage('  '), undefined);
    assert.equal(extractErrorMessage(42), undefined);
  });

  test('extractIssues flattens object and array error shapes', () => {
    assert.deepEqual(extractIssues({ errors: { recipient_phone: ['Invalid phone', 'Too short'], cod: 'Bad' } }), [
      { field: 'recipient_phone', code: 'provider_rejected', message: 'Invalid phone' },
      { field: 'recipient_phone', code: 'provider_rejected', message: 'Too short' },
      { field: 'cod', code: 'provider_rejected', message: 'Bad' },
    ]);
    assert.deepEqual(extractIssues({ errors: ['plain', { field: 'a', message: 'b' }] }), [
      { field: '', code: 'provider_rejected', message: 'plain' },
      { field: 'a', code: 'provider_rejected', message: 'b' },
    ]);
    assert.deepEqual(extractIssues('nope'), []);
  });
});

describe('HttpClient requests', () => {
  test('sends JSON with default and per-request headers', async () => {
    const mock = new MockFetch().on('POST', '/orders', json({ ok: true }, 201));
    const http = client(mock, { headers: { 'X-Static': 'yes' }, userAgent: 'my-shop/1.0' });
    const response = await http.request({ method: 'POST', path: '/orders', body: { a: 1 }, headers: { 'X-Once': '1' } });
    assert.equal(response.status, 201);
    assert.deepEqual(response.data, { ok: true });
    assert.equal(response.attempts, 1);
    assert.equal(mock.last.url, 'https://courier.example/api/orders');
    assert.deepEqual(mock.last.body, { a: 1 });
    assert.equal(mock.last.headers['content-type'], 'application/json');
    assert.equal(mock.last.headers.accept, 'application/json');
    assert.equal(mock.last.headers['x-static'], 'yes');
    assert.equal(mock.last.headers['x-once'], '1');
    assert.equal(mock.last.headers['user-agent'], 'my-shop/1.0');
  });

  test('default user agent identifies the SDK', async () => {
    const mock = new MockFetch().on('GET', '/ping', json({}));
    await client(mock).request({ method: 'GET', path: '/ping' });
    assert.match(mock.last.headers['user-agent'] ?? '', /^courier-bd-sdk\/\d+\.\d+\.\d+$/);
  });

  test('GET requests carry query parameters and no body', async () => {
    const mock = new MockFetch().on('GET', '/areas', json([]));
    await client(mock).request({ method: 'GET', path: '/areas', query: { post_code: 1209 } });
    assert.equal(mock.last.query.get('post_code'), '1209');
    assert.equal(mock.last.body, undefined);
    assert.equal(mock.last.headers['content-type'], undefined);
  });

  test('non-JSON success bodies come back as text, empty bodies as undefined', async () => {
    const mock = new MockFetch().on('GET', '/text', text('OK')).on('GET', '/empty', text(''));
    const http = client(mock);
    assert.equal((await http.request({ method: 'GET', path: '/text' })).data, 'OK');
    assert.equal((await http.request({ method: 'GET', path: '/empty' })).data, undefined);
  });

  test('rejects invalid construction options', () => {
    const mock = new MockFetch();
    assert.throws(() => client(mock, { retry: { retries: -1 } }), RangeError);
    assert.throws(() => client(mock, { retry: { retries: 1.5 } }), RangeError);
    assert.throws(() => client(mock, { timeoutMs: 0 }), RangeError);
  });

  test('undefined retry fields fall back to defaults', () => {
    const http = client(new MockFetch(), { retry: { retries: undefined, baseDelayMs: 50 } });
    assert.equal(http.retry.retries, DEFAULT_RETRY.retries);
    assert.equal(http.retry.baseDelayMs, 50);
  });
});

describe('HttpClient error mapping', () => {
  const cases: Array<[number, new (...args: never[]) => Error]> = [
    [400, ValidationError],
    [401, AuthError],
    [403, AuthError],
    [404, ProviderError],
    [409, ProviderError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ProviderError],
    [503, ProviderError],
  ];
  for (const [status, type] of cases) {
    test(`HTTP ${status} becomes ${type.name}`, async () => {
      const mock = new MockFetch().on('GET', '/x', json({ message: 'nope' }, status));
      await assert.rejects(client(mock, { retry: { retries: 0 } }).request({ method: 'GET', path: '/x' }), (error: unknown) => {
        assert.ok(error instanceof type);
        assert.equal((error as ProviderError).status, status);
        assert.equal((error as ProviderError).provider, 'test');
        assert.match((error as Error).message, new RegExp(`\\[test\\] GET /x failed with HTTP ${status}: nope`));
        return true;
      });
    });
  }

  test('422 carries field issues from the body', async () => {
    const mock = new MockFetch().on('POST', '/orders', json({ errors: { recipient_phone: ['Invalid'] } }, 422));
    await assert.rejects(client(mock).request({ method: 'POST', path: '/orders', body: {} }), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(error.issues, [{ field: 'recipient_phone', code: 'provider_rejected', message: 'Invalid' }]);
      return true;
    });
  });

  test('HTML error pages do not leak markup into the message', async () => {
    const mock = new MockFetch().on('GET', '/x', text('<html><h1>Bad Gateway</h1></html>', 502));
    await assert.rejects(client(mock, { retry: { retries: 0 } }).request({ method: 'GET', path: '/x' }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.ok(!error.message.includes('<h1>'));
      return true;
    });
  });

  test('error messages and details never contain registered secrets', async () => {
    const redactor = new Redactor(['super-secret-key']);
    const mock = new MockFetch().on(
      'GET',
      '/x',
      json({ message: 'key super-secret-key is not allowed', api_key: 'super-secret-key', echo: 'super-secret-key' }, 403),
    );
    await assert.rejects(client(mock, { redactor }).request({ method: 'GET', path: '/x' }), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.ok(!JSON.stringify(error).includes('super-secret-key'));
      assert.ok(!error.message.includes('super-secret-key'));
      return true;
    });
  });
});

describe('HttpClient retries', () => {
  test('GET retries 5xx then succeeds', async () => {
    const delays: number[] = [];
    const mock = new MockFetch().on('GET', '/x', json({}, 500), json({}, 502), json({ ok: 1 }));
    const response = await client(mock, {}, delays).request({ method: 'GET', path: '/x' });
    assert.equal(response.attempts, 3);
    assert.equal(mock.calls.length, 3);
    // random() is pinned to 0.5: equal jitter gives 75% of 300 ms, then of 600 ms.
    assert.deepEqual(delays, [225, 450]);
  });

  test('gives up after the configured number of retries', async () => {
    const mock = new MockFetch().on('GET', '/x', json({}, 500));
    await assert.rejects(client(mock, { retry: { retries: 3 } }).request({ method: 'GET', path: '/x' }), ProviderError);
    assert.equal(mock.calls.length, 4);
  });

  test('retries: 0 disables retrying', async () => {
    const mock = new MockFetch().on('GET', '/x', json({}, 503));
    await assert.rejects(client(mock, { retry: { retries: 0 } }).request({ method: 'GET', path: '/x' }), ProviderError);
    assert.equal(mock.calls.length, 1);
  });

  test('GET retries network errors', async () => {
    const mock = new MockFetch().on('GET', '/x', networkFailure('ECONNRESET'), json({ ok: 1 }));
    const response = await client(mock).request({ method: 'GET', path: '/x' });
    assert.equal(response.attempts, 2);
  });

  test('network failure surfaces as NetworkError with the cause attached', async () => {
    const mock = new MockFetch().on('GET', '/x', networkFailure('getaddrinfo ENOTFOUND'));
    await assert.rejects(client(mock, { retry: { retries: 1 } }).request({ method: 'GET', path: '/x' }), (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.match(error.message, /network error: getaddrinfo ENOTFOUND/);
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
    assert.equal(mock.calls.length, 2);
  });

  test('POST is not retried on 500, 502 or network errors', async () => {
    for (const responder of [json({}, 500), json({}, 502), networkFailure()]) {
      const mock = new MockFetch().on('POST', '/orders', responder);
      await assert.rejects(client(mock).request({ method: 'POST', path: '/orders', body: {} }));
      assert.equal(mock.calls.length, 1);
    }
  });

  test('POST is retried on 429 and 503, where the request was not processed', async () => {
    for (const status of [429, 503]) {
      const mock = new MockFetch().on('POST', '/orders', json({}, status), json({ ok: 1 }));
      const response = await client(mock).request({ method: 'POST', path: '/orders', body: {} });
      assert.equal(response.attempts, 2, String(status));
    }
  });

  test('POST marked idempotent retries like a GET', async () => {
    const mock = new MockFetch().on('POST', '/price', json({}, 500), json({ ok: 1 }));
    const response = await client(mock).request({ method: 'POST', path: '/price', body: {}, idempotent: true });
    assert.equal(response.attempts, 2);
  });

  test('retryNonIdempotent opts POST into full retries', async () => {
    const mock = new MockFetch().on('POST', '/orders', json({}, 500), json({ ok: 1 }));
    const http = client(mock, { retry: { retryNonIdempotent: true } });
    assert.equal((await http.request({ method: 'POST', path: '/orders', body: {} })).attempts, 2);
  });

  test('4xx responses are never retried', async () => {
    for (const status of [400, 401, 404, 422]) {
      const mock = new MockFetch().on('GET', '/x', json({}, status));
      await assert.rejects(client(mock).request({ method: 'GET', path: '/x' }));
      assert.equal(mock.calls.length, 1, String(status));
    }
  });

  test('Retry-After extends the delay but is capped by maxDelayMs', async () => {
    const delays: number[] = [];
    const mock = new MockFetch().on(
      'GET',
      '/x',
      json({}, 429, { 'retry-after': '2' }),
      json({}, 429, { 'retry-after': '3600' }),
      json({ ok: 1 }),
    );
    await client(mock, { retry: { maxDelayMs: 5000 } }, delays).request({ method: 'GET', path: '/x' });
    assert.deepEqual(delays, [2000, 5000]);
  });

  test('RateLimitError exposes retryAfterMs when retries are exhausted', async () => {
    const mock = new MockFetch().on('GET', '/x', json({}, 429, { 'retry-after': '12' }));
    await assert.rejects(client(mock, { retry: { retries: 1 } }).request({ method: 'GET', path: '/x' }), (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfterMs, 12_000);
      return true;
    });
  });

  test('jitter can be disabled for exact delays', async () => {
    const delays: number[] = [];
    const mock = new MockFetch().on('GET', '/x', json({}, 500), json({}, 500), json({}));
    await client(mock, { retry: { jitter: false, baseDelayMs: 10 } }, delays).request({ method: 'GET', path: '/x' });
    assert.deepEqual(delays, [10, 20]);
  });
});

describe('HttpClient timeouts and aborts', () => {
  test('a hanging request times out with TimeoutError', async () => {
    const mock = new MockFetch().on('GET', '/slow', hang());
    await assert.rejects(
      client(mock, { timeoutMs: 20, retry: { retries: 0 } }).request({ method: 'GET', path: '/slow' }),
      (error: unknown) => {
        assert.ok(error instanceof TimeoutError);
        assert.equal(error.timeoutMs, 20);
        assert.equal(error.code, 'TIMEOUT');
        return true;
      },
    );
    assert.equal(mock.last.signal?.aborted, true);
  });

  test('the deadline holds even when fetch ignores the abort signal', async () => {
    let release: (() => void) | undefined;
    const stubborn = (): Promise<Response> => new Promise((resolve) => (release = () => resolve(new Response('{}'))));
    const http = new HttpClient({ provider: 'test', baseUrl: 'https://x.example', fetch: stubborn, timeoutMs: 20, retry: { retries: 0 } });
    await assert.rejects(http.request({ method: 'GET', path: '/slow' }), TimeoutError);
    release?.();
  });

  test('GET retries after a timeout; POST does not', async () => {
    const getMock = new MockFetch().on('GET', '/slow', hang(), json({ ok: 1 }));
    const response = await client(getMock, { timeoutMs: 20 }).request({ method: 'GET', path: '/slow' });
    assert.equal(response.attempts, 2);

    const postMock = new MockFetch().on('POST', '/slow', hang(), json({ ok: 1 }));
    await assert.rejects(client(postMock, { timeoutMs: 20 }).request({ method: 'POST', path: '/slow', body: {} }), TimeoutError);
    assert.equal(postMock.calls.length, 1);
  });

  test('per-request timeout overrides the client default', async () => {
    const mock = new MockFetch().on('GET', '/slow', hang());
    await assert.rejects(
      client(mock, { timeoutMs: 60_000, retry: { retries: 0 } }).request({ method: 'GET', path: '/slow', timeoutMs: 15 }),
      (error: unknown) => error instanceof TimeoutError && error.timeoutMs === 15,
    );
  });

  test('caller abort produces a non-retryable NetworkError', async () => {
    const mock = new MockFetch().on('GET', '/slow', hang());
    const controller = new AbortController();
    const pending = client(mock).request({ method: 'GET', path: '/slow', signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.aborted, true);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(mock.calls.length, 1);
  });

  test('an already aborted signal never reaches fetch', async () => {
    const mock = new MockFetch().on('GET', '/x', json({}));
    await assert.rejects(client(mock).request({ method: 'GET', path: '/x', signal: AbortSignal.abort() }), NetworkError);
    assert.equal(mock.calls.length, 0);
  });
});

describe('HttpClient logging', () => {
  test('logs request, retry, response and error events', async () => {
    const entries: LogEntry[] = [];
    const mock = new MockFetch().on('GET', '/x', json({}, 500), json({}));
    await client(mock, { logger: (entry: LogEntry) => entries.push(entry) }).request({ method: 'GET', path: '/x' });
    assert.deepEqual(entries.map((entry) => entry.event), ['request', 'retry', 'request', 'response']);
    assert.equal(entries[1]?.status, 500);
    assert.equal(entries[1]?.delayMs, 225);
    assert.equal(entries[3]?.status, 200);
    assert.ok(entries.every((entry) => entry.provider === 'test'));
  });

  test('log entries are redacted', async () => {
    const entries: LogEntry[] = [];
    const redactor = new Redactor(['tok_live_placeholder']);
    const mock = new MockFetch().on('GET', /track/, json({ message: 'token tok_live_placeholder expired' }, 401));
    await assert.rejects(
      client(mock, { redactor, logger: (entry: LogEntry) => entries.push(entry) }).request({
        method: 'GET',
        path: '/track/tok_live_placeholder',
      }),
    );
    assert.ok(entries.length > 0);
    assert.ok(!JSON.stringify(entries).includes('tok_live_placeholder'));
  });

  test('a throwing logger does not break the request', async () => {
    const mock = new MockFetch().on('GET', '/x', json({ ok: 1 }));
    const http = client(mock, {
      logger: () => {
        throw new Error('logger exploded');
      },
    });
    assert.deepEqual((await http.request({ method: 'GET', path: '/x' })).data, { ok: 1 });
  });
});
