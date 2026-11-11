import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HELP, runCli } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { MockFetch, json, networkFailure } from './helpers/mock-fetch.js';

const STEADFAST_ENV = { STEADFAST_API_KEY: 'placeholder-api-key', STEADFAST_SECRET_KEY: 'placeholder-secret-key' };
const REDX_ENV = { REDX_ACCESS_TOKEN: 'placeholder-redx-token', REDX_PICKUP_AREA_ID: '1' };

async function run(argv: string[], env: Record<string, string> = {}, mock?: MockFetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...(mock ? { fetch: mock.fetch } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CREATE_ARGS = ['--invoice', 'INV-1001', '--name', 'Test Customer', '--phone', '01712345678', '--address', 'House 1, Road 2, Dhanmondi, Dhaka', '--cod', '1200'];

describe('CLI basics', () => {
  test('--version prints the package version', async () => {
    const result = await run(['--version']);
    assert.deepEqual(result, { code: 0, out: VERSION, err: '' });
  });

  test('--help, "help" and no arguments print usage', async () => {
    for (const argv of [['--help'], ['help'], []]) {
      const result = await run(argv);
      assert.equal(result.code, 0);
      assert.equal(result.out, HELP);
    }
    assert.match(HELP, /courier-bd track/);
    assert.match(HELP, /STEADFAST_API_KEY/);
  });

  test('unknown commands, providers and options are usage errors', async () => {
    for (const [argv, pattern] of [
      [['ship', 'pathao'], /Unknown command "ship"/],
      [['track'], /Missing provider/],
      [['track', 'paperfly', '1'], /Unknown provider "paperfly"/],
      [['track', 'steadfast', '1', '--nope'], /Usage error/],
      [['track', 'steadfast'], /Missing <id>/],
      [['track', 'steadfast', '1', '2'], /Unexpected argument "2"/],
      [['track', 'steadfast', '1', '--by', 'phone'], /--by must be one of/],
      [['charge', 'steadfast', 'extra', '--weight', '1'], /Unexpected argument "extra"/],
    ] as Array<[string[], RegExp]>) {
      const result = await run(argv, STEADFAST_ENV);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err, pattern);
      assert.match(result.err, /Run "courier-bd --help" for usage\./);
      assert.equal(result.out, '');
    }
  });

  test('missing credentials exit with 2 and name the variables', async () => {
    const result = await run(['track', 'steadfast', '42'], {});
    assert.equal(result.code, 2);
    assert.match(result.err, /Error \(CONFIG\): .*STEADFAST_API_KEY, STEADFAST_SECRET_KEY/);
  });

  test('argument problems are reported before missing credentials', async () => {
    const result = await run(['create', 'steadfast', '--invoice', 'INV-1'], {});
    assert.equal(result.code, 2);
    assert.match(result.err, /Usage error/);
    assert.doesNotMatch(result.err, /STEADFAST_API_KEY/);
  });
});

describe('CLI track', () => {
  test('prints a readable summary', async () => {
    const mock = new MockFetch().on('GET', '/status_by_cid/42', json({ status: 200, delivery_status: 'delivered' }));
    const result = await run(['track', 'steadfast', '42'], STEADFAST_ENV, mock);
    assert.equal(result.code, 0);
    assert.match(result.out, /^Provider: {5}steadfast$/m);
    assert.match(result.out, /^Consignment: {2}42$/m);
    assert.match(result.out, /^Status: {7}delivered \(delivered\)$/m);
    assert.equal(mock.last.headers['api-key'], 'placeholder-api-key');
  });

  test('--by selects the lookup and the provider name is case-insensitive', async () => {
    const mock = new MockFetch()
      .on('GET', '/status_by_invoice/INV-1001', json({ status: 200, delivery_status: 'hold' }))
      .on('GET', '/status_by_trackingcode/15BAEB8A', json({ status: 200, delivery_status: 'pending' }));
    assert.match((await run(['track', 'Steadfast', 'INV-1001', '--by', 'invoice'], STEADFAST_ENV, mock)).out, /on_hold/);
    assert.match((await run(['track', 'steadfast', '15BAEB8A', '--by', 'tracking'], STEADFAST_ENV, mock)).out, /pending/);
  });

  test('--json prints the normalized object without the raw payload', async () => {
    const mock = new MockFetch().on('GET', '/status_by_cid/42', json({ status: 200, delivery_status: 'delivered' }));
    const result = await run(['track', 'steadfast', '42', '--json'], STEADFAST_ENV, mock);
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    assert.equal(parsed.provider, 'steadfast');
    assert.equal(parsed.status, 'delivered');
    assert.ok(!('raw' in parsed));
  });

  test('a provider failure exits with 1 and never prints secrets', async () => {
    const mock = new MockFetch().on('GET', /status_by_cid/, json({ message: 'Invalid key placeholder-api-key' }, 401));
    const result = await run(['track', 'steadfast', '42'], STEADFAST_ENV, mock);
    assert.equal(result.code, 1);
    assert.match(result.err, /^Error \(AUTH\)/);
    assert.doesNotMatch(result.err, /placeholder-api-key/);
    assert.equal(result.out, '');
  });

  test('a network failure exits with 1', async () => {
    const mock = new MockFetch().on('GET', /status_by_cid/, networkFailure('getaddrinfo ENOTFOUND'));
    const result = await run(['track', 'steadfast', '42'], { ...STEADFAST_ENV }, mock);
    assert.equal(result.code, 1);
    assert.match(result.err, /^Error \(NETWORK\)/);
  });
});

describe('CLI create', () => {
  const created = {
    status: 200,
    consignment: { consignment_id: 1424107, invoice: 'INV-1001', tracking_code: '15BAEB8A', cod_amount: 1200, status: 'in_review' },
  };

  test('creates an order from flags', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json(created));
    const result = await run(['create', 'steadfast', ...CREATE_ARGS, '--note', 'Call first'], STEADFAST_ENV, mock);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^Consignment: {2}1424107$/m);
    assert.match(result.out, /^Tracking: {5}15BAEB8A$/m);
    assert.match(result.out, /^Invoice: {6}INV-1001$/m);
    assert.match(result.out, /^COD: {10}1200 BDT$/m);
    const body = mock.last.body as Record<string, unknown>;
    assert.equal(body.invoice, 'INV-1001');
    assert.equal(body.recipient_phone, '01712345678');
    assert.equal(body.cod_amount, 1200);
    assert.equal(body.note, 'Call first');
  });

  test('normalizes the phone number before sending', async () => {
    const mock = new MockFetch().on('POST', '/create_order', json(created));
    const args = CREATE_ARGS.map((value) => (value === '01712345678' ? '+880 1712-345678' : value));
    assert.equal((await run(['create', 'steadfast', ...args], STEADFAST_ENV, mock)).code, 0);
    assert.equal((mock.last.body as Record<string, unknown>).recipient_phone, '01712345678');
  });

  test('missing required flags are usage errors', async () => {
    const result = await run(['create', 'steadfast', '--invoice', 'INV-1'], STEADFAST_ENV, new MockFetch());
    assert.equal(result.code, 2);
    assert.match(result.err, /--name/);
  });

  test('a non-numeric amount is a usage error', async () => {
    const args = CREATE_ARGS.map((value) => (value === '1200' ? 'lots' : value));
    const mock = new MockFetch();
    const result = await run(['create', 'steadfast', ...args], STEADFAST_ENV, mock);
    assert.equal(result.code, 2);
    assert.match(result.err, /--cod/);
    assert.equal(mock.calls.length, 0);
  });

  test('validation problems list each field and send nothing', async () => {
    const args = CREATE_ARGS.map((value) => (value === '01712345678' ? '12345' : value));
    const mock = new MockFetch();
    const result = await run(['create', 'steadfast', ...args], STEADFAST_ENV, mock);
    assert.equal(result.code, 1);
    assert.match(result.err, /^Error \(VALIDATION\)/);
    assert.match(result.err, /^ {2}- recipient\.phone: /m);
    assert.equal(mock.calls.length, 0);
  });

  test('creates a RedX parcel with area flags', async () => {
    const mock = new MockFetch().on('POST', '/parcel', json({ tracking_id: '21A427TU4BN3R' }, 201));
    const result = await run(['create', 'redx', ...CREATE_ARGS, '--area', '100', '--area-name', 'Dhanmondi', '--weight', '1.5', '--json'], REDX_ENV, mock);
    assert.equal(result.code, 0, result.err);
    assert.equal((JSON.parse(result.out) as Record<string, unknown>).consignmentId, '21A427TU4BN3R');
    const body = mock.last.body as Record<string, unknown>;
    assert.equal(body.delivery_area_id, 100);
    assert.equal(body.delivery_area, 'Dhanmondi');
    assert.equal(body.parcel_weight, 1500);
    assert.equal(mock.last.headers['api-access-token'], 'Bearer placeholder-redx-token');
  });
});

describe('CLI charge', () => {
  test('prints a RedX quote', async () => {
    const mock = new MockFetch().on('GET', '/charge/charge_calculator', json({ deliveryCharge: 60, codCharge: 12 }));
    const result = await run(['charge', 'redx', '--weight', '0.5', '--cod', '1200', '--area', '100'], REDX_ENV, mock);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^Delivery: {5}60 BDT$/m);
    assert.match(result.out, /^COD charge: {3}12 BDT$/m);
    assert.match(result.out, /^Total: {8}72 BDT$/m);
    assert.equal(mock.last.query.get('pickup_area_id'), '1');
  });

  test('--pickup-area overrides the environment', async () => {
    const mock = new MockFetch().on('GET', '/charge/charge_calculator', json({ deliveryCharge: 60, codCharge: 0 }));
    await run(['charge', 'redx', '--weight', '1', '--area', '100', '--pickup-area', '9'], REDX_ENV, mock);
    assert.equal(mock.last.query.get('pickup_area_id'), '9');
  });

  test('requires --weight', async () => {
    const result = await run(['charge', 'redx', '--area', '100'], REDX_ENV, new MockFetch());
    assert.equal(result.code, 2);
    assert.match(result.err, /--weight/);
  });

  test('reports an unsupported operation for Steadfast without a rate card', async () => {
    const result = await run(['charge', 'steadfast', '--weight', '1'], STEADFAST_ENV, new MockFetch());
    assert.equal(result.code, 1);
    assert.match(result.err, /^Error \(UNSUPPORTED\)/);
  });
});
