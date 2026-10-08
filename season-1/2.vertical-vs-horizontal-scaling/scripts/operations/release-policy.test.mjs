import test from 'node:test';import assert from 'node:assert/strict';
import {assessWindow,rollout,validatePromotion,validateTarget} from './release-policy.mjs';
const target={enabled:true,environment:'staging',accountId:'111111111111',region:'ap-south-1',repository:'111111111111.dkr.ecr.ap-south-1.amazonaws.com/scaling-staging-api',url:'https://staging.example.invalid',cluster:'scaling-staging',services:{api:'api',worker:'worker',outbox:'outbox'}};
test('cloud placeholders and accidental HTTP/account targets fail closed',()=>{
  assert.equal(validateTarget(target),target);
  for(const patch of [{enabled:false},{accountId:'000000000000'},{url:'http://example.invalid'},{repository:'PLACEHOLDER'},{cluster:'another-project'}])assert.throws(()=>validateTarget({...target,...patch}));
});
test('SLO gate requires a complete measured window and enough traffic',()=>{
 const sample={seconds:300,requests:1000,failed:0,p95Ms:100};
 assert.equal(assessWindow({...sample,seconds:299},{baselineP95Ms:100}).decision,'insufficient');
 assert.equal(assessWindow({...sample,requests:299},{baselineP95Ms:100}).decision,'insufficient');
 assert.equal(assessWindow({...sample,failed:11},{baselineP95Ms:100}).decision,'rollback');
 assert.equal(assessWindow({...sample,p95Ms:160},{baselineP95Ms:100}).decision,'rollback');
 assert.equal(assessWindow({...sample,p95Ms:130},{baselineP95Ms:100}).decision,'continue');
 assert.equal(assessWindow({...sample,isolationFailure:true},{baselineP95Ms:100}).decision,'rollback');
 assert.equal(assessWindow({...sample,failed:NaN},{baselineP95Ms:100}).decision,'rollback');
 for(const baselineP95Ms of [0,-1,Infinity])assert.equal(assessWindow(sample,{baselineP95Ms}).decision,'rollback');
 assert.equal(assessWindow({...sample,p95Ms:-1},{baselineP95Ms:100}).decision,'rollback');
});
test('production promotion requires passing staging evidence for exactly the signed artifact',()=>{
 const release={digest:'sha256:abc',sourceSha:'abc'},staging={...release,environment:'staging',passed:true,cloud:true,journey:{passed:true},baselineP95Ms:100,sloWindows:[0,1,2].map(index=>({at:new Date(1700000000000+index*300000).toISOString(),seconds:300,requests:1000,failed:0,p95Ms:100}))};
 validatePromotion(release,staging);
 for(const patch of [{passed:false},{digest:'sha256:different'},{sourceSha:'different'},{environment:'production'},{cloud:false},{journey:{passed:false}},{baselineP95Ms:0},{sloWindows:[]},{sloWindows:staging.sloWindows.map(row=>({...row,failed:20}))},{sloWindows:staging.sloWindows.map(row=>({...row,at:staging.sloWindows[0].at}))}])assert.throws(()=>validatePromotion(release,{...staging,...patch}));
});
test('bad business behavior restores every changed service to its captured revision',async()=>{
 const calls=[],adapter={current:async role=>'old-'+role,migrate:async()=>{},deploy:async role=>calls.push('deploy-'+role),ready:async()=>{},rollback:async(role,revision)=>calls.push('rollback-'+role+'-'+revision),verifyRollback:async()=>calls.push('restored-business')};
 const result=await rollout({adapter,verify:async()=>{throw Error('wrong product contents')},observe:async()=>{}});
 assert.equal(result.rolledBack,true);assert.equal(result.passed,false);
 assert.deepEqual(calls.slice(3),['rollback-outbox-old-outbox','rollback-worker-old-worker','rollback-api-old-api','restored-business']);
});
test('readiness failure restores even the service whose update failed partway',async()=>{
 const calls=[],adapter={current:async role=>'old-'+role,migrate:async()=>{},deploy:async role=>{calls.push(role);if(role==='worker')throw Error('bad startup')},ready:async()=>{},rollback:async role=>calls.push('restore-'+role),verifyRollback:async()=>calls.push('restored-business')};
 const result=await rollout({adapter,verify:async()=>{},observe:async()=>{}});
 assert.equal(result.rolledBack,true);assert.deepEqual(calls,['api','worker','restore-worker','restore-api','restored-business']);
});
test('ready rollback is not recovered until the previous-version business journey passes',async()=>{
 const adapter={current:async()=> 'old',migrate:async()=>{},deploy:async()=>{throw Error('startup')},ready:async()=>{},rollback:async()=>{},verifyRollback:async()=>{throw Error('restored version serves wrong contents')}};
 const result=await rollout({adapter,verify:async()=>{},observe:async()=>{}});
 assert.equal(result.rolledBack,false);assert.deepEqual(result.rollbackFailures,['business-journey']);
 assert.deepEqual(result.rollbackErrors,[{role:'business-journey',message:'restored version serves wrong contents'}]);
});
test('migration failure never touches serving revisions; rollback failure is not called recovered',async()=>{
 const adapter={current:async()=> 'old',migrate:async()=>{throw Error('migration')},deploy:async()=>assert.fail(),ready:async()=>{},rollback:async()=>assert.fail()};
 assert.equal((await rollout({adapter,verify:async()=>{},observe:async()=>{}})).events.length,0);
 const failing={...adapter,migrate:async()=>{},deploy:async()=>{throw Error('deployment')},rollback:async()=>{throw Error('rollback')}};
 assert.equal((await rollout({adapter:failing,verify:async()=>{},observe:async()=>{}})).rolledBack,false);
});
