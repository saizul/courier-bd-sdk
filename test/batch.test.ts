import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_TRACK_CONCURRENCY, trackMany, trackQueryKey, type TrackResult } from '../src/batch.js';
import { ProviderError } from '../src/errors.js';
import * as sdk from '../src/index.js';
import type { OrderStatus } from '../src/status.js';
import type { Tracking, TrackQuery } from '../src/types.js';

function tracking(consignmentId: string, status: OrderStatus): Tracking {
  return { provider: 'fake', consignmentId, status, events: [{ status }], raw: {} };
}

class FakeTracker {
  readonly calls: TrackQuery[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly answers: Record<string, OrderStatus | Error>) {}

  async trackOrder(query: TrackQuery): Promise<Tracking> {
    this.calls.push(query);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    this.inFlight -= 1;
    const key = trackQueryKey(query);
    const answer = this.answers[key];
    if (answer === undefined) throw new Error(`unexpected query ${key}`);
    if (answer instanceof Error) throw answer;
    return tracking(key, answer);
  }
}

describe('trackQueryKey', () => {
  test('builds distinct keys for each query form', () => {
    assert.equal(trackQueryKey('C1'), 'C1');
    assert.equal(trackQueryKey({ consignmentId: 42 }), '42');
    assert.equal(trackQueryKey({ merchantOrderId: 'INV-1' }), 'merchant:INV-1');
    assert.equal(trackQueryKey({ trackingCode: 'ABC' }), 'code:ABC');
  });
});

describe('trackMany', () => {
  test('returns results in input order and reports every first sighting as changed', async () => {
    const fake = new FakeTracker({ A: 'pending', B: 'in_transit', C: 'delivered' });
    const result = await trackMany(fake, ['A', 'B', 'C']);
    assert.deepEqual(
      result.results.map((r) => r.key),
      ['A', 'B', 'C'],
    );
    assert.equal(result.changed.length, 3);
    assert.deepEqual(Object.fromEntries(result.statuses), { A: 'pending', B: 'in_transit', C: 'delivered' });
  });

  test('detects changes against previous statuses and skips terminal parcels', async () => {
    const fake = new FakeTracker({ A: 'pending', B: 'out_for_delivery' });
    const result = await trackMany(fake, ['A', 'B', 'C'], {
      previous: { A: 'pending', B: 'in_transit', C: 'delivered' },
    });
    assert.deepEqual(fake.calls, ['A', 'B']);
    assert.deepEqual(
      result.changed.map((r) => [r.key, r.previousStatus, r.tracking.status]),
      [['B', 'in_transit', 'out_for_delivery']],
    );
    assert.deepEqual(
      result.skipped.map((r) => [r.key, r.skipped]),
      [['C', 'terminal']],
    );
    assert.equal(result.statuses.get('C'), 'delivered');
    assert.equal(result.statuses.get('B'), 'out_for_delivery');
  });

  test('accepts a Map of previous statuses', async () => {
    const fake = new FakeTracker({ A: 'returned' });
    const result = await trackMany(fake, ['A'], { previous: new Map([['A', 'in_transit' as OrderStatus]]) });
    assert.equal(result.changed[0]?.previousStatus, 'in_transit');
  });

  test('collects failures without rejecting and keeps the previous status', async () => {
    const boom = new ProviderError('upstream down', { provider: 'fake', status: 502 });
    const fake = new FakeTracker({ A: boom, B: 'delivered' });
    const result = await trackMany(fake, ['A', 'B'], { previous: { A: 'in_transit' } });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.error, boom);
    assert.equal(result.statuses.get('A'), 'in_transit');
    assert.equal(result.statuses.get('B'), 'delivered');
  });

  test('never runs more than `concurrency` requests at once', async () => {
    const answers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`P${i}`, 'pending' as OrderStatus]));
    const fake = new FakeTracker(answers);
    await trackMany(fake, Object.keys(answers), { concurrency: 3 });
    assert.equal(fake.calls.length, 20);
    assert.equal(fake.maxInFlight, 3);
  });

  test('uses the default concurrency', async () => {
    const answers = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`P${i}`, 'pending' as OrderStatus]));
    const fake = new FakeTracker(answers);
    await trackMany(fake, Object.keys(answers));
    assert.equal(fake.maxInFlight, DEFAULT_TRACK_CONCURRENCY);
  });

  test('stops sending requests after the signal aborts', async () => {
    const fake = new FakeTracker({ A: 'pending', B: 'pending', C: 'pending' });
    const controller = new AbortController();
    const seen: TrackResult[] = [];
    const result = await trackMany(fake, ['A', 'B', 'C'], {
      concurrency: 1,
      signal: controller.signal,
      onResult: (r) => {
        seen.push(r);
        controller.abort();
      },
    });
    assert.deepEqual(fake.calls, ['A']);
    assert.deepEqual(
      result.skipped.map((r) => [r.key, r.skipped]),
      [
        ['B', 'aborted'],
        ['C', 'aborted'],
      ],
    );
    assert.equal(seen.length, 3);
  });

  test('rejects an invalid concurrency', async () => {
    await assert.rejects(trackMany(new FakeTracker({}), ['A'], { concurrency: 0 }), RangeError);
  });

  test('is exported from the package entry point', () => {
    assert.equal(sdk.trackMany, trackMany);
    assert.equal(sdk.trackQueryKey, trackQueryKey);
  });
});
