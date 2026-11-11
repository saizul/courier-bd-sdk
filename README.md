# courier-bd-sdk

One TypeScript interface for three Bangladesh courier APIs: **Pathao**, **Steadfast** and **RedX**.

[![CI](https://github.com/saizul/courier-bd-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/courier-bd-sdk/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

Every courier has its own authentication scheme, payload shape, status vocabulary and error format. This SDK puts
them behind a single `CourierClient` interface with normalized orders, tracking, statuses and errors, so the rest of
your application does not care which courier carries a parcel.

> **Read [Verification status](#verification-status) before using this in production.** The adapters are tested
> against mocked responses, not against the couriers' live APIs.

## Features

- **One interface** - `createOrder`, `bulkCreate`, `trackOrder`, `cancelOrder`, `calculateCharge`, `listCities`,
  `listZones`, `listAreas`, plus a `capabilities` object that says what each courier supports.
- **Authentication handled** - Pathao OAuth token issue, expiry caching, refresh and single-flight; Steadfast key
  headers; RedX bearer token.
- **Normalized statuses** - ten statuses with a mapping table per courier that you can extend or correct.
- **Resilient HTTP** - per-attempt timeout, exponential backoff with jitter on `429`, `5xx` and network errors,
  `Retry-After` support, and no blind retry of order creation (see [Retries](#retries-and-duplicate-orders)).
- **Typed errors** - `AuthError`, `ValidationError`, `RateLimitError`, `ProviderError`, `NetworkError`,
  `TimeoutError` and more, all with credentials redacted from messages and details.
- **Input validation** - Bangladesh mobile numbers in any common format (`01XXXXXXXXX`, `+880`, Bangla digits), COD
  amount, weight and address length, checked before a request is sent.
- **Webhooks** - verify and parse deliveries from all three couriers into one event shape.
- **Fallback router** - pick a courier by coverage rules, priority or cheapest quote, with failover and a circuit
  breaker.
- **CLI** - `courier-bd track | create | charge`.
- **Zero runtime dependencies** - uses the global `fetch` in Node 22+. The fetch implementation is injectable.

## Install

```bash
npm install courier-bd-sdk
```

Requires Node.js 22 or newer. The package is ESM-only and ships its own type declarations.

## Quick start

```ts
import { createCourier } from 'courier-bd-sdk';

const courier = createCourier('steadfast', {
  apiKey: process.env.STEADFAST_API_KEY!,
  secretKey: process.env.STEADFAST_SECRET_KEY!,
});

const order = await courier.createOrder({
  merchantOrderId: 'INV-1001',
  recipient: {
    name: 'Test Customer',
    phone: '+880 1712-345678', // normalized to 01712345678
    address: 'House 1, Road 2, Dhanmondi, Dhaka',
  },
  codAmount: 1200,
});

console.log(order.consignmentId, order.status); // e.g. "1424107" "pending"

const tracking = await courier.trackOrder(order.consignmentId);
console.log(tracking.status);
```

## The common interface

```ts
interface CourierClient {
  readonly provider: string;
  readonly capabilities: Capabilities;
  createOrder(input: CreateOrderInput): Promise<Order>;
  bulkCreate(inputs: CreateOrderInput[]): Promise<BulkCreateResult>;
  trackOrder(query: TrackQuery): Promise<Tracking>;
  cancelOrder(consignmentId: Id, reason?: string): Promise<CancelResult>;
  calculateCharge(input: ChargeInput): Promise<Charge>;
  listCities(): Promise<City[]>;
  listZones(cityId: Id): Promise<Zone[]>;
  listAreas(query: AreaQuery): Promise<Area[]>;
}
```

An operation a courier does not offer rejects with `UnsupportedOperationError`. Check `capabilities` to branch up
front:

| Capability                | Pathao           | Steadfast                    | RedX                     |
| ------------------------- | ---------------- | ---------------------------- | ------------------------ |
| `createOrder`             | yes              | yes                          | yes                      |
| `bulkCreate`              | native, async    | native, sync (chunks of 500) | emulated (parallel)      |
| `trackOrder` by           | consignment id   | consignment, invoice, code   | tracking id              |
| `cancelOrder`             | no               | no                           | yes                      |
| `calculateCharge`         | API              | local rate card (estimate)   | API                      |
| `listCities` / `listZones`| yes              | no                           | no                       |
| `listAreas`               | by zone          | no                           | by post code or district |

Every normalized object keeps the untouched courier response in `raw`, and `CreateOrderInput.extra` is merged into the
outgoing payload verbatim for fields the normalized model does not cover.

## Usage per provider

### Pathao

```ts
import { PathaoCourier } from 'courier-bd-sdk';

const pathao = new PathaoCourier({
  clientId: process.env.PATHAO_CLIENT_ID!,
  clientSecret: process.env.PATHAO_CLIENT_SECRET!,
  username: process.env.PATHAO_USERNAME!, // merchant account email
  password: process.env.PATHAO_PASSWORD!,
  storeId: 12345, // default pickup store
  sandbox: true, // use the sandbox base URL
});

const cities = await pathao.listCities();
const zones = await pathao.listZones(cities[0].id);
const areas = await pathao.listAreas({ zoneId: zones[0].id });

const quote = await pathao.calculateCharge({ cityId: cities[0].id, zoneId: zones[0].id, weightKg: 0.5, codAmount: 1200 });

const order = await pathao.createOrder({
  merchantOrderId: 'INV-1001',
  recipient: {
    name: 'Test Customer',
    phone: '01712345678',
    address: 'House 1, Road 2, Dhanmondi, Dhaka',
    cityId: cities[0].id,
    zoneId: zones[0].id,
    areaId: areas[0]?.id,
  },
  codAmount: 1200,
  weightKg: 0.5,
  deliveryType: 'normal', // or 'express'
  itemType: 'parcel', // or 'document'
});
```

Tokens are issued on first use, cached until 60 seconds before expiry, renewed with the refresh token (falling back to
the password grant if the refresh is rejected), and shared between concurrent calls. If the API answers `401` with a
cached token, the token is discarded and the request is replayed once.

Short-lived processes can share a token through a store:

```ts
const pathao = new PathaoCourier({
  /* credentials */
  tokenStore: {
    load: async () => JSON.parse((await redis.get('pathao:token')) ?? 'null') ?? undefined,
    save: async (token) => void (await redis.set('pathao:token', JSON.stringify(token))),
  },
});
```

`bulkCreate` submits one batch that Pathao processes in the background, so the result has `mode: 'async'` and carries
no consignment ids; items that fail local validation are reported immediately and never sent.

### Steadfast

```ts
import { SteadfastCourier } from 'courier-bd-sdk';

const steadfast = new SteadfastCourier({
  apiKey: process.env.STEADFAST_API_KEY!,
  secretKey: process.env.STEADFAST_SECRET_KEY!,
  // Optional: enables calculateCharge as a local estimate. Use your own rates.
  rateCard: {
    zones: { inside_dhaka: 70, outside_dhaka: 130 },
    defaultZone: 'inside_dhaka',
    baseWeightKg: 1,
    extraPerKg: 20,
    codPercent: 1,
  },
});

const order = await steadfast.createOrder({
  merchantOrderId: 'INV-1001',
  recipient: { name: 'Test Customer', phone: '01712345678', address: 'House 1, Road 2, Dhanmondi, Dhaka' },
  codAmount: 1200,
  note: 'Call before delivery',
});

await steadfast.trackOrder(order.consignmentId);
await steadfast.trackOrder({ merchantOrderId: 'INV-1001' });
await steadfast.trackOrder({ trackingCode: order.trackingCode! });

const bulk = await steadfast.bulkCreate(orders); // chunks of up to 500, matched back by invoice
const balance = await steadfast.getBalance();
```

Steadfast has no pricing endpoint. `calculateCharge` works only when you configure a `rateCard`, and the result is
flagged `estimated: true`. The SDK ships no prices of its own.

### RedX

```ts
import { RedxCourier } from 'courier-bd-sdk';

const redx = new RedxCourier({
  accessToken: process.env.REDX_ACCESS_TOKEN!, // without the "Bearer " prefix
  pickupStoreId: 1,
  pickupAreaId: 1, // default pickup area for charge quotes
  sandbox: true,
});

const [area] = await redx.listAreas({ postCode: 1209 });

const parcel = await redx.createOrder({
  merchantOrderId: 'INV-1001',
  recipient: {
    name: 'Test Customer',
    phone: '01712345678',
    address: 'House 1, Road 2, Dhanmondi, Dhaka',
    areaId: area.id,
    areaName: area.name,
  },
  codAmount: 1200,
  weightKg: 0.5, // sent to RedX in grams
});

const tracking = await redx.trackOrder(parcel.consignmentId); // history plus current status
const quote = await redx.calculateCharge({ areaId: area.id, weightKg: 0.5, codAmount: 1200 });
await redx.cancelOrder(parcel.consignmentId, 'Customer changed their mind');
```

`bulkCreate` is emulated with parallel single creates (`bulkConcurrency`, default 3) and returns `mode: 'sync'`.

### Common options

Every adapter accepts these in addition to its credentials:

| Option            | Default          | Purpose                                                                 |
| ----------------- | ---------------- | ----------------------------------------------------------------------- |
| `baseUrl`         | courier default  | Override the API base URL (proxy, new API version, tests)               |
| `fetch`           | `globalThis.fetch` | Custom fetch implementation                                           |
| `timeoutMs`       | `15000`          | Per-attempt timeout                                                     |
| `retry`           | see below        | `retries`, `baseDelayMs`, `maxDelayMs`, `factor`, `jitter`, `retryNonIdempotent` |
| `logger`          | none             | Receives structured, redacted entries for every request, retry, failure |
| `rules`           | per courier      | Override validation limits (COD maximum, weight range, text lengths)    |
| `statusOverrides` | none             | Extra or corrected raw-status mappings                                  |

## Status mapping

Raw statuses are compared case-insensitively with spaces and hyphens folded to underscores, so `Pickup-Cancelled`,
`pickup cancelled` and `pickup_cancelled` are the same key. Anything not in the table becomes `unknown`; the original
string is always available as `providerStatus`.

| Normalized          | Pathao                                                              | Steadfast                                                | RedX                                                                  |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `pending`           | `pending`, `created`, `pickup_requested`, `assigned_for_pickup`     | `pending`, `in_review`                                   | `pickup_pending`, `pickup_requested`, `pickup_assigned`, `pending`    |
| `picked_up`         | `picked`, `picked_up`                                               | -                                                        | `picked_up`, `pickup_done`                                            |
| `in_transit`        | `at_the_sorting_hub`, `in_transit`, `received_at_last_mile_hub`     | -                                                        | `received_at_hub`, `in_transit`, `ready_for_delivery`, `agent_area_change` |
| `out_for_delivery`  | `assigned_for_delivery`                                             | -                                                        | `delivery_in_progress`, `out_for_delivery`                            |
| `delivered`         | `delivered`, `exchange`, `exchanged`, `payment_invoice`, `paid`     | `delivered`, `delivered_approval_pending`                | `delivered`                                                           |
| `partial_delivered` | `partial_delivery`, `partial_delivered`                             | `partial_delivered`, `partial_delivered_approval_pending` | `partial_delivered`, `partially_delivered`                            |
| `returned`          | `return`, `returned`, `paid_return`                                 | -                                                        | `agent_returning`, `returning`, `returned`                            |
| `cancelled`         | `pickup_cancelled`, `pickup_cancel`, `cancelled`                    | `cancelled`, `cancelled_approval_pending`                | `cancelled`, `canceled`, `deleted`                                    |
| `on_hold`           | `pickup_failed`, `delivery_failed`, `on_hold`, `hold`               | `hold`                                                   | `agent_hold`, `hold`, `on_hold`                                       |
| `unknown`           | anything else                                                       | `unknown`, `unknown_approval_pending`, anything else     | anything else                                                         |

The tables live in `src/providers/<courier>/mapping.ts` and are exported as `PATHAO_STATUS_MAP`,
`STEADFAST_STATUS_MAP` and `REDX_STATUS_MAP`. To add or correct a mapping without waiting for a release:

```ts
const pathao = new PathaoCourier({
  /* credentials */
  statusOverrides: { delivery_failed: 'returned', some_new_status: 'in_transit' },
});
```

Helpers: `isTerminalStatus(status)`, `isDeliveredStatus(status)`, `isOrderStatus(value)`, `ORDER_STATUSES`.

## Validation

`createOrder` validates and normalizes input before any request is made and rejects with a `ValidationError` that
lists every problem:

```ts
import { ValidationError } from 'courier-bd-sdk';

try {
  await courier.createOrder(order);
} catch (error) {
  if (error instanceof ValidationError) {
    for (const issue of error.issues) console.log(issue.field, issue.code, issue.message);
    // recipient.phone invalid_phone ...
  }
}
```

The phone helpers are exported for use in your own forms:

```ts
import { detectOperator, isValidPhone, normalizePhone, toE164 } from 'courier-bd-sdk';

normalizePhone('+880 1712-345678'); // '01712345678'
normalizePhone('০১৭১২৩৪৫৬৭৮'); // '01712345678'
normalizePhone('1712345678'); // '01712345678'
normalizePhone('02-9876543'); // undefined (not a mobile number)
toE164('01712345678'); // '+8801712345678'
isValidPhone('01212345678'); // false (012 is not an operator prefix)
detectOperator('01712345678'); // operator name for the prefix
```

`detectOperator` reports the operator the prefix was originally allocated to; number portability means it may not be
the subscriber's current operator.

## Errors

All errors extend `CourierError` and carry `code`, `provider`, `status` (HTTP status when there is one), `details`
(the redacted response body) and `retryable`.

| Class                        | `code`        | When                                                            |
| ---------------------------- | ------------- | --------------------------------------------------------------- |
| `ValidationError`            | `VALIDATION`  | Input failed local checks, or the courier answered 400/422      |
| `AuthError`                  | `AUTH`        | 401/403, or credentials rejected when issuing a token           |
| `RateLimitError`             | `RATE_LIMIT`  | 429 after retries; `retryAfterMs` when the courier sent one     |
| `ProviderError`              | `PROVIDER`    | Any other error response, or a response the SDK cannot interpret |
| `NetworkError`               | `NETWORK`     | The request never produced a response                           |
| `TimeoutError`               | `TIMEOUT`     | An attempt exceeded `timeoutMs`                                 |
| `UnsupportedOperationError`  | `UNSUPPORTED` | The courier does not offer the operation                        |
| `ConfigError`                | `CONFIG`      | Missing or invalid configuration                                |
| `WebhookVerificationError`   | `WEBHOOK`     | A webhook failed authentication                                 |
| `NoCourierAvailableError`    | `NO_COURIER`  | The router ran out of candidates; see `attempts`                |

Credentials you configure are scrubbed from error messages, error details and log entries, including when a courier
echoes them back in a response.

### Retries and duplicate orders

Read-only requests are retried on network errors, timeouts, `429` and `5xx` (2 retries by default, 300 ms base delay
doubling each time, 50-100% jitter, capped at 10 s, honouring `Retry-After`).

Requests that create something are **not** retried on network errors, timeouts or generic `5xx`, because the courier
may have processed the first attempt and a retry would book a second parcel. They are retried only on `429` and
`503`. If you have your own de-duplication, opt in with `retry: { retryNonIdempotent: true }`.

After a `TimeoutError` or `NetworkError` on `createOrder`, the order may or may not exist. Where the courier supports
it (Steadfast), look it up by your invoice before creating it again.

## Webhooks

`parseWebhook` authenticates a delivery and returns one normalized event shape for all three couriers:

```ts
import { parseWebhook, pathaoWebhookResponse } from 'courier-bd-sdk';

// Express-style handler. Pass the raw body string or an already-parsed object.
app.post('/webhooks/:provider', express.text({ type: '*/*' }), (req, res) => {
  try {
    const event = parseWebhook(req.params.provider, { headers: req.headers, body: req.body, query: req.query }, {
      secret: process.env.WEBHOOK_SECRET,
    });
    // { provider, type, consignmentId, merchantOrderId, status, providerStatus, message, timestamp, codAmount, deliveryFee, raw }
    queue.push(event);

    if (event.provider === 'pathao') {
      const ack = pathaoWebhookResponse(process.env.PATHAO_WEBHOOK_INTEGRATION_SECRET!);
      res.status(ack.status).set(ack.headers).end();
    } else {
      res.json({ status: 'success' });
    }
  } catch (error) {
    res.status(error.code === 'WEBHOOK' ? 401 : 400).end();
  }
});
```

How each courier is authenticated:

| Courier   | Check performed                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------- |
| Pathao    | `X-PATHAO-Signature` header equals your webhook secret                                            |
| Steadfast | `Authorization: Bearer <token>` header equals your secret                                         |
| RedX      | A token you add to the callback URL (`?token=...`) or a header (`x-redx-token`) equals your secret |

All comparisons are constant-time. A secret is mandatory: calling `parseWebhook` without one throws `ConfigError`
unless you pass `allowUnverified: true`, which you should only do behind another authentication layer.
`verifyHmacSignature(rawBody, secret, signature)` is available for setups that put an HMAC-signing proxy in front.

`event.type` is `status_update`, `tracking_update` (a message without a status change) or `other` (for example
Pathao's integration handshake). A complete server built on `node:http` is in
[`examples/webhook-server.mjs`](examples/webhook-server.mjs).

## Fallback router

```ts
import { CourierRouter, allOf, coversCities, maxCod, maxWeight } from 'courier-bd-sdk';

const router = new CourierRouter({
  strategy: 'cheapest', // or 'priority' (default)
  candidates: [
    { client: pathao, covers: allOf(coversCities([1, 2]), maxWeight(10)) },
    { client: redx, covers: (order) => order.recipient.areaId !== undefined },
    { client: steadfast, covers: maxCod(50_000) },
  ],
});

const quotes = await router.quote(order); // every candidate: covered? charge? error?
const plan = await router.plan(order); // the order in which candidates would be tried
const routed = await router.createOrder(order);

console.log(routed.provider, routed.order.consignmentId, routed.charge?.total);
await router.client(routed.provider).trackOrder(routed.order.consignmentId);
```

- **Coverage** - `covers` is any sync or async predicate. Built-ins: `coversCities`, `coversZones`, `coversAreas`,
  `coversPostCodes`, `maxCod`, `maxWeight`, `allOf`, `anyOf`, `not`. A rule that throws counts as "not covered".
- **Priority** - candidates are tried in `priority` order (lower first; list order by default).
- **Cheapest** - every covering candidate is quoted with `calculateCharge`; the lowest total goes first, ties keep
  priority order, and couriers that cannot quote go last. Use `chargeInput` to adapt the quote request per courier.
- **Per-courier input** - location ids differ between couriers. Use `prepare(order)` on a candidate to translate your
  order into that courier's ids before it is sent.
- **Failover** - on an SDK error the next candidate is tried. `TimeoutError` does **not** fail over by default, since
  the first courier may have booked the parcel; opt in with `failoverOnTimeout: true` or supply `shouldFailover`.
  Errors that are not SDK errors are rethrown immediately.
- **Circuit breaker** - after 3 consecutive infrastructure failures (auth, rate limit, network, timeout, 5xx) a
  courier is skipped for 60 seconds. Tune with `circuitBreaker: { failureThreshold, cooldownMs }` or pass `false`.
- **Observability** - `onEvent` receives `skip`, `quote`, `attempt`, `success` and `failure` events.

When every candidate is skipped or fails, `createOrder` rejects with `NoCourierAvailableError`, whose `attempts`
array records what happened to each one.

## CLI

```bash
npx courier-bd --help

courier-bd track  <provider> <id> [--by consignment|invoice|tracking] [--json]
courier-bd create <provider> --invoice <id> --name <name> --phone <phone> --address <address> --cod <amount> [options] [--json]
courier-bd charge <provider> --weight <kg> [--cod <amount>] [options] [--json]
```

Credentials come from environment variables:

| Provider    | Required                                                                        | Optional                                                                  |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pathao`    | `PATHAO_CLIENT_ID`, `PATHAO_CLIENT_SECRET`, `PATHAO_USERNAME`, `PATHAO_PASSWORD` | `PATHAO_STORE_ID`, `PATHAO_SANDBOX`, `PATHAO_BASE_URL`                    |
| `steadfast` | `STEADFAST_API_KEY`, `STEADFAST_SECRET_KEY`                                     | `STEADFAST_BASE_URL`                                                      |
| `redx`      | `REDX_ACCESS_TOKEN`                                                             | `REDX_PICKUP_STORE_ID`, `REDX_PICKUP_AREA_ID`, `REDX_SANDBOX`, `REDX_BASE_URL` |

```bash
export STEADFAST_API_KEY=your-api-key STEADFAST_SECRET_KEY=your-secret-key

courier-bd track steadfast INV-1001 --by invoice
courier-bd create steadfast --invoice INV-1002 --name "Test Customer" --phone 01712345678 \
  --address "House 1, Road 2, Dhanmondi, Dhaka" --cod 1200
courier-bd charge redx --weight 0.5 --cod 1200 --area 100 --pickup-area 1 --json
```

Create options: `--weight`, `--quantity`, `--city`, `--zone`, `--area`, `--area-name`, `--store`, `--note`,
`--description`, `--express`. Exit codes: `0` success, `1` request failed, `2` usage or configuration error. Secrets
from the environment are never printed. The same variables work in code through `createCourierFromEnv('pathao')`; see
[`.env.example`](.env.example).

## Examples

Runnable scripts are in [`examples/`](examples): one per courier, the router, and a webhook server. They import the
package by name, so build first:

```bash
npm install && npm run build
node --env-file=.env examples/steadfast.mjs
```

They call the real courier APIs with whatever credentials you provide, so use sandbox credentials where a courier
offers them.

## Verification status

Please read this before relying on the SDK.

- **The adapters are tested against mocked HTTP responses only.** The test suite never touches the network. This
  project has **not** been tested against the live or sandbox APIs of Pathao, Steadfast or RedX.
- Endpoint paths, request field names, response shapes and status strings were written from each courier's merchant
  API documentation as understood at the time of writing. Couriers revise their APIs, and some behaviour is
  undocumented, so any of these may be wrong or out of date.
- **Before production use, check each adapter against the courier's current merchant API documentation and run it
  against a sandbox or a small number of real parcels.** Verify at least: base URLs, authentication, the
  create-order payload, the tracking response, and the status strings your account actually receives.
- To make that check easy, everything courier-specific lives in exactly one module per courier:
  [`src/providers/pathao/mapping.ts`](src/providers/pathao/mapping.ts),
  [`src/providers/steadfast/mapping.ts`](src/providers/steadfast/mapping.ts) and
  [`src/providers/redx/mapping.ts`](src/providers/redx/mapping.ts). Each holds the base URLs, endpoint paths, field
  names, validation limits and the status table. Fixing a mismatch is normally a change to that one file.
- Without changing the source you can already override `baseUrl`, add `statusOverrides`, adjust validation `rules`
  and pass additional payload fields through `extra`.
- The webhook payload shapes and authentication headers carry the same caveat.
- The default validation limits (COD maximum, weight range, text lengths) are conservative assumptions, not
  contractual limits published by the couriers.

Corrections backed by current documentation or real responses are very welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- **Cancellation** is implemented for RedX only. Pathao and Steadfast reject `cancelOrder` with
  `UnsupportedOperationError`; cancel those in the merchant panel.
- **Steadfast charges** are local estimates from a rate card you supply. There is no live quote.
- **Pathao bulk creation** is asynchronous on Pathao's side: no consignment ids are returned, so reconcile through
  webhooks or the merchant panel.
- **RedX bulk creation** is emulated with single requests; it is not atomic and is subject to rate limits.
- **Pathao tracking** works by consignment id only and returns the current status, not a history.
- **RedX history entries** carry free-text messages only. Their per-event status is a best-effort guess from the
  English message and is `unknown` when nothing matches. The top-level `status` comes from the parcel's status field.
- **RedX returns in progress** (`agent_returning`) are reported as `returned`; inspect `providerStatus` to tell a
  return in progress from a completed one.
- **Pathao COD fee** - the price response's `cod_percentage` is interpreted as a fraction (`0.01` is 1%). Confirm this
  against a real quote for your account.
- **RedX webhooks** are not signed by the courier. Authentication relies on a secret token you place in the callback
  URL or a header, so serve the endpoint over HTTPS only.
- **Location ids are not unified.** Each courier has its own city, zone and area ids; the SDK does not map between
  them. Use the router's `prepare` hook with your own lookup table.
- **No pickup-store management, payment or invoice endpoints** beyond the read-only helpers `listStores()` (Pathao),
  `listPickupStores()` (RedX) and `getBalance()` (Steadfast).
- **ESM only**, Node 22 or newer. There is no CommonJS build and no browser support (courier APIs are not meant to be
  called from a browser with merchant credentials).
- Amounts are in BDT throughout and weights in kilograms.

## Development

```bash
npm install
npm run build      # tsc into dist/
npm test           # build, then node --test "dist/test/*.test.js"
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how to add a courier.

## License

[MIT](LICENSE) - Copyright (c) 2026 Saizul Amin

This is an independent open-source project. It is not affiliated with, endorsed by or supported by Pathao, Steadfast
Courier or RedX. Their names are used only to identify the APIs this SDK talks to.

## Install from GitHub Packages

Releases are published as `@saizul/courier-bd-sdk` on GitHub Packages:

```bash
echo "@saizul:registry=https://npm.pkg.github.com" >> .npmrc
npm install @saizul/courier-bd-sdk
```

GitHub Packages needs a personal access token with `read:packages` in your npm config to install.
