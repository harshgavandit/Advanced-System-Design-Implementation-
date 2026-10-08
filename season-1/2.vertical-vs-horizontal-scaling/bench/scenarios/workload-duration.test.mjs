import test from 'node:test';
import assert from 'node:assert/strict';
import {durationSeconds,profileDurationSeconds} from './workload-duration.js';
import {profiles} from './mixed-policy.mjs';
test('complete durations are required for constant and staged arrival profiles',()=>{
  assert.equal(profileDurationSeconds(profiles.soak),14400);
  assert.equal(profileDurationSeconds(profiles.support),600);
  assert.equal(profileDurationSeconds(profiles.stress),480);
  assert.equal(profileDurationSeconds(profiles.spike),230);
  assert.equal(durationSeconds('1m500ms'),60.5);
  for(const value of ['0s','-1s','4h-extra','NaNm',undefined])assert.throws(()=>durationSeconds(value));
});
