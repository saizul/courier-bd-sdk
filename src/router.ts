import {
  AuthError,
  ConfigError,
  CourierError,
  NetworkError,
  NoCourierAvailableError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  type RouteAttempt,
} from './errors.js';
import type { Charge, ChargeInput, CourierClient, CreateOrderInput, Id, Order } from './types.js';

export type CoverageRule = (order: CreateOrderInput) => boolean | Promise<boolean>;

export interface RouteCandidate {
  client: CourierClient;
  /** Unique name; defaults to `client.provider`. Needed when the same provider appears twice. */
  name?: string;
  /** Lower runs first. Defaults to the candidate's position in the list. */
  priority?: number;
  /** Whether this courier can take the order. Defaults to "always". */
  covers?: CoverageRule;
  /**
   * Adapt the order for this courier, e.g. attach the provider-specific
   * city/zone/area ids. Receives a shallow copy; return the order to send.
   */
  prepare?: (order: CreateOrderInput) => CreateOrderInput | Promise<CreateOrderInput>;
  /** Build the charge request used by the `cheapest` strategy. Defaults to fields taken from the order. */
  chargeInput?: (order: CreateOrderInput) => ChargeInput;
}

export interface CircuitBreakerOptions {
  /** Consecutive infrastructure failures before the candidate is skipped. Default 3. */
  failureThreshold?: number;
  /** How long the candidate stays skipped. Default 60 000 ms. */
  cooldownMs?: number;
}

export type RouterEvent =
  | { type: 'skip'; provider: string; reason: string }
  | { type: 'quote'; provider: string; charge?: Charge; error?: unknown }
  | { type: 'attempt'; provider: string }
  | { type: 'success'; provider: string; order: Order }
  | { type: 'failure'; provider: string; error: unknown; willFailover: boolean };

export interface RouterOptions {
  candidates: readonly RouteCandidate[];
  /**
   * `priority` (default): try candidates in priority order.
   * `cheapest`: quote every covering candidate and try the lowest total
   * first; candidates that cannot quote are tried last, in priority order.
   */
  strategy?: 'priority' | 'cheapest';
  /** Try the next candidate when one fails. Default true. */
  failover?: boolean;
  /**
   * Fail over after a timeout. Off by default: a timed-out create may have
   * succeeded on the courier's side, and booking a second courier would then
   * ship the order twice.
   */
  failoverOnTimeout?: boolean;
  /** Full control over which errors trigger failover. Overrides the default policy. */
  shouldFailover?: (error: unknown, provider: string) => boolean;
  /** Skip couriers that keep failing. Pass `false` to disable. */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Observe routing decisions (logging, metrics). Exceptions thrown here are ignored. */
  onEvent?: (event: RouterEvent) => void;
  now?: () => number;
}

export interface RouteQuote {
  provider: string;
  covered: boolean;
  charge?: Charge;
  /** Why no charge is available (not covered, unsupported, quote failed). */
  error?: unknown;
}

export interface RoutePlanEntry {
  provider: string;
  charge?: Charge;
}

export interface RoutePlan {
  /** Candidates in the order they would be attempted. */
  order: RoutePlanEntry[];
  /** Candidates excluded up front and why. */
  skipped: Array<{ provider: string; reason: string }>;
}

export interface RoutedOrder {
  order: Order;
  /** Name of the candidate that created the order. */
  provider: string;
  /** Everything that happened on the way, in order. */
  attempts: RouteAttempt[];
  /** The winning candidate's quote, when the `cheapest` strategy produced one. */
  charge?: Charge;
}

interface Slot {
  name: string;
  candidate: RouteCandidate;
  priority: number;
  failures: number;
  openUntil: number;
}

/* --------------------------- Coverage helpers --------------------------- */

const idSet = (ids: Iterable<Id>): Set<string> => new Set([...ids].map((id) => String(id)));

/** Covered when the recipient's `cityId` is in the list. */
export function coversCities(cityIds: Iterable<Id>): CoverageRule {
  const set = idSet(cityIds);
  return (order) => order.recipient?.cityId !== undefined && set.has(String(order.recipient.cityId));
}

/** Covered when the recipient's `zoneId` is in the list. */
export function coversZones(zoneIds: Iterable<Id>): CoverageRule {
  const set = idSet(zoneIds);
  return (order) => order.recipient?.zoneId !== undefined && set.has(String(order.recipient.zoneId));
}

/** Covered when the recipient's `areaId` is in the list. */
export function coversAreas(areaIds: Iterable<Id>): CoverageRule {
  const set = idSet(areaIds);
  return (order) => order.recipient?.areaId !== undefined && set.has(String(order.recipient.areaId));
}

/** Covered when the recipient's `postCode` is in the list. */
export function coversPostCodes(postCodes: Iterable<string | number>): CoverageRule {
  const set = idSet(postCodes);
  return (order) => order.recipient?.postCode !== undefined && set.has(String(order.recipient.postCode).trim());
}

/** Covered when the COD amount does not exceed `limit`. */
export function maxCod(limit: number): CoverageRule {
  return (order) => order.codAmount <= limit;
}

/** Covered when the parcel weighs at most `limitKg` (orders without a weight pass). */
export function maxWeight(limitKg: number): CoverageRule {
  return (order) => order.weightKg === undefined || order.weightKg <= limitKg;
}

/** Covered when every rule agrees. */
export function allOf(...rules: CoverageRule[]): CoverageRule {
  return async (order) => {
    for (const rule of rules) if (!(await rule(order))) return false;
    return true;
  };
}

/** Covered when at least one rule agrees. */
export function anyOf(...rules: CoverageRule[]): CoverageRule {
  return async (order) => {
    for (const rule of rules) if (await rule(order)) return true;
    return false;
  };
}

/** Invert a rule. */
export function not(rule: CoverageRule): CoverageRule {
  return async (order) => !(await rule(order));
}

function defaultChargeInput(order: CreateOrderInput): ChargeInput {
  const input: ChargeInput = { weightKg: order.weightKg ?? 0.5, codAmount: order.codAmount };
  const recipient = order.recipient ?? ({} as CreateOrderInput['recipient']);
  if (recipient.cityId !== undefined) input.cityId = recipient.cityId;
  if (recipient.zoneId !== undefined) input.zoneId = recipient.zoneId;
  if (recipient.areaId !== undefined) input.areaId = recipient.areaId;
  if (order.itemType !== undefined) input.itemType = order.itemType;
  if (order.deliveryType !== undefined) input.deliveryType = order.deliveryType;
  if (order.storeId !== undefined) input.storeId = order.storeId;
  return input;
}

/** Failures that say something about the courier's health rather than about one order. */
function isInfrastructureFailure(error: unknown): boolean {
  return (
    error instanceof AuthError ||
    error instanceof RateLimitError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError ||
    (error instanceof ProviderError && (error.status === undefined || error.status >= 500))
  );
}

/**
 * Chooses a courier for each order by coverage rules and either priority or
 * cheapest quote, and fails over to the next candidate when one cannot take
 * the order.
 */
export class CourierRouter {
  private readonly slots: Slot[];
  private readonly strategy: 'priority' | 'cheapest';
  private readonly failover: boolean;
  private readonly failoverOnTimeout: boolean;
  private readonly customShouldFailover: RouterOptions['shouldFailover'];
  private readonly breaker: Required<CircuitBreakerOptions> | undefined;
  private readonly onEvent: RouterOptions['onEvent'];
  private readonly now: () => number;

  constructor(options: RouterOptions) {
    const candidates = options?.candidates ?? [];
    if (candidates.length === 0) throw new ConfigError('CourierRouter needs at least one candidate');
    const seen = new Set<string>();
    this.slots = candidates.map((candidate, index) => {
      if (!candidate?.client) throw new ConfigError(`Router candidate #${index} has no client`);
      const name = candidate.name ?? candidate.client.provider;
      if (seen.has(name)) {
        throw new ConfigError(`Duplicate router candidate "${name}"; give each candidate a unique name`);
      }
      seen.add(name);
      return { name, candidate, priority: candidate.priority ?? index, failures: 0, openUntil: 0 };
    });
    // Stable sort keeps list order among equal priorities.
    this.slots.sort((a, b) => a.priority - b.priority);
    this.strategy = options.strategy ?? 'priority';
    if (this.strategy !== 'priority' && this.strategy !== 'cheapest') {
      throw new ConfigError(`Unknown routing strategy: ${String(options.strategy)}`);
    }
    this.failover = options.failover ?? true;
    this.failoverOnTimeout = options.failoverOnTimeout ?? false;
    this.customShouldFailover = options.shouldFailover;
    this.breaker =
      options.circuitBreaker === false
        ? undefined
        : {
            failureThreshold: options.circuitBreaker?.failureThreshold ?? 3,
            cooldownMs: options.circuitBreaker?.cooldownMs ?? 60_000,
          };
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
  }

  /** Candidate names in priority order. */
  get providers(): string[] {
    return this.slots.map((slot) => slot.name);
  }

  /** The client registered under `name`, for tracking or cancelling after routing. */
  client(name: string): CourierClient {
    const slot = this.slots.find((item) => item.name === name);
    if (!slot) throw new ConfigError(`No router candidate named "${name}"`);
    return slot.candidate.client;
  }

  /** Quote every candidate for the order, without creating anything. */
  async quote(order: CreateOrderInput): Promise<RouteQuote[]> {
    return Promise.all(
      this.slots.map(async (slot): Promise<RouteQuote> => {
        if (!(await this.isCovered(slot, order))) return { provider: slot.name, covered: false };
        try {
          return { provider: slot.name, covered: true, charge: await this.quoteSlot(slot, order) };
        } catch (error) {
          return { provider: slot.name, covered: true, error };
        }
      }),
    );
  }

  /** Decide the order in which candidates would be attempted, without creating anything. */
  async plan(order: CreateOrderInput): Promise<RoutePlan> {
    const { ordered, skipped } = await this.rank(order);
    return {
      order: ordered.map(({ slot, charge }) => (charge ? { provider: slot.name, charge } : { provider: slot.name })),
      skipped,
    };
  }

  /**
   * Create the order with the best available courier, failing over according
   * to the configured policy. Rejects with {@link NoCourierAvailableError}
   * when every candidate was skipped or failed.
   */
  async createOrder(order: CreateOrderInput): Promise<RoutedOrder> {
    const { ordered, skipped } = await this.rank(order);
    const attempts: RouteAttempt[] = skipped.map((skip) => ({ provider: skip.provider, outcome: 'skipped', reason: skip.reason }));

    for (let i = 0; i < ordered.length; i++) {
      const { slot, charge } = ordered[i] as { slot: Slot; charge?: Charge };
      this.emit({ type: 'attempt', provider: slot.name });
      try {
        const prepared = slot.candidate.prepare ? await slot.candidate.prepare({ ...order }) : order;
        const created = await slot.candidate.client.createOrder(prepared);
        slot.failures = 0;
        slot.openUntil = 0;
        attempts.push({ provider: slot.name, outcome: 'success' });
        this.emit({ type: 'success', provider: slot.name, order: created });
        return charge ? { order: created, provider: slot.name, attempts, charge } : { order: created, provider: slot.name, attempts };
      } catch (error) {
        this.recordFailure(slot, error);
        attempts.push({ provider: slot.name, outcome: 'failed', error });
        const hasNext = i < ordered.length - 1;
        const willFailover = this.failover && this.shouldFailover(error, slot.name);
        this.emit({ type: 'failure', provider: slot.name, error, willFailover: willFailover && hasNext });
        if (!willFailover) throw error;
      }
    }

    const tried = attempts.filter((attempt) => attempt.outcome === 'failed').length;
    throw new NoCourierAvailableError(
      tried === 0
        ? 'No courier is available for this order (all candidates were skipped)'
        : `All ${tried} attempted courier(s) failed to create the order`,
      attempts,
    );
  }

  /** Clear circuit-breaker state for one candidate, or all of them. */
  reset(name?: string): void {
    for (const slot of this.slots) {
      if (name !== undefined && slot.name !== name) continue;
      slot.failures = 0;
      slot.openUntil = 0;
    }
  }

  private async rank(order: CreateOrderInput): Promise<{
    ordered: Array<{ slot: Slot; charge?: Charge }>;
    skipped: Array<{ provider: string; reason: string }>;
  }> {
    const skipped: Array<{ provider: string; reason: string }> = [];
    const eligible: Slot[] = [];
    for (const slot of this.slots) {
      if (this.breaker && slot.openUntil > this.now()) {
        skipped.push({ provider: slot.name, reason: 'circuit_open' });
        this.emit({ type: 'skip', provider: slot.name, reason: 'circuit_open' });
        continue;
      }
      if (!(await this.isCovered(slot, order))) {
        skipped.push({ provider: slot.name, reason: 'not_covered' });
        this.emit({ type: 'skip', provider: slot.name, reason: 'not_covered' });
        continue;
      }
      eligible.push(slot);
    }
    if (this.strategy !== 'cheapest') return { ordered: eligible.map((slot) => ({ slot })), skipped };

    const quoted = await Promise.all(
      eligible.map(async (slot): Promise<{ slot: Slot; charge?: Charge }> => {
        try {
          const charge = await this.quoteSlot(slot, order);
          this.emit({ type: 'quote', provider: slot.name, charge });
          return { slot, charge };
        } catch (error) {
          this.emit({ type: 'quote', provider: slot.name, error });
          return { slot };
        }
      }),
    );
    const withCharge = quoted.filter((entry) => entry.charge !== undefined);
    const withoutCharge = quoted.filter((entry) => entry.charge === undefined);
    // `eligible` is already in priority order and Array#sort is stable, so ties keep priority order.
    withCharge.sort((a, b) => (a.charge as Charge).total - (b.charge as Charge).total);
    return { ordered: [...withCharge, ...withoutCharge], skipped };
  }

  private async isCovered(slot: Slot, order: CreateOrderInput): Promise<boolean> {
    if (!slot.candidate.covers) return true;
    try {
      return Boolean(await slot.candidate.covers(order));
    } catch {
      // A coverage rule that throws cannot vouch for the courier.
      return false;
    }
  }

  private quoteSlot(slot: Slot, order: CreateOrderInput): Promise<Charge> {
    const input = slot.candidate.chargeInput ? slot.candidate.chargeInput(order) : defaultChargeInput(order);
    return slot.candidate.client.calculateCharge(input);
  }

  private shouldFailover(error: unknown, provider: string): boolean {
    if (this.customShouldFailover) return this.customShouldFailover(error, provider);
    if (error instanceof TimeoutError) return this.failoverOnTimeout;
    // Anything that is not an SDK error is a bug or an unknown condition; do not mask it.
    return error instanceof CourierError;
  }

  private recordFailure(slot: Slot, error: unknown): void {
    if (!this.breaker || !isInfrastructureFailure(error)) return;
    slot.failures += 1;
    if (slot.failures >= this.breaker.failureThreshold) {
      slot.openUntil = this.now() + this.breaker.cooldownMs;
      slot.failures = 0;
    }
  }

  private emit(event: RouterEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // Observers must not affect routing.
    }
  }
}
