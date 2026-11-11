import { parseArgs } from 'node:util';
import { CourierError, ValidationError } from './errors.js';
import { ENV_VARS, createCourierFromEnv, isProviderName, type Env } from './factory.js';
import type { FetchLike } from './http.js';
import { Redactor } from './redact.js';
import { PROVIDERS, type Charge, type ChargeInput, type CreateOrderInput, type Order, type ProviderName, type Tracking, type TrackQuery } from './types.js';
import { VERSION } from './version.js';

export interface CliIO {
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected in tests; defaults to global fetch. */
  fetch?: FetchLike;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {}

export const HELP = `courier-bd ${VERSION} - one CLI for Pathao, Steadfast and RedX

Usage:
  courier-bd track  <provider> <id> [--by consignment|invoice|tracking] [--json]
  courier-bd create <provider> --invoice <id> --name <name> --phone <phone>
                    --address <address> --cod <amount> [options] [--json]
  courier-bd charge <provider> --weight <kg> [--cod <amount>] [options] [--json]
  courier-bd --help | --version

Providers: ${PROVIDERS.join(', ')}

Create options:
  --weight <kg>         Parcel weight in kg (default 0.5)
  --quantity <n>        Number of items (default 1)
  --city <id>           Destination city id (Pathao)
  --zone <id>           Destination zone id (Pathao)
  --area <id>           Destination area id (Pathao, RedX)
  --area-name <name>    Destination area name (RedX)
  --store <id>          Pickup store id (overrides the environment)
  --note <text>         Instruction for the rider
  --description <text>  Item description
  --express             Request express delivery where available

Charge options:
  --city, --zone, --area, --store as above
  --pickup-area <id>    Pickup area id (RedX)

Credentials are read from environment variables:
  pathao     ${ENV_VARS.pathao.required.join(', ')}
             optional: ${ENV_VARS.pathao.optional.join(', ')}
  steadfast  ${ENV_VARS.steadfast.required.join(', ')}
  redx       ${ENV_VARS.redx.required.join(', ')}
             optional: ${ENV_VARS.redx.optional.join(', ')}

Exit codes: 0 success, 1 request failed, 2 usage error.`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  by: { type: 'string' },
  invoice: { type: 'string' },
  name: { type: 'string' },
  phone: { type: 'string' },
  address: { type: 'string' },
  cod: { type: 'string' },
  weight: { type: 'string' },
  quantity: { type: 'string' },
  city: { type: 'string' },
  zone: { type: 'string' },
  area: { type: 'string' },
  'area-name': { type: 'string' },
  'pickup-area': { type: 'string' },
  store: { type: 'string' },
  note: { type: 'string' },
  description: { type: 'string' },
  express: { type: 'boolean' },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

function numberOption(values: Values, key: 'cod' | 'weight' | 'quantity', required: boolean): number | undefined {
  const raw = values[key];
  if (raw === undefined) {
    if (required) throw new UsageError(`Missing required option --${key}`);
    return undefined;
  }
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`Option --${key} must be a number, got "${raw}"`);
  return value;
}

function requiredOption(values: Values, key: 'invoice' | 'name' | 'phone' | 'address'): string {
  const value = values[key];
  if (value === undefined || value.trim() === '') throw new UsageError(`Missing required option --${key}`);
  return value;
}

function buildTrackQuery(id: string, by: string | undefined): TrackQuery {
  switch (by ?? 'consignment') {
    case 'consignment':
      return { consignmentId: id };
    case 'invoice':
      return { merchantOrderId: id };
    case 'tracking':
      return { trackingCode: id };
    default:
      throw new UsageError(`Option --by must be one of: consignment, invoice, tracking (got "${by}")`);
  }
}

function buildOrder(values: Values): CreateOrderInput {
  const order: CreateOrderInput = {
    merchantOrderId: requiredOption(values, 'invoice'),
    recipient: {
      name: requiredOption(values, 'name'),
      phone: requiredOption(values, 'phone'),
      address: requiredOption(values, 'address'),
    },
    codAmount: numberOption(values, 'cod', true) as number,
  };
  const weight = numberOption(values, 'weight', false);
  if (weight !== undefined) order.weightKg = weight;
  const quantity = numberOption(values, 'quantity', false);
  if (quantity !== undefined) order.quantity = quantity;
  if (values.city !== undefined) order.recipient.cityId = values.city;
  if (values.zone !== undefined) order.recipient.zoneId = values.zone;
  if (values.area !== undefined) order.recipient.areaId = values.area;
  if (values['area-name'] !== undefined) order.recipient.areaName = values['area-name'];
  if (values.store !== undefined) order.storeId = values.store;
  if (values.note !== undefined) order.note = values.note;
  if (values.description !== undefined) order.itemDescription = values.description;
  if (values.express) order.deliveryType = 'express';
  return order;
}

function buildCharge(values: Values): ChargeInput {
  const input: ChargeInput = { weightKg: numberOption(values, 'weight', true) as number };
  const cod = numberOption(values, 'cod', false);
  if (cod !== undefined) input.codAmount = cod;
  if (values.city !== undefined) input.cityId = values.city;
  if (values.zone !== undefined) input.zoneId = values.zone;
  if (values.area !== undefined) input.areaId = values.area;
  if (values['pickup-area'] !== undefined) input.pickupAreaId = values['pickup-area'];
  if (values.store !== undefined) input.storeId = values.store;
  if (values.express) input.deliveryType = 'express';
  return input;
}

function withoutRaw<T extends { raw: unknown }>(value: T): Omit<T, 'raw'> {
  const { raw: _raw, ...rest } = value;
  return rest;
}

function printTracking(tracking: Tracking, out: (line: string) => void): void {
  out(`Provider:     ${tracking.provider}`);
  if (tracking.consignmentId) out(`Consignment:  ${tracking.consignmentId}`);
  if (tracking.merchantOrderId) out(`Invoice:      ${tracking.merchantOrderId}`);
  out(`Status:       ${tracking.status}${tracking.providerStatus ? ` (${tracking.providerStatus})` : ''}`);
  if (tracking.updatedAt) out(`Updated:      ${tracking.updatedAt}`);
  if (tracking.events.length > 1 || tracking.events.some((event) => event.message)) {
    out('History:');
    for (const event of tracking.events) {
      out(`  ${event.timestamp ?? '-'}  ${event.status.padEnd(17)} ${event.message ?? ''}`.trimEnd());
    }
  }
}

function printOrder(order: Order, out: (line: string) => void): void {
  out(`Provider:     ${order.provider}`);
  out(`Consignment:  ${order.consignmentId}`);
  if (order.trackingCode && order.trackingCode !== order.consignmentId) out(`Tracking:     ${order.trackingCode}`);
  if (order.merchantOrderId) out(`Invoice:      ${order.merchantOrderId}`);
  out(`Status:       ${order.status}${order.providerStatus ? ` (${order.providerStatus})` : ''}`);
  if (order.deliveryFee !== undefined) out(`Delivery fee: ${order.deliveryFee} BDT`);
  if (order.codAmount !== undefined) out(`COD:          ${order.codAmount} BDT`);
}

function printCharge(charge: Charge, out: (line: string) => void): void {
  out(`Provider:     ${charge.provider}`);
  out(`Delivery:     ${charge.deliveryCharge} BDT`);
  out(`COD charge:   ${charge.codCharge} BDT`);
  if (charge.discount > 0) out(`Discount:     ${charge.discount} BDT`);
  out(`Total:        ${charge.total} BDT${charge.estimated ? ' (estimated from rate card)' : ''}`);
}

/**
 * Run the CLI. Returns the process exit code instead of exiting, so it can be
 * embedded and tested.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const redactor = new Redactor(
    Object.entries(io.env)
      .filter(([key]) => /(SECRET|PASSWORD|TOKEN|API_KEY)/.test(key))
      .map(([, value]) => value),
  );
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const values = parsed.values as Values;
    const [command, providerArg, ...rest] = parsed.positionals;

    if (values.version) {
      io.stdout(VERSION);
      return EXIT_OK;
    }
    if (values.help || command === undefined || command === 'help') {
      io.stdout(HELP);
      return EXIT_OK;
    }
    if (command !== 'track' && command !== 'create' && command !== 'charge') {
      throw new UsageError(`Unknown command "${command}". Expected track, create or charge.`);
    }
    if (providerArg === undefined) throw new UsageError(`Missing provider. Expected one of: ${PROVIDERS.join(', ')}`);
    const providerName = providerArg.toLowerCase();
    if (!isProviderName(providerName)) {
      throw new UsageError(`Unknown provider "${providerArg}". Expected one of: ${PROVIDERS.join(', ')}`);
    }
    const provider: ProviderName = providerName;

    // Validate arguments before touching credentials so usage errors surface first.
    let run: (client: ReturnType<typeof createCourierFromEnv>) => Promise<void>;
    if (command === 'track') {
      const id = rest[0];
      if (id === undefined || id.trim() === '') throw new UsageError('Missing <id> to track');
      if (rest.length > 1) throw new UsageError(`Unexpected argument "${rest[1]}"`);
      const query = buildTrackQuery(id, values.by);
      run = async (client) => {
        const tracking = await client.trackOrder(query);
        if (values.json) io.stdout(JSON.stringify(withoutRaw(tracking), null, 2));
        else printTracking(tracking, io.stdout);
      };
    } else {
      if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}"`);
      if (command === 'create') {
        const order = buildOrder(values);
        run = async (client) => {
          const created = await client.createOrder(order);
          if (values.json) io.stdout(JSON.stringify(withoutRaw(created), null, 2));
          else printOrder(created, io.stdout);
        };
      } else {
        const input = buildCharge(values);
        run = async (client) => {
          const charge = await client.calculateCharge(input);
          if (values.json) io.stdout(JSON.stringify(withoutRaw(charge), null, 2));
          else printCharge(charge, io.stdout);
        };
      }
    }

    const client = createCourierFromEnv(provider, io.env, io.fetch ? { fetch: io.fetch } : {});
    await run(client);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`Usage error: ${error.message}`);
      io.stderr('Run "courier-bd --help" for usage.');
      return EXIT_USAGE;
    }
    if (error instanceof CourierError) {
      io.stderr(`Error (${error.code}): ${redactor.redact(error.message)}`);
      if (error instanceof ValidationError) {
        for (const issue of error.issues) io.stderr(`  - ${issue.field || 'input'}: ${redactor.redact(issue.message)}`);
      }
      return error.code === 'CONFIG' ? EXIT_USAGE : EXIT_FAILURE;
    }
    io.stderr(`Unexpected error: ${redactor.redact(error instanceof Error ? error.message : String(error))}`);
    return EXIT_FAILURE;
  }
}
