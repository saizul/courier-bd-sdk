// Create, track and cancel a RedX parcel.
// Run: npm run build && node --env-file=.env examples/redx.mjs
import { RedxCourier } from 'courier-bd-sdk';

const redx = new RedxCourier({
  accessToken: process.env.REDX_ACCESS_TOKEN ?? '',
  sandbox: process.env.REDX_SANDBOX === 'true',
  ...(process.env.REDX_PICKUP_STORE_ID ? { pickupStoreId: process.env.REDX_PICKUP_STORE_ID } : {}),
  ...(process.env.REDX_PICKUP_AREA_ID ? { pickupAreaId: process.env.REDX_PICKUP_AREA_ID } : {}),
});

// RedX addresses a recipient by delivery area id and name.
const areas = await redx.listAreas({ postCode: 1209 });
const area = areas[0];
if (!area) throw new Error('RedX returned no areas for post code 1209');
console.log(`Delivering to ${area.name} (#${area.id})`);

if (process.env.REDX_PICKUP_AREA_ID) {
  const quote = await redx.calculateCharge({ areaId: area.id, weightKg: 0.5, codAmount: 1200 });
  console.log(`Quoted ${quote.total} BDT`);
}

const parcel = await redx.createOrder({
  merchantOrderId: `EXAMPLE-${Date.now()}`,
  recipient: {
    name: 'Test Customer',
    phone: '01712345678',
    address: 'House 1, Road 2, Dhanmondi, Dhaka',
    areaId: area.id,
    areaName: area.name,
  },
  codAmount: 1200,
  weightKg: 0.5,
});
console.log(`Created ${parcel.consignmentId}`);

const tracking = await redx.trackOrder(parcel.consignmentId);
for (const event of tracking.events) console.log(`  ${event.timestamp ?? '-'}  ${event.status}  ${event.message ?? ''}`);

const cancelled = await redx.cancelOrder(parcel.consignmentId, 'Example run');
console.log(`Cancelled: ${cancelled.cancelled}`);
