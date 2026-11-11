import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AuthError,
  ConfigError,
  ProviderError,
  UnsupportedOperationError,
  ValidationError,
} from '../src/errors.js';
import type { LogEntry } from '../src/http.js';
import { PathaoCourier, type PathaoConfig, type PathaoToken } from '../src/providers/pathao/index.js';
import { PATHAO_STATUS_MAP, mapPathaoStatus } from '../src/providers/pathao/mapping.js';
import { isOrderStatus } from '../src/status.js';
import { MockFetch, instant, json, networkFailure, sampleOrder } from './helpers/mock-fetch.js';

const TOKEN_PATH = '/aladdin/api/v1/issue-token';
const ORDERS_PATH = '/aladdin/api/v1/orders';

function tokenBody(n = 1, expiresIn = 3600): Record<string, unknown> {
  return { token_type: 'Bearer', expires_in: expiresIn, access_token: `access-token-${n}`, refresh_token: `refresh-token-${n}` };
}

const orderBody = {
  message: 'Order Created Successfully',
  type: 'success',
  code: 200,
  data: { consignment_id: 'DT0101TEST', merchant_order_id: 'INV-1001', order_status: 'Pending', delivery_fee: 80 },
};

function setup(mock: MockFetch, extra: Partial<PathaoConfig> = {}): { courier: PathaoCourier; clock: { now: number } } {
  const clock = { now: 1_800_000_000_000 };
  const courier = new PathaoCourier({
    clientId: 'placeholder-client-id',
    clientSecret: 'placeholder-client-secret',
    username: 'merchant@example.com',
    password: 'placeholder-password',
    storeId: 55,
    fetch: mock.fetch,
    now: () => clock.now,
    ...instant(),
    ...extra,
  });
  return { courier, clock };
}

describe('Pathao configuration', () => {
  test('lists every missing credential', () => {
    assert.throws(
      () => new PathaoCourier({ clientId: 'x', clientSecret: '', username: ' ', password: 'y' } as PathaoConfig),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /clientSecret, username/);
        return true;
      },
    );
  });

  test('uses the production host by default and the sandbox host on request', async () => {
    const prod = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    await setup(prod).courier.listCities();
    assert.ok(prod.last.url.startsWith('https://api-hermes.pathao.com/'));

    const sandbox = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    await setup(sandbox, { sandbox: true }).courier.listCities();
    assert.ok(sandbox.last.url.startsWith('https://courier-api-sandbox.pathao.com/'));
  });

  test('baseUrl override wins', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    await setup(mock, { baseUrl: 'https://proxy.example/pathao' }).courier.listCities();
    assert.equal(mock.last.url, 'https://proxy.example/pathao/aladdin/api/v1/city-list');
  });

  test('declares its capabilities', () => {
    const { courier } = setup(new MockFetch());
    assert.equal(courier.provider, 'pathao');
    assert.equal(courier.capabilities.cancelOrder, false);
    assert.equal(courier.capabilities.bulkCreate, 'native');
    assert.equal(courier.capabilities.calculateCharge, 'api');
  });
});

describe('Pathao authentication', () => {
  test('issues a token with the password grant and sends it as a bearer header', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    await setup(mock).courier.createOrder(sampleOrder());
    const tokenCall = mock.callsTo(TOKEN_PATH)[0];
    assert.deepEqual(tokenCall?.body, {
      client_id: 'placeholder-client-id',
      client_secret: 'placeholder-client-secret',
      grant_type: 'password',
      username: 'merchant@example.com',
      password: 'placeholder-password',
    });
    assert.equal(mock.last.headers.authorization, 'Bearer access-token-1');
  });

  test('caches the token across calls', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    const { courier } = setup(mock);
    await courier.createOrder(sampleOrder());
    await courier.createOrder(sampleOrder({ merchantOrderId: 'INV-1002' }));
    assert.equal(mock.callsTo(TOKEN_PATH).length, 1);
  });

  test('concurrent calls share one token request', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    const { courier } = setup(mock);
    await Promise.all([courier.listCities(), courier.listCities(), courier.listCities()]);
    assert.equal(mock.callsTo(TOKEN_PATH).length, 1);
    assert.equal(mock.callsTo('/city-list').length, 3);
  });

  test('refreshes with the refresh token once the access token nears expiry', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody(1, 3600)), json(tokenBody(2, 3600)))
      .on('GET', '/city-list', json({ data: { data: [] } }));
    const { courier, clock } = setup(mock);
    await courier.listCities();
    clock.now += 3_550_000; // inside the 60 s safety margin
    await courier.listCities();
    const tokenCalls = mock.callsTo(TOKEN_PATH);
    assert.equal(tokenCalls.length, 2);
    assert.deepEqual(tokenCalls[1]?.body, {
      client_id: 'placeholder-client-id',
      client_secret: 'placeholder-client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token-1',
    });
    assert.equal(mock.last.headers.authorization, 'Bearer access-token-2');
  });

  test('a token is still reused just before the safety margin', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    const { courier, clock } = setup(mock);
    await courier.listCities();
    clock.now += 3_500_000;
    await courier.listCities();
    assert.equal(mock.callsTo(TOKEN_PATH).length, 1);
  });

  test('falls back to the password grant when the refresh token is rejected', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody(1)), json({ error: 'invalid_request' }, 401), json(tokenBody(3)))
      .on('GET', '/city-list', json({ data: { data: [] } }));
    const { courier, clock } = setup(mock);
    await courier.listCities();
    clock.now += 4_000_000;
    await courier.listCities();
    const grants = mock.callsTo(TOKEN_PATH).map((call) => (call.body as { grant_type: string }).grant_type);
    assert.deepEqual(grants, ['password', 'refresh_token', 'password']);
    assert.equal(mock.last.headers.authorization, 'Bearer access-token-3');
  });

  test('a network failure during refresh is not masked by a password retry', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody(1)), networkFailure())
      .on('GET', '/city-list', json({ data: { data: [] } }));
    const { courier, clock } = setup(mock, { retry: { retries: 0 } });
    await courier.listCities();
    clock.now += 4_000_000;
    await assert.rejects(courier.listCities(), /network error/);
    assert.equal(mock.callsTo(TOKEN_PATH).length, 2);
  });

  test('replays the request once with a new token after an API 401', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody(1)), json(tokenBody(2)))
      .on('POST', ORDERS_PATH, json({ message: 'Unauthenticated.' }, 401), json(orderBody));
    const order = await setup(mock).courier.createOrder(sampleOrder());
    assert.equal(order.consignmentId, 'DT0101TEST');
    const orderCalls = mock.callsTo(ORDERS_PATH);
    assert.equal(orderCalls.length, 2);
    assert.equal(orderCalls[0]?.headers.authorization, 'Bearer access-token-1');
    assert.equal(orderCalls[1]?.headers.authorization, 'Bearer access-token-2');
  });

  test('a second 401 is surfaced instead of looping', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody(1)), json(tokenBody(2)))
      .on('POST', ORDERS_PATH, json({ message: 'Unauthenticated.' }, 401));
    await assert.rejects(setup(mock).courier.createOrder(sampleOrder()), AuthError);
    assert.equal(mock.callsTo(ORDERS_PATH).length, 2);
  });

  test('bad credentials (HTTP 400 from the token endpoint) become AuthError without a second attempt', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json({ error: 'invalid_grant', message: 'Wrong credentials' }, 400));
    await assert.rejects(setup(mock).courier.listCities(), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(mock.calls.length, 1);
  });

  test('a token response without access_token is an AuthError', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json({ message: 'ok' }));
    await assert.rejects(setup(mock).courier.listCities(), /did not contain an access token/);
  });

  test('the token request is retried on a transient 500', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json({}, 500), json(tokenBody()))
      .on('GET', '/city-list', json({ data: { data: [] } }));
    await setup(mock).courier.listCities();
    assert.equal(mock.callsTo(TOKEN_PATH).length, 2);
  });

  test('loads a fresh token from the store and skips the token endpoint', async () => {
    const mock = new MockFetch().on('GET', '/city-list', json({ data: { data: [] } }));
    const tokenStore = {
      load: (): PathaoToken => ({ accessToken: 'stored-access-token', refreshToken: 'stored-refresh', expiresAt: 1_800_000_000_000 + 600_000 }),
      save: (): void => undefined,
    };
    await setup(mock, { tokenStore }).courier.listCities();
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.last.headers.authorization, 'Bearer stored-access-token');
  });

  test('an expired stored token is refreshed and the new one saved', async () => {
    const saved: PathaoToken[] = [];
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody(7))).on('GET', '/city-list', json({ data: { data: [] } }));
    const tokenStore = {
      load: async (): Promise<PathaoToken> => ({ accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: 1 }),
      save: async (token: PathaoToken): Promise<void> => {
        saved.push(token);
      },
    };
    await setup(mock, { tokenStore }).courier.listCities();
    assert.equal((mock.callsTo(TOKEN_PATH)[0]?.body as { refresh_token: string }).refresh_token, 'old-refresh-token');
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.accessToken, 'access-token-7');
    assert.equal(saved[0]?.expiresAt, 1_800_000_000_000 + 3_600_000);
  });

  test('a broken token store does not block authentication', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', '/city-list', json({ data: { data: [] } }));
    const tokenStore = {
      load: (): never => {
        throw new Error('disk unavailable');
      },
      save: (): never => {
        throw new Error('disk unavailable');
      },
    };
    await setup(mock, { tokenStore }).courier.listCities();
    assert.equal(mock.last.headers.authorization, 'Bearer access-token-1');
  });

  test('credentials and tokens never appear in errors or logs', async () => {
    const entries: LogEntry[] = [];
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on(
        'POST',
        ORDERS_PATH,
        json({ message: 'token access-token-1 lacks scope; secret placeholder-client-secret; pw placeholder-password' }, 403),
      );
    const { courier } = setup(mock, { logger: (entry) => entries.push(entry) });
    await assert.rejects(courier.createOrder(sampleOrder()), (error: unknown) => {
      const dump = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(entries)}`;
      for (const secret of ['access-token-1', 'placeholder-client-secret', 'placeholder-password', 'refresh-token-1']) {
        assert.ok(!dump.includes(secret), `leaked ${secret}`);
      }
      return true;
    });
  });
});

describe('Pathao orders', () => {
  test('maps the normalized order onto Pathao field names', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    await setup(mock).courier.createOrder(
      sampleOrder({
        note: 'Call first',
        itemDescription: 'Cotton shirt',
        quantity: 2,
        deliveryType: 'express',
        itemType: 'document',
        recipient: { phone: '+8801712345678', secondaryPhone: '01812345678' },
      }),
    );
    assert.deepEqual(mock.last.body, {
      store_id: 55,
      merchant_order_id: 'INV-1001',
      recipient_name: 'Test Customer',
      recipient_phone: '01712345678',
      recipient_secondary_phone: '01812345678',
      recipient_address: 'House 1, Road 2, Dhanmondi, Dhaka',
      recipient_city: 1,
      recipient_zone: 10,
      recipient_area: 100,
      delivery_type: 12,
      item_type: 1,
      special_instruction: 'Call first',
      item_quantity: 2,
      item_weight: 1,
      item_description: 'Cotton shirt',
      amount_to_collect: 1200,
    });
  });

  test('returns a normalized order', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    const order = await setup(mock).courier.createOrder(sampleOrder());
    assert.equal(order.provider, 'pathao');
    assert.equal(order.consignmentId, 'DT0101TEST');
    assert.equal(order.merchantOrderId, 'INV-1001');
    assert.equal(order.status, 'pending');
    assert.equal(order.providerStatus, 'Pending');
    assert.equal(order.deliveryFee, 80);
    assert.equal(order.codAmount, 1200);
    assert.deepEqual(order.raw, orderBody);
  });

  test('optional location ids are omitted rather than sent as null', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    await setup(mock).courier.createOrder(sampleOrder({ recipient: { cityId: undefined, zoneId: undefined, areaId: undefined } }));
    const body = mock.last.body as Record<string, unknown>;
    assert.ok(!('recipient_city' in body));
    assert.ok(!('recipient_zone' in body));
    assert.ok(!('recipient_area' in body));
  });

  test('per-order storeId and extra fields override the defaults', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json(orderBody));
    await setup(mock).courier.createOrder(sampleOrder({ storeId: '77', extra: { item_type: 3, custom_flag: true } }));
    const body = mock.last.body as Record<string, unknown>;
    assert.equal(body.store_id, 77);
    assert.equal(body.item_type, 3);
    assert.equal(body.custom_flag, true);
  });

  test('validation failures never reach the network', async () => {
    const mock = new MockFetch();
    await assert.rejects(setup(mock).courier.createOrder(sampleOrder({ codAmount: 99.5, weightKg: 11 })), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(error.issues.map((issue) => issue.code).sort(), ['cod_not_integer', 'weight_too_large']);
      return true;
    });
    assert.equal(mock.calls.length, 0);
  });

  test('a store id is required', async () => {
    const mock = new MockFetch();
    await assert.rejects(setup(mock, { storeId: undefined }).courier.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues[0]?.field, 'storeId');
      return true;
    });
  });

  test('provider-side validation errors surface with field issues', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('POST', ORDERS_PATH, json({ message: 'Validation failed', errors: { recipient_zone: ['Zone is invalid'] } }, 422));
    await assert.rejects(setup(mock).courier.createOrder(sampleOrder()), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.provider, 'pathao');
      assert.equal(error.issues[0]?.field, 'recipient_zone');
      return true;
    });
  });

  test('order creation is not blindly retried on a 500', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json({}, 500));
    await assert.rejects(setup(mock).courier.createOrder(sampleOrder()), ProviderError);
    assert.equal(mock.callsTo(ORDERS_PATH).length, 1);
  });

  test('a success response without a consignment id is a ProviderError', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', ORDERS_PATH, json({ code: 200, data: {} }));
    await assert.rejects(setup(mock).courier.createOrder(sampleOrder()), /unexpected create order response/);
  });

  test('statusOverrides apply to responses', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('POST', ORDERS_PATH, json({ data: { consignment_id: 'C1', order_status: 'Awaiting Rider' } }));
    const { courier } = setup(mock, { statusOverrides: { awaiting_rider: 'pending' } });
    assert.equal((await courier.createOrder(sampleOrder())).status, 'pending');
  });

  test('cancelOrder is reported as unsupported', async () => {
    await assert.rejects(setup(new MockFetch()).courier.cancelOrder('C1'), (error: unknown) => {
      assert.ok(error instanceof UnsupportedOperationError);
      assert.equal(error.operation, 'cancelOrder');
      return true;
    });
  });
});

describe('Pathao bulk create', () => {
  test('sends valid orders in one request and reports async acceptance', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('POST', '/orders/bulk', json({ message: 'Your bulk order creation request is accepted', type: 'success', code: 202, data: true }, 202));
    const result = await setup(mock).courier.bulkCreate([
      sampleOrder({ merchantOrderId: 'A1' }),
      sampleOrder({ merchantOrderId: 'A2', recipient: { phone: 'bad' } }),
      sampleOrder({ merchantOrderId: 'A3' }),
    ]);
    assert.equal(result.mode, 'async');
    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.results[1]?.success, false);
    assert.equal(result.results[1]?.error?.code, 'VALIDATION');
    const sent = (mock.last.body as { orders: Array<{ merchant_order_id: string }> }).orders;
    assert.deepEqual(sent.map((order) => order.merchant_order_id), ['A1', 'A3']);
  });

  test('a rejected batch marks every submitted item as failed', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('POST', '/orders/bulk', json({ message: 'boom' }, 500));
    const result = await setup(mock).courier.bulkCreate([sampleOrder({ merchantOrderId: 'A1' }), sampleOrder({ merchantOrderId: 'A2' })]);
    assert.equal(result.succeeded, 0);
    assert.equal(result.results[0]?.error?.code, 'PROVIDER');
  });

  test('no request is made when every item is invalid', async () => {
    const mock = new MockFetch();
    const result = await setup(mock).courier.bulkCreate([sampleOrder({ codAmount: -1 })]);
    assert.equal(result.failed, 1);
    assert.equal(mock.calls.length, 0);
  });

  test('an auth failure aborts the batch', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json({ message: 'bad' }, 400));
    await assert.rejects(setup(mock).courier.bulkCreate([sampleOrder()]), AuthError);
  });
});

describe('Pathao tracking', () => {
  const info = {
    code: 200,
    data: {
      consignment_id: 'DT0101TEST',
      merchant_order_id: 'INV-1001',
      order_status: 'Assigned for Delivery',
      order_status_slug: 'Assigned_for_Delivery',
      updated_at: '2026-02-01 10:00:00',
    },
  };

  test('normalizes order info', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', /\/orders\/DT0101TEST\/info$/, json(info));
    const tracking = await setup(mock).courier.trackOrder('DT0101TEST');
    assert.equal(tracking.status, 'out_for_delivery');
    assert.equal(tracking.providerStatus, 'Assigned_for_Delivery');
    assert.equal(tracking.merchantOrderId, 'INV-1001');
    assert.equal(tracking.updatedAt, '2026-02-01T04:00:00.000Z');
    assert.equal(tracking.events.length, 1);
    assert.equal(tracking.events[0]?.message, 'Assigned for Delivery');
  });

  test('unrecognized statuses map to unknown but keep the raw value', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('GET', /\/info$/, json({ data: { consignment_id: 'C9', order_status: 'Teleported' } }));
    const tracking = await setup(mock).courier.trackOrder({ consignmentId: 'C9' });
    assert.equal(tracking.status, 'unknown');
    assert.equal(tracking.providerStatus, 'Teleported');
  });

  test('consignment ids are URL-encoded', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on('GET', /\/info$/, json(info));
    await setup(mock).courier.trackOrder('A/B 1');
    assert.ok(mock.last.url.includes('/orders/A%2FB%201/info'));
  });

  test('tracking by merchant order id is unsupported; an empty query is invalid', async () => {
    const { courier } = setup(new MockFetch());
    await assert.rejects(courier.trackOrder({ merchantOrderId: 'INV-1' }), UnsupportedOperationError);
    await assert.rejects(courier.trackOrder('  '), ValidationError);
  });
});

describe('Pathao pricing and locations', () => {
  test('calculateCharge sends the price-plan payload and derives the COD fee', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on(
      'POST',
      '/merchant/price-plan',
      json({ data: { price: 80, discount: 10, promo_discount: 0, final_price: 70, cod_enabled: 1, cod_percentage: 0.01 } }),
    );
    const charge = await setup(mock).courier.calculateCharge({ weightKg: 1.5, codAmount: 2000, cityId: 1, zoneId: '10' });
    assert.deepEqual(mock.last.body, { store_id: 55, item_type: 2, delivery_type: 48, item_weight: 1.5, recipient_city: 1, recipient_zone: 10 });
    assert.equal(charge.deliveryCharge, 70);
    assert.equal(charge.codCharge, 20);
    assert.equal(charge.discount, 10);
    assert.equal(charge.total, 90);
    assert.equal(charge.currency, 'BDT');
    assert.equal(charge.estimated, false);
  });

  test('COD fee is zero when COD is not enabled on the plan', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('POST', '/merchant/price-plan', json({ data: { price: 60, final_price: 60, cod_enabled: 0, cod_percentage: 0.01 } }));
    const charge = await setup(mock).courier.calculateCharge({ weightKg: 1, codAmount: 500, cityId: 1, zoneId: 2 });
    assert.equal(charge.codCharge, 0);
    assert.equal(charge.total, 60);
  });

  test('calculateCharge needs city and zone', async () => {
    await assert.rejects(setup(new MockFetch()).courier.calculateCharge({ weightKg: 1 }), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(error.issues.map((issue) => issue.field), ['cityId', 'zoneId']);
      return true;
    });
  });

  test('price quotes are retried on 500 because they have no side effects', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('POST', '/merchant/price-plan', json({}, 500), json({ data: { final_price: 60 } }));
    const charge = await setup(mock).courier.calculateCharge({ weightKg: 1, cityId: 1, zoneId: 2 });
    assert.equal(charge.total, 60);
  });

  test('lists cities, zones and areas', async () => {
    const mock = new MockFetch()
      .on('POST', TOKEN_PATH, json(tokenBody()))
      .on('GET', '/city-list', json({ data: { data: [{ city_id: 1, city_name: 'Dhaka' }, { city_id: 2, city_name: 'Chattogram' }, { bogus: true }] } }))
      .on('GET', '/cities/1/zone-list', json({ data: { data: [{ zone_id: 10, zone_name: 'Dhanmondi' }] } }))
      .on(
        'GET',
        '/zones/10/area-list',
        json({ data: { data: [{ area_id: 100, area_name: 'Road 2', home_delivery_available: true, pickup_available: false }] } }),
      );
    const { courier } = setup(mock);
    assert.deepEqual(await courier.listCities(), [{ id: 1, name: 'Dhaka' }, { id: 2, name: 'Chattogram' }]);
    assert.deepEqual(await courier.listZones(1), [{ id: 10, name: 'Dhanmondi', cityId: 1 }]);
    assert.deepEqual(await courier.listAreas({ zoneId: 10 }), [
      { id: 100, name: 'Road 2', zoneId: 10, homeDeliveryAvailable: true, pickupAvailable: false },
    ]);
  });

  test('listAreas requires a zone id', async () => {
    await assert.rejects(setup(new MockFetch()).courier.listAreas({}), ValidationError);
  });

  test('lists pickup stores', async () => {
    const mock = new MockFetch().on('POST', TOKEN_PATH, json(tokenBody())).on(
      'GET',
      '/stores',
      json({ data: { data: [{ store_id: 55, store_name: 'Main Warehouse', store_address: 'Mirpur', is_active: 1, city_id: 1, zone_id: 10, is_default_store: true }] } }),
    );
    assert.deepEqual(await setup(mock).courier.listStores(), [
      { id: 55, name: 'Main Warehouse', address: 'Mirpur', cityId: 1, zoneId: 10, isActive: true, isDefault: true },
    ]);
  });
});

describe('Pathao status table', () => {
  test('every entry maps to a normalized status', () => {
    for (const [raw, status] of Object.entries(PATHAO_STATUS_MAP)) assert.ok(isOrderStatus(status), raw);
  });

  const expectations: Array<[string, string]> = [
    ['Pending', 'pending'],
    ['Pickup Requested', 'pending'],
    ['Picked', 'picked_up'],
    ['At the Sorting HUB', 'in_transit'],
    ['In Transit', 'in_transit'],
    ['Received at Last Mile HUB', 'in_transit'],
    ['Assigned for Delivery', 'out_for_delivery'],
    ['Delivered', 'delivered'],
    ['Partial Delivery', 'partial_delivered'],
    ['Return', 'returned'],
    ['Paid Return', 'returned'],
    ['Delivery Failed', 'on_hold'],
    ['On Hold', 'on_hold'],
    ['Pickup Cancelled', 'cancelled'],
    ['Something Else', 'unknown'],
  ];
  for (const [raw, expected] of expectations) {
    test(`"${raw}" -> ${expected}`, () => {
      assert.equal(mapPathaoStatus(raw), expected);
    });
  }
});
