import test from 'node:test';
import assert from 'node:assert/strict';
import {idempotencyHash, payloadHash, parseEvent} from './policy.ts';

test('requires a bounded idempotency key without unsafe characters', () => {
  for (const key of [undefined, '', 'a'.repeat(129), 'white space', 'é', 'line\nbreak']) {
    assert.throws(() => idempotencyHash(key), error => (error as {status?:number}).status === 400);
  }
  assert.equal(idempotencyHash('a').length, 64);
  assert.notEqual(idempotencyHash('a'), idempotencyHash('b'));
});
test('hashes only the normalized product fields in a stable order', () => {
  const payload = {name:'Product', description:'Test', price:1, stock:0, category:'books', imageUrl:'https://example.invalid/p.jpg'};
  assert.equal(payloadHash(payload), payloadHash({...payload, unexpected:'ignored'}));
  assert.notEqual(payloadHash(payload), payloadHash({...payload, price:2}));
});
test('rejects malformed, oversized and unsupported transport events', () => {
  const good = {version:1, jobId:'000000000000002a00000001', generation:1};
  assert.deepEqual(parseEvent(JSON.stringify(good)), good);
  for (const value of ['bad', '{}', 'a'.repeat(1025), JSON.stringify({...good, version:2}), JSON.stringify({...good, jobId:'../../private'}), JSON.stringify({...good, generation:0}), JSON.stringify({...good, generation:1.5})]) {
    assert.throws(() => parseEvent(value));
  }
});
