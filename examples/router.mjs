// Route each order to the cheapest courier that covers it, with failover.
// Run: npm run build && node --env-file=.env examples/router.mjs
import { CourierRouter, NoCourierAvailableError, allOf, coversCities, createCourierFromEnv, maxCod, maxWeight } from 'courier-bd-sdk';

const pathao = createCourierFromEnv('pathao');
const redx = createCourierFromEnv('redx');
const steadfast = createCourierFromEnv('steadfast', process.env, {
  // Placeholder prices: replace with the rates from your merchant panel.
  rateCard: { zones: { inside_dhaka: 70, outside_dhaka: 130 }, defaultZone: 'outside_dhaka', extraPerKg: 20, codPercent: 1 },
});

// Your own lookup from an internal location to each courier's ids.
const PATHAO_DHAKA_CITY_ID = 1;

const router = new CourierRouter({
  strategy: 'cheapest',
  candidates: [
    {
      client: pathao,
      // Only send Dhaka parcels under 10 kg to Pathao.
      covers: allOf(coversCities([PATHAO_DHAKA_CITY_ID]), maxWeight(10)),
    },
    {
      client: redx,
      covers: (order) => order.recipient.areaId !== undefined && order.recipient.areaName !== undefined,
    },
    {
      client: steadfast,
      covers: maxCod(50_000),
      chargeInput: (order) => ({
        weightKg: order.weightKg ?? 0.5,
        codAmount: order.codAmount,
        rateZone: order.recipient.cityId === PATHAO_DHAKA_CITY_ID ? 'inside_dhaka' : 'outside_dhaka',
      }),
    },
  ],
  onEvent: (event) => {
    if (event.type === 'failure') console.warn(`${event.provider} failed; failing over: ${event.willFailover}`);
  },
});

const order = {
  merchantOrderId: `EXAMPLE-${Date.now()}`,
  recipient: { name: 'Test Customer', phone: '01712345678', address: 'House 1, Road 2, Dhanmondi, Dhaka', cityId: PATHAO_DHAKA_CITY_ID, zoneId: 10 },
  codAmount: 1200,
  weightKg: 1,
};

for (const quote of await router.quote(order)) {
  const price = quote.charge ? `${quote.charge.total} BDT${quote.charge.estimated ? ' (estimate)' : ''}` : quote.covered ? 'no quote' : 'not covered';
  console.log(`${quote.provider.padEnd(10)} ${price}`);
}

try {
  const routed = await router.createOrder(order);
  console.log(`Booked with ${routed.provider}: ${routed.order.consignmentId}`);
  // Keep the provider name next to the consignment id; you need both to track later.
  const tracking = await router.client(routed.provider).trackOrder(routed.order.consignmentId);
  console.log(`Status: ${tracking.status}`);
} catch (error) {
  if (!(error instanceof NoCourierAvailableError)) throw error;
  console.error(error.message);
  for (const attempt of error.attempts) console.error(`  ${attempt.provider}: ${attempt.outcome}`);
  process.exitCode = 1;
}
