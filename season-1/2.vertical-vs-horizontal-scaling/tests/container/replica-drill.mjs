import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname,resolve } from 'node:path';
import {randomUUID} from 'node:crypto';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const compose=resolve(topic,'infra/compose/production-like.yaml');
// Recreate the selected replica using the same overlays as its live service.
// A base-only up would change all API environments in a telemetry stack.
const composeArgs=['compose','-f',compose];
if(process.argv.includes('--telemetry'))for(const name of ['ingestion.yaml','observability.yaml','telemetry.yaml'])composeArgs.push('-f',resolve(topic,'infra/compose',name));
const keys=JSON.parse((await readFile(resolve(topic,'infra/compose/artifacts/local-keys.json'),'utf8')).replace(/^\uFEFF/,''));
const env={...process.env,LAB_ACCESS_SECRET:keys.access,LAB_REFRESH_SECRET:keys.refresh};
const report={startedAt:new Date().toISOString(),passed:false,acknowledgedWrites:0,ambiguousWrites:0,readErrors:0};
const hold=`scaling-lab-ip-reservation-${process.pid}`;
let held=false;
function docker(args) {
  const r=spawnSync('docker',args,{encoding:'utf8',env,timeout:120000});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
const ids=docker([...composeArgs,'ps','-q','api']).split(/\r?\n/).filter(Boolean);
assert.equal(ids.length,4);
const victim=JSON.parse(docker(['inspect',ids[3]]))[0];
assert.equal(victim.Config.Labels['scaling.owner'],'production-lab');
report.image=victim.Image;
report.sourceTreeSha256=victim.Config.Labels['org.scaling.source.sha256'];
for(const id of ids)assert.equal(JSON.parse(docker(['inspect',id]))[0].Image,report.image,'Replica drill requires one serving image');
const network='scaling-production-lab_backend';
const oldIP=victim.NetworkSettings.Networks[network].IPAddress;
const base='http://127.0.0.1:18082';
async function request(path,{method='GET',body,token}={}) {
  const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000),...(['POST','PATCH','PUT','DELETE'].includes(method)?{headers:{'content-type':'application/json',authorization:`Bearer ${token??''}`,'idempotency-key':randomUUID()}}:{})});
  return {status:response.status,body:await response.json(),upstream:response.headers.get('x-lab-upstream')?.split(',').at(-1).trim()};
}
let stopReads=false;
let reads;
let load;
let loadDone;
let loadOutput='';
try {
  const signup=await request('/users/signup',{method:'POST',body:{name:'Replica drill',email:`replica-${Date.now()}@example.invalid`,password:'Synthetic-replica-password'}});
  assert.equal(signup.status,201);
  const token=signup.body.accessToken;
  const cart=await request('/cart',{method:'POST',token,body:{productId:'000000000000002a00000001',qty:1}});
  assert.equal(cart.status,201);
  const before=new Set();
  for(let i=0;i<20;i++){const r=await request('/users/me',{token});assert.equal(r.status,200);before.add(r.upstream);}
  assert.equal(before.size,4);
  load=spawn('docker',['run','--rm','--name',`scaling-replica-load-${process.pid}`,'--network',network,'--cpus=1','--memory=512m','-v',`${resolve(topic,'bench/scenarios')}:/scripts:ro`,'-v',`${resolve(topic,'infra/compose/artifacts')}:/results`,'-e','RATE=20','-e','DURATION=1m','grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603','run','--summary-export=/results/replica-k6.json','/scripts/catalog.js'],{stdio:['ignore','pipe','pipe']});
  loadDone=once(load,'exit');
  load.stdout.on('data',chunk=>loadOutput+=chunk);load.stderr.on('data',chunk=>loadOutput+=chunk);
  await new Promise(r=>setTimeout(r,5000));
  reads=(async()=>{let completed=0;while(!stopReads){try{const r=await request('/products?page=1&limit=20');if(r.status===200){assert.equal(r.body.items.length,20);completed++;}else report.readErrors++;}catch(error){if(error instanceof assert.AssertionError)throw error;report.readErrors++;}await new Promise(r=>setTimeout(r,50));}return completed;})();
  const lostAt=performance.now();
  docker(['kill','--signal','SIGKILL',victim.Id]);
  docker(['rm',victim.Id]);
  // Reserve the old IP so replacement discovery must handle a genuinely new address.
  docker(['run','-d','--rm','--name',hold,'--network',network,'--ip',oldIP,'--cpus=0.01','--memory=16m','--entrypoint','sh','nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236','-c','sleep 120']);
  held=true;
  for(let i=0;i<20;i++) {
    try {const r=await request(`/cart/${cart.body._id}/quantity`,{method:'PATCH',token,body:{delta:1}});if(r.status===200)report.acknowledgedWrites++;else report.ambiguousWrites++;}catch{report.ambiguousWrites++;}
  }
  const surviving=await request(`/cart/${cart.body._id}`,{token});
  assert.equal(surviving.status,200);
  assert.ok(surviving.body.qty>=1+report.acknowledgedWrites,'Every acknowledged increment must survive replica loss');
  report.observedQty=surviving.body.qty;
  report.lossAndWriteSeconds=(performance.now()-lostAt)/1000;
  docker([...composeArgs,'up','-d','--no-deps','--scale','api=4','api']);
  const replacementIds=docker([...composeArgs,'ps','-q','api']).split(/\r?\n/).filter(Boolean);
  assert.ok(ids.slice(0,3).every(id=>replacementIds.includes(id)),'Healthy surviving replicas must not be recreated by the drill');
  const replacement=JSON.parse(docker(['inspect',...replacementIds])).find(c=>!ids.includes(c.Id));
  assert.ok(replacement);
  const newIP=replacement.NetworkSettings.Networks[network].IPAddress;
  assert.notEqual(newIP,oldIP);
  const seen=new Set();const deadline=Date.now()+45000;
  while(Date.now()<deadline&&seen.size<4) {
    const r=await request('/users/me',{token});
    if(r.status===200){assert.equal(r.body._id,signup.body.user.id);seen.add(r.upstream);}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(seen.size,4);
  assert.ok(seen.has(`${newIP}:5002`));
  report.replacementIP=newIP;
  report.previousIP=oldIP;
  report.recoverySeconds=(performance.now()-lostAt)/1000;
  assert.equal((await request(`/cart/${cart.body._id}`,{token})).body.qty,report.observedQty);
  const [loadCode]=await loadDone;
  report.load=JSON.parse(await readFile(resolve(topic,'infra/compose/artifacts/replica-k6.json'),'utf8'));
  assert.equal(loadCode,0,'Constant-arrival replica failure load failed');
  report.passed=true;
  console.log(`REPLICA_DRILL_PASS acknowledged=${report.acknowledgedWrites} readErrors=${report.readErrors} recovery=${report.recoverySeconds.toFixed(2)}s`);
} finally {
  stopReads=true;
  if(reads) report.completedReads=await reads;
  if(loadDone) await loadDone;
  await writeFile(resolve(topic,'infra/compose/artifacts/replica-k6-output.txt'),loadOutput);
  if(held) docker(['stop','--timeout','3',hold]);
  docker([...composeArgs,'up','-d','--no-deps','--scale','api=4','api']);
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(topic,'infra/compose/artifacts/replica-drill.json'),JSON.stringify(report,null,2)+'\n');
}
