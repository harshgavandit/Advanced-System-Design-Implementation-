import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedLab } from './seed.mjs';
import { waitForGateway } from './gateway-ready.mjs';

const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const compose=resolve(topic,'infra/compose/production-like.yaml');
const artifacts=resolve(topic,'infra/compose/artifacts');
const report={startedAt:new Date().toISOString(),checks:[],passed:false};
function docker(args) {
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,`${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const base='http://127.0.0.1:18082';
async function request(path,{method='GET',body,token,status=200}={}) {
  const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,status,`${method} ${path}`);
  return {body:await response.json(),headers:response.headers};
}
try {
  const ids=docker(['compose','-f',compose,'ps','-q','api']).split(/\r?\n/).filter(Boolean);
  assert.ok(ids.length>0);
  report.configuration=[];
  for(const id of ids) {
    const config=JSON.parse(docker(['inspect',id]))[0];
    assert.equal(config.Config.Labels['scaling.owner'],'production-lab');
    assert.equal(config.Config.Labels['com.docker.compose.project'],'scaling-production-lab');
    const sourceTreeSha256=config.Config.Labels['org.scaling.source.sha256'];
    assert.match(sourceTreeSha256,/^[a-f0-9]{64}$/,'Every serving image must retain application provenance');
    report.configuration.push({id,image:config.Image,sourceTreeSha256});
    assert.equal(config.Config.User,'1000:1000');
    assert.equal(config.HostConfig.ReadonlyRootfs,true);
    assert.equal(config.State.Health.Status,'healthy');
    assert.equal(config.NetworkSettings.Ports['5002/tcp'],null);
    assert.equal(docker(['exec',id,'node','-p','process.getuid()']),'1000');
  }
  report.checks.push('non-root, read-only image, healthy, no published API port');
  report.image=docker(['inspect','--format','{{.Image}}',ids[0]]);
  assert.equal(new Set(report.configuration.map(row=>row.image)).size,1,'Every serving replica must use the same image');
  assert.equal(new Set(report.configuration.map(row=>row.sourceTreeSha256)).size,1,'Every serving replica must use the same source');
  report.sourceTreeSha256=report.configuration[0].sourceTreeSha256;
  report.dataset=seedLab(compose);
  await waitForGateway(base);
  await request('/health'); await request('/ready');
  assert.equal((await fetch(base+'/metrics')).status,404);
  const signup=await request('/users/signup',{method:'POST',body:{name:'Container verification',email:`container-${Date.now()}@example.invalid`,password:'Synthetic-container-password'},status:201});
  const token=signup.body.accessToken;
  const seen=new Set();
  const deadline=Date.now()+30000;
  for(let i=0; Date.now()<deadline && (i<ids.length*2 || seen.size<ids.length);i++) {
    const profile=await request('/users/me',{token});
    assert.equal(profile.body._id,signup.body.user.id);
    seen.add(profile.headers.get('x-lab-upstream').split(',').at(-1).trim());
    if(seen.size<ids.length) await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(seen.size,ids.length,'Every healthy replica must serve the same authenticated session');
  await request('/users/logout',{method:'POST',token});
  await request('/users/me',{token,status:401});
  const listing=await request('/products?page=1&limit=20');
  assert.ok(Array.isArray(listing.body.items));
  assert.equal(listing.body.items.length,20);
  assert.equal(listing.body.totalItems,10000);
  report.checks.push('real Linux bcrypt signup, cross-request session, logout, catalog, private metrics');
  report.replicas=ids.length;
  report.distinctUpstreams=seen.size;
  report.passed=true;
  console.log(`CONTAINER_PASS replicas=${ids.length} upstreams=${seen.size}`);
} finally {
  report.finishedAt=new Date().toISOString();
  await mkdir(artifacts,{recursive:true});
  await writeFile(resolve(artifacts,'container-verification.json'),JSON.stringify(report,null,2)+'\n');
}
