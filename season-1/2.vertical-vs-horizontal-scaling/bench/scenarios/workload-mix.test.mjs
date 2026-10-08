import test from 'node:test';
import assert from 'node:assert/strict';
import {workloadBucket} from './workload-mix.js';

test('each arrival block preserves the workload and distributes costly journeys', () => {
  for (const offset of [0, 100, 720000]) {
    const buckets = Array.from({length: 100}, (_, index) => workloadBucket(offset + index));
    assert.equal(new Set(buckets).size, 100);
    assert.equal(buckets.filter(value => value < 70).length, 70);
    assert.equal(buckets.filter(value => value >= 70 && value < 90).length, 20);
    assert.equal(buckets.filter(value => value >= 90 && value < 98).length, 8);
    assert.equal(buckets.filter(value => value >= 98).length, 2);
    assert.ok(buckets.every((value, index) => value < 90 || buckets[(index + 1) % 100] < 90), 'write journeys must not be artificially clustered');
  }
});
