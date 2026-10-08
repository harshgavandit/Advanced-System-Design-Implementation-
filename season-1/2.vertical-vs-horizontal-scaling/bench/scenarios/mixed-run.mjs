import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';import {profiles,assessMixed} from './mixed-policy.mjs';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
import {createHash} from 'node:crypto';
import {profileDurationSeconds} from './workload-duration.js';
export async function runMixed({profile='smoke',environment,query}) {
 assert.ok(Object.hasOwn(profiles,profile),'Choose an explicit bounded workload profile');
 const folder=resolve(topic,'infra/compose/artifacts/operations/load');await mkdir(folder,{recursive:true});
 const fixture=JSON.parse(await readFile(resolve(folder,'sessions.json'),'utf8')),runId=randomUUID(),name='scaling-mixed-'+runId;
 const report={startedAt:new Date().toISOString(),passed:false,synthetic:true,cloud:false,profile,runId,dataset:fixture.manifest,iterationMix:{catalog:70,identity:20,cartAndWishlist:8,ingestion:2},authentication:'Separate password-login/refresh/logout probe at 2 journeys per minute, plus serialized 15-minute access-token refresh',samples:[],limitations:['Iteration percentages are not HTTP-request percentages because write and ingestion journeys make multiple requests.','Local one-host replica set and four API replicas, not multi-AZ capacity.','Stress and spike are exploratory profiles; failed thresholds cannot be used as supported launch capacity.','No production population or real user data.']};
 report.mixSchedule='coprime-permutation-v1: exact proportions per 100 arrivals, expensive writes spread across arrivals';
 const scenarioHash=createHash('sha256');
 for(const file of ['mixed.js','workload-mix.js','vu-fixture.js','workload-duration.js','json-equal.js','mixed-policy.mjs']){scenarioHash.update(file+'\0');scenarioHash.update(await readFile(resolve(topic,'bench/scenarios',file)));}
 report.scenarioSha256=scenarioHash.digest('hex');
 report.fixtureConfiguration={isolatedSessionPairs:fixture.pairs.length,authenticationAccounts:fixture.auth.length,instanceVuBudget:profiles[profile].maxVUs+2};
 report.plannedSeconds=profileDurationSeconds(profiles[profile]);
 assert.ok(fixture.pairs.length>=report.fixtureConfiguration.instanceVuBudget,'Prepare enough unique token families for all instance-wide VU IDs');
 function docker(args) {const result=spawnSync('docker',args,{env:environment,encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
 const compose=['compose','-p','scaling-operations-test','-f',resolve(topic,'tests/operations/compose.yaml'),'--profile','load'];let child,timer,output='';
 try {
  docker([...compose,'up','-d','--wait','--scale','api-load=4','api-load','gateway-load']);
  const ids=docker(['ps','--filter','label=com.docker.compose.project=scaling-operations-test','--filter','label=com.docker.compose.service=api-load','--format','{{.ID}}']).split(/\r?\n/).filter(Boolean);assert.equal(ids.length,4);
  report.configuration=JSON.parse(docker(['inspect',...ids])).map(c=>({image:c.Image,sourceTreeSha256:c.Config.Labels['org.scaling.source.sha256'],cpu:c.HostConfig.NanoCpus/1e9,memory:c.HostConfig.Memory,readonly:c.HostConfig.ReadonlyRootfs}));assert.equal(new Set(report.configuration.map(c=>c.image)).size,1);assert.ok(report.configuration.every(c=>c.cpu===1&&c.readonly));
  const database=JSON.parse(docker(['inspect','scaling-operations-test-mongo-1']))[0];
  report.databaseConfiguration={cpu:database.HostConfig.NanoCpus/1e9,memory:database.HostConfig.Memory,healthcheckIntervalSeconds:database.Config.Healthcheck.Interval/1e9};
  const peers=new Set();for(let i=0;i<40;i++){const response=await fetch('http://127.0.0.1:18089/ready',{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);peers.add(response.headers.get('x-lab-upstream'));await response.arrayBuffer();}assert.equal(peers.size,4,'All four replicas must actually serve traffic');report.servingReplicas=peers.size;
  const duration=profiles[profile].duration??(profile==='stress'?'8m':'3m50s');
  report.loadStartedAt=new Date().toISOString();
  child=spawn('docker',['run','--rm','--name',name,'--label','scaling.owner=mixed-load','--network','scaling-operations-test_backend','--cpus=1','--memory=512m','--read-only','--tmpfs','/tmp:size=32m','--cap-drop=ALL','--security-opt=no-new-privileges:true','--user',process.platform==='win32'?'1000:1000':String(process.getuid())+':'+String(process.getgid()),'-v',resolve(topic,'bench/scenarios')+':/scripts:ro','-v',folder+':/private','-e','PROFILE_JSON='+JSON.stringify(profiles[profile]),'-e','RUN_ID='+runId,'-e','AUTH_DURATION='+duration,'grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603','run','--summary-export=/private/'+profile+'-k6.json','/scripts/mixed.js'],{env:environment,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(-2*1024*1024)});child.stderr.on('data',chunk=>{output=(output+chunk).slice(-2*1024*1024)});
  timer=setInterval(()=>{
   try{const stats=docker(['stats','--no-stream','--format','{{json .}}',...ids,name,'scaling-operations-test-mongo-1','scaling-operations-test-gateway-load-1','scaling-operations-test-worker-1']);report.samples.push({at:new Date().toISOString(),stats:stats.split(/\r?\n/).map(JSON.parse)});}catch{report.samples.push({at:new Date().toISOString(),unavailable:true});}
   const last=[...output.matchAll(/running \(([^)]+)\),\s*(\d+)\/(\d+) VUs, (\d+) complete and (\d+) interrupted iterations/g)].at(-1);
   report.live={profile,runId,status:'running',at:new Date().toISOString(),elapsedSeconds:(Date.now()-Date.parse(report.loadStartedAt))/1000,...(last?{generatorElapsed:last[1],activeVUs:Number(last[2]),maxVUs:Number(last[3]),completedIterations:Number(last[4]),interruptedIterations:Number(last[5])}:{})};
   // Progress is diagnostic, never a passing load/launch artifact. No tokens,
   // fixture accounts or raw generator output are copied into this file.
   void writeFile(resolve(folder,profile+'-progress.json'),JSON.stringify(report.live,null,2)+'\n').catch(()=>{report.progressWriteFailure=true;});
   if(report.samples.length%3===0)console.log('MIXED_LOAD_PROGRESS '+profile+' samples='+report.samples.length);
  },10000);
  const [code]=await once(child,'exit');clearInterval(timer);
  report.measuredSeconds=(Date.now()-Date.parse(report.loadStartedAt))/1000;
  report.result=JSON.parse(await readFile(resolve(folder,profile+'-k6.json'),'utf8'));
  assert.ok(report.measuredSeconds>=report.plannedSeconds,'An interrupted workload cannot pass its complete profile');
  const deadline=Date.now()+60000;let reconciliation;
  do {reconciliation=query(`const jobs=dbx.ingestion_jobs.find({'payload.description':${JSON.stringify('load-run-'+runId)}}).toArray();return {acknowledged:jobs.length,succeeded:jobs.filter(j=>j.status==='succeeded').length,pending:jobs.filter(j=>['accepted','processing'].includes(j.status)).length,failed:jobs.filter(j=>j.status==='failed').length,productEffects:jobs.reduce((n,j)=>n+dbx.products.countDocuments({_id:j.productId}),0),duplicateEffects:jobs.filter(j=>dbx.products.countDocuments({_id:j.productId})>1).length,outstandingCarts:dbx.cartitems.countDocuments({userId:{$in:${JSON.stringify(fixture.pairs.map(p=>p.user.id))}.map(id=>new ObjectId(id))}}),outstandingWishlists:dbx.wishlistitems.countDocuments({userId:{$in:${JSON.stringify(fixture.pairs.map(p=>p.user.id))}.map(id=>new ObjectId(id))}})};`);if(!reconciliation.pending)break;await new Promise(done=>setTimeout(done,500));}while(Date.now()<deadline);
  report.reconciliation=reconciliation;assert.equal(reconciliation.acknowledged,report.result.metrics.accepted_ingestions.count,'Every client 202 must reconcile to durable work');
  assessMixed(report.result,reconciliation);assert.equal(code,0,'k6 thresholds failed');report.passed=true;console.log('MIXED_LOAD_PASS '+profile);
 }catch(error){report.failure=error.message;throw error;}
 finally {
  clearInterval(timer);
  const inspect=spawnSync('docker',['inspect',name],{encoding:'utf8'});if(inspect.status===0){assert.equal(JSON.parse(inspect.stdout)[0].Config.Labels['scaling.owner'],'mixed-load');docker(['rm','--force',name]);}
  docker([...compose,'stop','api-load','gateway-load']);
  report.finishedAt=new Date().toISOString();await writeFile(resolve(folder,profile+'-output.txt'),output);await writeFile(resolve(folder,profile+'.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(resolve(folder,profile+'-progress.json'),JSON.stringify({...report.live,profile,runId,status:report.passed?'passed':'failed',at:report.finishedAt,elapsedSeconds:report.measuredSeconds,completedIterations:report.result?.metrics?.iterations?.count},null,2)+'\n');
 }
 return report;
}
