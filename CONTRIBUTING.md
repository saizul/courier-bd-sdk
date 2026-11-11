# Contributing

Thanks for taking the time to improve `courier-bd-sdk`. Bug reports, corrections to courier mappings and new
adapters are all welcome.

## Getting started

```bash
git clone https://github.com/saizul/courier-bd-sdk.git
cd courier-bd-sdk
npm install
npm test
```

You need Node.js 22 or newer. There are no runtime dependencies; the only development dependencies are TypeScript
and the Node type definitions. Please keep it that way unless there is a strong reason.

## Project layout

```
src/
  types.ts            normalized models and the CourierClient interface
  status.ts           normalized status enum and the status-mapper factory
  errors.ts           typed error hierarchy
  http.ts             fetch wrapper: timeout, retry, error mapping
  redact.ts           secret redaction
  validation.ts       phone, COD, weight and address validation
  base.ts             shared adapter plumbing
  ratecard.ts         static rate-card charge estimation
  webhooks.ts         webhook verification and parsing
  router.ts           fallback router
  factory.ts          createCourier / environment configuration
  cli.ts, bin.ts      the courier-bd command
  providers/<name>/
    mapping.ts        base URLs, endpoint paths, field names, limits, status table
    client.ts         the adapter (auth, orchestration)
    index.ts          public exports
test/
  helpers/mock-fetch.ts   scripted fetch used by every test
  *.test.ts
examples/
```

The rule that matters most: **everything courier-specific belongs in that courier's `mapping.ts`**. Endpoint paths,
request and response field names and status strings must not leak into `client.ts` or shared modules. That keeps a
change in a courier's API a one-file fix.

## Correcting a courier mapping

The adapters are tested against mocked responses, so reports from real accounts are the most valuable contribution.
If an endpoint, field or status is wrong:

1. Open an issue or pull request describing what the courier actually sends. Link the relevant section of the
   courier's documentation if it is public.
2. Include a sample request or response with **all credentials, tokens, phone numbers, names and addresses replaced
   by placeholders**.
3. Update `mapping.ts` and add or adjust a test that uses the corrected shape.

## Tests

- Tests use `node:test` and `node:assert/strict`, and run against the compiled output:
  `npm test` builds and then runs `node --test "dist/test/*.test.js"`.
- Tests must never touch the network. Use `MockFetch` from `test/helpers/mock-fetch.ts` and the `instant()` helper
  for deterministic sleep and jitter.
- Assert on the outgoing request (path, headers, body) as well as on the normalized result.
- Every behaviour change needs a test. Bug fixes should start with a failing test.

## Code style

- TypeScript in strict mode, ESM with explicit `.js` import suffixes.
- Prefer small pure functions in `mapping.ts`; keep I/O in `client.ts`.
- Public API additions need a doc comment and a mention in `README.md` and `CHANGELOG.md`.
- Never log or throw raw credentials. Register secrets with the client's redactor.
- Do not retry non-idempotent requests on ambiguous failures; a duplicate parcel costs a merchant real money.

## Adding a courier

1. Create `src/providers/<name>/mapping.ts`, `client.ts` and `index.ts`, following an existing adapter. Extend
   `BaseCourier` and declare accurate `capabilities`.
2. Add the provider to `PROVIDERS` in `src/types.ts`, to `src/factory.ts` (including its environment variables) and
   to the exports in `src/index.ts`.
3. Add webhook support in `src/webhooks.ts` if the courier sends webhooks.
4. Add `test/<name>.test.ts` covering authentication, each operation, error mapping and the status table.
5. Document the courier in `README.md`: usage, the capability table, the status table and any limitations.

## Commits and pull requests

- Keep pull requests focused; one logical change each.
- Describe what changed and why, and how you verified it.
- Make sure `npm test` passes on Node 22 and 24 (CI runs both).

## Security

Please do not open public issues for security problems (for example a way to leak credentials through logs or
errors). Report them privately through GitHub's "Report a vulnerability" feature on the repository.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
