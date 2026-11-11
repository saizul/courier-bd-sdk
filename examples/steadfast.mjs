// Create, bulk-create and track Steadfast consignments.
// Run: npm run build && node --env-file=.env examples/steadfast.mjs
import { SteadfastCourier } from 'courier-bd-sdk';

const steadfast = new SteadfastCourier({
  apiKey: process.env.STEADFAST_API_KEY ?? '',
  secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
  // Steadfast has no pricing endpoint. These figures are placeholders: copy
  // the rates from your own merchant panel to get meaningful estimates.
  rateCard: {
    zones: { inside_dhaka: 70, sub_dhaka: 100, outside_dhaka: 130 },
    defaultZone: 'inside_dhaka',
    baseWeightKg: 1,
    extraPerKg: 20,
    codPercent: 1,
  },
});

const estimate = await steadfast.calculateCharge({ weightKg: 2.4, codAmount: 1500, rateZone: 'outside_dhaka' });
console.log(`Estimated ${estimate.total} BDT (estimated: ${estimate.estimated})`);

const order = await steadfast.createOrder({
  merchantOrderId: `EXAMPLE-${Date.now()}`,
  recipient: { name: 'Test Customer', phone: '01712345678', address: 'House 1, Road 2, Dhanmondi, Dhaka' },
  codAmount: 1500,
  note: 'Call before delivery',
});
console.log(`Created ${order.consignmentId}, tracking code ${order.trackingCode ?? 'n/a'}`);

const bulk = await steadfast.bulkCreate([
  { merchantOrderId: `EXAMPLE-A-${Date.now()}`, recipient: { name: 'Customer A', phone: '01812345678', address: 'Agrabad, Chattogram' }, codAmount: 900 },
  { merchantOrderId: `EXAMPLE-B-${Date.now()}`, recipient: { name: 'Customer B', phone: '12345', address: 'Zindabazar, Sylhet' }, codAmount: 650 },
]);
console.log(`Bulk: ${bulk.succeeded} created, ${bulk.failed} failed`);
for (const item of bulk.results) {
  console.log(item.success ? `  ${item.merchantOrderId} -> ${item.order?.consignmentId}` : `  ${item.merchantOrderId} failed: ${item.error?.message}`);
}

const tracking = await steadfast.trackOrder({ merchantOrderId: order.merchantOrderId ?? '' });
console.log(`Status: ${tracking.status}`);
console.log(`Balance: ${await steadfast.getBalance()} BDT`);
