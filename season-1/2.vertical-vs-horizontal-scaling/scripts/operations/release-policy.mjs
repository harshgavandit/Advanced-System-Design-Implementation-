import assert from 'node:assert/strict';
export function validateTarget(target){
  assert.equal(target.enabled,true,'Cloud execution is disabled by default');
  assert.ok(['staging','production'].includes(target.environment));
  assert.match(target.accountId,/^[0-9]{12}$/);assert.notEqual(target.accountId,'000000000000');
  assert.match(target.region,/^[a-z]{2}-[a-z]+-[0-9]$/);
  assert.ok(!JSON.stringify(target).includes('PLACEHOLDER'),'Configure placeholders before cloud execution');
  assert.match(target.repository,new RegExp('^'+target.accountId+'\\.dkr\\.ecr\\.'+target.region.replaceAll('.','\\.')+'\\.amazonaws\\.com/[a-z0-9/_-]+$'));
  assert.equal(new URL(target.url).protocol,'https:');
  assert.equal(target.cluster,'scaling-'+target.environment);
  for(const role of ['api','worker','outbox'])assert.equal(target.services[role],role);
  return target;
}
export function assessWindow(sample,{baselineP95Ms,minRequests=300}){
  if(![sample.seconds,sample.requests,sample.failed,sample.p95Ms,baselineP95Ms].every(Number.isFinite)||baselineP95Ms<=0||sample.seconds<=0||sample.p95Ms<0||sample.failed<0||sample.requests<0||sample.failed>sample.requests)return {decision:'rollback',reason:'invalid-telemetry'};
  if(sample.isolationFailure||sample.lostWrite)return {decision:'rollback',reason:'correctness'};
  if(sample.seconds<300||sample.requests<minRequests)return {decision:'insufficient',reason:'traffic'};
  if(sample.failed/sample.requests>0.01)return {decision:'rollback',reason:'service-errors'};
  if(sample.p95Ms>150&&sample.p95Ms>baselineP95Ms*1.2)return {decision:'rollback',reason:'latency'};
  return {decision:'continue'};
}
export function validatePromotion(release,staging){
  assert.equal(staging.passed,true);assert.equal(staging.environment,'staging');
  assert.equal(staging.cloud,true,'Local drills cannot authorize cloud production promotion');
  assert.equal(staging.journey?.passed,true,'A complete staging business journey is required');
  assert.equal(staging.digest,release.digest,'Promote the tested digest, never rebuild');
  assert.equal(staging.sourceSha,release.sourceSha,'Staging evidence must match the signed source');
  assert.ok(Number.isFinite(staging.baselineP95Ms)&&staging.baselineP95Ms>0);
  const windows=staging.sloWindows?.slice(-3);
  assert.equal(windows?.length,3,'Three complete SLO windows are required');
  for(const window of windows){
    assert.equal(assessWindow(window,{baselineP95Ms:staging.baselineP95Ms}).decision,'continue');
  }
  for(let index=1;index<windows.length;index++){
    const interval=Date.parse(windows[index].at)-Date.parse(windows[index-1].at);
    assert.equal(interval,300000,'Staging windows must be consecutive and must not overlap');
  }
}
export async function rollout({roles=['api','worker','outbox'],adapter,verify,observe}){
  const previous={},changed=[],events=[];
  try{
    // Capture every original revision before making the first service change.
    for(const role of roles)previous[role]=await adapter.current(role);
    await adapter.migrate();
    for(const role of roles){changed.push(role);await adapter.deploy(role);await adapter.ready(role);events.push({role,state:'ready'});}
    await verify();await observe();
    return {passed:true,rolledBack:false,previous,events};
  }catch(error){
    const failures=[],rollbackErrors=[];
    for(const role of changed.reverse()){
      try{await adapter.rollback(role,previous[role]);await adapter.ready(role);events.push({role,state:'restored'});}
      catch(restoreError){failures.push(role);rollbackErrors.push({role,message:String(restoreError.message).slice(0,200)});}
    }
    if(changed.length&&failures.length===0){
      try{
        assert.equal(typeof adapter.verifyRollback,'function','Restored services require the previous-version business journey');
        await adapter.verifyRollback();events.push({state:'restored-business-verified'});
      }catch(restoreError){failures.push('business-journey');rollbackErrors.push({role:'business-journey',message:String(restoreError.message).slice(0,200)});}
    }
    return {passed:false,rolledBack:failures.length===0,previous,events,failure:String(error.message).slice(0,200),rollbackFailures:failures,rollbackErrors};
  }
}
