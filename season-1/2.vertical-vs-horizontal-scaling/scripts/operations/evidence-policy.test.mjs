import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceStatus, launchDecision} from './evidence-policy.mjs';

test('a successful report for a different artifact remains historical', () => {
  const current = {sourceHash: 'current', imageId: 'current-image'};
  assert.equal(evidenceStatus(null, current), 'missing');
  assert.equal(evidenceStatus({passed: false}, current), 'failed');
  assert.equal(evidenceStatus({passed: false, verificationPassed: true, image: 'current-image'}, current), 'failed');
  assert.equal(evidenceStatus({passed: true}, current), 'unbound');
  assert.equal(evidenceStatus({passed: true, sourceTreeSha256: 'old'}, current), 'historical');
  assert.equal(evidenceStatus({passed: true, configuration: [{image: 'old-image'}]}, current), 'historical');
  assert.equal(evidenceStatus({passed: true, image: 'current-image'}, current), 'passed');
});

test('mixed reports require the current scenario and every serving replica', () => {
  const current={imageId:'current-image',scenarioSha256:'current-scenario'};
  const report={passed:true,configuration:[{image:'current-image'}],scenarioSha256:'current-scenario'};
  assert.equal(evidenceStatus(report,current),'passed');
  assert.equal(evidenceStatus({...report,scenarioSha256:'old-scenario'},current),'historical');
  assert.equal(evidenceStatus({...report,scenarioSha256:undefined},current),'unbound');
  assert.equal(evidenceStatus({...report,configuration:[{image:'current-image'},{image:'old-image'}]},current),'historical');
});

test('local proof, partial soak and absent operating history cannot pass launch', () => {
  const pass = {passed: true};
  const inputs = {cloud: {...pass, cloud: true}, support: pass, soak: {...pass, profile: 'soak', measuredSeconds: 14400, result: {metrics: {'iterations{scenario:mixed}': {count: 720000}}}}, recovery: pass, rollback: pass, security: pass, observationDays: 30};
  assert.equal(launchDecision(inputs).approved, true);
  assert.equal(launchDecision({...inputs,soak:{...inputs.soak,result:{metrics:{iterations:{count:720480}}}}}).approved,false,'Authentication iterations cannot substitute for the required main workload');
  for (const override of [{cloud: {...pass, cloud: false}}, {soak: {...inputs.soak, profile: 'smoke'}}, {soak: {...inputs.soak, measuredSeconds: 60}}, {soak: {...pass, profile: 'soak'}}, {recovery: {passed: false}}, {observationDays: 0}]) {
    assert.equal(launchDecision({...inputs, ...override}).approved, false);
  }
});
