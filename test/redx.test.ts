import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuthError, ConfigError, ProviderError, UnsupportedOperationError, ValidationError } from '../src/errors.js';
import { RedxCourier, type RedxConfig } from '../src/providers/redx/index.js';
import { REDX_STATUS_MAP, mapRedxStatus, statusFromMessage } from '../src/providers/redx/mapping.js';
import { isOrderStatus } from '../src/status.js';
import { MockFetch, instant, json, sampleOrder } from './helpers/mock-fetch.js';

function setup(mock: MockFetch, extra: Partial<RedxConfig> = {}): RedxCourier {
  return new RedxCourier({ accessToken: 'placeholder-redx-token', fetch: mock.fetch, ...instant(), ...extra });
}

const tracking = {
  tracking: [
    { message_en: 'Parcel is out for delivery', message_bn: 'পার্সেল ডেলিভারির জন্য বের হয়েছে', time: '2026-03-03T09:00:00.000Z' },
    { message_en: 'Package is created successfully', message_bn: 'প্যাকেজ তৈরি হয়েছে', time: '2026-03-01T09:00:00.000Z' },
    { message_en: 'Package has been picked up', message_bn: 'প্যাকেজ পিক আপ হয়েছে', time: '2026-03-02T09:00:00.000Z' },
  ],
};
const info = {
  parcel: {
    tracking_id: '21A427TU4BN3R',
    merchant_invoice_id: 'INV-1001',
    status: 'delivery-in-progress',
    cash_collection_amount: 1200,
    charge: 60,
    created_at: '2026-03-01T09:00:00.000Z',
  },
};

describe('RedX configuration', () => {
  test('requires an access token', () => {
    assert.throws(() => new RedxCourier({ accessToken: '  ' }), ConfigError);
  });

  test('sends the token in API-ACCESS-TOKEN with a single Bearer prefix', async () => {
    for (const accessToken of ['placeholder-redx-token', 'Bearer placeholder-redx-token']) {
      const mock = new MockFetch().on('GET', '/areas', json({ areas: [] }));
      await setup(mock, { accessToken }).listAreas();
      assert.equal(mock.last.headers['api-access-token'], 'Bearer placeholder-redx-token');
    }
  });

  test('switches host for the sandbox', async () => {
    const mock = new MockFetch().on('GET', '/areas', json({ areas: [] }));
    await setup(mock, { sandbox: true }).listAreas();
    assert.ok(mock.last.url.startsWith('https://sandbox.redx.com.bd/v1.0.0-beta/areas'));
    const prod = new MockFetch().on('GET', '/areas', json({ areas: [] }));
    await setup(prod).listAreas();
    assert.ok(prod.last.url.startsWith('https://openapi.redx.com.bd/v1.0.0-beta/areas'));
  });

  test('rejects an invalid bulk concurrency', () => {
    assert.throws(() => setup(new MockFetch(), { bulkConcurrency: 0 }), ConfigError);
  });
});

describe('RedX orders', () => {
  test('maps the normalized order onto RedX field names, with weight in grams', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ tracking_id: '21A427TU4BN3R' }, 201));
    await setup(mock, { pickupStoreId: '9' }).createOrder(
      sampleOrder({ weightKg: 1.25, note: 'Leave at gate', itemDescription: 'Headphones', declaredValue: 1500 }),
    );
    assert.deepEqual(mock.last.body, {
      customer_name: 'Test Customer',
      customer_phone: '01712345678',
      delivery_area: 'Dhanmondi',
      delivery_area_id: 100,
      customer_address: 'House 1, Road 2, Dhanmondi, Dhaka',
      merchant_invoice_id: 'INV-1001',
      cash_collection_amount: 1200,
      parcel_weight: 1250,
      instruction: 'Leave at gate',
      value: 1500,
      pickup_store_id: 9,
      parcel_details_json: [{ name: 'Headphones', category: 'parcel', value: 1500 }],
    });
  });

  test('returns a normalized order', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ tracking_id: '21A427TU4BN3R' }, 201));
    const order = await setup(mock).createOrder(sampleOrder());
    assert.deepEqual(
      { ...order, raw: undefined },
      {
        provider: 'redx',
        consignmentId: '21A427TU4BN3R',
        trackingCode: '21A427TU4BN3R',
        merchantOrderId: 'INV-1001',
        status: 'pending',
        codAmount: 1200,
        raw: undefined,
      },
    );
  });

  test('requires the delivery area id and name', async () => {
    const mock = new MockFetch();
    await assert.rejects(
      setup(mock).createOrder(sampleOrder({ recipient: { areaId: undefined, areaName: undefined } })),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.deepEqual(error.issues.map((issue) => issue.field), ['recipient.areaId', 'recipient.areaName']);
        return true;
      },
    );
    assert.equal(mock.calls.length, 0);
  });

  test('accepts parcels up to 25 kg and rejects heavier ones', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ tracking_id: 'T1' }));
    await setup(mock).createOrder(sampleOrder({ weightKg: 25 }));
    await assert.rejects(setup(mock).createOrder(sampleOrder({ weightKg: 25.1 })), ValidationError);
  });

  test('a response without tracking_id is a ProviderError', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ message: 'ok' }));
    await assert.rejects(setup(mock).createOrder(sampleOrder()), ProviderError);
  });

  test('401 is an AuthError that never contains the token', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ message: 'Invalid token Bearer placeholder-redx-token' }, 401));
    await assert.rejects(setup(mock).createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.ok(!`${error.message}${JSON.stringify(error)}`.includes('placeholder-redx-token'));
      return true;
    });
  });
});

describe('RedX bulk create (emulated)', () => {
  test('creates parcels one by one and keeps input order', async () => {
    let counter = 0;
    const mock = new MockFetch().on('POST', '/parcel', (call) => {
      const invoice = (call.body as { merchant_invoice_id: string }).merchant_invoice_id;
      counter += 1;
      return invoice === 'R2' ? json({ message: 'Area not serviceable' }, 400)(call) : json({ tracking_id: `TRK-${invoice}` })(call);
    });
    const result = await setup(mock).bulkCreate([
      sampleOrder({ merchantOrderId: 'R1' }),
      sampleOrder({ merchantOrderId: 'R2' }),
      sampleOrder({ merchantOrderId: 'R3', codAmount: -1 }),
      sampleOrder({ merchantOrderId: 'R4' }),
    ]);
    assert.equal(counter, 3);
    assert.equal(result.mode, 'sync');
    assert.deepEqual([result.total, result.succeeded, result.failed], [4, 2, 2]);
    assert.equal(result.results[0]?.order?.consignmentId, 'TRK-R1');
    assert.equal(result.results[1]?.error?.code, 'VALIDATION');
    assert.equal(result.results[2]?.error?.code, 'VALIDATION');
    assert.equal(result.results[3]?.order?.consignmentId, 'TRK-R4');
    assert.deepEqual(result.results.map((item) => item.merchantOrderId), ['R1', 'R2', 'R3', 'R4']);
  });

  test('respects the configured concurrency', async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockFetch().on('POST', '/parcel', async (call) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({ tracking_id: 'T' })(call);
    });
    const inputs = Array.from({ length: 6 }, (_, i) => sampleOrder({ merchantOrderId: `P${i}` }));
    await setup(mock, { bulkConcurrency: 2 }).bulkCreate(inputs);
    assert.equal(peak, 2);
  });

  test('throws when every item fails with an auth error', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ message: 'Unauthorized' }, 401));
    await assert.rejects(setup(mock).bulkCreate([sampleOrder(), sampleOrder({ merchantOrderId: 'X2' })]), AuthError);
  });
});

describe('RedX tracking', () => {
  test('combines parcel info with the tracking history, oldest first', async () => {
    const mock = new MockFetch()
      .on('GET', '/parcel/track/21A427TU4BN3R', json(tracking))
      .on('GET', '/parcel/info/21A427TU4BN3R', json(info));
    const result = await setup(mock).trackOrder('21A427TU4BN3R');
    assert.equal(result.status, 'out_for_delivery');
    assert.equal(result.providerStatus, 'delivery-in-progress');
    assert.equal(result.merchantOrderId, 'INV-1001');
    assert.deepEqual(result.events.map((event) => event.status), ['pending', 'picked_up', 'out_for_delivery']);
    assert.equal(result.events[0]?.messageBn, 'প্যাকেজ তৈরি হয়েছে');
    assert.equal(result.updatedAt, '2026-03-03T09:00:00.000Z');
  });

  test('falls back to the latest tracking message when parcel info is unavailable', async () => {
    const mock = new MockFetch()
      .on('GET', /\/parcel\/track\//, json(tracking))
      .on('GET', /\/parcel\/info\//, json({ message: 'Not found' }, 404));
    const result = await setup(mock).trackOrder({ trackingCode: 'ABC' });
    assert.equal(result.status, 'out_for_delivery');
    assert.equal(result.providerStatus, undefined);
    assert.equal(result.consignmentId, 'ABC');
  });

  test('an auth failure on parcel info is not swallowed', async () => {
    const mock = new MockFetch()
      .on('GET', /\/parcel\/track\//, json(tracking))
      .on('GET', /\/parcel\/info\//, json({ message: 'Unauthorized' }, 401));
    await assert.rejects(setup(mock).trackOrder('ABC'), AuthError);
  });

  test('a failed tracking lookup rejects', async () => {
    const mock = new MockFetch()
      .on('GET', /\/parcel\/track\//, json({ message: 'Parcel not found' }, 404))
      .on('GET', /\/parcel\/info\//, json(info));
    await assert.rejects(setup(mock, { retry: { retries: 0 } }).trackOrder('ABC'), ProviderError);
  });

  test('tracking by merchant order id is unsupported', async () => {
    await assert.rejects(setup(new MockFetch()).trackOrder({ merchantOrderId: 'INV-1' }), UnsupportedOperationError);
  });

  test('getParcelInfo normalizes the parcel', async () => {
    const mock = new MockFetch().on('GET', '/parcel/info/21A427TU4BN3R', json(info));
    const parcel = await setup(mock).getParcelInfo('21A427TU4BN3R');
    assert.equal(parcel.status, 'out_for_delivery');
    assert.equal(parcel.codAmount, 1200);
    assert.equal(parcel.charge, 60);
  });
});

describe('RedX cancel, charge and areas', () => {
  test('cancelOrder sends the status update and reports the outcome', async () => {
    const mock = new MockFetch().on('PATCH', '/parcels', json({ success: true, message: 'Parcel cancelled' }));
    const result = await setup(mock).cancelOrder('21A427TU4BN3R', ' Customer changed mind ');
    assert.deepEqual(mock.last.body, {
      entity_type: 'parcel-tracking-id',
      entity_id: '21A427TU4BN3R',
      update_details: { property_name: 'status', new_value: 'cancelled', reason: 'Customer changed mind' },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.message, 'Parcel cancelled');
    assert.equal(result.provider, 'redx');
  });

  test('cancelOrder reports cancelled: false when RedX declines', async () => {
    const mock = new MockFetch().on('PATCH', '/parcels', json({ success: false, message: 'Parcel already picked up' }));
    const result = await setup(mock).cancelOrder('T1');
    assert.equal(result.cancelled, false);
    assert.equal(result.message, 'Parcel already picked up');
  });

  test('cancelOrder requires a tracking id', async () => {
    await assert.rejects(setup(new MockFetch()).cancelOrder(''), ValidationError);
  });

  test('calculateCharge queries the calculator with grams', async () => {
    const mock = new MockFetch().on('GET', '/charge/charge_calculator', json({ deliveryCharge: 60, codCharge: 12 }));
    const charge = await setup(mock, { pickupAreaId: 1 }).calculateCharge({ weightKg: 0.5, codAmount: 1200, areaId: 100 });
    assert.equal(mock.last.query.get('delivery_area_id'), '100');
    assert.equal(mock.last.query.get('pickup_area_id'), '1');
    assert.equal(mock.last.query.get('cash_collection_amount'), '1200');
    assert.equal(mock.last.query.get('weight'), '500');
    assert.deepEqual({ ...charge, raw: undefined }, {
      provider: 'redx',
      deliveryCharge: 60,
      codCharge: 12,
      discount: 0,
      total: 72,
      currency: 'BDT',
      estimated: false,
      raw: undefined,
    });
  });

  test('calculateCharge needs delivery and pickup areas', async () => {
    await assert.rejects(setup(new MockFetch()).calculateCharge({ weightKg: 1 }), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(error.issues.map((issue) => issue.field), ['areaId', 'pickupAreaId']);
      return true;
    });
  });

  test('listAreas passes filters and normalizes the result', async () => {
    const mock = new MockFetch().on(
      'GET',
      '/areas',
      json({ areas: [{ id: 1, name: 'Mohammadpur (Dhaka)', post_code: 1207, division_name: 'Dhaka', zone_id: 1 }, { name: 'no id' }] }),
    );
    const areas = await setup(mock).listAreas({ postCode: '1207', districtName: 'Dhaka' });
    assert.equal(mock.last.query.get('post_code'), '1207');
    assert.equal(mock.last.query.get('district_name'), 'Dhaka');
    assert.equal(mock.last.query.has('zone_id'), false);
    assert.deepEqual(areas, [{ id: 1, name: 'Mohammadpur (Dhaka)', zoneId: 1, postCode: '1207', districtName: 'Dhaka' }]);
  });

  test('listCities and listZones are unsupported', async () => {
    const courier = setup(new MockFetch());
    await assert.rejects(courier.listCities(), UnsupportedOperationError);
    await assert.rejects(courier.listZones(1), UnsupportedOperationError);
  });

  test('listPickupStores normalizes stores', async () => {
    const mock = new MockFetch().on(
      'GET',
      '/pickup/stores',
      json({ pickup_stores: [{ id: 9, name: 'Main Store', address: 'Banani', area_name: 'Banani', area_id: 3, phone: '01712345678' }] }),
    );
    assert.deepEqual(await setup(mock).listPickupStores(), [
      { id: 9, name: 'Main Store', address: 'Banani', areaId: 3, areaName: 'Banani', phone: '01712345678' },
    ]);
  });
});

describe('RedX status mapping', () => {
  test('every entry maps to a normalized status', () => {
    for (const [raw, status] of Object.entries(REDX_STATUS_MAP)) assert.ok(isOrderStatus(status), raw);
  });
  const expectations: Array<[string, string]> = [
    ['pickup-pending', 'pending'],
    ['picked-up', 'picked_up'],
    ['received-at-hub', 'in_transit'],
    ['ready-for-delivery', 'in_transit'],
    ['delivery-in-progress', 'out_for_delivery'],
    ['delivered', 'delivered'],
    ['partial-delivered', 'partial_delivered'],
    ['agent-hold', 'on_hold'],
    ['agent-returning', 'returned'],
    ['returned', 'returned'],
    ['cancelled', 'cancelled'],
    ['mystery', 'unknown'],
  ];
  for (const [raw, expected] of expectations) {
    test(`"${raw}" -> ${expected}`, () => {
      assert.equal(mapRedxStatus(raw), expected);
    });
  }

  test('statusFromMessage reads free-text tracking messages', () => {
    assert.equal(statusFromMessage('Parcel delivered successfully'), 'delivered');
    assert.equal(statusFromMessage('Parcel could not be delivered, customer unreachable'), 'on_hold');
    assert.equal(statusFromMessage('Parcel is being returned to merchant'), 'returned');
    assert.equal(statusFromMessage('Parcel received at Dhaka hub'), 'in_transit');
    assert.equal(statusFromMessage('Parcel has been cancelled'), 'cancelled');
    assert.equal(statusFromMessage('???'), 'unknown');
    assert.equal(statusFromMessage(undefined), 'unknown');
  });
});
