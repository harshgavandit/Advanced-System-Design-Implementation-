import test from 'node:test';
import assert from 'node:assert/strict';
import {vuFixtureSlot,initialRefreshClock} from './vu-fixture.js';
test('every instance-wide VU has an isolated token family without modulo collisions', () => {
  const slots=Array.from({length:102},(_,index)=>vuFixtureSlot(index+1,102));
  assert.equal(new Set(slots).size,102);
  assert.notEqual(vuFixtureSlot(1,102),vuFixtureSlot(101,102));
  for(const id of [0,-1,103,1.5,NaN])assert.throws(()=>vuFixtureSlot(id,102),RangeError);
  assert.throws(()=>vuFixtureSlot(101,100),RangeError,'An undersized fixture must fail instead of sharing sessions');
});
test('a late-activated VU refreshes using token issuance instead of activation time', () => {
  const issuedAt=1700000000, activatedAt=issuedAt*1000+16*60000;
  assert.ok(activatedAt-initialRefreshClock(issuedAt,0)>720000);
  assert.equal(initialRefreshClock(issuedAt,20),issuedAt*1000-100000);
  assert.ok(issuedAt*1000+60000-initialRefreshClock(issuedAt,20)<720000);
  for(const value of [0,-1,NaN,Infinity])assert.throws(()=>initialRefreshClock(value,0),RangeError);
});
