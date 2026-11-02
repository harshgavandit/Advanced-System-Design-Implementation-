import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {capacityRates,summarizeCapacity,summarizeOutage,parseAdmission,faultTraffic} from './capacity-policy.mjs';

test('capacity ladder is bounded and does not hide a failed rate behind a later lucky result',()=>{
  assert.deepEqual(capacityRates(20),[20,40,80]);assert.deepEqual(capacityRates(100),[100,200]);
  assert.throws(()=>capacityRates(201));
  const row=rate=>({offeredIterationsPerSecond:rate,passed:true,correctnessFailures:0,droppedIterations:0,p95Ms:100,requests:300,failResponses:0});
  const summary=summarizeCapacity([row(20),row(20),{...row(40),p95Ms:151},row(80)]);
  assert.equal(summary.highestSupportedTestedRate,20);assert.equal(summary.maximumCapacityEstablished,false);
  assert.equal(summary.levels[1].qualified,false);assert.equal(summary.levels[2].qualified,true);
  assert.equal(summarizeCapacity([{...row(20),correctnessFailures:1}]).highestSupportedTestedRate,null);
  assert.equal(summarizeCapacity([{...row(20),droppedIterations:1}]).highestSupportedTestedRate,null);
});
test('dependency outage cannot pass missing data, wrong bodies, no observed fault, transport failure or slow response',()=>{
  const raw={metrics:{http_reqs:{count:100},checks:{fails:0},learning_correctness_failures:{count:0},learning_explicit_unavailable:{count:90},http_req_duration:{max:5000,'p(95)':4000}}};
  assert.equal(summarizeOutage(raw,0).passed,true);
  for(const patch of [{learning_explicit_unavailable:{count:0}},{checks:{fails:1}},{learning_correctness_failures:{count:1}},{dropped_iterations:{count:1}},{http_req_duration:{max:8001}}])assert.equal(summarizeOutage({metrics:{...raw.metrics,...patch}},0).passed,false);
  assert.equal(summarizeOutage(raw,99).passed,false);assert.throws(()=>summarizeOutage({metrics:{}},0));
});
test('gateway retries dead connections but never retries a peer overload response',async()=>{
  const config=await readFile(new URL('../../infra/compose/gateway.conf',import.meta.url),'utf8');
  assert.match(config,/proxy_next_upstream error timeout http_502;/);
  assert.doesNotMatch(config,/proxy_next_upstream[^;]*http_503/);
  assert.doesNotMatch(config,/proxy_next_upstream[^;]*non_idempotent/);
});
test('direct process admission samples reject missing, ambiguous or invalid metrics',()=>{
  const text=['active 1','limit 2','high_water 2','rejected_total 7'].map(row=>'app_admission_'+row.replace(' ', '{worker="1"} ')).join('\n');
  assert.deepEqual(parseAdmission(text),{active:1,limit:2,high_water:2,rejected_total:7});
  assert.throws(()=>parseAdmission(''));assert.throws(()=>parseAdmission(text+'\n'+text));
});
test('fault overlap requires completed business requests, not only probes or generator startup',()=>{
  assert.throws(()=>faultTraffic('{"kind":"edge","route":"/health","status":200}'),/No business traffic/);
  assert.deepEqual(faultTraffic('noise\n{"kind":"edge","route":"/products","status":200}\n{"kind":"edge","route":"/users/me","status":503}'),{completedRequests:2,statuses:{200:1,503:1}});
});
