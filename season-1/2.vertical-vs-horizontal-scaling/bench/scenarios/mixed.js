import http from 'k6/http';import {check,sleep} from 'k6';import exec from 'k6/execution';import {SharedArray} from 'k6/data';import {Counter,Trend} from 'k6/metrics';
import {canonicalJson} from './json-equal.js';
import {workloadBucket} from './workload-mix.js';
import {vuFixtureSlot,initialRefreshClock} from './vu-fixture.js';
import encoding from 'k6/encoding';
import {profileDurationSeconds} from './workload-duration.js';
const fixture=new SharedArray('synthetic sessions',()=>[JSON.parse(open('/private/sessions.json'))])[0];
const profile=JSON.parse(__ENV.PROFILE_JSON),base=__ENV.URL||'http://gateway-load:8080',run=__ENV.RUN_ID;
const plannedSeconds=profileDurationSeconds(profile);
const minimumMainIterations=profile.rate?profile.rate*plannedSeconds:undefined;
const accepted=new Counter('accepted_ingestions'),completion=new Trend('ingestion_completion_ms',true),correctness=new Counter('correctness_failures');
http.setResponseCallback(http.expectedStatuses(200,201,202,404));
export const options={scenarios:{mixed:{...profile,exec:'mixed',gracefulStop:'60s'},authentication:{executor:'constant-arrival-rate',rate:2,timeUnit:'1m',duration:__ENV.AUTH_DURATION,startTime:'5s',preAllocatedVUs:2,maxVUs:2,exec:'authentication'}},thresholds:{checks:['rate==1'],http_req_failed:['rate==0'],dropped_iterations:['count==0'],correctness_failures:['count==0'],...(Number.isFinite(minimumMainIterations)?{'iterations{scenario:mixed}':['count>='+minimumMainIterations]}:{}),'iterations{scenario:authentication}':['count>='+Math.ceil(plannedSeconds/30)],'http_req_duration{kind:catalog}':['p(95)<150','p(99)<300'],'http_req_duration{kind:write}':['p(95)<400'],'http_req_duration{kind:authentication}':['p(95)<1000'],ingestion_completion_ms:['p(95)<10000']},summaryTrendStats:['avg','p(95)','p(99)','max']};
let state;
function call(method,path,body,token,key,kind='read') {
 const response=http.request(method,base+path,body?JSON.stringify(body):null,{headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},tags:{name:path.replace(/[a-f0-9]{24}/g,':id'),kind},timeout:'10s'});
 return response;
}
function ensure(ok,label) {if(!check(ok,{[label]:value=>value===true}))correctness.add(1);return ok;}
function json(response) {try{return response.json();}catch{return {};}}
function refresh(account) {
 const response=call('POST','/users/refresh',{refreshToken:account.refreshToken},null,null,'authentication'),body=json(response);
 if(!ensure(response.status===200&&!!body.accessToken,'serialized real refresh succeeds'))return;
 account.accessToken=body.accessToken;account.refreshToken=body.refreshToken;
}
export function mixed() {
 correctness.add(0);
 const slot=vuFixtureSlot(exec.vu.idInInstance,fixture.pairs.length),pair=fixture.pairs[slot];
 if(!state){
  // Decode only for scheduling. The API verifies each token's signature and claims.
  const issuedAt=Math.min(...[pair.user,pair.admin].map(account=>JSON.parse(encoding.b64decode(account.accessToken.split('.')[1],'rawurl','s')).iat));
  state={user:{...pair.user},admin:{...pair.admin},refreshed:initialRefreshClock(issuedAt,slot)};
 }
 if(Date.now()-state.refreshed>720000){refresh(state.user);refresh(state.admin);state.refreshed=Date.now();}
 const iteration=exec.scenario.iterationInTest,bucket=workloadBucket(iteration),productId=fixture.productIds[slot],key=run+'-'+exec.vu.idInInstance+'-'+exec.vu.iterationInScenario;
 if(bucket<70) {
  const response=call('GET',bucket%2===0?'/products?page=1&limit=20':'/products/'+productId,null,null,null,'catalog'),body=json(response);
  ensure(response.status===200&&(bucket%2===0?body.items?.length===20&&body.totalItems>=10000:body._id===productId),'populated canonical catalog');
 }else if(bucket<90) {
  const response=call('GET','/users/me',null,state.user.accessToken,null,'identity');ensure(response.status===200&&json(response)._id===state.user.id,'session belongs to correct user');
 }else if(bucket<98) {
  const path=bucket<94?'/cart':'/wishlist',body={productId,...(path==='/cart'?{qty:1}:{})};
  const created=call('POST',path,body,state.user.accessToken,key,'write'),line=json(created);
  if(ensure([200,201].includes(created.status)&&!!line._id,'write acknowledged')) {
   const replay=call('POST',path,body,state.user.accessToken,key,'write');ensure(canonicalJson(json(replay))===canonicalJson(line),'same key has one write effect');
   const own=call('GET',path+'/'+line._id,null,state.user.accessToken,null,'identity');ensure(own.status===200&&json(own)._id===line._id&&(path!=='/cart'||json(own).qty===line.qty),'write is immediately readable');
   // A separately authorized local ingestion operator is still a different principal.
   const outsider=call('GET',path+'/'+line._id,null,state.admin.accessToken,null,'identity');ensure(outsider.status===404,'a different valid principal cannot read the owned line');
   const removed=call('DELETE',path+'/'+line._id,null,state.user.accessToken,key+'-delete','write');ensure(removed.status===200,'owned synthetic line removed');
  }
 }else {
  const start=Date.now(),payload={name:'Mixed '+key,description:'load-run-'+run,price:1,stock:1,category:'books',imageUrl:'https://example.invalid/synthetic'};
  const response=call('POST','/products/ingest',payload,state.admin.accessToken,key,'ingestion'),job=json(response);
  if(ensure(response.status===202&&!!job.jobId,'ingestion has durable acknowledgement')) {
   accepted.add(1);let status;
   for(let i=0;i<120;i++){const result=call('GET','/ingestion-jobs/'+job.jobId,null,state.admin.accessToken,null,'ingestion');status=json(result);if(status.status==='succeeded'||status.status==='failed')break;sleep(0.25);}
   ensure(status?.status==='succeeded','acknowledged job completes');completion.add(Date.now()-start);
  }
 }
 // Bounded user think time distributes writes without changing HTTP latency measurements.
 sleep(0.5);
}
export function authentication() {
 const user=fixture.auth[exec.scenario.iterationInTest%2],response=call('POST','/users/login',{email:user.email,password:user.password},null,null,'authentication'),body=json(response);
 if(ensure(response.status===200&&!!body.accessToken,'real password login')) {
  const refreshed=call('POST','/users/refresh',{refreshToken:body.refreshToken},null,null,'authentication');ensure(refreshed.status===200,'refresh token rotates');
  const token=json(refreshed).accessToken;ensure(call('POST','/users/logout',null,token,null,'authentication').status===200,'logout revokes session');
 }
}
