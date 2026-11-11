// Create and track a Pathao order.
// Run: npm run build && node --env-file=.env examples/pathao.mjs
import { ValidationError, createCourierFromEnv } from 'courier-bd-sdk';

const pathao = createCourierFromEnv('pathao');

// Pathao addresses a recipient by city, zone and (optionally) area ids.
const cities = await pathao.listCities();
const dhaka = cities.find((city) => city.name.toLowerCase() === 'dhaka') ?? cities[0];
if (!dhaka) throw new Error('Pathao returned no cities');
const zones = await pathao.listZones(dhaka.id);
const zone = zones[0];
if (!zone) throw new Error(`Pathao returned no zones for ${dhaka.name}`);
console.log(`Delivering to ${dhaka.name} / ${zone.name}`);

const quote = await pathao.calculateCharge({ cityId: dhaka.id, zoneId: zone.id, weightKg: 0.5, codAmount: 1200 });
console.log(`Quoted ${quote.total} BDT (delivery ${quote.deliveryCharge}, COD ${quote.codCharge})`);

try {
  const order = await pathao.createOrder({
    merchantOrderId: `EXAMPLE-${Date.now()}`,
    recipient: {
      name: 'Test Customer',
      phone: '+880 1712-345678',
      address: 'House 1, Road 2, Dhanmondi, Dhaka',
      cityId: dhaka.id,
      zoneId: zone.id,
    },
    codAmount: 1200,
    weightKg: 0.5,
    itemDescription: 'Cotton T-shirt',
  });
  console.log(`Created ${order.consignmentId} (${order.status})`);

  const tracking = await pathao.trackOrder(order.consignmentId);
  console.log(`Current status: ${tracking.status} (${tracking.providerStatus ?? 'n/a'})`);
} catch (error) {
  if (error instanceof ValidationError) {
    for (const issue of error.issues) console.error(`${issue.field}: ${issue.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
