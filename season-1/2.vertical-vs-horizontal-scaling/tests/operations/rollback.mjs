import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {rollout} from '../../scripts/operations/release-policy.mjs';
import {journey} from '../../scripts/operations/journey.mjs';
import {nginxWorkerPids,generationDrained} from '../../scripts/operations/proxy-generation.mjs';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),folder=resolve(topic,'infra/compose/artifacts/operations/rollback');await mkdir(folder,{recursive:true});
const keys=JSON.parse((await readFile(resolve(topic,'infra/compose/artifacts/local-keys.json'),'utf8')).replace(/^\uFEFF/,'')),env={...process.env,JWT_ACCESS_SECRET:keys.access,JWT_REFRESH_SECRET:keys.refresh};
const prefix='scaling-release-drill-',good=prefix+'good',candidate=prefix+'candidate',edge=prefix+'edge',network=prefix+'public',created=[];let networkCreated=false;
const backend=process.env.ROLLBACK_NETWORK??'scaling-production-lab_backend',uri=process.env.ROLLBACK_MONGO_URI??'mongodb://mongo:27017/production_lab?replicaSet=production-lab',catalogSize=Number(process.env.ROLLBACK_CATALOG_SIZE??10000),candidateTag=process.env.ROLLBACK_CURRENT_IMAGE??'scaling-express:phase6',previousTag=process.env.ROLLBACK_PREVIOUS_IMAGE??'scaling-express:phase6-before-wolfi';
assert.ok(['scaling-production-lab_backend','scaling-operations-test_backend'].includes(backend));
assert.ok(['mongodb://mongo:27017/production_lab?replicaSet=production-lab','mongodb://mongo:27017/operations_test?replicaSet=operations'].includes(uri));
const report={startedAt:new Date().toISOString(),passed:false,synthetic:true,proof:'Real containers and isolated loopback proxy, not an ECS/cloud rollback',cases:[]};
const credentials=process.env.ROLLBACK_JOURNEY_JSON?JSON.parse(process.env.ROLLBACK_JOURNEY_JSON):null;
if(credentials)assert.equal(credentials.users?.length,2,'Rollback journeys require two separate synthetic users');
report.journeyScope=credentials?.admin?'Two-user mutation, revocation and durable ingestion':credentials?'Two-user mutation and revocation':'Catalog only';
function docker(args,{capture=true}={}){const result=spawnSync('docker',args,{encoding:'utf8',env,timeout:60000,stdio:capture?'pipe':'inherit'});assert.equal(result.status,0,result.stderr);return result.stdout?.trim();}
async function until(fn,label,ms=60000){const end=Date.now()+ms;let last;while(Date.now()<end){try{if(await fn())return;}catch(error){last=error.message;}await new Promise(done=>setTimeout(done,250));}throw Error(label+' deadline: '+last);}
// Nginx reload is graceful: one response from the new worker does not mean old
// workers stopped routing pooled connections. Observe the entire old generation.
async function select(upstream){
 const serving=created.includes(edge);
 const oldWorkers=serving?nginxWorkerPids(docker(['top',edge,'-eo','pid,args'])):[];
 await writeFile(resolve(folder,'nginx.conf'),'worker_shutdown_timeout 2s;\nevents {}\nhttp { keepalive_timeout 0; server { listen 8080; add_header X-Release '+upstream+' always; location / { proxy_pass http://'+upstream+':5002; } } }\n');
 if(serving){
  assert.ok(oldWorkers.length>0,'Do not reload without observing the serving proxy generation');
  docker(['exec',edge,'nginx','-s','reload']);
  await until(()=>generationDrained(oldWorkers,nginxWorkerPids(docker(['top',edge,'-eo','pid,args']))),'previous proxy generation drained');
  await until(async()=>{const response=await fetch('http://127.0.0.1:18088/ready',{headers:{connection:'close'},signal:AbortSignal.timeout(2000)});return response.headers.get('x-release')===upstream},'proxy switched revision');
 }
}
async function business(){const result=await(await fetch('http://127.0.0.1:18088/products?page=1&limit=20',{signal:AbortSignal.timeout(3000)})).json();assert.equal(result.totalItems,catalogSize,'Readiness alone must not pass a wrong business result');assert.equal(result.items.length,20);}
function remove(name){const inspected=spawnSync('docker',['inspect',name],{encoding:'utf8'});if(inspected.status!==0)return;const config=JSON.parse(inspected.stdout)[0];assert.equal(config.Config.Labels['scaling.owner'],'release-drill');docker(['rm','--force',name]);}
function launch(name,image,args){const exists=spawnSync('docker',['inspect',name],{encoding:'utf8'});assert.notEqual(exists.status,0,'Do not replace an existing drill container');docker(['run','-d','--name',name,'--label','scaling.owner=release-drill','--network',backend,'--cpus=0.5','--memory=512m','--read-only','--tmpfs','/tmp:size=32m','--cap-drop=ALL','--security-opt=no-new-privileges:true','--log-opt','max-size=1m','--log-opt','max-file=2',...args,image],{capture:false});created.push(name);}
try{
 assert.notEqual(spawnSync('docker',['network','inspect',network],{encoding:'utf8'}).status,0,'Do not replace an existing network');
 docker(['network','create','--label','scaling.owner=release-drill',network]);networkCreated=true;
 report.previousImage=docker(['image','inspect','--format','{{.Id}}',previousTag]);
 report.candidateImage=docker(['image','inspect','--format','{{.Id}}',candidateTag]);report.crossVersion=report.previousImage!==report.candidateImage;
 launch(good,report.previousImage,['-e','NODE_ENV=production','-e','MONGO_AUTO_INDEX=true','-e','JWT_ACCESS_SECRET','-e','JWT_REFRESH_SECRET','-e','MONGO_URI='+uri,'-e','REDIS_URL=redis://redis:6379']);
 await until(()=>JSON.parse(docker(['inspect',good]))[0].State.Health?.Status==='healthy','previous image readiness');
 await select(good);
 launch(edge,'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236',['--user','101:101','-p','127.0.0.1:18088:8080','-v',resolve(folder,'nginx.conf')+':/etc/nginx/nginx.conf:ro','--tmpfs','/var/cache/nginx:size=16m,uid=101,gid=101','--tmpfs','/var/run:size=1m,uid=101,gid=101']);
 // Docker Desktop loopback forwarding needs an egress-capable edge network;
 // application containers remain on the existing private backend network.
 docker(['network','connect',network,edge]);
  await until(async()=>{await business();return true;},'stable baseline');
  if(credentials)report.previousVersionJourney=await journey({base:'http://127.0.0.1:18088',users:credentials.users,admin:credentials.admin});
 for(const fault of ['startup','wrong-business']){
  const start=Date.now();const image=report.candidateImage;
  // Fixture command is injected explicitly; the actual immutable image is recorded.
  docker(['run','-d','--name',candidate,'--label','scaling.owner=release-drill','--network',backend,'--cpus=0.5','--memory=256m','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','-v',resolve(topic,'tests/operations/bad-release.mjs')+':/fault.mjs:ro','-e','FAIL_STARTUP='+(fault==='startup'),'--entrypoint','node',image,'/fault.mjs']);created.push(candidate);
  let restoredJourney;
  const result=await rollout({roles:['api'],adapter:{current:async()=>report.previousImage,migrate:async()=>{},deploy:async()=>{if(fault==='startup'){await new Promise(done=>setTimeout(done,500));assert.equal(JSON.parse(docker(['inspect',candidate]))[0].State.Running,true,'Candidate failed startup');}await select(candidate);},ready:async()=>{await until(async()=>{const status=await fetch('http://127.0.0.1:18088/ready',{signal:AbortSignal.timeout(1000)});return status.ok},'candidate ready',5000)},rollback:async()=>select(good),verifyRollback:async()=>{await business();if(credentials)restoredJourney=await journey({base:'http://127.0.0.1:18088',users:credentials.users,admin:credentials.admin});}},verify:business,observe:async()=>{}});
  const caseReport={fault,...result,restoredJourney};report.cases.push(caseReport);
  assert.equal(result.passed,false);assert.equal(result.rolledBack,true,JSON.stringify(result));await until(async()=>{await business();return true;},'restored business journey');
  for(let i=0;i<25;i++)await business();
  const rollbackMs=Date.now()-start;
  caseReport.rollbackMs=rollbackMs;remove(candidate);
 }
 report.passed=true;console.log('ROLLBACK_DRILL_PASS startup and ready-but-wrong-business releases restored real serving content');
}catch(error){
 report.failure=error.message;
 for(const name of [...new Set(created)]){const logs=spawnSync('docker',['logs','--tail','30',name],{encoding:'utf8'});await writeFile(resolve(folder,name+'.log'),(logs.stdout??'')+(logs.stderr??''));}
 throw error;
}finally{
 for(const name of [...new Set(created)].reverse())remove(name);
 if(networkCreated){assert.equal(JSON.parse(docker(['network','inspect',network]))[0].Labels['scaling.owner'],'release-drill');docker(['network','rm',network]);}
 report.finishedAt=new Date().toISOString();await writeFile(resolve(folder,'rollback.json'),JSON.stringify(report,null,2)+'\n');
}
