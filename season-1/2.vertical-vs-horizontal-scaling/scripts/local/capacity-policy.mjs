import assert from 'node:assert/strict';

export function faultTraffic(log){
  const statuses={};let completedRequests=0;
  for(const line of log.split(/\r?\n/)){
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(event.kind!=='edge'||!['/products','/users/me','/cart','/wishlist'].includes(event.route)||!Number.isInteger(event.status))continue;
    completedRequests++;statuses[event.status]=(statuses[event.status]??0)+1;
  }
  assert.ok(completedRequests>0,'No business traffic completed inside the actual fault interval');
  return {completedRequests,statuses};
}

export function capacityRates(base) {
  assert.ok(Number.isSafeInteger(base)&&base>=1&&base<=200);
  return [...new Set([base,Math.min(200,base*2),Math.min(200,base*4)])];
}
export function parseAdmission(text){
  const result={};
  for(const field of ['active','limit','high_water','rejected_total']){
    const matches=[...text.matchAll(new RegExp(`^app_admission_${field}(?:\\{[^\\n]*\\})?\\s+([0-9.e+-]+)$`,'gm'))];
    assert.equal(matches.length,1,`Missing or ambiguous admission ${field}`);
    result[field]=Number(matches[0][1]);assert.ok(Number.isFinite(result[field])&&result[field]>=0);
  }
  return result;
}
export function summarizeCapacity(trials) {
  assert.ok(trials.length>0);
  const rates=[...new Set(trials.map(row=>row.offeredIterationsPerSecond))].sort((a,b)=>a-b);
  const levels=rates.map(rate=>{
    const rows=trials.filter(row=>row.offeredIterationsPerSecond===rate);
    const qualified=rows.every(row=>row.passed&&row.correctnessFailures===0&&row.droppedIterations===0&&Number.isFinite(row.p95Ms)&&row.p95Ms<150);
    const latencies=rows.map(row=>row.p95Ms).sort((a,b)=>a-b);
    const median=latencies.length%2?latencies[Math.floor(latencies.length/2)]:(latencies[latencies.length/2-1]+latencies[latencies.length/2])/2;
    return {offeredIterationsPerSecond:rate,trials:rows.length,qualified,p95MedianMs:median,p95RangeMs:[latencies[0],latencies.at(-1)],requests:rows.reduce((sum,row)=>sum+row.requests,0),failures:rows.reduce((sum,row)=>sum+(row.failResponses??0),0),drops:rows.reduce((sum,row)=>sum+row.droppedIterations,0)};
  });
  // Only a contiguous qualifying ladder is supported. A lucky later trial
  // cannot hide an earlier failure or prove the untested rates in between.
  let highestSupportedTestedRate=null;
  for(const level of levels){if(!level.qualified)break;highestSupportedTestedRate=level.offeredIterationsPerSecond;}
  return {levels,highestSupportedTestedRate,maximumCapacityEstablished:false,interpretation:'Bounded offered rates with correct responses, zero drops/errors and p95 <150ms in every repeat. Not a maximum-capacity or long-soak claim; failed levels and non-monotonic results remain visible.'};
}
export function summarizeOutage(raw,exitCode) {
  const values=name=>raw.metrics?.[name]?.values??raw.metrics?.[name];
  for(const name of ['http_reqs','checks','learning_correctness_failures','learning_explicit_unavailable','http_req_duration'])assert.ok(values(name),`Missing outage metric ${name}`);
  const requests=values('http_reqs').count,checkFailures=values('checks').fails,correctnessFailures=values('learning_correctness_failures').count,unavailable=values('learning_explicit_unavailable').count,drops=values('dropped_iterations')?.count??0,maxMs=values('http_req_duration').max;
  assert.ok([requests,checkFailures,correctnessFailures,unavailable,drops,maxMs].every(Number.isFinite),'Incomplete outage measurements');
  return {requests,checkFailures,correctnessFailures,explicitUnavailable:unavailable,droppedIterations:drops,p95Ms:values('http_req_duration')['p(95)'],maxMs,exitCode,passed:exitCode===0&&requests>0&&unavailable>0&&checkFailures===0&&correctnessFailures===0&&drops===0&&maxMs<8000,qualification:'Only correct 200 or JSON 503 with Retry-After; at least one explicit unavailable response, no transport errors, no dropped arrivals, all measured responses below 8s. This is containment, not availability.'};
}
