# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `withIdempotency(client, options)` / `IdempotentCourier`: books each merchant order id at most once. Confirmed
  orders are replayed from a pluggable `IdempotencyStore` (in-memory `MemoryIdempotencyStore` included), concurrent
  calls share one request, ambiguous failures (timeout, network, 5xx, unparseable response) are resolved by looking
  the order up by merchant order id where the courier supports it, definite rejections release the key, and reusing
  a key for an order with different contents is refused. `bulkCreate` skips items that already exist and maps result
  indices back to the input.
- `IdempotencyError` (code `IDEMPOTENCY`) with `reason` `in_progress`, `outcome_unknown` or `conflict`.
- `orderFingerprint` and `isAmbiguousCreateFailure` helpers.

## [0.1.0] - 2026-11-11

Initial release.

### Added

- `CourierClient` interface with normalized `Order`, `Tracking`, `Charge`, `City`, `Zone` and `Area` models and a
  `capabilities` descriptor per courier.
- Pathao adapter: OAuth token issue, expiry caching, refresh with password-grant fallback, single-flight token
  requests, optional token store, one replay on `401`; create, bulk create, track, price quote, city/zone/area and
  store listings.
- Steadfast adapter: key-header authentication, create, chunked bulk create, tracking by consignment id, invoice or
  tracking code, balance, and charge estimation from a user-supplied rate card.
- RedX adapter: bearer-token authentication, create, emulated bulk create, tracking with history, cancel, charge
  calculator, area and pickup-store listings.
- Normalized status enum (`pending`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`,
  `partial_delivered`, `returned`, `cancelled`, `on_hold`, `unknown`) with a mapping table per courier and
  `statusOverrides`.
- HTTP layer with per-attempt timeout, exponential backoff with jitter, `Retry-After` support, injectable `fetch`,
  structured logging hook and secret redaction. Order creation is not retried on ambiguous failures by default.
- Typed error hierarchy rooted at `CourierError`.
- Input validation: Bangladesh mobile number normalization (local, `+880`, Bangla digits), COD amount, weight, name
  and address length.
- Webhook verification and parsing for all three couriers into a common `WebhookEvent`.
- `CourierRouter` with coverage rules, priority and cheapest strategies, failover and a circuit breaker.
- `courier-bd` CLI with `track`, `create` and `charge` commands configured through environment variables.
- Test suite of 394 tests running on `node:test` against a mock `fetch`.

### Known limitations

- Adapters are verified against mocked responses only, not against live courier APIs. See "Verification status" in
  the README.

[Unreleased]: https://github.com/saizul/courier-bd-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/courier-bd-sdk/releases/tag/v0.1.0
