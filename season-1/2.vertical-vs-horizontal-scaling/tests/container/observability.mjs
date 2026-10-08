import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=resolve(topic,'infra/compose/artifacts');
const keys=JSON.parse((await readFile(resolve(artifacts,'local-keys.json'),'utf8')).replace(/^\uFEFF/,''));
const authorization='Basic '+Buffer.from('lab-admin:'+keys.grafana).toString('base64');
const report={startedAt:new Date().toISOString(),passed:false,synthetic:true,checks:[],limitations:['Single-host local synthetic proof, not real users or multi-AZ production.','Bounded UDP logs can lose events; load-generator counts are authoritative.','A local alert webhook is not a configured human on-call channel.','No 30-day SLO claim.']};
const base='http://127.0.0.1:18082',grafana='http://127.0.0.1:13002';
function docker(args){const result=spawnSync('docker',args,{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
async function json(url,options={}){const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});assert.ok(response.ok,`${url.split('?')[0]} returned ${response.status}`);return response.json();}
async function gf(path){return json(grafana+path,{headers:{authorization,accept:'application/json'}});}
async function query(expression){const result=await json('http://127.0.0.1:19092/api/v1/query?query='+encodeURIComponent(expression));assert.equal(result.status,'success');return result.data.result;}
async function receiverCounts(){const text=await(await fetch('http://127.0.0.1:19190/metrics')).text();const rows=text.split('\n');return {drops:rows.filter(row=>row.startsWith('telemetry_events_dropped_total{')).reduce((sum,row)=>sum+Number(row.split(' ').at(-1)),0),catalogRequests:rows.filter(row=>row.startsWith('edge_http_requests_total{')&&row.includes('route="/products"')&&row.includes('method="GET"')).reduce((sum,row)=>sum+Number(row.split(' ').at(-1)),0)};}
async function until(check,label,timeout=90000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch(error){last=error;}await new Promise(done=>setTimeout(done,1000));}throw new Error(`${label} timed out${last?': '+last.message:''}`);}
async function api(path,{method='GET',body,token,key=randomUUID(),traceparent,status=200}={}){const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{}) ,...(['POST','PATCH','PUT','DELETE'].includes(method)?{'idempotency-key':key}:{}),...(traceparent?{traceparent}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});assert.equal(response.status,status,`${method} ${path}`);return {body:await response.json(),traceId:response.headers.get('x-trace-id')};}
const apiIDs=docker(['ps','--filter','label=com.docker.compose.project=scaling-production-lab','--filter','label=com.docker.compose.service=api','--format','{{.ID}}']).split(/\r?\n/).filter(Boolean);
assert.equal(apiIDs.length,4);
for(const id of [...apiIDs,'scaling-production-lab-mongo-1','scaling-production-lab-worker-1','scaling-production-lab-outbox-1'])assert.equal(JSON.parse(docker(['inspect',id]))[0].Config.Labels['scaling.owner'],'production-lab');
const victim=apiIDs[3];let stopped=false,load,loadDone,loadOutput='',demoProduct,adminToken;
try{
  report.image=docker(['inspect','--format','{{.Image}}',apiIDs[0]]);
  report.sourceTreeSha256=docker(['inspect','--format','{{index .Config.Labels "org.scaling.source.sha256"}}',apiIDs[0]]);
  const dashboard=await until(()=>gf('/api/dashboards/uid/catalog-production-lab'),'provisioned dashboard');assert.equal(dashboard.dashboard.panels.length,18);
  assert.deepEqual((await gf('/api/datasources')).map(row=>row.uid).sort(),['scaling-loki','scaling-prometheus','scaling-tempo']);
  await until(async()=>Number((await query('sum(app_readiness{job="production-lab-api"})'))[0]?.value[1])===4,'four ready processes');
  assert.equal(Number((await query('sum(container_cgroup_available{job="production-lab-api"})'))[0]?.value[1]),4);
  assert.equal(Number((await query('sum(container_cpu_limit_cores{job="production-lab-api"})'))[0]?.value[1]),4);
  assert.equal(Number((await query('sum(container_memory_limit_bytes{job="production-lab-api"})'))[0]?.value[1]),4*1024**3);
  report.checks.push('18 provisioned panels, three private datasources, four direct ready API scrapes and real cgroup limits');

  const identity=randomUUID(),email=`observability-${identity}@example.invalid`,password='Synthetic-observability-password';
  const account=await api('/users/signup',{method:'POST',body:{name:'Synthetic trace operator',email,password},status:201});adminToken=account.body.accessToken;
  // Only this newly created synthetic principal is promoted in the owned local lab.
  const grant=docker(['exec','scaling-production-lab-mongo-1','mongosh','mongodb://localhost:27017/production_lab?replicaSet=production-lab','--quiet','--eval',`const id=ObjectId('${account.body.user.id}');const user=db.users.findOne({_id:id,email:${JSON.stringify(email)}});if(!user)quit(2);db.users.updateOne({_id:id},{$set:{role:'admin'}});db.audit_events.insertOne({actor:String(id),action:'local-observability-admin-grant',at:new Date(),synthetic:true});print('GRANTED_SYNTHETIC_ONLY')`]);
  assert.equal(grant,'GRANTED_SYNTHETIC_ONLY');
  const traceId=randomBytes(16).toString('hex'),traceparent=`00-${traceId}-${randomBytes(8).toString('hex')}-01`,key=randomUUID();
  const payload={name:`Trace payload ${identity}`,description:`Private payload marker ${identity}`,price:7,stock:2,category:'books',imageUrl:`https://example.invalid/${identity}`};
  const accepted=await api('/products/ingest',{method:'POST',token:adminToken,key,body:payload,traceparent,status:202});assert.equal(accepted.traceId,traceId);
  const job=await until(async()=>{const result=(await api('/ingestion-jobs/'+accepted.body.jobId,{token:adminToken})).body;assert.notEqual(result.status,'failed');return result.status==='succeeded'?result:false;},'durable synthetic job');demoProduct=job.productId;
  const trace=await until(async()=>{const value=await gf('/api/datasources/proxy/uid/scaling-tempo/api/traces/'+traceId);const serialized=JSON.stringify(value);return serialized.includes('ingestion.publish')&&serialized.includes('ingestion.process')?value:false;},'API relay worker trace');
  const serialized=JSON.stringify(trace);
  for(const forbidden of [identity,email,password,key,adminToken,payload.description])assert.ok(!serialized.includes(forbidden),'Trace must not retain payload, token or identity');
  for(const service of ['catalog-api','outbox-relay','catalog-worker'])assert.ok(serialized.includes(service),`Missing traced service ${service}`);
  report.trace={traceId,jobId:job.jobId,status:job.status,services:['catalog-api','outbox-relay','catalog-worker'],payloadRedacted:true};
  await until(async()=>Number((await query('sum(app_ingestion_completion_seconds_count)'))[0]?.value[1])>=1,'successful completion latency observation');
  await until(async()=>{const logs=await gf('/api/datasources/proxy/uid/scaling-loki/loki/api/v1/query_range?query='+encodeURIComponent('{service="catalog-api"} |= "'+traceId+'"')+'&limit=20');return logs.data?.result?.length?logs:false;},'trace-correlated Loki logs');
  report.checks.push('majority-accepted durable job completed and API, relay, worker share one payload-redacted trace; correlated Loki log exists');
  await api('/products/'+demoProduct,{method:'DELETE',token:adminToken});demoProduct=undefined;
  const countsBefore=await receiverCounts();

  load=spawn('docker',['run','--rm','--name',`scaling-observability-load-${process.pid}`,'--network','scaling-production-lab_backend','--cpus=1','--memory=512m','-v',resolve(topic,'bench/scenarios')+':/scripts:ro','-v',artifacts+':/results','-e','RATE=100','-e','DURATION=3m','grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603','run','--summary-export=/results/observability-k6.json','/scripts/catalog.js'],{stdio:['ignore','pipe','pipe']});loadDone=once(load,'exit');load.stdout.on('data',part=>loadOutput+=part);load.stderr.on('data',part=>loadOutput+=part);
  const drillStart=new Date().toISOString();
  docker(['stop','--time','20',victim]);stopped=true;
  await until(async()=>{const evidence=await json('http://127.0.0.1:19190/evidence');return evidence.alerts.find(row=>row.at>=drillStart&&row.alertname==='ApiReplicaUnavailable'&&row.status==='firing');},'replica alert delivery');
  docker(['start',victim]);stopped=false;
  await until(async()=>Number((await query('sum(app_readiness{job="production-lab-api"})'))[0]?.value[1])===4,'restored readiness');
  await until(async()=>{const evidence=await json('http://127.0.0.1:19190/evidence');return evidence.alerts.find(row=>row.at>=drillStart&&row.alertname==='ApiReplicaUnavailable'&&row.status==='resolved');},'resolved alert delivery');
  report.alertDelivery=(await json('http://127.0.0.1:19190/evidence')).alerts.filter(row=>row.at>=drillStart);
  console.log('OBSERVABILITY_PROGRESS traced ingestion, redacted logs and firing/resolved alert verified; fixed-arrival load continues');
  const [code]=await loadDone;
  const loadResult=JSON.parse(await readFile(resolve(artifacts,'observability-k6.json'),'utf8'));report.load={rate:100,duration:'3m',requests:loadResult.metrics.http_reqs.count,p95Ms:loadResult.metrics.http_req_duration['p(95)'],p99Ms:loadResult.metrics.http_req_duration['p(99)'],failedRequests:loadResult.metrics.http_req_failed.passes,droppedIterations:loadResult.metrics.dropped_iterations?.count??0};
  assert.equal(code,0,'Fixed-arrival load thresholds failed');
  const countsAfter=await receiverCounts();report.telemetry={droppedDuringLoad:countsAfter.drops-countsBefore.drops,edgeCatalogRequests:countsAfter.catalogRequests-countsBefore.catalogRequests};
  assert.equal(report.telemetry.droppedDuringLoad,0,'Successful load must not hide local evidence loss');
  assert.ok(report.telemetry.edgeCatalogRequests>=report.load.requests*0.995,'Edge telemetry must reconcile with the independent load-generator count');
  await until(async()=>Number((await query('sum(rate(edge_http_requests_total{route="/products",method="GET"}[1m]))'))[0]?.value[1])>95,'edge request throughput');
  const logs=await gf('/api/datasources/proxy/uid/scaling-loki/loki/api/v1/query_range?query='+encodeURIComponent('{environment="local-synthetic"}')+'&limit=100');
  const logText=JSON.stringify(logs);for(const forbidden of [email,password,adminToken,payload.description])assert.ok(!logText.includes(forbidden),'Logs must remain redacted');
  report.catalogProducts=Number((await query('max(app_ingestion_state{state="catalogProducts"})'))[0]?.value[1]);
  report.syntheticProfiles=Number((await query('max(app_ingestion_state{state="syntheticProfiles"})'))[0]?.value[1]);
  assert.equal(report.catalogProducts,10000);assert.ok(report.syntheticProfiles>0);
  report.checks.push('100 req/s fixed-arrival catalog load during replica stop/restore; alert firing and resolved delivery recorded; synthetic DB counts reconciled');
  report.passed=true;console.log(`OBSERVABILITY_PASS requests=${report.load.requests} p95=${report.load.p95Ms}ms`);
}finally{
  if(stopped)docker(['start',victim]);
  if(demoProduct&&adminToken)await api('/products/'+demoProduct,{method:'DELETE',token:adminToken}).catch(()=>{});
  if(loadDone)await loadDone;
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(artifacts,'observability-k6-output.txt'),loadOutput);
  await writeFile(resolve(artifacts,'phase6-observability.json'),JSON.stringify(report,null,2)+'\n');
}
