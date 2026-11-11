import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError } from '../src/errors.js';
import { ENV_VARS, configFromEnv, createCourier, createCourierFromEnv, isProviderName } from '../src/factory.js';
import { PathaoCourier } from '../src/providers/pathao/index.js';
import { RedxCourier } from '../src/providers/redx/index.js';
import { SteadfastCourier } from '../src/providers/steadfast/index.js';
import { MockFetch, instant, json } from './helpers/mock-fetch.js';

const PATHAO_ENV = {
  PATHAO_CLIENT_ID: 'placeholder-client-id',
  PATHAO_CLIENT_SECRET: 'placeholder-client-secret',
  PATHAO_USERNAME: 'merchant@example.com',
  PATHAO_PASSWORD: 'placeholder-password',
};

describe('factory', () => {
  test('isProviderName recognises only the supported couriers', () => {
    assert.ok(isProviderName('pathao'));
    assert.ok(isProviderName('steadfast'));
    assert.ok(isProviderName('redx'));
    assert.ok(!isProviderName('Pathao'));
    assert.ok(!isProviderName('paperfly'));
    assert.ok(!isProviderName(undefined));
  });

  test('ENV_VARS documents the variables per provider', () => {
    assert.deepEqual(Object.keys(ENV_VARS).sort(), ['pathao', 'redx', 'steadfast']);
    assert.ok(ENV_VARS.pathao.required.includes('PATHAO_CLIENT_SECRET'));
    assert.deepEqual([...ENV_VARS.redx.required], ['REDX_ACCESS_TOKEN']);
  });

  test('createCourier builds the matching adapter', () => {
    assert.ok(createCourier('steadfast', { apiKey: 'k', secretKey: 's' }) instanceof SteadfastCourier);
    assert.ok(createCourier('redx', { accessToken: 'placeholder-token' }) instanceof RedxCourier);
    assert.ok(
      createCourier('pathao', { clientId: 'c', clientSecret: 's', username: 'u', password: 'p' }) instanceof PathaoCourier,
    );
  });

  test('createCourier rejects an unknown provider', () => {
    assert.throws(() => createCourier('paperfly' as never, {} as never), ConfigError);
  });

  test('configFromEnv reads Pathao credentials and options', () => {
    const config = configFromEnv('pathao', { ...PATHAO_ENV, PATHAO_STORE_ID: ' 55 ', PATHAO_SANDBOX: 'true' });
    assert.equal(config.clientId, 'placeholder-client-id');
    assert.equal(config.username, 'merchant@example.com');
    assert.equal(config.storeId, '55');
    assert.equal(config.sandbox, true);
    assert.equal(config.baseUrl, undefined);
  });

  for (const value of ['1', 'true', 'YES', 'on']) {
    test(`sandbox flag accepts "${value}"`, () => {
      assert.equal(configFromEnv('redx', { REDX_ACCESS_TOKEN: 't', REDX_SANDBOX: value }).sandbox, true);
    });
  }

  test('sandbox flag is off for anything else', () => {
    assert.equal(configFromEnv('redx', { REDX_ACCESS_TOKEN: 't', REDX_SANDBOX: '0' }).sandbox, false);
    assert.equal(configFromEnv('redx', { REDX_ACCESS_TOKEN: 't' }).sandbox, false);
  });

  test('lists every missing variable, treating blanks as missing', () => {
    assert.throws(() => configFromEnv('pathao', { PATHAO_CLIENT_ID: 'x', PATHAO_USERNAME: '   ' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'CONFIG');
      assert.match(error.message, /PATHAO_CLIENT_SECRET, PATHAO_USERNAME, PATHAO_PASSWORD/);
      assert.doesNotMatch(error.message, /PATHAO_CLIENT_ID/);
      return true;
    });
    assert.throws(() => configFromEnv('steadfast', {}), /STEADFAST_API_KEY, STEADFAST_SECRET_KEY/);
  });

  test('reads RedX pickup defaults and base URL overrides', () => {
    const config = configFromEnv('redx', {
      REDX_ACCESS_TOKEN: 'placeholder-token',
      REDX_PICKUP_STORE_ID: '7',
      REDX_PICKUP_AREA_ID: '3',
      REDX_BASE_URL: 'https://redx.example.test/v1',
    });
    assert.equal(config.pickupStoreId, '7');
    assert.equal(config.pickupAreaId, '3');
    assert.equal(config.baseUrl, 'https://redx.example.test/v1');
  });

  test('createCourierFromEnv applies overrides such as a custom fetch', async () => {
    const mock = new MockFetch().on('GET', '/status_by_cid/42', json({ status: 200, delivery_status: 'delivered' }));
    const client = createCourierFromEnv(
      'steadfast',
      { STEADFAST_API_KEY: 'placeholder-api-key', STEADFAST_SECRET_KEY: 'placeholder-secret-key', STEADFAST_BASE_URL: 'https://steadfast.example.test/api' },
      { fetch: mock.fetch, ...instant() },
    );
    const tracking = await client.trackOrder({ consignmentId: '42' });
    assert.equal(tracking.status, 'delivered');
    assert.ok(mock.last.url.startsWith('https://steadfast.example.test/api/status_by_cid/42'));
    assert.equal(mock.last.headers['api-key'], 'placeholder-api-key');
  });
});
