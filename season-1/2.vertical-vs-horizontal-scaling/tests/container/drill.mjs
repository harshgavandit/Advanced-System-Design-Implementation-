import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const compose=resolve(topic,'infra/compose/production-like.yaml');
const base='http://127.0.0.1:18082';
const report={startedAt:new Date().toISOString(),passed:false,checks:[]};
function docker(args) {
  const r=spawnSync('docker',args,{encoding:'utf8',timeout:60000});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
async function status(path,token) {
  return (await fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(5000)})).status;
}
async function waitFor(path,expected,token) {
  for(let i=0;i<60;i++) { try {if(await status(path,token)===expected)return;}catch{} await new Promise(r=>setTimeout(r,500)); }
  throw new Error(`${path} never returned ${expected}`);
}
const services={};
for(const name of ['api','mongo','redis']) services[name]=docker(['compose','-f',compose,'ps','-q',name]).split(/\r?\n/).filter(Boolean);
assert.equal(services.api.length,1,'Run the drain drill before horizontal scaling');
report.image=docker(['inspect','--format','{{.Image}}',services.api[0]]);
report.sourceTreeSha256=docker(['inspect','--format','{{index .Config.Labels "org.scaling.source.sha256"}}',services.api[0]]);
try {
  const signed=await fetch(base+'/users/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Dependency drill',email:`drill-${Date.now()}@example.invalid`,password:'Synthetic-drill-password'})});
  assert.equal(signed.status,201);
  const token=(await signed.json()).accessToken;
  docker(['stop','--timeout','10',services.redis[0]]);
  try {
    assert.equal(await status('/products?page=1&limit=20'),200);
    assert.equal(await status('/users/me',token),200);
    assert.equal(await status('/ready'),200);
  } finally {docker(['start',services.redis[0]]);}
  report.checks.push('Redis outage preserves catalog, authoritative auth and readiness');
  docker(['stop','--timeout','25',services.mongo[0]]);
  try {
    await waitFor('/ready',503);
    assert.equal(await status('/users/me',token),503);
    assert.equal(await status('/health'),200);
  } finally {docker(['start',services.mongo[0]]);}
  await waitFor('/ready',200);
  await waitFor('/users/me',200,token);
  report.checks.push('Mongo outage fails protected requests closed, then recovers');
  const started=performance.now();
  // Traffic continues until SIGTERM closes admission. Completed replies must
  // have valid contents; rejected/unavailable replies during a single-replica
  // stop are counted rather than hidden.
  let stopping=false;
  const traffic=(async()=>{
    let successful=0,unavailable=0;
    while(!stopping) {
      try {const r=await fetch(base+'/products?page=1&limit=20',{signal:AbortSignal.timeout(5000)});if(r.ok){const body=await r.json();assert.equal(body.items.length,20);successful++;}else unavailable++;}
      catch(error){if(error instanceof assert.AssertionError)throw error;unavailable++;}
    }
    return {successful,unavailable};
  })();
  await new Promise(r=>setTimeout(r,300));
  const stopped=spawn('docker',['stop','--timeout','25',services.api[0]],{stdio:'ignore'});
  const [code]=await once(stopped,'exit');
  stopping=true;
  report.shutdownTraffic=await traffic;
  assert.equal(code,0);
  const state=JSON.parse(docker(['inspect','--format','{{json .State}}',services.api[0]]));
  assert.equal(state.ExitCode,0,'SIGTERM must drain without forced termination');
  report.shutdownSeconds=(performance.now()-started)/1000;
  assert.ok(report.shutdownSeconds<25);
  docker(['start',services.api[0]]);
  await waitFor('/ready',200);
  await waitFor('/users/me',200,token);
  report.checks.push('SIGTERM exits cleanly within deadline and durable session survives restart');
  report.passed=true;
  console.log(`CONTAINER_DRILL_PASS shutdown=${report.shutdownSeconds.toFixed(2)}s`);
} finally {
  // Restore only the explicitly selected lab resources after any test failure.
  for(const ids of Object.values(services)) for(const id of ids) docker(['start',id]);
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(topic,'infra/compose/artifacts/container-drill.json'),JSON.stringify(report,null,2)+'\n');
}
