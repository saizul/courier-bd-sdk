import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { ConfigError, ValidationError, WebhookVerificationError } from '../src/errors.js';
import {
  getHeader,
  parsePathaoWebhook,
  parseRedxWebhook,
  parseSteadfastWebhook,
  parseWebhook,
  parseWebhookBody,
  pathaoWebhookResponse,
  safeEqual,
  verifyHmacSignature,
  verifyPathaoWebhook,
  verifyRedxWebhook,
  verifySteadfastWebhook,
} from '../src/webhooks.js';

const SECRET = 'placeholder-webhook-secret';

describe('webhook primitives', () => {
  test('getHeader is case-insensitive across Headers and plain objects', () => {
    assert.equal(getHeader(new Headers({ 'X-Pathao-Signature': 'a' }), 'x-pathao-signature'), 'a');
    assert.equal(getHeader({ 'X-PATHAO-Signature': 'b' }, 'x-pathao-signature'), 'b');
    assert.equal(getHeader({ authorization: ['c', 'd'] }, 'Authorization'), 'c');
    assert.equal(getHeader({}, 'missing'), undefined);
    assert.equal(getHeader(undefined, 'missing'), undefined);
  });

  test('safeEqual compares content regardless of length', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
    assert.ok(!safeEqual('', 'a'));
  });

  test('parseWebhookBody accepts strings, bytes and objects', () => {
    assert.deepEqual(parseWebhookBody('{"a":1}'), { a: 1 });
    assert.deepEqual(parseWebhookBody(Buffer.from('{"a":2}')), { a: 2 });
    assert.deepEqual(parseWebhookBody({ a: 3 }), { a: 3 });
  });

  test('parseWebhookBody rejects invalid JSON and non-objects', () => {
    assert.throws(() => parseWebhookBody('{nope'), ValidationError);
    assert.throws(() => parseWebhookBody('[1,2]'), ValidationError);
    assert.throws(() => parseWebhookBody(undefined), ValidationError);
  });

  test('verifyHmacSignature checks a hex HMAC over the raw body', () => {
    const body = '{"consignment_id":"C1"}';
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.ok(verifyHmacSignature(body, SECRET, signature));
    assert.ok(verifyHmacSignature(body, SECRET, `sha256=${signature.toUpperCase()}`));
    assert.ok(!verifyHmacSignature(`${body} `, SECRET, signature));
    assert.ok(!verifyHmacSignature(body, 'other-secret', signature));
    assert.ok(!verifyHmacSignature(body, '', signature));
    assert.ok(!verifyHmacSignature(body, SECRET, ''));
  });
});

describe('Pathao webhooks', () => {
  const body = {
    consignment_id: 'DT0101TEST',
    merchant_order_id: 'INV-1001',
    updated_at: '2026-02-01 10:00:00',
    timestamp: '2026-02-01T04:00:00.000Z',
    store_id: 55,
    event: 'order.delivered',
    delivery_fee: 80,
    collected_amount: 1200,
  };

  test('verifies the signature header and normalizes the event', () => {
    const event = parsePathaoWebhook({ headers: { 'X-PATHAO-Signature': SECRET }, body: JSON.stringify(body) }, { secret: SECRET });
    assert.equal(event.provider, 'pathao');
    assert.equal(event.type, 'status_update');
    assert.equal(event.consignmentId, 'DT0101TEST');
    assert.equal(event.merchantOrderId, 'INV-1001');
    assert.equal(event.status, 'delivered');
    assert.equal(event.providerStatus, 'order.delivered');
    assert.equal(event.timestamp, '2026-02-01T04:00:00.000Z');
    assert.equal(event.codAmount, 1200);
    assert.equal(event.deliveryFee, 80);
  });

  const events: Array<[string, string]> = [
    ['order.created', 'pending'],
    ['order.pickup-requested', 'pending'],
    ['order.picked', 'picked_up'],
    ['order.at-the-sorting-hub', 'in_transit'],
    ['order.in-transit', 'in_transit'],
    ['order.received-at-last-mile-hub', 'in_transit'],
    ['order.assigned-for-delivery', 'out_for_delivery'],
    ['order.partial-delivery', 'partial_delivered'],
    ['order.returned', 'returned'],
    ['order.delivery-failed', 'on_hold'],
    ['order.on-hold', 'on_hold'],
    ['order.pickup-cancelled', 'cancelled'],
  ];
  for (const [name, expected] of events) {
    test(`event ${name} -> ${expected}`, () => {
      const event = parsePathaoWebhook({ body: { ...body, event: name } }, { allowUnverified: true });
      assert.equal(event.status, expected);
    });
  }

  test('rejects a wrong or missing signature', () => {
    assert.throws(() => parsePathaoWebhook({ headers: { 'x-pathao-signature': 'wrong' }, body }, { secret: SECRET }), WebhookVerificationError);
    assert.throws(() => parsePathaoWebhook({ headers: {}, body }, { secret: SECRET }), WebhookVerificationError);
    assert.equal(verifyPathaoWebhook({ headers: { 'x-pathao-signature': SECRET } }, ''), false);
  });

  test('refuses to run without a secret unless explicitly allowed', () => {
    assert.throws(() => parsePathaoWebhook({ headers: {}, body }), ConfigError);
    assert.throws(() => parsePathaoWebhook({ headers: {}, body }, { secret: '' }), ConfigError);
    assert.equal(parsePathaoWebhook({ body }, { allowUnverified: true }).status, 'delivered');
  });

  test('the integration handshake event is reported as "other"', () => {
    const event = parsePathaoWebhook({ body: { event: 'webhook_integration' } }, { allowUnverified: true });
    assert.equal(event.type, 'other');
    assert.equal(event.status, 'unknown');
    assert.equal(event.consignmentId, '');
  });

  test('a payload with no identifying fields is a validation error', () => {
    assert.throws(() => parsePathaoWebhook({ body: { hello: 'world' } }, { allowUnverified: true }), ValidationError);
  });

  test('pathaoWebhookResponse builds the 202 handshake response', () => {
    assert.deepEqual(pathaoWebhookResponse('placeholder-integration-secret'), {
      status: 202,
      headers: { 'X-Pathao-Merchant-Webhook-Integration-Secret': 'placeholder-integration-secret' },
    });
  });
});

describe('Steadfast webhooks', () => {
  const delivery = {
    notification_type: 'delivery_status',
    consignment_id: 12345,
    invoice: 'INV-1001',
    cod_amount: 1500,
    status: 'Delivered',
    delivery_charge: 100,
    tracking_message: 'Your parcel has been delivered successfully.',
    updated_at: '2026-03-02 12:45:30',
  };

  test('verifies the bearer token and normalizes a delivery status event', () => {
    const event = parseSteadfastWebhook({ headers: { Authorization: `Bearer ${SECRET}` }, body: delivery }, { secret: SECRET });
    assert.equal(event.type, 'status_update');
    assert.equal(event.consignmentId, '12345');
    assert.equal(event.merchantOrderId, 'INV-1001');
    assert.equal(event.status, 'delivered');
    assert.equal(event.providerStatus, 'Delivered');
    assert.equal(event.codAmount, 1500);
    assert.equal(event.deliveryFee, 100);
    assert.equal(event.message, 'Your parcel has been delivered successfully.');
    assert.equal(event.timestamp, '2026-03-02T06:45:30.000Z');
  });

  test('tracking updates carry a message and an unknown status', () => {
    const event = parseSteadfastWebhook(
      {
        body: {
          notification_type: 'tracking_update',
          consignment_id: 12345,
          invoice: 'INV-1001',
          tracking_message: 'Parcel arrived at the sorting center.',
          updated_at: '2026-03-02 13:15:00',
        },
      },
      { allowUnverified: true },
    );
    assert.equal(event.type, 'tracking_update');
    assert.equal(event.status, 'unknown');
    assert.equal(event.message, 'Parcel arrived at the sorting center.');
  });

  test('accepts the secret with or without a Bearer prefix on either side', () => {
    assert.ok(verifySteadfastWebhook({ headers: { authorization: SECRET } }, SECRET));
    assert.ok(verifySteadfastWebhook({ headers: { authorization: `bearer ${SECRET}` } }, `Bearer ${SECRET}`));
    assert.ok(!verifySteadfastWebhook({ headers: { authorization: 'Bearer nope' } }, SECRET));
    assert.ok(!verifySteadfastWebhook({ headers: {} }, SECRET));
  });

  test('rejects an unauthenticated request', () => {
    assert.throws(() => parseSteadfastWebhook({ headers: {}, body: delivery }, { secret: SECRET }), WebhookVerificationError);
  });
});

describe('RedX webhooks', () => {
  const body = {
    tracking_number: '21A427TU4BN3R',
    timestamp: '2026-03-03T09:00:00.000Z',
    status: 'delivery-in-progress',
    message_en: 'Parcel is out for delivery',
    message_bn: 'পার্সেল ডেলিভারির জন্য বের হয়েছে',
    invoice_number: 'INV-1001',
  };

  test('verifies a token from the callback URL query', () => {
    const event = parseRedxWebhook({ body, query: new URLSearchParams({ token: SECRET }) }, { secret: SECRET });
    assert.equal(event.type, 'status_update');
    assert.equal(event.consignmentId, '21A427TU4BN3R');
    assert.equal(event.merchantOrderId, 'INV-1001');
    assert.equal(event.status, 'out_for_delivery');
    assert.equal(event.message, 'Parcel is out for delivery');
    assert.equal(event.messageBn, 'পার্সেল ডেলিভারির জন্য বের হয়েছে');
    assert.equal(event.timestamp, '2026-03-03T09:00:00.000Z');
  });

  test('verifies a token from the header, including custom names', () => {
    assert.ok(verifyRedxWebhook({ headers: { 'X-Redx-Token': SECRET } }, SECRET));
    assert.ok(verifyRedxWebhook({ headers: { 'x-hook-key': SECRET } }, SECRET, { tokenHeader: 'X-Hook-Key' }));
    assert.ok(verifyRedxWebhook({ query: { key: SECRET } }, SECRET, { tokenQueryParam: 'key' }));
    assert.ok(!verifyRedxWebhook({ query: { token: 'wrong' } }, SECRET));
    assert.ok(!verifyRedxWebhook({}, SECRET));
  });

  test('without a status field the message decides the status', () => {
    const event = parseRedxWebhook(
      { body: { tracking_number: 'T1', message_en: 'Parcel delivered successfully' } },
      { allowUnverified: true },
    );
    assert.equal(event.type, 'tracking_update');
    assert.equal(event.status, 'delivered');
  });

  test('a payload without a tracking number is invalid', () => {
    assert.throws(() => parseRedxWebhook({ body: { status: 'delivered' } }, { allowUnverified: true }), ValidationError);
  });
});

describe('parseWebhook', () => {
  test('rejects an unknown provider', () => {
    assert.throws(() => parseWebhook('dhl' as never, { body: {} }, { allowUnverified: true }), ConfigError);
  });

  test('verification happens before the body is parsed', () => {
    assert.throws(() => parseWebhook('pathao', { headers: {}, body: '{broken' }, { secret: SECRET }), WebhookVerificationError);
  });
});
