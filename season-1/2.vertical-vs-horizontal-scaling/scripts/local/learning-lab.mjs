import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {project,owner,ports,images,scenarios,parseOptions,assertOwned,composeModel,summarizeLoad,dashboard,dashboardContract,waitForHttpReady} from './learning-model.mjs';
import {capacityRates,summarizeCapacity,summarizeOutage,parseAdmission,faultTraffic} from './capacity-policy.mjs';
import {acquireRunnerLock,runCommand,trafficStart} from './learning-lifecycle.mjs';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const options=parseOptions(process.argv.slice(2));
if(options.list){
  console.log('Local synthetic system-design experiments. No cloud credentials or provisioning.');
  for(const [name,definition] of Object.entries(scenarios))console.log(`${name.padEnd(20)} ${definition.expected}`);
  console.log('\nnode scripts/local/learning-lab.mjs --all\nnode scripts/local/learning-lab.mjs --scenario=scaling --duration=1m --rate=40 --repeat=3\nnode scripts/local/learning-lab.mjs --down\nDefaults: baseline, 30s, 20 iterations/s, 2 comparison repeats. --build rebuilds the canonical image.');
  process.exit(0);
}
if(process.platform==='win32')assert.equal(topic.slice(0,3).toUpperCase(),'D:\\','Learning files must stay on D:');
const artifacts=join(topic,'infra/compose/artifacts/learning');
const runtime=join(artifacts,'runtime');
await mkdir(runtime,{recursive:true});
const env={...process.env,TEMP:join(artifacts,'temp'),TMP:join(artifacts,'temp')};
await mkdir(env.TEMP,{recursive:true});
const lockPath=join(artifacts,'runner.lock');
const lock=await acquireRunnerLock(lockPath);
const cancellation=new AbortController();let recovering=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(!cancellation.signal.aborted){console.error(`LEARNING_INTERRUPTED ${signal}: restoring owned resources`);cancellation.abort(new Error(`Interrupted by ${signal}`));}
});

const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex');
const results=join(artifacts,'runs',runId);
const composePath=join(runtime,'compose.json');
if(!options.down)await mkdir(results,{recursive:true});
let image,sourceHash,keys,token,topology='horizontal',cache=false,admissionLimit=64,initialized=false;
const report={runId,synthetic:true,cloudApplied:false,startedAt:new Date().toISOString(),passed:false,options,scenarios:[],limitations:[
  'One Docker Desktop host, one synthetic Mongo primary and ElasticMQ. Not real AWS, Atlas, AZ, HTTPS or production acceptance.',
  'Bounded offered-load trials do not establish saturation capacity or a universal topology winner.',
  'Faults affect only labelled learning resources. Existing development stacks and volumes are not modified.',
  'Backup scenario is a quiesced full archive and independent local restore, not PITR, encrypted offsite recovery or a production RPO/RTO claim.',
  'Worker crashes terminate real component helper processes at actual boundaries. Visibility and lease expiry are accelerated explicitly for the experiment.',
  'Grafana anonymous access is Viewer only on loopback. Local admin keys are private ignored artifacts, not real credentials.',
]};
const pause=ms=>delay(ms,undefined,{signal:recovering?undefined:cancellation.signal});
const jsonFile=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const command=(binary,args,settings={})=>runCommand(binary,args,{...settings,cwd:topic,env,signal:recovering?undefined:cancellation.signal});
const docker=(args,settings)=>command('docker',args,settings);
const compose=(args,settings)=>docker(['compose','-p',project,'-f',composePath,...args],settings);
async function inspect(id){return JSON.parse((await docker(['inspect',id])).stdout)[0];}
async function ids(service,running=false){
  const args=['ps',...(running?[]:['-a']),'--filter',`label=com.docker.compose.project=${project}`,'--filter',`label=com.docker.compose.service=${service}`,'--format','{{.ID}}'];
  const found=(await docker(args)).stdout.split(/\r?\n/).filter(Boolean);
  for(const id of found)assertOwned((await inspect(id)).Config.Labels,service);
  return found;
}
async function id(service){const found=await ids(service,true);assert.equal(found.length,1,`Expected one running owned ${service}`);return found[0];}
async function inventory(){
  const found=(await docker(['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}'])).stdout.split(/\r?\n/).filter(Boolean);
  const allowed=['mongo','mongo-init','redis','queue','api','worker','outbox','gateway','prometheus','grafana','candidate','restore'];
  for(const container of found){const labels=(await inspect(container)).Config.Labels;assert.ok(allowed.includes(labels['com.docker.compose.service']),'Unexpected learning service');assertOwned(labels,labels['com.docker.compose.service']);}
}
async function lifecycle(service,action){
  assert.ok(['stop','start','kill','pause','unpause'].includes(action));
  if(['pause','unpause'].includes(action))assert.equal(service,'mongo','Only the owned synthetic Mongo can be frozen');
  const targets=await ids(service);assert.ok(targets.length>0,`No owned ${service}`);
  await docker([action,...targets]);
}
async function helper(input,{crash=false}={}){
  const target=(await ids('api',true))[0];assert.ok(target,'No running learning API');
  const result=await docker(['exec','-i',target,'node','/lab/helper.mjs'],{input:JSON.stringify(input),allowFailure:crash,timeout:45000});
  assert.equal(result.code,crash?73:0,`Helper failed: ${result.stderr.slice(-1000)}`);
  const line=result.stdout.split(/\r?\n/).find(row=>row.startsWith('LAB_RESULT:'));
  assert.ok(line,`Missing helper result: ${result.stdout.slice(-500)}`);
  return JSON.parse(line.slice(11));
}
async function until(check,label,timeout=120000){
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline){if(!recovering)cancellation.signal.throwIfAborted();try{const value=await check();if(value)return value;}catch(error){last=error;}await pause(1000);}
  throw new Error(`Timed out: ${label}${last?' ('+last.message+')':''}`);
}
const base=`http://127.0.0.1:${ports.api}`;
const grafana=`http://127.0.0.1:${ports.grafana}`;
async function request(path,{method='GET',body,key,auth=false,status=200}={}){
  const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(auth?{authorization:`Bearer ${token}`}:{}) ,...(key?{'idempotency-key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,status,`${method} ${path}: expected ${status}, got ${response.status}`);
  return {json:await response.json(),headers:response.headers};
}
async function ready(){await until(async()=>{const r=await fetch(base+'/ready',{signal:AbortSignal.timeout(3000)});return r.status===200;},'learning gateway readiness');}
async function render(){
  await jsonFile(composePath,composeModel({root:topic,runtime,image,sourceHash,topology,cache,admissionLimit}));
  const scrape=(name,port)=>`  - job_name: ${name}\n    dns_sd_configs:\n      - names: [${name==='learning-api'?'api':name.slice(9)}]\n        type: A\n        port: ${port}\n        refresh_interval: 5s\n`;
  await writeFile(join(runtime,'prometheus.yml'),'global:\n  scrape_interval: 5s\nscrape_configs:\n'+scrape('learning-api',topology==='vertical'?5006:5002)+scrape('learning-worker',5002)+scrape('learning-outbox',5002));
}
async function configure(nextTopology='horizontal',nextCache=false,nextAdmissionLimit=64){
  await inventory();topology=nextTopology;cache=nextCache;admissionLimit=nextAdmissionLimit;await render();
  await compose(['up','-d','--wait','--wait-timeout','180','--scale',`api=${topology==='vertical'?1:4}`,'api','worker','outbox','gateway','prometheus','grafana']);
  await docker(['exec',await id('gateway'),'nginx','-c','/etc/nginx/lab/gateway.conf','-s','reload']);
  await docker(['restart',await id('prometheus')]);
  await waitForHttpReady(`http://127.0.0.1:${ports.prometheus}/-/ready`);
  await until(async()=>{
    const response=await fetch(`http://127.0.0.1:${ports.prometheus}/api/v1/targets`,{signal:AbortSignal.timeout(3000)});if(!response.ok)return false;
    const body=await response.json();const targets=body.data.activeTargets.filter(row=>row.labels.job==='learning-api');
    return targets.length===(topology==='vertical'?1:4)&&targets.every(row=>row.health==='up');
  },'current topology scrapes ready');
  await ready();
  const serving=await ids('api',true);assert.equal(serving.length,topology==='vertical'?1:4);
  let cpu=0,memory=0;
  for(const target of serving){const config=await inspect(target);assert.equal(config.Image,image);cpu+=config.HostConfig.NanoCpus/1e9;memory+=config.HostConfig.Memory;}
  assert.equal(cpu,1);assert.equal(memory,2147483648);
}
async function gatewayTarget(target){
  assert.ok(['api','candidate'].includes(target));
  const original=await readFile(join(topic,'infra/compose/gateway.conf'),'utf8');
  const config=original.replace('include /etc/nginx/edge-logging.conf;','fastcgi_temp_path /tmp/fastcgi_temp;\n  uwsgi_temp_path /tmp/uwsgi_temp;\n  scgi_temp_path /tmp/scgi_temp;').replace('server api:5002 resolve',`server ${target}:5002 resolve`);
  await writeFile(join(runtime,'gateway/gateway.conf'),config);
  if(initialized){const gatewayId=await id('gateway');await docker(['exec',gatewayId,'nginx','-c','/etc/nginx/lab/gateway.conf','-t']);await docker(['exec',gatewayId,'nginx','-c','/etc/nginx/lab/gateway.conf','-s','reload']);await pause(1500);}
}
async function annotation(text,time=Date.now()){
  const response=await fetch(grafana+'/api/annotations',{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from(`learning-admin:${keys.grafana}`).toString('base64')},body:JSON.stringify({dashboardUID:'local-learning-lab',time,text,tags:['learning',runId]}),signal:AbortSignal.timeout(5000)});
  assert.ok(response.ok,`Grafana annotation failed: ${response.status}`);
}
async function query(expr){
  const response=await fetch(`http://127.0.0.1:${ports.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`,{signal:AbortSignal.timeout(5000)});
  assert.ok(response.ok);const body=await response.json();assert.equal(body.status,'success');return body.data.result;
}
async function ensureDashboard(){
  const expected=dashboardContract(dashboard());
  const matches=async()=>{
    const response=await fetch(grafana+'/api/dashboards/uid/local-learning-lab',{signal:AbortSignal.timeout(5000)});
    if(!response.ok)return false;
    const actual=await response.json();
    try{assert.deepEqual(dashboardContract(actual.dashboard),expected);return true;}catch{return false;}
  };
  // File watchers over Docker Desktop bind mounts can miss a rewrite. Do not
  // claim provisioning success from health alone; inspect the served contract.
  if(!await matches()){
    await docker(['restart',await id('grafana')]);
    await waitForHttpReady(grafana+'/api/health',{timeoutMs:120000,intervalMs:1000});
  }
  await until(matches,'served Grafana dashboard matches current source');
  report.dashboardProvisioning={verified:true,panelCount:expected.length,contractSha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex')};
}
async function admissionSamples(label){
  const samples=[];
  for(const target of await ids('api',true)){
    const output=await docker(['exec',target,'node','-e',"fetch('http://127.0.0.1:5002/metrics',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)throw Error('Metrics unavailable');console.log(await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})"]);
    samples.push({container:target,at:new Date().toISOString(),...parseAdmission(output.stdout)});
  }
  await jsonFile(join(results,`admission-${label}.json`),samples);return samples;
}
async function artifactManifest(folder,prefix=''){
  const entries=[];
  for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=prefix+entry.name;
    if(entry.isDirectory())entries.push(...await artifactManifest(join(folder,entry.name),name+'/'));
    else if(entry.name!=='report.json'){const bytes=await readFile(join(folder,entry.name));entries.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
  return entries;
}
async function load(label,{during,requirePass=true,faultWindow=false,outage=false,rate=options.rate,duration=options.duration}={}){
  const folder=join(results,label);await mkdir(folder,{recursive:true});
  const name=`${project}-load-${randomBytes(4).toString('hex')}`;
  const samples=[];let sampling=false,errors=[];
  const sample=async()=>{
    if(sampling)return;sampling=true;
    try{const targets=await ids('api',true);const rows=(await docker(['stats','--no-stream','--format','{{json .}}',...targets],{timeout:15000})).stdout.split(/\r?\n/).filter(Boolean).map(row=>JSON.parse(row));samples.push({at:new Date().toISOString(),apiCpuCores:rows.reduce((sum,row)=>sum+Number(row.CPUPerc.replace('%',''))/100,0)});}catch(error){errors.push(error.message);}finally{sampling=false;}
  };
  const snapshot=async()=>({at:new Date().toISOString(),cache:await query('sum by(outcome)(app_catalog_cache_operations_total{job="learning-api"})'),mongo:await query('sum(app_mongo_command_seconds_count{job="learning-api",command=~"find|aggregate|count"})')});
  const before=await snapshot();
  await sample();const timer=setInterval(()=>{void sample();},5000);
  let fault;const handshake=trafficStart();
  try{
    const task=docker(['run','--rm','--name',name,...(process.platform==='win32'?[]:['--user',`${process.getuid()}:${process.getgid()}`]),'--label',`scaling.owner=${owner}`,'--label',`scaling.run=${runId}`,'--label','scaling.role=load','--network',`${project}_backend`,'--cpus','1','--memory','512m','-e',`RATE=${rate}`,'-e',`DURATION=${duration}`,'-e',`FAULT_WINDOW=${faultWindow}`,'-e','ACCESS_TOKEN','-v',`${join(topic,'bench/scenarios',outage?'dependency-outage.js':'learning.js')}:/scenario.js:ro`,'-v',`${folder}:/results`,images.k6,'run','--summary-export=/results/k6.json','/scenario.js'],{allowFailure:true,timeout:720000,onOutput:handshake.observe});
    fault=during?(async()=>{
      const startedAt=await Promise.race([handshake.promise,task.then(()=>{throw new Error('Generator completed without a traffic-start acknowledgement');})]);
      await jsonFile(join(folder,'traffic-start.json'),{at:new Date(startedAt).toISOString(),source:'k6 first scenario iteration'});
      return during();
    })():Promise.resolve();
    const [execution]=await Promise.all([task,fault]);
    await writeFile(join(folder,'k6.log'),execution.stdout+'\n'+execution.stderr+'\n');
    const raw=JSON.parse(await readFile(join(folder,'k6.json'),'utf8'));
    await pause(6000);const after=await snapshot();
    const counter=(rows,outcome)=>Number(rows.find(row=>row.metric.outcome===outcome)?.value?.[1]??0);
    const cacheDeltas=Object.fromEntries(['hits','misses','loads','joined'].map(outcome=>[outcome,counter(after.cache,outcome)-counter(before.cache,outcome)]));
    const mongoDelta=before.mongo.length&&after.mongo.length?Number(after.mongo[0].value[1])-Number(before.mongo[0].value[1]):null;
    const reset=Object.values(cacheDeltas).some(value=>value<0)||Boolean(during);
    const result={...(outage?summarizeOutage(raw,execution.code):summarizeLoad(raw,execution.code,{faultWindow})),offeredIterationsPerSecond:rate,duration,topology,cacheEnabled:cache,apiBudget:{cpuCores:1,memoryBytes:2147483648,servingProcesses:4,poolSlots:40,admissionSlots:admissionLimit*4},generatorBudget:{cpuCores:1,memoryBytes:536870912},serverCpuMeanCores:samples.reduce((sum,row)=>sum+row.apiCpuCores,0)/samples.length,serverCpuMaxCores:Math.max(...samples.map(row=>row.apiCpuCores)),samplingErrors:errors,cacheDeltas:reset?null:cacheDeltas,cacheHitFraction:reset?null:cacheDeltas.hits/Math.max(1,cacheDeltas.hits+cacheDeltas.misses),mongoReadCommands:reset||mongoDelta===null||mongoDelta<0?null:mongoDelta,scrapeBoundaries:{before,after,intervalSeconds:5,interpretation:'Cumulative-counter deltas across scrape boundaries may include readiness and warm-up probes. Null after process resets/faults or missing series.'}};
    await jsonFile(join(folder,'measurements.json'),{...result,samples});
    if(requirePass)assert.ok(result.passed,`Load/correctness gate failed for ${label}; inspect ${folder}`);
    return result;
  }finally{
    clearInterval(timer);if(cancellation.signal.aborted)recovering=true;if(fault)await fault.catch(()=>{});
    // An interrupted workload is removed only after validating both ownership and run ID.
    const leftover=await docker(['inspect',name],{allowFailure:true});
    if(leftover.code===0){const labels=JSON.parse(leftover.stdout)[0].Config.Labels;assert.equal(labels['scaling.owner'],owner);assert.equal(labels['scaling.run'],runId);await docker(['rm','-f',name]);}
  }
}
const payload={name:'Synthetic learning product',description:'Local learning lab only',price:1,stock:0,category:'learning',imageUrl:'https://example.invalid/learning.jpg'};
async function accept(label){return (await request('/products/ingest',{method:'POST',body:{...payload,name:`Learning ${label}`},auth:true,key:`${runId}-${label}`,status:202})).json;}
async function drain(){await until(async()=>{const state=await helper({action:'state'});assert.equal(state.failed,0,'Unexpected failed learning jobs');return state.pending===0;},'all accepted jobs complete');}
async function stopConsumers(){await drain();await lifecycle('outbox','stop');await lifecycle('worker','stop');await pause(11000);}
async function warm(){for(let i=0;i<12;i++)await request('/products?page=1&limit=20');}

async function experiment(name){
  const definition=scenarios[name];
  const entry={name,expected:definition.expected,lesson:definition.lesson,startedAt:new Date().toISOString(),passed:false,observed:null,limitingResource:'Not established by this bounded experiment. Inspect CPU, Mongo checkout and latency panels before inferring a bottleneck.',grafanaPanels:definition.panels.map(panel=>`${grafana}/d/local-learning-lab?viewPanel=${panel}`)};
  report.scenarios.push(entry);console.log(`\nEXPERIMENT ${name}: ${entry.expected}`);
  await annotation(`START ${name}: ${entry.expected}`);
  try{
    if(name==='baseline'){
      entry.observed=await load('baseline');
      const jobs=[];for(let i=0;i<10;i++)jobs.push(await accept(`baseline-${i}`));await drain();
      for(const job of jobs)assert.deepEqual((await helper({action:'job',id:job.jobId})).effects,1);
      entry.ingestion={accepted:jobs.length,effects:jobs.length};entry.data=await helper({action:'state'});
    }else if(name==='scaling'){
      entry.observed={vertical:[],horizontal:[],winner:null,interpretation:'Offered-load comparison, not a saturation benchmark.'};
      for(let trial=0;trial<options.repeat;trial++)for(const shape of trial%2?['horizontal','vertical']:['vertical','horizontal']){
        await configure(shape,false);entry.observed[shape].push(await load(`scaling-${shape}-${trial+1}`));
      }
      await configure();
    }else if(name==='cache'){
      await configure('horizontal',false);const off=await load('cache-off');
      await configure('horizontal',true);await warm();const on=await load('cache-on');
      assert.equal((await request('/products?page=1&limit=20',{auth:true})).headers.get('x-catalog-cache'),null,'Private read must bypass shared cache');
      assert.ok(on.cacheDeltas?.hits>0,'No cache hits across the measured scrape window');
      entry.observed={off,on,privateReadBypassedCache:true};
    }else if(name==='api-failure'){
      await configure();const victim=(await ids('api',true))[0],fault={};
      entry.observed=await load('api-failure',{faultWindow:true,during:async()=>{await pause(5000);assertOwned((await inspect(victim)).Config.Labels,'api');await docker(['kill',victim]);fault.startedAt=new Date().toISOString();try{await pause(7000);assert.equal((await ids('api',true)).length,3);}finally{fault.finishedAt=new Date().toISOString();await docker(['start',victim]);}}});
      const overlap=await docker(['logs','--since',fault.startedAt,'--until',fault.finishedAt,await id('gateway')]);
      entry.observed.faultOverlap={...fault,...faultTraffic(overlap.stdout)};await jsonFile(join(results,'api-failure-overlap.json'),entry.observed.faultOverlap);
      await ready();assert.equal((await ids('api',true)).length,4);
    }else if(name==='redis-outage'){
      await configure('horizontal',true);await warm();
      await lifecycle('redis','stop');
      try{entry.observed=await load('redis-outage');assert.notEqual((await request('/products?page=1&limit=20')).headers.get('x-catalog-cache'),'hit');}
      finally{await lifecycle('redis','start');}
      await until(async()=>{await warm();return (await request('/products?page=1&limit=20')).headers.get('x-catalog-cache')==='hit';},'cache hit after Redis recovery');
    }else if(name==='capacity'){
      await configure('horizontal',false);await warm();
      const rates=capacityRates(options.rate),trials=[];
      for(let trial=0;trial<options.repeat;trial++)for(const rate of trial%2?[...rates].reverse():rates){
        trials.push(await load(`capacity-${rate}-${trial+1}`,{rate,requirePass:false}));
      }
      entry.observed={...summarizeCapacity(trials),rawTrials:trials,dataset:await helper({action:'state'}),cache:false,compression:'off',profile:'80% public catalog, 20% authenticated reads, global iteration schedule'};
      assert.ok(entry.observed.highestSupportedTestedRate!==null,'Even the lowest offered rate did not qualify');
      entry.observed.recovery=await load('capacity-recovery');
    }else if(name==='mongo-outage'){
      await configure('horizontal',false,2);
      const before=await admissionSamples('before');
      const initial=before.reduce((sum,row)=>sum+row.rejected_total,0);
      const apiIds=await ids('api',true),fault={},processStarts={};
      for(const target of apiIds)processStarts[target]=(await inspect(target)).State.StartedAt;
      entry.observed={fault};
      entry.observed.during=await load('mongo-outage',{outage:true,rate:Math.min(options.rate,40),duration:'20s',during:async()=>{
        await pause(3000);await lifecycle('mongo','pause');fault.startedAt=new Date().toISOString();
        try{
          await pause(2000);const health=await request('/health');assert.equal(health.json.status,'ok');fault.healthStatus=200;
          fault.admission=await admissionSamples('frozen');
          await pause(6000);
        }finally{await lifecycle('mongo','unpause');fault.recoveredAt=new Date().toISOString();}
      }});
      await ready();const after=await admissionSamples('after');entry.observed.admissionSamples=after;
      entry.observed.admissionRejections=after.reduce((sum,row)=>sum+row.rejected_total,0)-initial;
      assert.ok(entry.observed.admissionRejections>0,'No actual admission shedding observed');
      for(const row of after){assert.equal(row.limit,2);assert.ok(row.high_water<=2,'Admission budget exceeded');}
      for(const target of apiIds){const container=await inspect(target);assert.equal(container.State.Running,true);assert.equal(container.RestartCount,0);assert.equal(container.State.StartedAt,processStarts[target]);}
      entry.observed.sameApiProcessesSurvived=true;
      for(const target of apiIds){
        await docker(['exec','-e','ACCESS_TOKEN',target,'node','-e',"(async()=>{for(const path of ['/products?page=1&limit=20','/users/me']){const r=await fetch('http://127.0.0.1:5002'+path,{headers:path==='/users/me'?{authorization:'Bearer '+process.env.ACCESS_TOKEN}:{},signal:AbortSignal.timeout(8000)});if(r.status!==200)throw Error('Recovered peer unavailable');const b=await r.json();if(path==='/users/me'?!b.email?.endsWith('@example.invalid'):b.items?.length!==20||b.items[0]?._id!=='000000000000002a00000001')throw Error('Recovered peer body incorrect')}console.log('RECOVERED_PEER_PASS')})().catch(e=>{console.error(e.message);process.exit(1)})"]);
      }
      entry.observed.recovery=await load('mongo-recovered',{rate:Math.min(options.rate,20)});
      const recoveredIds=await ids('api',true);assert.deepEqual([...recoveredIds].sort(),[...apiIds].sort());
      const recovered=await admissionSamples('recovered');
      for(const row of recovered){assert.equal(row.limit,2);assert.ok(row.active<=1);}
      entry.observed.recoveredSameProcesses=true;entry.observed.recoveredAdmissionSamples=recovered;
      await configure();
    }else if(name==='worker-crash'||name==='duplicate-delivery'){
      await configure();await stopConsumers();
      try{
        const accepted=await accept(name);assert.equal(await helper({action:'component',operation:'relay'}),true);
        const message=await until(async()=>helper({action:'queue',operation:'receive'}),'delivery to fault helper');
        const event=JSON.parse(message.Body);assert.equal(event.jobId,accepted.jobId);
        if(name==='worker-crash'){
          assert.deepEqual(await helper({action:'component',operation:'lease',event,crash:true},{crash:true}),{leased:true});
          const before=await helper({action:'job',id:accepted.jobId});assert.equal(before.status,'processing');assert.equal(before.effects,0);
          await helper({action:'expire',id:accepted.jobId});await helper({action:'queue',operation:'release',receipt:message.ReceiptHandle});
          await lifecycle('worker','start');await until(async()=>(await helper({action:'job',id:accepted.jobId})).status==='succeeded','worker retries expired lease');
          entry.observed={before,after:await helper({action:'job',id:accepted.jobId}),helperExit:73,acceleratedLeaseExpiry:true};
          assert.equal(entry.observed.after.effects,1);assert.ok(entry.observed.after.attempts>=2);
        }else{
          assert.equal(await helper({action:'component',operation:'complete',event,crash:true},{crash:true}),'ack');
          await helper({action:'queue',operation:'release',receipt:message.ReceiptHandle});
          const duplicate=await until(async()=>helper({action:'queue',operation:'receive'}),'redelivery after commit');
          assert.equal(JSON.parse(duplicate.Body).jobId,accepted.jobId);
          assert.equal(await helper({action:'component',operation:'complete',event:JSON.parse(duplicate.Body)}),'ack');
          await helper({action:'queue',operation:'delete',receipt:duplicate.ReceiptHandle});
          entry.observed={...await helper({action:'job',id:accepted.jobId}),deliveries:2,helperExit:73};assert.equal(entry.observed.effects,1);
        }
      }finally{await lifecycle('worker','start');await lifecycle('outbox','start');}
      await drain();
    }else if(name==='rollback'){
      await compose(['--profile','manual','up','-d','candidate']);await id('candidate');
      const previous=(await inspect((await ids('api',true))[0])).Image;
      try{await gatewayTarget('candidate');await request('/ready',{status:503});entry.observed={badReleaseStatus:503,trafficSwitchedToCandidate:true,promotionAccepted:false,automaticallyRolledBack:true,rollbackImage:previous};}
      finally{await gatewayTarget('api');await lifecycle('candidate','stop');}
      await ready();assert.equal(previous,image);entry.observed.afterRollback=await load('rollback-recovered');
    }else if(name==='restore'){
      await stopConsumers();
      try{
        await compose(['--profile','manual','up','-d','--wait','restore']);
        const before=await helper({action:'digest'});const mongo=await id('mongo'),restore=await id('restore');
        const archive=`/backup/${runId}.archive.gz`;
        await docker(['exec',mongo,'mongodump','--uri','mongodb://mongo:27017/learning_lab?replicaSet=production-lab','--db','learning_lab',`--archive=${archive}`,'--gzip']);
        await docker(['exec',restore,'mongorestore','--uri','mongodb://restore:27017/learning_lab','--nsInclude','learning_lab.*',`--archive=${archive}`,'--gzip','--drop']);
        const after=await helper({action:'restore-digest'});assert.deepEqual(after,before,'Independent restored collection content mismatch');
        const bytes=await readFile(join(runtime,'backup',`${runId}.archive.gz`));
        entry.observed={collections:after,archiveSha256:createHash('sha256').update(bytes).digest('hex'),archiveBytes:bytes.length,independentRestore:true,quiesced:true};
      }finally{await lifecycle('outbox','start');await lifecycle('worker','start');const restoreIds=await ids('restore');if(restoreIds.length)await lifecycle('restore','stop');}
    }
    entry.passed=true;console.log(`EXPERIMENT_PASS ${name}`);
  }catch(error){entry.error=error.message;throw error;}
  finally{entry.finishedAt=new Date().toISOString();await annotation(`${entry.passed?'PASS':'FAIL'} ${name}: ${entry.lesson}`).catch(error=>{entry.annotationError=error.message;});await jsonFile(join(results,`${name}.json`),entry);}
}

try{
  await inventory();
  // A forceful host/runner interruption cannot run finally. Recover only a
  // verified owned Mongo pause before Compose waits for its healthcheck.
  for(const target of await ids('mongo'))if((await inspect(target)).State.Paused)await lifecycle('mongo','unpause');
  if(options.down){
    assert.ok((await docker(['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}'])).stdout,'No owned learning stack to stop');
    await readFile(composePath);const privateKeys=JSON.parse(await readFile(join(artifacts,'private-keys.json'),'utf8'));
    Object.assign(env,{LEARNING_ACCESS_SECRET:privateKeys.access,LEARNING_REFRESH_SECRET:privateKeys.refresh,LEARNING_GRAFANA_SECRET:privateKeys.grafana});
    await compose(['down']);console.log('LEARNING_STACK_DOWN: volumes and results preserved');
  }else{
    await mkdir(results,{recursive:true});
    sourceHash=(await command(process.execPath,[join(topic,'scripts/local/source-hash.mjs')])).stdout;
    report.sourceTreeSha256=sourceHash;
    const sources=['scripts/local/learning-model.mjs','scripts/local/learning-lab.mjs','scripts/local/learning-helper.mjs','scripts/local/learning-lifecycle.mjs','scripts/local/capacity-policy.mjs','bench/scenarios/learning.js','bench/scenarios/dependency-outage.js','infra/compose/gateway.conf','infra/compose/ingestion.conf','infra/compose/init-mongo.js'];
    const fingerprint=createHash('sha256');for(const file of sources){fingerprint.update(file+'\0');fingerprint.update(await readFile(join(topic,file)));}report.learningSourceSha256=fingerprint.digest('hex');
    let candidate=await docker(['image','inspect','scaling-express:phase6'],{allowFailure:true});
    if(!options.build&&(candidate.code!==0||JSON.parse(candidate.stdout)[0].Config.Labels?.['org.scaling.source.sha256']!==sourceHash))candidate=await docker(['image','inspect','scaling-express:learning'],{allowFailure:true});
    if(options.build||candidate.code!==0||JSON.parse(candidate.stdout)[0].Config.Labels?.['org.scaling.source.sha256']!==sourceHash){
      await docker(['build','--build-arg',`SOURCE_TREE_SHA256=${sourceHash}`,'-t','scaling-express:learning',join(topic,'servers/02-express')],{timeout:1200000,stream:true});
      candidate=await docker(['image','inspect','scaling-express:learning']);
    }
    const identity=JSON.parse(candidate.stdout)[0];assert.equal(identity.Config.Labels['org.scaling.source.sha256'],sourceHash);image=identity.Id;report.image=image;
    for(const port of Object.values(ports)){
      const own=(await docker(['ps','--filter',`label=com.docker.compose.project=${project}`,'--filter',`publish=${port}`,'--format','{{.ID}}'])).stdout;
      if(!own)await new Promise((done,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Loopback port ${port} is occupied by another process`)));server.listen(port,'127.0.0.1',()=>server.close(done));});
    }
    for(const name of ['mongo','queue','restore','prometheus','grafana']){
      const volume=`${project}_${name}-data`;const prior=await docker(['volume','inspect',volume],{allowFailure:true});
      if(prior.code===0){const labels=JSON.parse(prior.stdout)[0].Labels;assert.equal(labels?.['scaling.owner'],owner,`Refusing unowned ${volume}`);assert.equal(labels?.['scaling.purpose'],name);}
      else await docker(['volume','create','--label',`scaling.owner=${owner}`,'--label',`scaling.purpose=${name}`,volume]);
    }
    const privatePath=join(artifacts,'private-keys.json');
    try{keys=JSON.parse(await readFile(privatePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;keys=Object.fromEntries(['access','refresh','grafana','password'].map(key=>[key,randomBytes(36).toString('base64url')]));await writeFile(privatePath,JSON.stringify(keys)+'\n',{mode:0o600,flag:'wx'});}
    for(const value of Object.values(keys))assert.ok(typeof value==='string'&&value.length>=32,'Invalid local private key');
    if(process.platform==='win32')await command('icacls.exe',[privatePath,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`]);
    Object.assign(env,{LEARNING_ACCESS_SECRET:keys.access,LEARNING_REFRESH_SECRET:keys.refresh,LEARNING_GRAFANA_SECRET:keys.grafana});
    for(const folder of ['gateway','backup','provisioning/datasources','provisioning/dashboards','dashboards'])await mkdir(join(runtime,folder),{recursive:true});
    await gatewayTarget('api');
    await writeFile(join(runtime,'provisioning/datasources/learning.yml'),'apiVersion: 1\ndatasources:\n  - name: Learning Prometheus\n    uid: learning-prometheus\n    type: prometheus\n    access: proxy\n    url: http://prometheus:9090\n    isDefault: true\n');
    await writeFile(join(runtime,'provisioning/dashboards/learning.yml'),'apiVersion: 1\nproviders:\n  - name: learning\n    type: file\n    updateIntervalSeconds: 5\n    options:\n      path: /var/lib/grafana/dashboards\n');
    await jsonFile(join(runtime,'dashboards/learning.json'),dashboard());await render();
    await compose(['up','-d','--wait','--wait-timeout','180','--scale','api=4','api','worker','outbox','gateway','prometheus','grafana']);initialized=true;await ready();
    report.fixture=await helper({action:'seed',password:keys.password});
    const admin=await request('/users/signup',{method:'POST',body:{name:'Synthetic experiment operator',email:`operator-${runId}@example.invalid`,password:keys.password},status:201});
    await helper({action:'grant',id:admin.json.user.id});token=admin.json.accessToken;env.ACCESS_TOKEN=token;
    await until(async()=>{const response=await fetch(grafana+'/api/health',{signal:AbortSignal.timeout(3000)});return response.ok;},'Grafana');
    await ensureDashboard();
    await configure();
    await drain();
    for(const name of options.scenarios)await experiment(name);
    report.passed=true;
  }
}catch(error){report.error=error.message;process.exitCode=1;console.error('LEARNING_RUN_FAILED: '+error.message);}
finally{
  recovering=true;
  if(cancellation.signal.aborted){report.passed=false;report.interrupted=true;process.exitCode=1;}
  if(initialized){
    try{
      for(const mongoId of await ids('mongo'))if((await inspect(mongoId)).State.Paused)await lifecycle('mongo','unpause');
      await gatewayTarget('api');
      for(const service of ['mongo','redis','worker','outbox'])await lifecycle(service,'start');
      for(const target of await ids('candidate'))if((await inspect(target)).State.Running)await lifecycle('candidate','stop');
      for(const target of await ids('restore'))if((await inspect(target)).State.Running)await lifecycle('restore','stop');
      await configure();await drain();await load('final-live');
      await until(async()=>Number((await query('max(app_ingestion_state{job="learning-outbox",state="syntheticProfiles"})'))[0]?.value?.[1])>=20,'synthetic users visible in Prometheus');
      report.finalState=await helper({action:'state'});report.dashboard=`${grafana}/d/local-learning-lab`;report.api=base;
    }catch(error){report.passed=false;report.recoveryError=error.message;process.exitCode=1;console.error('LEARNING_RECOVERY_FAILED: '+error.message);}
  }
  report.finishedAt=new Date().toISOString();
  try{
    if(!options.down){report.artifacts=await artifactManifest(results);await jsonFile(join(results,'report.json'),report);await jsonFile(join(artifacts,'latest.json'),{runId,report:join(results,'report.json'),passed:report.passed});console.log(`RESULTS ${join(results,'report.json')}`);if(report.dashboard)console.log(`DASHBOARD ${report.dashboard}`);if(report.passed)console.log(`LEARNING_RUN_PASS ${report.scenarios.length} scenarios`);}
  }finally{await lock.release();}
}
