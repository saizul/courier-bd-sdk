import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthError,
  ConfigError,
  NetworkError,
  NoCourierAvailableError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UnsupportedOperationError,
  ValidationError,
} from '../src/errors.js';
import {
  CourierRouter,
  allOf,
  anyOf,
  coversAreas,
  coversCities,
  coversPostCodes,
  coversZones,
  maxCod,
  maxWeight,
  not,
  type RouterEvent,
} from '../src/router.js';
import type { Capabilities, Charge, ChargeInput, CourierClient, CreateOrderInput, Order } from '../src/types.js';
import { sampleOrder } from './helpers/mock-fetch.js';

interface FakeOptions {
  /** Outcomes for successive createOrder calls; the last one repeats. An Error rejects. */
  create?: Array<Error | 'ok'>;
  /** Charge total, or an Error to reject the quote. */
  charge?: number | Error;
}

class FakeCourier implements CourierClient {
  readonly capabilities: Readonly<Capabilities> = {
    cancelOrder: false,
    calculateCharge: 'api',
    bulkCreate: 'emulated',
    listCities: false,
    listZones: false,
    listAreas: false,
    trackByMerchantOrderId: false,
    trackByTrackingCode: false,
  };
  readonly created: CreateOrderInput[] = [];
  readonly quoted: ChargeInput[] = [];
  private createCalls = 0;

  constructor(
    readonly provider: string,
    private readonly options: FakeOptions = {},
  ) {}

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const outcomes = this.options.create ?? ['ok'];
    const outcome = outcomes[Math.min(this.createCalls, outcomes.length - 1)];
    this.createCalls += 1;
    this.created.push(input);
    if (outcome instanceof Error) throw outcome;
    return {
      provider: this.provider,
      consignmentId: `${this.provider}-${this.createCalls}`,
      merchantOrderId: input.merchantOrderId,
      status: 'pending',
      raw: {},
    };
  }

  async calculateCharge(input: ChargeInput): Promise<Charge> {
    this.quoted.push(input);
    const charge = this.options.charge;
    if (charge === undefined) throw new UnsupportedOperationError(this.provider, "calculateCharge");
    if (charge instanceof Error) throw charge;
    return { provider: this.provider, deliveryCharge: charge, codCharge: 0, discount: 0, total: charge, currency: 'BDT', estimated: false, raw: {} };
  }

  bulkCreate(): never {
    throw new Error('not used');
  }
  trackOrder(): never {
    throw new Error('not used');
  }
  cancelOrder(): never {
    throw new Error('not used');
  }
  listCities(): never {
    throw new Error('not used');
  }
  listZones(): never {
    throw new Error('not used');
  }
  listAreas(): never {
    throw new Error('not used');
  }
}

const serverError = (): ProviderError => new ProviderError('boom', { status: 502 });

describe('CourierRouter configuration', () => {
  test('needs at least one candidate', () => {
    assert.throws(() => new CourierRouter({ candidates: [] }), ConfigError);
  });

  test('rejects duplicate names and unknown strategies', () => {
    const a = new FakeCourier('pathao');
    assert.throws(() => new CourierRouter({ candidates: [{ client: a }, { client: a }] }), /Duplicate router candidate "pathao"/);
    assert.throws(() => new CourierRouter({ candidates: [{ client: a }], strategy: 'fastest' as never }), ConfigError);
    assert.throws(() => new CourierRouter({ candidates: [{} as never] }), /has no client/);
  });

  test('orders candidates by priority, keeping list order for ties', () => {
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('a'), priority: 2 },
        { client: new FakeCourier('b'), priority: 1 },
        { client: new FakeCourier('c'), priority: 1 },
      ],
    });
    assert.deepEqual(router.providers, ['b', 'c', 'a']);
  });

  test('the same provider can appear twice under different names', () => {
    const main = new FakeCourier('pathao');
    const backup = new FakeCourier('pathao');
    const router = new CourierRouter({ candidates: [{ client: main, name: 'pathao-main' }, { client: backup, name: 'pathao-backup' }] });
    assert.equal(router.client('pathao-backup'), backup);
    assert.throws(() => router.client('nope'), ConfigError);
  });
});

describe('CourierRouter priority routing', () => {
  test('uses the first candidate when it succeeds', async () => {
    const a = new FakeCourier('a');
    const b = new FakeCourier('b');
    const result = await new CourierRouter({ candidates: [{ client: a }, { client: b }] }).createOrder(sampleOrder());
    assert.equal(result.provider, 'a');
    assert.equal(result.order.consignmentId, 'a-1');
    assert.deepEqual(result.attempts, [{ provider: 'a', outcome: 'success' }]);
    assert.equal(b.created.length, 0);
    assert.equal(result.charge, undefined);
  });

  test('fails over to the next candidate on a provider error', async () => {
    const a = new FakeCourier('a', { create: [serverError()] });
    const b = new FakeCourier('b');
    const result = await new CourierRouter({ candidates: [{ client: a }, { client: b }] }).createOrder(sampleOrder());
    assert.equal(result.provider, 'b');
    assert.deepEqual(result.attempts.map((attempt) => [attempt.provider, attempt.outcome]), [['a', 'failed'], ['b', 'success']]);
  });

  for (const [label, error] of [
    ['auth', new AuthError('bad credentials')],
    ['rate limit', new RateLimitError('slow down')],
    ['network', new NetworkError('socket hang up')],
    ['validation', new ValidationError('area not served')],
    ['unsupported', new UnsupportedOperationError('a', 'createOrder')],
  ] as Array<[string, Error]>) {
    test(`fails over on a ${label} error`, async () => {
      const a = new FakeCourier('a', { create: [error] });
      const result = await new CourierRouter({ candidates: [{ client: a }, { client: new FakeCourier('b') }] }).createOrder(sampleOrder());
      assert.equal(result.provider, 'b');
    });
  }

  test('does not fail over on a timeout by default, because the order may exist', async () => {
    const timeout = new TimeoutError('timed out', { timeoutMs: 1000 });
    const b = new FakeCourier('b');
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a', { create: [timeout] }) }, { client: b }] });
    await assert.rejects(router.createOrder(sampleOrder()), (error: unknown) => error === timeout);
    assert.equal(b.created.length, 0);
  });

  test('fails over on a timeout when explicitly enabled', async () => {
    const router = new CourierRouter({
      candidates: [{ client: new FakeCourier('a', { create: [new TimeoutError('timed out', { timeoutMs: 1000 })] }) }, { client: new FakeCourier('b') }],
      failoverOnTimeout: true,
    });
    assert.equal((await router.createOrder(sampleOrder())).provider, 'b');
  });

  test('rethrows errors that are not SDK errors', async () => {
    const bug = new TypeError('undefined is not a function');
    const b = new FakeCourier('b');
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a', { create: [bug] }) }, { client: b }] });
    await assert.rejects(router.createOrder(sampleOrder()), (error: unknown) => error === bug);
    assert.equal(b.created.length, 0);
  });

  test('failover: false surfaces the first error untouched', async () => {
    const error = serverError();
    const b = new FakeCourier('b');
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a', { create: [error] }) }, { client: b }], failover: false });
    await assert.rejects(router.createOrder(sampleOrder()), (thrown: unknown) => thrown === error);
    assert.equal(b.created.length, 0);
  });

  test('a custom shouldFailover decides per error', async () => {
    const seen: string[] = [];
    const router = new CourierRouter({
      candidates: [{ client: new FakeCourier('a', { create: [new ValidationError('bad phone')] }) }, { client: new FakeCourier('b') }],
      shouldFailover: (error, provider) => {
        seen.push(provider);
        return !(error instanceof ValidationError);
      },
    });
    await assert.rejects(router.createOrder(sampleOrder()), ValidationError);
    assert.deepEqual(seen, ['a']);
  });

  test('reports every attempt when all candidates fail', async () => {
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('a', { create: [serverError()] }) },
        { client: new FakeCourier('b', { create: [new AuthError('expired')] }) },
        { client: new FakeCourier('c'), covers: () => false },
      ],
    });
    await assert.rejects(router.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof NoCourierAvailableError);
      assert.equal(error.code, 'NO_COURIER');
      assert.match(error.message, /All 2 attempted courier\(s\) failed/);
      assert.deepEqual(error.attempts.map((attempt) => [attempt.provider, attempt.outcome]), [
        ['c', 'skipped'],
        ['a', 'failed'],
        ['b', 'failed'],
      ]);
      assert.equal(error.attempts[0]?.reason, 'not_covered');
      assert.ok(error.attempts[2]?.error instanceof AuthError);
      return true;
    });
  });

  test('prepare adapts the order per courier without mutating the original', async () => {
    const a = new FakeCourier('a');
    const order = sampleOrder();
    const router = new CourierRouter({
      candidates: [{ client: a, prepare: (input) => ({ ...input, note: 'Handle with care' }) }],
    });
    await router.createOrder(order);
    assert.equal(a.created[0]?.note, 'Handle with care');
    assert.equal(order.note, undefined);
  });

  test('a failing prepare counts as a failed attempt for that courier', async () => {
    const a = new FakeCourier('a');
    const router = new CourierRouter({
      candidates: [
        { client: a, prepare: () => { throw new ValidationError('no area mapping for this courier'); } },
        { client: new FakeCourier('b') },
      ],
    });
    assert.equal((await router.createOrder(sampleOrder())).provider, 'b');
    assert.equal(a.created.length, 0);
  });
});

describe('CourierRouter coverage', () => {
  test('skips candidates whose coverage rule rejects the order', async () => {
    const a = new FakeCourier('a');
    const router = new CourierRouter({
      candidates: [{ client: a, covers: coversCities([2, 3]) }, { client: new FakeCourier('b') }],
    });
    const result = await router.createOrder(sampleOrder());
    assert.equal(result.provider, 'b');
    assert.deepEqual(result.attempts[0], { provider: 'a', outcome: 'skipped', reason: 'not_covered' });
    assert.equal(a.created.length, 0);
  });

  test('async coverage rules are awaited', async () => {
    const router = new CourierRouter({
      candidates: [{ client: new FakeCourier('a'), covers: async () => false }, { client: new FakeCourier('b'), covers: async () => true }],
    });
    assert.equal((await router.createOrder(sampleOrder())).provider, 'b');
  });

  test('a coverage rule that throws does not vouch for the courier', async () => {
    const router = new CourierRouter({
      candidates: [{ client: new FakeCourier('a'), covers: () => { throw new Error('lookup failed'); } }, { client: new FakeCourier('b') }],
    });
    assert.equal((await router.createOrder(sampleOrder())).provider, 'b');
  });

  test('rejects when nobody covers the order', async () => {
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a'), covers: () => false }] });
    await assert.rejects(router.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof NoCourierAvailableError);
      assert.match(error.message, /all candidates were skipped/);
      return true;
    });
  });

  test('coverage helpers compare ids loosely and handle missing fields', () => {
    const order = sampleOrder();
    assert.equal(coversCities(['1'])(order), true);
    assert.equal(coversCities([9])(order), false);
    assert.equal(coversZones([10])(order), true);
    assert.equal(coversZones([11])(order), false);
    assert.equal(coversAreas(['100'])(order), true);
    assert.equal(coversAreas([101])(order), false);
    assert.equal(coversCities([1])(sampleOrder({ recipient: { cityId: undefined } })), false);
  });

  test('coversPostCodes matches the recipient post code', () => {
    assert.equal(coversPostCodes([1209, '1207'])(sampleOrder({ recipient: { postCode: '1209' } })), true);
    assert.equal(coversPostCodes([1207])(sampleOrder({ recipient: { postCode: '1209' } })), false);
    assert.equal(coversPostCodes([1207])(sampleOrder()), false);
  });

  test('maxCod and maxWeight are inclusive limits', () => {
    assert.equal(maxCod(1200)(sampleOrder()), true);
    assert.equal(maxCod(1199)(sampleOrder()), false);
    assert.equal(maxWeight(1)(sampleOrder()), true);
    assert.equal(maxWeight(0.5)(sampleOrder()), false);
  });

  test('allOf, anyOf and not combine rules', async () => {
    const order = sampleOrder();
    assert.equal(await allOf(coversCities([1]), maxCod(5000))(order), true);
    assert.equal(await allOf(coversCities([1]), maxCod(100))(order), false);
    assert.equal(await anyOf(coversCities([9]), async () => true)(order), true);
    assert.equal(await anyOf(coversCities([9]), maxCod(100))(order), false);
    assert.equal(await not(coversCities([9]))(order), true);
    assert.equal(await allOf()(order), true);
    assert.equal(await anyOf()(order), false);
  });
});

describe('CourierRouter cheapest strategy', () => {
  test('tries the lowest total first and returns the winning quote', async () => {
    const a = new FakeCourier('a', { charge: 120 });
    const b = new FakeCourier('b', { charge: 80 });
    const c = new FakeCourier('c', { charge: 100 });
    const router = new CourierRouter({ candidates: [{ client: a }, { client: b }, { client: c }], strategy: 'cheapest' });
    const result = await router.createOrder(sampleOrder());
    assert.equal(result.provider, 'b');
    assert.equal(result.charge?.total, 80);
    assert.equal(a.created.length + c.created.length, 0);
  });

  test('ties keep priority order', async () => {
    const router = new CourierRouter({
      candidates: [{ client: new FakeCourier('a', { charge: 90 }) }, { client: new FakeCourier('b', { charge: 90 }) }],
      strategy: 'cheapest',
    });
    assert.deepEqual((await router.plan(sampleOrder())).order.map((entry) => entry.provider), ['a', 'b']);
  });

  test('couriers that cannot quote are tried last', async () => {
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('no-price') },
        { client: new FakeCourier('broken', { charge: serverError() }) },
        { client: new FakeCourier('priced', { charge: 150 }) },
      ],
      strategy: 'cheapest',
    });
    const plan = await router.plan(sampleOrder());
    assert.deepEqual(plan.order.map((entry) => entry.provider), ['priced', 'no-price', 'broken']);
    assert.equal(plan.order[0]?.charge?.total, 150);
    assert.equal(plan.order[1]?.charge, undefined);
  });

  test('fails over from the cheapest to the next cheapest', async () => {
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('a', { charge: 120 }) },
        { client: new FakeCourier('b', { charge: 80, create: [serverError()] }) },
      ],
      strategy: 'cheapest',
    });
    const result = await router.createOrder(sampleOrder());
    assert.equal(result.provider, 'a');
    assert.equal(result.charge?.total, 120);
  });

  test('derives the charge input from the order by default', async () => {
    const a = new FakeCourier('a', { charge: 70 });
    await new CourierRouter({ candidates: [{ client: a }], strategy: 'cheapest' }).plan(sampleOrder());
    const input = a.quoted[0];
    assert.equal(input?.weightKg, 1);
    assert.equal(input?.codAmount, 1200);
    assert.equal(input?.cityId, 1);
    assert.equal(input?.zoneId, 10);
    assert.equal(input?.areaId, 100);
  });

  test('a per-candidate chargeInput overrides the default', async () => {
    const a = new FakeCourier('a', { charge: 70 });
    const router = new CourierRouter({
      candidates: [{ client: a, chargeInput: (order) => ({ weightKg: order.weightKg ?? 0.5, rateZone: 'inside_dhaka' }) }],
      strategy: 'cheapest',
    });
    await router.plan(sampleOrder());
    assert.deepEqual(a.quoted[0], { weightKg: 1, rateZone: 'inside_dhaka' });
  });

  test('uncovered candidates are never quoted', async () => {
    const a = new FakeCourier('a', { charge: 10 });
    const router = new CourierRouter({ candidates: [{ client: a, covers: () => false }, { client: new FakeCourier('b', { charge: 99 }) }], strategy: 'cheapest' });
    const plan = await router.plan(sampleOrder());
    assert.deepEqual(plan.order.map((entry) => entry.provider), ['b']);
    assert.deepEqual(plan.skipped, [{ provider: 'a', reason: 'not_covered' }]);
    assert.equal(a.quoted.length, 0);
  });
});

describe('CourierRouter quote and plan', () => {
  test('quote reports coverage, charges and quote errors for every candidate', async () => {
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('a', { charge: 60 }) },
        { client: new FakeCourier('b') },
        { client: new FakeCourier('c', { charge: 10 }), covers: () => false },
      ],
    });
    const quotes = await router.quote(sampleOrder());
    assert.deepEqual(quotes.map((quote) => [quote.provider, quote.covered]), [['a', true], ['b', true], ['c', false]]);
    assert.equal(quotes[0]?.charge?.total, 60);
    assert.ok(quotes[1]?.error instanceof UnsupportedOperationError);
    assert.equal(quotes[2]?.charge, undefined);
  });

  test('plan creates nothing', async () => {
    const a = new FakeCourier('a');
    const plan = await new CourierRouter({ candidates: [{ client: a }] }).plan(sampleOrder());
    assert.deepEqual(plan, { order: [{ provider: 'a' }], skipped: [] });
    assert.equal(a.created.length, 0);
  });
});

describe('CourierRouter circuit breaker', () => {
  function build(options: { threshold?: number; cooldownMs?: number; disabled?: boolean; error?: Error } = {}) {
    let now = 1_000_000;
    const a = new FakeCourier('a', { create: [options.error ?? serverError()] });
    const b = new FakeCourier('b');
    const router = new CourierRouter({
      candidates: [{ client: a }, { client: b }],
      circuitBreaker: options.disabled ? false : { failureThreshold: options.threshold ?? 2, cooldownMs: options.cooldownMs ?? 30_000 },
      now: () => now,
    });
    return { a, b, router, advance: (ms: number) => { now += ms; } };
  }

  test('opens after the threshold and skips the courier during the cooldown', async () => {
    const { a, router } = build();
    await router.createOrder(sampleOrder());
    await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 2);
    const third = await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 2);
    assert.deepEqual(third.attempts[0], { provider: 'a', outcome: 'skipped', reason: 'circuit_open' });
  });

  test('closes again after the cooldown', async () => {
    const { a, router, advance } = build();
    await router.createOrder(sampleOrder());
    await router.createOrder(sampleOrder());
    advance(30_001);
    await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 3);
  });

  test('validation failures never open the circuit', async () => {
    const { a, router } = build({ error: new ValidationError('area not served') });
    for (let i = 0; i < 5; i++) await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 5);
  });

  test('a success resets the failure count', async () => {
    let now = 0;
    const a = new FakeCourier('a', { create: [serverError(), 'ok', serverError(), 'ok'] });
    const router = new CourierRouter({
      candidates: [{ client: a }, { client: new FakeCourier('b') }],
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1000 },
      now: () => now++,
    });
    for (let i = 0; i < 4; i++) await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 4);
  });

  test('reset() closes the circuit immediately', async () => {
    const { a, router } = build();
    await router.createOrder(sampleOrder());
    await router.createOrder(sampleOrder());
    router.reset('a');
    await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 3);
  });

  test('can be disabled', async () => {
    const { a, router } = build({ disabled: true });
    for (let i = 0; i < 6; i++) await router.createOrder(sampleOrder());
    assert.equal(a.created.length, 6);
  });
});

describe('CourierRouter events', () => {
  test('emits skip, quote, attempt, failure and success in order', async () => {
    const events: RouterEvent[] = [];
    const router = new CourierRouter({
      candidates: [
        { client: new FakeCourier('a', { charge: 50, create: [serverError()] }) },
        { client: new FakeCourier('b', { charge: 70 }) },
        { client: new FakeCourier('c'), covers: () => false },
      ],
      strategy: 'cheapest',
      onEvent: (event) => events.push(event),
    });
    await router.createOrder(sampleOrder());
    assert.deepEqual(events.map((event) => `${event.type}:${event.provider}`), [
      'skip:c',
      'quote:a',
      'quote:b',
      'attempt:a',
      'failure:a',
      'attempt:b',
      'success:b',
    ]);
    const failure = events.find((event) => event.type === 'failure');
    assert.ok(failure?.type === 'failure' && failure.willFailover);
  });

  test('willFailover is false for the last candidate', async () => {
    const events: RouterEvent[] = [];
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a', { create: [serverError()] }) }], onEvent: (event) => events.push(event) });
    await assert.rejects(router.createOrder(sampleOrder()), NoCourierAvailableError);
    const failure = events.find((event) => event.type === 'failure');
    assert.ok(failure?.type === 'failure' && failure.willFailover === false);
  });

  test('a throwing observer does not affect routing', async () => {
    const router = new CourierRouter({ candidates: [{ client: new FakeCourier('a') }], onEvent: () => { throw new Error('logger down'); } });
    assert.equal((await router.createOrder(sampleOrder())).provider, 'a');
  });
});
