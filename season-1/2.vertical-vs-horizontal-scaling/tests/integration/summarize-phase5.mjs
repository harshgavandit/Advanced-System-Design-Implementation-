import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(topic,'infra/compose/artifacts');
const contract=JSON.parse(await readFile(resolve(topic,'tests/phase0/artifacts/contract-report-express.json'),'utf8'));
const ingestion=JSON.parse(await readFile(resolve(root,'ingestion/durability.json'),'utf8'));
const container=JSON.parse(await readFile(resolve(root,'container-verification.json'),'utf8'));
assert.ok(contract.verificationPassed && contract.databaseCache.passed && contract.indexCost.passed);
assert.ok(ingestion.passed && ingestion.gate==='durability');
assert.ok(container.passed && container.replicas===4);
assert.equal(ingestion.image,container.image);
assert.match(container.sourceTreeSha256,/^[a-f0-9]{64}$/);
assert.equal(ingestion.sourceTreeSha256,container.sourceTreeSha256,'Durability and runtime must share application source');
const contractHash=createHash('sha256');
async function hashContractSource(path,prefix=''){
  const entries=await readdir(path,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const name=prefix+entry.name;
    if(entry.isDirectory())await hashContractSource(resolve(path,entry.name),name+'/');
    else{contractHash.update(name+'\0');contractHash.update(await readFile(resolve(path,entry.name)));}
  }
}
await hashContractSource(resolve(topic,'servers/02-express/src'));
assert.equal(contract.sourceTreeSha256,contractHash.digest('hex'),'Index/cache contracts must cover current source');
const reports=[];
for(const file of await readdir(resolve(root,'benchmarks'))){
  if(!file.endsWith('-report.json'))continue;
  const report=JSON.parse(await readFile(resolve(root,'benchmarks',file),'utf8'));
  if(report.configuration?.[0]?.image===container.image && report.duration==='2m' && [6,7].includes(report.run))reports.push({...report,file});
}
const load=[];
for(const run of [6,7]){
  const report=reports.filter(row=>row.run===run).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0];
  assert.ok(report?.passed);assert.equal(report.rate,100);assert.equal(report.cache,'public-cache-aside');
  assert.equal(report.configuration.length,4);
  assert.ok(report.configuration.every(row=>row.image===container.image&&row.sourceTreeSha256===container.sourceTreeSha256&&row.publicCache===true),'Every capacity replica must match the current artifact and cache policy');
  assert.equal(report.dataset.sha256,container.dataset.sha256);
  const metrics=report.result.metrics;
  assert.equal(metrics.http_req_failed.value,0);assert.equal(metrics.dropped_iterations?.count??0,0);assert.equal(metrics.checks.value,1);
  assert.ok(metrics.http_req_duration['p(95)']<150 && metrics.http_req_duration['p(99)']<300);
  load.push({scenario:run===6?'cache-on cold/warm':'Redis unavailable',requests:metrics.http_reqs.count,p95Ms:metrics.http_req_duration['p(95)'],p99Ms:metrics.http_req_duration['p(99)'],report:report.file});
}
const summary={completedAt:new Date().toISOString(),passed:true,synthetic:true,image:container.image,sourceTreeSha256:container.sourceTreeSha256,contractVersion:contract.contractVersion,operations:contract.supportedOperationsExecuted.length,databaseCache:contract.databaseCache,indexCost:contract.indexCost,ingestionReconciliation:ingestion.reconciliation,load,limitations:['Fixed catalog load on 10000 synthetic products; not mixed-workload maximum production capacity.','Single-primary local MongoDB and ElasticMQ; cloud retention/AZ behavior not established.']};
await writeFile(resolve(root,'phase5-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log('PHASE5_PASS mutation retry/race, index evidence, bounded cache/pools, 100 RPS Redis-outage integrity');
