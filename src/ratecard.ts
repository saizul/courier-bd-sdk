import { ConfigError, ValidationError } from './errors.js';
import type { Charge, ChargeInput } from './types.js';
import { roundMoney } from './utils.js';

/**
 * A static price list for couriers that publish rates in the merchant panel
 * but expose no pricing endpoint (e.g. Steadfast). All figures are in BDT and
 * supplied by you; the SDK ships no built-in prices.
 */
export interface RateCard {
  /** Base delivery charge per zone key, covering up to `baseWeightKg`. */
  zones: Readonly<Record<string, number>>;
  /** Zone used when the charge request has no `rateZone`. */
  defaultZone?: string;
  /** Weight included in the base charge. Default 1 kg. */
  baseWeightKg?: number;
  /** Charge for each started kilogram above `baseWeightKg`. Default 0. */
  extraPerKg?: number;
  /** COD fee as a percentage of the collected amount (1 means 1%). Default 0. */
  codPercent?: number;
}

/** Fail fast on a malformed rate card. */
export function assertRateCard(card: RateCard, provider?: string): void {
  const options = provider !== undefined ? { provider } : {};
  const entries = Object.entries(card.zones ?? {});
  if (entries.length === 0) throw new ConfigError('Rate card must define at least one zone', options);
  for (const [zone, price] of entries) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new ConfigError(`Rate card zone "${zone}" must have a non-negative price`, options);
    }
  }
  if (card.defaultZone !== undefined && !(card.defaultZone in card.zones)) {
    throw new ConfigError(`Rate card default zone "${card.defaultZone}" is not defined in zones`, options);
  }
  for (const key of ['baseWeightKg', 'extraPerKg', 'codPercent'] as const) {
    const value = card[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new ConfigError(`Rate card ${key} must be a non-negative number`, options);
    }
  }
}

/** Compute an estimated charge from a rate card. */
export function chargeFromRateCard(provider: string, card: RateCard, input: ChargeInput): Charge {
  const zone = input.rateZone ?? card.defaultZone;
  if (zone === undefined) {
    throw new ValidationError(`[${provider}] rateZone is required to estimate a charge from the rate card`, {
      provider,
      issues: [{ field: 'rateZone', code: 'required', message: 'rateZone is required (no default zone configured)' }],
    });
  }
  const base = card.zones[zone];
  if (base === undefined) {
    throw new ValidationError(`[${provider}] unknown rate zone "${zone}"`, {
      provider,
      issues: [
        {
          field: 'rateZone',
          code: 'unknown_zone',
          message: `Unknown rate zone "${zone}"; expected one of: ${Object.keys(card.zones).join(', ')}`,
        },
      ],
    });
  }
  const baseWeight = card.baseWeightKg ?? 1;
  const extraKg = Math.max(0, Math.ceil(input.weightKg - baseWeight - 1e-9));
  const deliveryCharge = roundMoney(base + extraKg * (card.extraPerKg ?? 0));
  const codCharge = roundMoney(((input.codAmount ?? 0) * (card.codPercent ?? 0)) / 100);
  return {
    provider,
    deliveryCharge,
    codCharge,
    discount: 0,
    total: roundMoney(deliveryCharge + codCharge),
    currency: 'BDT',
    estimated: true,
    raw: { zone, base, extraKg, card },
  };
}
