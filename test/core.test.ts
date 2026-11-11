import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  AuthError,
  ConfigError,
  CourierError,
  NetworkError,
  NoCourierAvailableError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UnsupportedOperationError,
  ValidationError,
  isCourierError,
} from '../src/errors.js';
import * as sdk from '../src/index.js';
import { assertRateCard, chargeFromRateCard } from '../src/ratecard.js';
import { REDACTED, Redactor, maskSecret } from '../src/redact.js';
import {
  ORDER_STATUSES,
  OrderStatus,
  createStatusMapper,
  isDeliveredStatus,
  isOrderStatus,
  isTerminalStatus,
  normalizeStatusKey,
} from '../src/status.js';
import { chunk, mapWithConcurrency, numericId, roundMoney, toIsoTimestamp, toNumber } from '../src/utils.js';
import { VERSION } from '../src/version.js';

describe('errors', () => {
  test('every error extends CourierError and Error with its own name', () => {
    const errors = [
      new AuthError('a'),
      new ValidationError('v'),
      new RateLimitError('r'),
      new ProviderError('p'),
      new NetworkError('n'),
      new TimeoutError('t', { timeoutMs: 5 }),
      new UnsupportedOperationError('steadfast', 'cancelOrder'),
      new ConfigError('c'),
    ];
    for (const error of errors) {
      assert.ok(error instanceof CourierError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
      assert.ok(isCourierError(error));
    }
    assert.equal(isCourierError(new Error('plain')), false);
  });

  test('codes are stable', () => {
    assert.equal(new AuthError('x').code, 'AUTH');
    assert.equal(new ValidationError('x').code, 'VALIDATION');
    assert.equal(new RateLimitError('x').code, 'RATE_LIMIT');
    assert.equal(new ProviderError('x').code, 'PROVIDER');
    assert.equal(new NetworkError('x').code, 'NETWORK');
    assert.equal(new TimeoutError('x', { timeoutMs: 1 }).code, 'TIMEOUT');
  });

  test('retryable reflects the failure kind', () => {
    assert.equal(new AuthError('x').retryable, false);
    assert.equal(new ValidationError('x').retryable, false);
    assert.equal(new RateLimitError('x').retryable, true);
    assert.equal(new ProviderError('x', { status: 502 }).retryable, true);
    assert.equal(new ProviderError('x', { status: 404 }).retryable, false);
    assert.equal(new NetworkError('x').retryable, true);
    assert.equal(new NetworkError('x', { aborted: true }).retryable, false);
  });

  test('toJSON is serializable and includes issues', () => {
    const error = new ValidationError('bad', {
      provider: 'redx',
      status: 422,
      issues: [{ field: 'recipient.phone', code: 'invalid_phone', message: 'nope' }],
    });
    const parsed = JSON.parse(JSON.stringify(error));
    assert.equal(parsed.name, 'ValidationError');
    assert.equal(parsed.provider, 'redx');
    assert.equal(parsed.status, 422);
    assert.equal(parsed.issues[0].field, 'recipient.phone');
  });

  test('cause is preserved', () => {
    const cause = new TypeError('socket hang up');
    assert.equal(new NetworkError('x', { cause }).cause, cause);
  });

  test('UnsupportedOperationError names provider and operation', () => {
    const error = new UnsupportedOperationError('steadfast', 'cancelOrder', 'use the merchant panel');
    assert.equal(error.operation, 'cancelOrder');
    assert.equal(error.provider, 'steadfast');
    assert.match(error.message, /steadfast does not support cancelOrder: use the merchant panel/);
  });

  test('NoCourierAvailableError summarizes attempts in details', () => {
    const error = new NoCourierAvailableError('none', [
      { provider: 'pathao', outcome: 'failed', error: new ProviderError('boom') },
      { provider: 'redx', outcome: 'skipped', reason: 'not_covered' },
    ]);
    assert.equal(error.attempts.length, 2);
    assert.deepEqual(error.details, [
      { provider: 'pathao', outcome: 'failed', reason: undefined, error: 'boom' },
      { provider: 'redx', outcome: 'skipped', reason: 'not_covered', error: undefined },
    ]);
  });
});

describe('Redactor', () => {
  test('masks registered secrets wherever they appear', () => {
    const redactor = new Redactor(['s3cr3t-value']);
    assert.equal(redactor.redact('got s3cr3t-value back, twice: s3cr3t-value'), `got ${REDACTED} back, twice: ${REDACTED}`);
  });

  test('ignores very short and non-string secrets', () => {
    const redactor = new Redactor(['ab', undefined, '']);
    assert.equal(redactor.size, 0);
    assert.equal(redactor.redact('ab ab'), 'ab ab');
  });

  test('masks the longer secret first when secrets overlap', () => {
    const redactor = new Redactor(['token', 'token-extended']);
    assert.equal(redactor.redact('x token-extended y'), `x ${REDACTED} y`);
  });

  test('masks bearer tokens it was never told about', () => {
    const out = new Redactor().redact('Authorization: Bearer abc.DEF-123_xyz');
    assert.ok(!out.includes('abc.DEF-123_xyz'));
    assert.match(out, /Bearer \[REDACTED\]/);
  });

  test('masks the RedX style header without leaking the token', () => {
    const out = new Redactor().redact('API-ACCESS-TOKEN: Bearer zzzTOKENzzz');
    assert.ok(!out.includes('zzzTOKENzzz'));
  });

  test('masks credential-looking key=value pairs', () => {
    const redactor = new Redactor();
    for (const sample of ['client_secret=hunter2222', '"password":"hunter2222"', 'api_key: hunter2222', 'Secret-Key=hunter2222']) {
      assert.ok(!redactor.redact(sample).includes('hunter2222'), sample);
    }
  });

  test('leaves ordinary text alone', () => {
    const text = 'Recipient phone must be a valid number';
    assert.equal(new Redactor(['unrelated-secret']).redact(text), text);
  });

  test('redactValue masks sensitive keys deeply without mutating input', () => {
    const input = {
      client_secret: 'abc',
      nested: { password: 'p', list: [{ access_token: 't', keep: 'visible' }] },
      note: 'has the-known-secret inside',
    };
    const out = new Redactor(['the-known-secret']).redactValue(input);
    assert.equal(out.client_secret, REDACTED);
    assert.equal(out.nested.password, REDACTED);
    assert.equal(out.nested.list[0]?.access_token, REDACTED);
    assert.equal(out.nested.list[0]?.keep, 'visible');
    assert.equal(out.note, `has ${REDACTED} inside`);
    assert.equal(input.client_secret, 'abc');
  });

  test('redactValue survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    assert.equal((new Redactor().redactValue(a) as Record<string, unknown>).self, '[Circular]');
  });

  test('maskSecret keeps only the edges', () => {
    assert.equal(maskSecret('abcdefghij'), 'ab******ij');
    assert.equal(maskSecret('abc'), '****');
  });
});

describe('status', () => {
  test('exposes exactly the ten normalized statuses', () => {
    assert.deepEqual([...ORDER_STATUSES].sort(), [
      'cancelled',
      'delivered',
      'in_transit',
      'on_hold',
      'out_for_delivery',
      'partial_delivered',
      'pending',
      'picked_up',
      'returned',
      'unknown',
    ]);
  });

  test('normalizeStatusKey collapses case, spaces and punctuation', () => {
    assert.equal(normalizeStatusKey('Assigned for Delivery'), 'assigned_for_delivery');
    assert.equal(normalizeStatusKey('delivery-in-progress'), 'delivery_in_progress');
    assert.equal(normalizeStatusKey('  ON__HOLD  '), 'on_hold');
    assert.equal(normalizeStatusKey(undefined), '');
    assert.equal(normalizeStatusKey(42), '42');
  });

  test('createStatusMapper maps known values and falls back to unknown', () => {
    const map = createStatusMapper({ at_hub: OrderStatus.InTransit });
    assert.equal(map('At Hub'), 'in_transit');
    assert.equal(map('something new'), 'unknown');
    assert.equal(map(null), 'unknown');
  });

  test('createStatusMapper overrides win over the base table', () => {
    const map = createStatusMapper({ hold: OrderStatus.OnHold }, { hold: OrderStatus.Returned, brand_new: OrderStatus.Pending });
    assert.equal(map('hold'), 'returned');
    assert.equal(map('Brand New'), 'pending');
  });

  test('createStatusMapper rejects malformed tables early', () => {
    assert.throws(() => createStatusMapper({ 'Not Normalized': OrderStatus.Pending }), /not normalized/);
    assert.throws(() => createStatusMapper({ ok: 'shipped' as never }), /not a normalized status/);
  });

  test('terminal and delivered helpers', () => {
    assert.ok(isTerminalStatus('delivered'));
    assert.ok(isTerminalStatus('returned'));
    assert.ok(isTerminalStatus('cancelled'));
    assert.ok(!isTerminalStatus('on_hold'));
    assert.ok(!isTerminalStatus('unknown'));
    assert.ok(isDeliveredStatus('partial_delivered'));
    assert.ok(!isDeliveredStatus('returned'));
    assert.ok(isOrderStatus('in_transit'));
    assert.ok(!isOrderStatus('shipped'));
  });
});

describe('utils', () => {
  test('toNumber is lenient with provider strings', () => {
    assert.equal(toNumber('1,200.50'), 1200.5);
    assert.equal(toNumber(' 60 '), 60);
    assert.equal(toNumber(''), undefined);
    assert.equal(toNumber('abc'), undefined);
    assert.equal(toNumber(Number.NaN), undefined);
  });

  test('toIsoTimestamp treats zone-less times as Asia/Dhaka', () => {
    assert.equal(toIsoTimestamp('2026-01-15 14:30:00'), '2026-01-15T08:30:00.000Z');
    assert.equal(toIsoTimestamp('2026-01-15T14:30:00'), '2026-01-15T08:30:00.000Z');
  });

  test('toIsoTimestamp respects explicit zones and epoch values', () => {
    assert.equal(toIsoTimestamp('2026-01-15T14:30:00Z'), '2026-01-15T14:30:00.000Z');
    assert.equal(toIsoTimestamp(1_700_000_000), '2023-11-14T22:13:20.000Z');
    assert.equal(toIsoTimestamp(1_700_000_000_000), '2023-11-14T22:13:20.000Z');
    assert.equal(toIsoTimestamp('1700000000'), '2023-11-14T22:13:20.000Z');
  });

  test('toIsoTimestamp returns undefined for junk', () => {
    assert.equal(toIsoTimestamp('not a date'), undefined);
    assert.equal(toIsoTimestamp(''), undefined);
    assert.equal(toIsoTimestamp(null), undefined);
  });

  test('roundMoney avoids float artifacts', () => {
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
    assert.equal(roundMoney(1.005), 1.01);
  });

  test('chunk splits evenly and rejects bad sizes', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
    assert.throws(() => chunk([1], 0), RangeError);
  });

  test('mapWithConcurrency preserves order and respects the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });

  test('numericId converts digit strings only', () => {
    assert.equal(numericId('42'), 42);
    assert.equal(numericId('A42'), 'A42');
    assert.equal(numericId(7), 7);
    assert.equal(numericId(undefined), undefined);
  });
});

describe('rate card', () => {
  const card = { zones: { inside_dhaka: 60, outside_dhaka: 120 }, defaultZone: 'inside_dhaka', extraPerKg: 20, codPercent: 1 };

  test('base charge covers the first kilogram', () => {
    const charge = chargeFromRateCard('steadfast', card, { weightKg: 1, codAmount: 0 });
    assert.equal(charge.deliveryCharge, 60);
    assert.equal(charge.total, 60);
    assert.equal(charge.estimated, true);
  });

  test('each started extra kilogram is charged, plus COD percentage', () => {
    const charge = chargeFromRateCard('steadfast', card, { weightKg: 2.2, codAmount: 1500, rateZone: 'outside_dhaka' });
    assert.equal(charge.deliveryCharge, 160);
    assert.equal(charge.codCharge, 15);
    assert.equal(charge.total, 175);
  });

  test('unknown or missing zone is a validation error', () => {
    assert.throws(() => chargeFromRateCard('steadfast', card, { weightKg: 1, rateZone: 'mars' }), ValidationError);
    assert.throws(() => chargeFromRateCard('steadfast', { zones: { a: 1 } }, { weightKg: 1 }), ValidationError);
  });

  test('assertRateCard rejects malformed cards', () => {
    assert.throws(() => assertRateCard({ zones: {} }), ConfigError);
    assert.throws(() => assertRateCard({ zones: { a: -1 } }), ConfigError);
    assert.throws(() => assertRateCard({ zones: { a: 1 }, defaultZone: 'b' }), ConfigError);
    assert.throws(() => assertRateCard({ zones: { a: 1 }, codPercent: Number.NaN }), ConfigError);
    assert.doesNotThrow(() => assertRateCard(card));
  });
});

describe('package', () => {
  test('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  test('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    assert.equal(pkg.dependencies, undefined);
  });

  test('public entry point exports the main API', () => {
    for (const name of [
      'PathaoCourier',
      'SteadfastCourier',
      'RedxCourier',
      'CourierRouter',
      'createCourier',
      'parseWebhook',
      'normalizePhone',
      'OrderStatus',
      'HttpClient',
    ]) {
      assert.ok(name in sdk, `missing export ${name}`);
    }
  });
});
