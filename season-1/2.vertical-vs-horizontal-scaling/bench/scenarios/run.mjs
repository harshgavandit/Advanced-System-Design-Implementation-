import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const values=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
for(const key of Object.keys(values)) assert.ok(['topology','run','rate','duration','cache'].includes(key),`Unknown ${key}`);
const cache=values.cache??'off';assert.ok(['on','off'].includes(cache));
const topology=values.topology;
assert.ok(['vertical','horizontal'].includes(topology));
const rate=Number(values.rate||100); assert.ok(Number.isInteger(rate)&&rate>0&&rate<=1000);
const duration=values.duration||'10m'; assert.match(duration,/^[1-9][0-9]*[sm]$/);
const run=Number(values.run||1); assert.ok(Number.isInteger(run)&&run>0&&run<=10);
const artifacts=resolve(topic,'infra/compose/artifacts/benchmarks');
await mkdir(artifacts,{recursive:true});
const key=`${topology}-${run}-${Date.now()}`;
const container=`scaling-benchmark-${process.pid}`;
const image='grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603';
function docker(args) {
  const r=spawnSync('docker',args,{encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
const ids=docker(['ps','--filter','label=com.docker.compose.project=scaling-production-lab','--filter','label=com.docker.compose.service=api','--format','{{.ID}}']).split(/\r?\n/).filter(Boolean);
assert.equal(ids.length,topology==='vertical'?1:4);
const configuration=JSON.parse(docker(['inspect',...ids])).map(c=>({id:c.Id,image:c.Image,sourceTreeSha256:c.Config.Labels['org.scaling.source.sha256'],cpus:c.HostConfig.NanoCpus/1e9,memory:c.HostConfig.Memory,workers:Number(c.Config.Env.find(v=>v.startsWith('WORKERS='))?.split('=')[1]||1),publicCache:c.Config.Env.includes('PUBLIC_CATALOG_CACHE=true')}));
assert.ok(configuration.every(row=>row.publicCache===(cache==='on')),'Requested cache mode must match every serving container');
assert.equal(configuration.reduce((sum,c)=>sum+c.cpus,0),4);
assert.equal(configuration.reduce((sum,c)=>sum+c.memory,0),4*1024**3);
assert.equal(configuration.reduce((sum,c)=>sum+c.workers,0),4);
assert.equal(new Set(configuration.map(c=>c.image)).size,1);
for(const config of configuration) assert.match(config.sourceTreeSha256,/^[a-f0-9]{64}$/,'Use stack.ps1 -Build to record image provenance');
const cacheProbe=await fetch('http://127.0.0.1:18082/products?page=1&limit=20',{headers:{'accept-encoding':'identity'},signal:AbortSignal.timeout(5000)});
assert.ok(cacheProbe.ok);
const cacheHeader=cacheProbe.headers.get('x-catalog-cache');
assert.ok(cache==='on'?['hit','miss','joined'].includes(cacheHeader):cacheHeader===null,'Cache behavior must match the declared mode, not only an environment flag');
await cacheProbe.arrayBuffer();
async function query(expression) {
  const response=await fetch('http://127.0.0.1:19092/api/v1/query?query='+encodeURIComponent(expression),{signal:AbortSignal.timeout(5000)});
  assert.ok(response.ok);
  const result=await response.json();assert.equal(result.status,'success');
  return result.data.result.map(row=>({labels:row.metric,value:Number.isFinite(Number(row.value[1]))?Number(row.value[1]):null}));
}
let healthyTargets=[];
for(let i=0;i<60;i++) {
  const response=await fetch('http://127.0.0.1:19092/api/v1/targets',{signal:AbortSignal.timeout(5000)});
  healthyTargets=(await response.json()).data.activeTargets.filter(t=>t.labels.job==='production-lab-api'&&t.health==='up');
  if(healthyTargets.length===ids.length)break;
  await new Promise(r=>setTimeout(r,500));
}
assert.equal(healthyTargets.length,ids.length,'Every replica must be scraped directly before measurement');
const catalogCounter='sum(app_http_requests_total{route="/products",method="GET",status_code="200"})';
const requestsBefore=(await query(catalogCounter))[0]?.value||0;
const samples=[];
const report={startedAt:new Date().toISOString(),topology,run,rate,duration,configuration,passed:false,samples,synthetic:true,compression:'off',cache:'disabled',telemetry:{scrapedReplicas:healthyTargets.length,requestsBefore},limits:{apiCpu:4,apiMemoryGiB:4,gatewayCpu:0.25,gatewayMemoryMiB:128,mongoCpu:1,mongoMemoryMiB:768,loadCpu:1,loadMemoryMiB:512},dataset:{count:10000,seed:42},limitations:['Read-only catalog workload; not mixed production capacity.','Prometheus worker metrics exclude cluster supervisor overhead; Docker container samples include it.','CPU samples are Docker percentages, not CPU time integrated over the whole test.','Prometheus latency/resource queries cover their final 5-minute window, not the whole run.']};
report.dataset=JSON.parse(await readFile(resolve(topic,'infra/compose/artifacts/container-verification.json'),'utf8')).dataset;
report.cache=cache==='on'?'public-cache-aside':'disabled';
const child=spawn('docker',['run','--rm','--name',container,'--network','scaling-production-lab_backend','--cpus=1','--memory=512m','-v',`${resolve(topic,'bench/scenarios')}:/scripts:ro`,'-v',`${artifacts}:/results`,'-e',`RATE=${rate}`,'-e',`DURATION=${duration}`,image,'run','--summary-export='+`/results/${key}-k6.json`,'/scripts/catalog.js'],{stdio:['ignore','pipe','pipe']});
let output=''; child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
const timer=setInterval(()=>{
  try {samples.push({at:new Date().toISOString(),stats:docker(['stats','--no-stream','--format','{{json .}}',...ids,container,'scaling-production-lab-mongo-1','scaling-production-lab-gateway-1']).split(/\r?\n/).map(line=>JSON.parse(line))});}catch(error){samples.push({at:new Date().toISOString(),samplingError:error.message});}
  if(samples.length%12===0) console.log(`BENCHMARK_PROGRESS topology=${topology} run=${run} samples=${samples.length}`);
},5000);
try {
  const [code]=await once(child,'exit');
  clearInterval(timer);
  report.result=JSON.parse(await readFile(resolve(artifacts,`${key}-k6.json`),'utf8'));
  assert.equal(code,0,`Benchmark thresholds failed. See ${key}-output.txt`);
  await new Promise(r=>setTimeout(r,7000));
  report.telemetry.requestsAfter=(await query(catalogCounter))[0]?.value||0;
  report.telemetry.observedRequestDelta=report.telemetry.requestsAfter-requestsBefore;
  report.telemetry.snapshots={
    poolCheckoutP95Seconds:await query('histogram_quantile(0.95,sum by(le)(rate(app_mongo_pool_checkout_seconds_bucket{job="production-lab-api"}[5m])))'),
    mongoCommandP95Seconds:await query('histogram_quantile(0.95,sum by(le,command)(rate(app_mongo_command_seconds_bucket{job="production-lab-api"}[5m])))'),
    workerRssBytes:await query('sum(runtime_process_resident_memory_bytes{job="production-lab-api"})'),
    worstWorkerEventLoopP99Seconds:await query('max(runtime_nodejs_eventloop_lag_p99_seconds{job="production-lab-api"})'),
    gcP95Seconds:await query('histogram_quantile(0.95,sum by(le)(rate(runtime_nodejs_gc_duration_seconds_bucket{job="production-lab-api"}[5m])))'),
  };
  if(duration==='10m') assert.ok(report.telemetry.observedRequestDelta>=report.result.metrics.http_reqs.count*0.98,'Aggregated app metrics must cover the measured client requests');
  report.passed=true;
  console.log(`BENCHMARK_PASS topology=${topology} run=${run} duration=${duration} rate=${rate}`);
} finally {
  clearInterval(timer);
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(artifacts,`${key}-output.txt`),output);
  await writeFile(resolve(artifacts,`${key}-report.json`),JSON.stringify(report,null,2)+'\n');
}
