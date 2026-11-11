import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthError,
  ConfigError,
  ProviderError,
  RateLimitError,
  UnsupportedOperationError,
  ValidationError,
} from '../src/errors.js';
import { SteadfastCourier, type SteadfastConfig } from '../src/providers/steadfast/index.js';
import { STEADFAST_STATUS_MAP, mapSteadfastStatus } from '../src/providers/steadfast/mapping.js';
import { isOrderStatus } from '../src/status.js';
import { MockFetch, instant, json, sampleOrder } from './helpers/mock-fetch.js';

function setup(mock: MockFetch, extra: Partial<SteadfastConfig> = {}): SteadfastCourier {
  return new SteadfastCourier({
    apiKey: 'placeholder-api-key',
    secretKey: 'placeholder-secret-key',
    fetch: mock.fetch,
    ...instant(),
    ...extra,
  });
}

const created = {
  status: 200,
  message: 'Consignment has been created successfully.',
  consignment: {
    consignment_id: 1424107,
    invoice: 'INV-1001',
    tracking_code: '15BAEB8A',
    recipient_name: 'Test Customer',
    recipient_phone: '01712345678',
    recipient_address: 'House 1, Road 2, Dhanmondi, Dhaka',
    cod_amount: 1200,
    status: 'in_review',
    note: null,
    created_at: '2026-03-01T06:00:00.000000Z',
  },
};

describe('Steadfast configuration', () => {
  test('requires both keys', () => {
    assert.throws(() => new SteadfastCourier({ apiKey: '', secretKey: '' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /apiKey, secretKey/);
      return true;
    });
    assert.throws(() => new SteadfastCourier({ apiKey: 'k' } as SteadfastConfig), /secretKey/);
  });

  test('rejects an out-of-range bulk chunk size', () => {
    assert.throws(() => setup(new MockFetch(), { bulkChunkSize: 501 }), ConfigError);
    assert.throws(() => setup(new MockFetch(), { bulkChunkSize: 0 }), ConfigError);
  });

  test('rejects a malformed rate card at construction time', () => {
    assert.throws(() => setup(new MockFetch(), { rateCard: { zones: {} } }), ConfigError);
  });

  test('capabilities reflect whether a rate card is configured', () => {
    assert.equal(setup(new MockFetch()).capabilities.calculateCharge, false);
    assert.equal(setup(new MockFetch(), { rateCard: { zones: { a: 60 } } }).capabilities.calculateCharge, 'rate_card');
    assert.equal(setup(new MockFetch()).capabilities.trackByMerchantOrderId, true);
  });
});

describe('Steadfast orders', () => {
  test('authenticates with Api-Key and Secret-Key headers', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json(created));
    await setup(mock).createOrder(sampleOrder());
    assert.equal(mock.last.url, 'https://portal.packzy.com/api/v1/create_order');
    assert.equal(mock.last.headers['api-key'], 'placeholder-api-key');
    assert.equal(mock.last.headers['secret-key'], 'placeholder-secret-key');
    assert.equal(mock.last.headers.authorization, undefined);
  });

  test('maps the normalized order onto Steadfast field names', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json(created));
    await setup(mock).createOrder(
      sampleOrder({ note: 'Fragile', itemDescription: 'Mug', quantity: 3, recipient: { phone: '8801712345678', secondaryPhone: '01912345678' } }),
    );
    assert.deepEqual(mock.last.body, {
      invoice: 'INV-1001',
      recipient_name: 'Test Customer',
      recipient_phone: '01712345678',
      alternative_phone: '01912345678',
      recipient_address: 'House 1, Road 2, Dhanmondi, Dhaka',
      cod_amount: 1200,
      note: 'Fragile',
      item_description: 'Mug',
      total_lot: 3,
    });
  });

  test('returns a normalized order', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json(created));
    const order = await setup(mock).createOrder(sampleOrder());
    assert.equal(order.provider, 'steadfast');
    assert.equal(order.consignmentId, '1424107');
    assert.equal(order.trackingCode, '15BAEB8A');
    assert.equal(order.merchantOrderId, 'INV-1001');
    assert.equal(order.status, 'pending');
    assert.equal(order.providerStatus, 'in_review');
    assert.equal(order.codAmount, 1200);
    assert.equal(order.createdAt, '2026-03-01T06:00:00.000Z');
  });

  test('invoice ids with unsupported characters are rejected locally', async () => {
    const mock = new MockFetch();
    await assert.rejects(setup(mock).createOrder(sampleOrder({ merchantOrderId: 'INV 10/01' })), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues[0]?.field, 'merchantOrderId');
      return true;
    });
    assert.equal(mock.calls.length, 0);
  });

  test('an error status inside an HTTP 200 body becomes a typed error', async () => {
    const mock = new MockFetch().on(
      'POST',
      '/create_order',
      json({ status: 400, errors: { invoice: ['The invoice has already been taken.'] } }),
    );
    await assert.rejects(setup(mock).createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.status, 400);
      assert.equal(error.issues[0]?.field, 'invoice');
      assert.match(error.message, /already been taken/);
      return true;
    });
  });

  test('HTTP 401 is an AuthError that never contains the keys', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json({ message: 'Unauthorized: key placeholder-api-key' }, 401));
    await assert.rejects(setup(mock).createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.ok(!`${error.message}${JSON.stringify(error)}`.includes('placeholder-api-key'));
      return true;
    });
  });

  test('429 is retried, then surfaces as RateLimitError', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json({ message: 'Too many requests' }, 429));
    await assert.rejects(setup(mock, { retry: { retries: 2 } }).createOrder(sampleOrder()), RateLimitError);
    assert.equal(mock.calls.length, 3);
  });

  test('a body without a consignment is a ProviderError', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json({ status: 200, message: 'ok' }));
    await assert.rejects(setup(mock).createOrder(sampleOrder()), ProviderError);
  });

  test('cancelOrder is unsupported', async () => {
    await assert.rejects(setup(new MockFetch()).cancelOrder('1'), UnsupportedOperationError);
  });
});

describe('Steadfast bulk create', () => {
  const bulkResponse = [
    { invoice: 'B2', recipient_name: 'x', consignment_id: 502, tracking_code: 'TC502', status: 'success' },
    { invoice: 'B1', recipient_name: 'x', consignment_id: 501, tracking_code: 'TC501', status: 'success' },
    { invoice: 'B4', recipient_name: 'x', consignment_id: null, tracking_code: null, status: 'error' },
  ];

  test('matches results to inputs by invoice and reports per-item outcomes', async () => {
    const mock = new MockFetch().on('POST', '/create_order/bulk-order', json(bulkResponse));
    const result = await setup(mock).bulkCreate([
      sampleOrder({ merchantOrderId: 'B1' }),
      sampleOrder({ merchantOrderId: 'B2' }),
      sampleOrder({ merchantOrderId: 'B3', recipient: { phone: '12345' } }),
      sampleOrder({ merchantOrderId: 'B4' }),
    ]);
    assert.equal(result.mode, 'sync');
    assert.deepEqual([result.total, result.succeeded, result.failed], [4, 2, 2]);
    assert.equal(result.results[0]?.order?.consignmentId, '501');
    assert.equal(result.results[1]?.order?.consignmentId, '502');
    assert.equal(result.results[1]?.order?.status, 'pending');
    assert.equal(result.results[2]?.error?.code, 'VALIDATION');
    assert.equal(result.results[3]?.error?.code, 'PROVIDER');
    const sent = (mock.last.body as { data: Array<{ invoice: string }> }).data;
    assert.deepEqual(sent.map((item) => item.invoice), ['B1', 'B2', 'B4']);
  });

  test('splits large batches into chunks', async () => {
    const mock = new MockFetch().on('POST', '/create_order/bulk-order', (call) => {
      const items = (call.body as { data: Array<{ invoice: string }> }).data;
      return json(items.map((item, i) => ({ invoice: item.invoice, consignment_id: `${item.invoice}-${i}`, status: 'success' })))(call);
    });
    const inputs = Array.from({ length: 5 }, (_, i) => sampleOrder({ merchantOrderId: `C${i}` }));
    const result = await setup(mock, { bulkChunkSize: 2 }).bulkCreate(inputs);
    assert.equal(mock.calls.length, 3);
    assert.deepEqual(mock.calls.map((call) => (call.body as { data: unknown[] }).data.length), [2, 2, 1]);
    assert.equal(result.succeeded, 5);
  });

  test('a failed chunk only fails its own items', async () => {
    const ok = [{ invoice: 'D0', consignment_id: 1, status: 'success' }];
    const mock = new MockFetch().on('POST', '/create_order/bulk-order', json(ok), json({ message: 'boom' }, 500));
    const result = await setup(mock, { bulkChunkSize: 1 }).bulkCreate([
      sampleOrder({ merchantOrderId: 'D0' }),
      sampleOrder({ merchantOrderId: 'D1' }),
    ]);
    assert.equal(result.results[0]?.success, true);
    assert.equal(result.results[1]?.success, false);
    assert.equal(result.results[1]?.error?.code, 'PROVIDER');
  });

  test('an item missing from the response is reported as failed', async () => {
    const mock = new MockFetch().on('POST', '/create_order/bulk-order', json([{ invoice: 'E0', consignment_id: 9, status: 'success' }]));
    const result = await setup(mock).bulkCreate([sampleOrder({ merchantOrderId: 'E0' }), sampleOrder({ merchantOrderId: 'E1' })]);
    assert.equal(result.succeeded, 1);
    assert.match(result.results[1]?.error?.message ?? '', /did not return a result/);
  });

  test('an auth failure aborts the whole batch', async () => {
    const mock = new MockFetch().on('POST', '/create_order/bulk-order', json({ message: 'Unauthorized' }, 401));
    await assert.rejects(setup(mock).bulkCreate([sampleOrder()]), AuthError);
  });
});

describe('Steadfast tracking and balance', () => {
  test('tracks by consignment id, invoice and tracking code', async () => {
    const mock = new MockFetch()
      .on('GET', '/status_by_cid/1424107', json({ status: 200, delivery_status: 'delivered' }))
      .on('GET', '/status_by_invoice/INV-1001', json({ status: 200, delivery_status: 'partial_delivered_approval_pending' }))
      .on('GET', '/status_by_trackingcode/15BAEB8A', json({ status: 200, delivery_status: 'hold' }));
    const courier = setup(mock);
    const byId = await courier.trackOrder('1424107');
    assert.equal(byId.status, 'delivered');
    assert.equal(byId.consignmentId, '1424107');
    const byInvoice = await courier.trackOrder({ merchantOrderId: 'INV-1001' });
    assert.equal(byInvoice.status, 'partial_delivered');
    assert.equal(byInvoice.merchantOrderId, 'INV-1001');
    const byCode = await courier.trackOrder({ trackingCode: '15BAEB8A' });
    assert.equal(byCode.status, 'on_hold');
    assert.equal(byCode.providerStatus, 'hold');
  });

  test('status lookups are retried on 5xx', async () => {
    const mock = new MockFetch().on('GET', /status_by_cid/, json({}, 502), json({ status: 200, delivery_status: 'pending' }));
    assert.equal((await setup(mock).trackOrder('7')).status, 'pending');
    assert.equal(mock.calls.length, 2);
  });

  test('an embedded 404 is a ProviderError', async () => {
    const mock = new MockFetch().on('GET', /status_by_cid/, json({ status: 404, message: 'Consignment not found' }));
    await assert.rejects(setup(mock).trackOrder('7'), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 404);
      return true;
    });
  });

  test('statusOverrides extend the table', async () => {
    const mock = new MockFetch().on('GET', /status_by_cid/, json({ status: 200, delivery_status: 'in_hub' }));
    assert.equal((await setup(mock).trackOrder('7')).status, 'unknown');
    assert.equal((await setup(mock, { statusOverrides: { in_hub: 'in_transit' } }).trackOrder('7')).status, 'in_transit');
  });

  test('getBalance returns the current balance', async () => {
    const mock = new MockFetch().on('GET', '/get_balance', json({ status: 200, current_balance: '1520.50' }));
    assert.equal(await setup(mock).getBalance(), 1520.5);
  });
});

describe('Steadfast charge estimate', () => {
  test('is unsupported without a rate card', async () => {
    await assert.rejects(setup(new MockFetch()).calculateCharge({ weightKg: 1 }), UnsupportedOperationError);
  });

  test('uses the configured rate card without touching the network', async () => {
    const mock = new MockFetch();
    const courier = setup(mock, { rateCard: { zones: { inside: 60, outside: 110 }, defaultZone: 'inside', extraPerKg: 15, codPercent: 1 } });
    const charge = await courier.calculateCharge({ weightKg: 3, codAmount: 1000, rateZone: 'outside' });
    assert.equal(charge.deliveryCharge, 140);
    assert.equal(charge.codCharge, 10);
    assert.equal(charge.total, 150);
    assert.equal(charge.estimated, true);
    assert.equal(mock.calls.length, 0);
  });
});

describe('Steadfast status table', () => {
  test('every entry maps to a normalized status', () => {
    for (const [raw, status] of Object.entries(STEADFAST_STATUS_MAP)) assert.ok(isOrderStatus(status), raw);
  });
  const expectations: Array<[string, string]> = [
    ['pending', 'pending'],
    ['in_review', 'pending'],
    ['delivered_approval_pending', 'delivered'],
    ['partial_delivered_approval_pending', 'partial_delivered'],
    ['cancelled_approval_pending', 'cancelled'],
    ['delivered', 'delivered'],
    ['partial_delivered', 'partial_delivered'],
    ['cancelled', 'cancelled'],
    ['hold', 'on_hold'],
    ['unknown', 'unknown'],
  ];
  for (const [raw, expected] of expectations) {
    test(`"${raw}" -> ${expected}`, () => {
      assert.equal(mapSteadfastStatus(raw), expected);
    });
  }
});
