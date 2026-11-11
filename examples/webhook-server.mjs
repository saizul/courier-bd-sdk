// Minimal webhook receiver built on node:http.
// Run: npm run build && WEBHOOK_SECRET=change-me node examples/webhook-server.mjs
// Then point each courier's webhook at:
//   POST http://your-host:3000/webhooks/pathao
//   POST http://your-host:3000/webhooks/steadfast
//   POST http://your-host:3000/webhooks/redx?token=<WEBHOOK_SECRET>
import { createServer } from 'node:http';
import { CourierError, isProviderName, parseWebhook, pathaoWebhookResponse } from 'courier-bd-sdk';

const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error('Set WEBHOOK_SECRET');
  process.exit(2);
}
const MAX_BODY_BYTES = 256 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const provider = url.pathname.replace(/^\/webhooks\//, '');
  if (request.method !== 'POST' || !isProviderName(provider)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readBody(request);
    const event = parseWebhook(provider, { headers: request.headers, body, query: url.searchParams }, { secret });

    // Acknowledge quickly; do slow work (database, notifications) asynchronously.
    console.log(`[${event.provider}] ${event.consignmentId || '(handshake)'} -> ${event.status} (${event.providerStatus ?? event.type})`);

    if (provider === 'pathao') {
      // Pathao expects 202 plus an integration-secret header on every delivery.
      const ack = pathaoWebhookResponse(process.env.PATHAO_WEBHOOK_INTEGRATION_SECRET ?? '');
      response.writeHead(ack.status, ack.headers).end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"success"}');
    }
  } catch (error) {
    if (error instanceof RangeError) response.writeHead(413).end();
    else if (error instanceof CourierError && error.code === 'WEBHOOK') response.writeHead(401).end();
    else if (error instanceof CourierError && error.code === 'VALIDATION') response.writeHead(400).end();
    else {
      console.error(error);
      response.writeHead(500).end();
    }
  }
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log('Listening for courier webhooks'));
