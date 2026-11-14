import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthError,
  ConfigError,
  IdempotencyError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../src/errors.js';
import {
  IdempotentCourier,
  MemoryIdempotencyStore,
  isAmbiguousCreateFailure,
  orderFingerprint,
  withIdempotency,
  type IdempotencyEvent,
  type IdempotencyOptions,
} from '../src/idempotency.js';
import * as sdk from '../src/index.js';
import { SteadfastCourier } from '../src/providers/steadfast/index.js';
import type {
  BulkCreateResult,
  Capabilities,
  CourierClient,
  CreateOrderInput,
  Order,
  Tracking,
  TrackQuery,
} from '../src/types.js';
import { MockFetch, hang, instant, json, networkFailure, sampleOrder } from './helpers/mock-fetch.js';

type Outcome = Error | 'ok' | (() => Promise<never>);

class FakeCourier implements CourierClient {
  readonly provider = 'fake';
  readonly capabilities: Capabilities;
  readonly created: CreateOrderInput[] = [];
  readonly bulkCalls: CreateOrderInput[][] = [];
  readonly trackCalls: TrackQuery[] = [];
  private calls = 0;

  constructor(
    private readonly outcomes: Outcome[] = ['ok'],
    options: { trackByMerchantOrderId?: boolean; track?: Error | Tracking; bulk?: (inputs: readonly CreateOrderInput[]) => BulkCreateResult | Error } = {},
  ) {
    this.capabilities = {
      cancelOrder: false,
      calculateCharge: false,
      bulkCreate: 'native',
      listCities: false,
      listZones: false,
      listAreas: false,
      trackByMerchantOrderId: options.trackByMerchantOrderId ?? false,
      trackByTrackingCode: false,
    };
    this.track = options.track;
    this.bulk = options.bulk;
  }

  private readonly track: Error | Tracking | undefined;
  private readonly bulk: ((inputs: readonly CreateOrderInput[]) => BulkCreateResult | Error) | undefined;

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
    this.calls += 1;
    this.created.push(input);
    if (typeof outcome === 'function') return outcome();
    if (outcome instanceof Error) throw outcome;
    await Promise.resolve();
    return { provider: this.provider, consignmentId: `C-${this.calls}`, merchantOrderId: input.merchantOrderId, status: 'pending', raw: {} };
  }

  async bulkCreate(inputs: readonly CreateOrderInput[]): Promise<BulkCreateResult> {
    this.bulkCalls.push([...inputs]);
    if (!this.bulk) throw new Error('bulk not scripted');
    const result = this.bulk(inputs);
    if (result instanceof Error) throw result;
    return result;
  }

  async trackOrder(query: TrackQuery): Promise<Tracking> {
    this.trackCalls.push(query);
    if (this.track instanceof Error) throw this.track;
    if (!this.track) throw new Error('track not scripted');
    return this.track;
  }

  cancelOrder(): never {
    throw new Error('not used');
  }
  calculateCharge(): never {
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

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function guard(client: CourierClient, options: IdempotencyOptions = {}): { courier: IdempotentCourier; events: IdempotencyEvent[] } {
  const events: IdempotencyEvent[] = [];
  return { courier: withIdempotency(client, { onEvent: (event) => events.push(event), ...options }), events };
}

function isReason(reason: IdempotencyError['reason']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof IdempotencyError, `expected IdempotencyError, got ${String(error)}`);
    assert.equal(error.code, 'IDEMPOTENCY');
    assert.equal(error.reason, reason);
    return true;
  };
}

const timeout = () => new TimeoutError('timed out', { timeoutMs: 10 });

describe('IdempotentCourier: createOrder', () => {
  test('a confirmed order is replayed from the store without another request', async () => {
    const fake = new FakeCourier();
    const { courier, events } = guard(fake);
    const first = await courier.createOrder(sampleOrder());
    const second = await courier.createOrder(sampleOrder());
    assert.equal(fake.created.length, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(
      events.map((event) => event.type),
      ['stored', 'replay'],
    );
    assert.equal((await courier.status('INV-1001'))?.state, 'created');
  });

  test('different merchant order ids are independent', async () => {
    const fake = new FakeCourier();
    const { courier } = guard(fake);
    await courier.createOrder(sampleOrder({ merchantOrderId: 'A' }));
    await courier.createOrder(sampleOrder({ merchantOrderId: 'B' }));
    assert.equal(fake.created.length, 2);
  });

  test('concurrent calls for one key share a single request', async () => {
    const fake = new FakeCourier();
    const { courier } = guard(fake);
    const [a, b, c] = await Promise.all([
      courier.createOrder(sampleOrder()),
      courier.createOrder(sampleOrder()),
      courier.createOrder(sampleOrder()),
    ]);
    assert.equal(fake.created.length, 1);
    assert.equal(a.consignmentId, b.consignmentId);
    assert.equal(b.consignmentId, c.consignmentId);
  });

  test('a concurrent call with different contents is a conflict', async () => {
    const { courier } = guard(new FakeCourier());
    const first = courier.createOrder(sampleOrder());
    await assert.rejects(courier.createOrder(sampleOrder({ codAmount: 999 })), isReason('conflict'));
    await first;
  });

  test('reusing a key for a different order is rejected', async () => {
    const fake = new FakeCourier();
    const { courier } = guard(fake);
    await courier.createOrder(sampleOrder());
    await assert.rejects(courier.createOrder(sampleOrder({ recipient: { phone: '01812345678' } })), isReason('conflict'));
    await assert.rejects(courier.createOrder(sampleOrder({ codAmount: 1500 })), isReason('conflict'));
    assert.equal(fake.created.length, 1);
  });

  test('cosmetic differences do not count as a conflict', async () => {
    const { courier } = guard(new FakeCourier());
    await courier.createOrder(sampleOrder());
    await courier.createOrder(
      sampleOrder({ recipient: { phone: '+8801712345678', address: '  house 1,  Road 2, Dhanmondi, Dhaka ' }, note: 'ring twice' }),
    );
  });

  test('fingerprint: false disables the conflict check', async () => {
    const fake = new FakeCourier();
    const { courier } = guard(fake, { fingerprint: false });
    const first = await courier.createOrder(sampleOrder());
    const again = await courier.createOrder(sampleOrder({ codAmount: 1 }));
    assert.equal(again.consignmentId, first.consignmentId);
  });

  for (const [name, error] of [
    ['validation', new ValidationError('bad')],
    ['auth', new AuthError('no')],
    ['rate limit', new RateLimitError('slow down')],
    ['4xx provider', new ProviderError('gone', { status: 404 })],
  ] as const) {
    test(`a definite ${name} failure releases the key`, async () => {
      const fake = new FakeCourier([error, 'ok']);
      const { courier, events } = guard(fake);
      await assert.rejects(courier.createOrder(sampleOrder()), (thrown: unknown) => thrown === error);
      assert.equal(await courier.status('INV-1001'), undefined);
      assert.equal(events.at(-1)?.type, 'released');
      const order = await courier.createOrder(sampleOrder({ codAmount: 10 }));
      assert.equal(order.consignmentId, 'C-2');
    });
  }

  for (const [name, error] of [
    ['timeout', timeout()],
    ['network', new NetworkError('reset')],
    ['5xx', new ProviderError('boom', { status: 502 })],
    ['unparseable 200', new ProviderError('unexpected', { status: 200 })],
    ['non-SDK', new TypeError('bug')],
  ] as const) {
    test(`an ambiguous ${name} failure blocks a resend when the courier cannot look orders up`, async () => {
      const fake = new FakeCourier([error, 'ok']);
      const { courier, events } = guard(fake);
      await assert.rejects(courier.createOrder(sampleOrder()), (thrown: unknown) => thrown === error);
      const record = await courier.status('INV-1001');
      assert.equal(record?.state, 'unknown');
      assert.equal(events.at(-1)?.type, 'ambiguous');
      await assert.rejects(courier.createOrder(sampleOrder()), isReason('outcome_unknown'));
      assert.equal(fake.created.length, 1);
    });
  }

  test('forget() releases an unknown key for a deliberate resend', async () => {
    const fake = new FakeCourier([timeout(), 'ok']);
    const { courier } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    await courier.forget('INV-1001');
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'C-2');
  });

  test('markCreated() records an order confirmed elsewhere', async () => {
    const fake = new FakeCourier([timeout()]);
    const { courier } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    await courier.markCreated({ provider: 'fake', consignmentId: 'PANEL-1', merchantOrderId: 'INV-1001', status: 'pending', raw: {} });
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'PANEL-1');
    assert.equal(fake.created.length, 1);
  });

  test('after an ambiguous failure the order is looked up and recovered when it exists', async () => {
    const tracking: Tracking = {
      provider: 'fake',
      consignmentId: 'C-REAL',
      merchantOrderId: 'INV-1001',
      status: 'pending',
      providerStatus: 'in_review',
      events: [],
      raw: { found: true },
    };
    const fake = new FakeCourier([timeout(), 'ok'], { trackByMerchantOrderId: true, track: tracking });
    const { courier, events } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'C-REAL');
    assert.equal(order.providerStatus, 'in_review');
    assert.equal(order.codAmount, 1200);
    assert.deepEqual(fake.trackCalls, [{ merchantOrderId: 'INV-1001' }]);
    assert.equal(fake.created.length, 1);
    assert.ok(events.some((event) => event.type === 'recovered'));
    // Recovered orders are now replayed without another lookup.
    await courier.createOrder(sampleOrder());
    assert.equal(fake.trackCalls.length, 1);
  });

  test('a 404 lookup means the order does not exist and it is created', async () => {
    const fake = new FakeCourier([timeout(), 'ok'], {
      trackByMerchantOrderId: true,
      track: new ProviderError('not found', { status: 404 }),
    });
    const { courier } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'C-2');
    assert.equal(fake.created.length, 2);
  });

  test('a failing lookup keeps the key blocked and exposes the cause', async () => {
    const lookupError = new NetworkError('still down');
    const fake = new FakeCourier([timeout(), 'ok'], { trackByMerchantOrderId: true, track: lookupError });
    const { courier } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    await assert.rejects(courier.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof IdempotencyError);
      assert.equal(error.reason, 'outcome_unknown');
      assert.equal(error.cause, lookupError);
      return true;
    });
    assert.equal((await courier.status('INV-1001'))?.state, 'unknown');
  });

  test('a custom lookup is used and lookup: false disables the default', async () => {
    const lookups: string[] = [];
    const fake = new FakeCourier([timeout(), 'ok'], { trackByMerchantOrderId: true });
    const { courier } = guard(fake, {
      lookup: async (input) => {
        lookups.push(input.merchantOrderId);
        return null;
      },
    });
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    await courier.createOrder(sampleOrder());
    assert.deepEqual(lookups, ['INV-1001']);

    const blocked = guard(new FakeCourier([timeout()], { trackByMerchantOrderId: true }), { lookup: false }).courier;
    await assert.rejects(blocked.createOrder(sampleOrder()), TimeoutError);
    await assert.rejects(blocked.createOrder(sampleOrder()), isReason('outcome_unknown'));
  });

  test('a fresh pending record from another worker blocks; a stale one is resolved', async () => {
    const time = clock();
    const store = new MemoryIdempotencyStore({ now: time.now });
    const other = new FakeCourier();
    const otherWorker = withIdempotency(other, { store, now: time.now, lookup: async () => null });
    store.set(otherWorker.keyFor('INV-1001'), { state: 'pending', at: time.now() }, 60_000_000);

    await assert.rejects(otherWorker.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(isReason('in_progress')(error));
      assert.equal((error as IdempotencyError).retryable, true);
      return true;
    });
    time.advance(2 * 60 * 1000);
    const order = await otherWorker.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'C-1');
  });

  test('records expire after ttlMs', async () => {
    const time = clock();
    const fake = new FakeCourier();
    const { courier } = guard(fake, { now: time.now, ttlMs: 1000 });
    await courier.createOrder(sampleOrder());
    time.advance(999);
    await courier.createOrder(sampleOrder());
    assert.equal(fake.created.length, 1);
    time.advance(1);
    await courier.createOrder(sampleOrder());
    assert.equal(fake.created.length, 2);
  });

  test('a custom keyFor shares records across couriers', async () => {
    const store = new MemoryIdempotencyStore();
    const keyFor = (merchantOrderId: string) => `order:${merchantOrderId}`;
    const a = new FakeCourier();
    const b = new FakeCourier();
    await withIdempotency(a, { store, keyFor }).createOrder(sampleOrder());
    const order = await withIdempotency(b, { store, keyFor }).createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'C-1');
    assert.equal(b.created.length, 0);
  });

  test('an async store is awaited', async () => {
    const data = new Map<string, unknown>();
    const fake = new FakeCourier();
    const courier = withIdempotency(fake, {
      store: {
        get: async (key) => data.get(key) as never,
        set: async (key, record) => {
          data.set(key, record);
        },
        delete: async (key) => {
          data.delete(key);
        },
      },
    });
    await courier.createOrder(sampleOrder());
    await courier.createOrder(sampleOrder());
    assert.equal(fake.created.length, 1);
    assert.equal(data.size, 1);
  });

  test('a missing merchant order id is rejected locally', async () => {
    const fake = new FakeCourier();
    const { courier } = guard(fake);
    await assert.rejects(courier.createOrder(sampleOrder({ merchantOrderId: '  ' })), ValidationError);
    assert.equal(fake.created.length, 0);
  });

  test('a throwing observer does not break order creation', async () => {
    const courier = withIdempotency(new FakeCourier(), {
      onEvent: () => {
        throw new Error('observer bug');
      },
    });
    await courier.createOrder(sampleOrder());
  });

  test('invalid options are rejected', () => {
    assert.throws(() => withIdempotency(new FakeCourier(), { ttlMs: 0 }), ConfigError);
    assert.throws(() => withIdempotency(new FakeCourier(), { pendingTimeoutMs: Number.NaN }), ConfigError);
  });

  test('other operations pass through to the wrapped client', async () => {
    const tracking: Tracking = { provider: 'fake', consignmentId: 'X', status: 'delivered', events: [], raw: {} };
    const fake = new FakeCourier(['ok'], { track: tracking });
    const courier = withIdempotency(fake);
    assert.equal(courier.provider, 'fake');
    assert.equal(courier.capabilities, fake.capabilities);
    assert.equal(await courier.trackOrder('X'), tracking);
    assert.throws(() => courier.listCities(), /not used/);
  });
});

describe('IdempotentCourier: bulkCreate', () => {
  const syncBulk = (inputs: readonly CreateOrderInput[]): BulkCreateResult => ({
    provider: 'fake',
    mode: 'sync',
    total: inputs.length,
    succeeded: inputs.length,
    failed: 0,
    results: inputs.map((input, index) => ({
      index,
      merchantOrderId: input.merchantOrderId,
      success: true,
      order: { provider: 'fake', consignmentId: `B-${input.merchantOrderId}`, status: 'pending', raw: {} },
    })),
  });

  test('already created items are replayed and only new items are sent, with indices restored', async () => {
    const fake = new FakeCourier(['ok'], { bulk: syncBulk });
    const { courier } = guard(fake);
    await courier.createOrder(sampleOrder({ merchantOrderId: 'B2' }));
    const result = await courier.bulkCreate([
      sampleOrder({ merchantOrderId: 'B1' }),
      sampleOrder({ merchantOrderId: 'B2' }),
      sampleOrder({ merchantOrderId: 'B3' }),
    ]);
    assert.deepEqual(
      fake.bulkCalls[0]?.map((input) => input.merchantOrderId),
      ['B1', 'B3'],
    );
    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 3);
    assert.deepEqual(
      result.results.map((item) => [item.index, item.merchantOrderId, item.order?.consignmentId]),
      [
        [0, 'B1', 'B-B1'],
        [1, 'B2', 'C-1'],
        [2, 'B3', 'B-B3'],
      ],
    );
    // A second run sends nothing at all.
    const again = await courier.bulkCreate([sampleOrder({ merchantOrderId: 'B1' }), sampleOrder({ merchantOrderId: 'B3' })]);
    assert.equal(fake.bulkCalls.length, 1);
    assert.equal(again.succeeded, 2);
  });

  test('duplicates within one batch, conflicts and missing ids fail per item', async () => {
    const fake = new FakeCourier(['ok'], { bulk: syncBulk });
    const { courier } = guard(fake);
    await courier.createOrder(sampleOrder({ merchantOrderId: 'USED' }));
    const result = await courier.bulkCreate([
      sampleOrder({ merchantOrderId: 'D1' }),
      sampleOrder({ merchantOrderId: 'D1' }),
      sampleOrder({ merchantOrderId: 'USED', codAmount: 5 }),
      sampleOrder({ merchantOrderId: '' }),
    ]);
    assert.deepEqual(fake.bulkCalls[0]?.map((input) => input.merchantOrderId), ['D1']);
    assert.deepEqual(
      result.results.map((item) => [item.success, item.error?.code]),
      [
        [true, undefined],
        [false, 'IDEMPOTENCY'],
        [false, 'IDEMPOTENCY'],
        [false, 'VALIDATION'],
      ],
    );
    assert.equal(result.failed, 3);
  });

  test('per-item outcomes settle each key: rejected items are released, network failures stay blocked', async () => {
    const fake = new FakeCourier(['ok'], {
      bulk: (inputs) => ({
        provider: 'fake',
        mode: 'sync',
        total: inputs.length,
        succeeded: 0,
        failed: inputs.length,
        results: [
          { index: 0, merchantOrderId: 'R1', success: false, error: { code: 'VALIDATION', message: 'bad phone' } },
          { index: 1, merchantOrderId: 'R2', success: false, error: { code: 'NETWORK', message: 'reset' } },
        ],
      }),
    });
    const { courier } = guard(fake);
    await courier.bulkCreate([sampleOrder({ merchantOrderId: 'R1' }), sampleOrder({ merchantOrderId: 'R2' })]);
    assert.equal(await courier.status('R1'), undefined);
    const r2 = await courier.status('R2');
    assert.equal(r2?.state, 'unknown');
    assert.deepEqual(r2?.state === 'unknown' ? r2.error : undefined, { code: 'NETWORK', message: 'reset' });
  });

  test('async acceptance is stored as submitted and not resent', async () => {
    const fake = new FakeCourier(['ok'], {
      bulk: (inputs) => ({
        provider: 'fake',
        mode: 'async',
        total: inputs.length,
        succeeded: inputs.length,
        failed: 0,
        results: inputs.map((input, index) => ({ index, merchantOrderId: input.merchantOrderId, success: true })),
      }),
    });
    const { courier } = guard(fake);
    const first = await courier.bulkCreate([sampleOrder({ merchantOrderId: 'A1' })]);
    assert.equal(first.mode, 'async');
    assert.equal((await courier.status('A1'))?.state, 'submitted');
    const second = await courier.bulkCreate([sampleOrder({ merchantOrderId: 'A1' })]);
    assert.equal(second.succeeded, 1);
    assert.equal(fake.bulkCalls.length, 1);
    await assert.rejects(courier.createOrder(sampleOrder({ merchantOrderId: 'A1' })), isReason('outcome_unknown'));
    assert.equal(fake.created.length, 0);
  });

  test('a thrown bulk error settles every sent key and is rethrown', async () => {
    const ambiguous = guard(new FakeCourier(['ok'], { bulk: () => timeout() })).courier;
    await assert.rejects(ambiguous.bulkCreate([sampleOrder({ merchantOrderId: 'T1' })]), TimeoutError);
    assert.equal((await ambiguous.status('T1'))?.state, 'unknown');

    const definite = guard(new FakeCourier(['ok'], { bulk: () => new AuthError('denied') })).courier;
    await assert.rejects(definite.bulkCreate([sampleOrder({ merchantOrderId: 'T2' })]), AuthError);
    assert.equal(await definite.status('T2'), undefined);
  });
});

describe('IdempotentCourier with the Steadfast adapter', () => {
  const created = {
    status: 200,
    consignment: { consignment_id: 1424107, invoice: 'INV-1001', tracking_code: '15BAEB8A', cod_amount: 1200, status: 'in_review' },
  };

  test('a timed-out create is recovered through status_by_invoice instead of booking twice', async () => {
    const mock = new MockFetch()
      .on('POST', '/create_order', hang(), json(created))
      .on('GET', '/status_by_invoice/INV-1001', json({ status: 200, delivery_status: 'in_review' }));
    const steadfast = new SteadfastCourier({
      apiKey: 'placeholder-api-key',
      secretKey: 'placeholder-secret-key',
      fetch: mock.fetch,
      timeoutMs: 5,
      ...instant(),
    });
    const courier = withIdempotency(steadfast);
    await assert.rejects(courier.createOrder(sampleOrder()), TimeoutError);
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.merchantOrderId, 'INV-1001');
    assert.equal(order.status, 'pending');
    assert.equal(mock.callsTo('/create_order', 'POST').length, 1);
    assert.equal(mock.callsTo('/status_by_invoice/INV-1001').length, 1);
  });

  test('a network failure followed by a 404 lookup creates the order once', async () => {
    const mock = new MockFetch()
      .on('POST', '/create_order', networkFailure(), json(created))
      .on('GET', '/status_by_invoice/INV-1001', json({ status: 404, message: 'Not found' }));
    const steadfast = new SteadfastCourier({
      apiKey: 'placeholder-api-key',
      secretKey: 'placeholder-secret-key',
      fetch: mock.fetch,
      ...instant(),
    });
    const courier = withIdempotency(steadfast);
    await assert.rejects(courier.createOrder(sampleOrder()), NetworkError);
    const order = await courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, '1424107');
    assert.equal(mock.callsTo('/create_order', 'POST').length, 2);
    await courier.createOrder(sampleOrder());
    assert.equal(mock.callsTo('/create_order', 'POST').length, 2);
  });
});

describe('idempotency helpers', () => {
  test('orderFingerprint is stable for equivalent orders and changes with COD', () => {
    assert.equal(orderFingerprint(sampleOrder()), orderFingerprint(sampleOrder({ recipient: { phone: '8801712345678' } })));
    assert.notEqual(orderFingerprint(sampleOrder()), orderFingerprint(sampleOrder({ codAmount: 1201 })));
    assert.match(orderFingerprint(sampleOrder()), /^[0-9a-f]{32}$/);
  });

  test('isAmbiguousCreateFailure classifies errors', () => {
    assert.equal(isAmbiguousCreateFailure(timeout()), true);
    assert.equal(isAmbiguousCreateFailure(new NetworkError('x')), true);
    assert.equal(isAmbiguousCreateFailure(new ProviderError('x', { status: 500 })), true);
    assert.equal(isAmbiguousCreateFailure(new ProviderError('x')), true);
    assert.equal(isAmbiguousCreateFailure(new ProviderError('x', { status: 409 })), false);
    assert.equal(isAmbiguousCreateFailure(new ValidationError('x')), false);
    assert.equal(isAmbiguousCreateFailure(new RateLimitError('x')), false);
    assert.equal(isAmbiguousCreateFailure(new Error('x')), true);
  });

  test('MemoryIdempotencyStore expires lazily and reports its size', () => {
    const time = clock();
    const store = new MemoryIdempotencyStore({ now: time.now });
    store.set('a', { state: 'pending', at: 0 }, 10);
    store.set('b', { state: 'pending', at: 0 }, 20);
    assert.equal(store.size, 2);
    time.advance(10);
    assert.equal(store.get('a'), undefined);
    assert.equal(store.size, 1);
    store.delete('b');
    assert.equal(store.size, 0);
  });

  test('IdempotencyError serializes its reason and key', () => {
    const error = new IdempotencyError('blocked', { reason: 'conflict', key: 'fake:1', provider: 'fake' });
    assert.equal(error.retryable, false);
    assert.deepEqual(
      { reason: error.toJSON().reason, key: error.toJSON().key, code: error.toJSON().code },
      { reason: 'conflict', key: 'fake:1', code: 'IDEMPOTENCY' },
    );
  });

  test('the entry point exports the idempotency API', () => {
    for (const name of ['withIdempotency', 'IdempotentCourier', 'MemoryIdempotencyStore', 'IdempotencyError', 'orderFingerprint']) {
      assert.ok(name in sdk, `missing export ${name}`);
    }
  });
});
