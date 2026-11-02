import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {parseOptions, assertOwned, composeModel, summarizeLoad, dashboard, dashboardContract,scenarios,waitForHttpReady} from './learning-model.mjs';

test('scenario selection is explicit, bounded and rejects cloud/unknown inputs', () => {
  assert.deepEqual(parseOptions(['--all']).scenarios, Object.keys(scenarios));
  assert.deepEqual(parseOptions(['--scenario=worker-crash', '--duration=45s', '--rate=30']).scenarios, ['worker-crash']);
  for (const args of [['--scenario=aws'], ['--rate=0'], ['--duration=4h'], ['--rate=20junk'], ['--all','--scenario=baseline'], ['--cloud'], ['--repeat=0']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('ownership checks fail closed for foreign, missing and mixed labels', () => {
  const labels = {'com.docker.compose.project':'scaling-learning-lab','com.docker.compose.service':'api','scaling.owner':'learning-lab'};
  assert.doesNotThrow(() => assertOwned(labels, 'api'));
  for (const invalid of [{}, {...labels,'scaling.owner':'production-lab'}, {...labels,'com.docker.compose.project':'other'}, {...labels,'com.docker.compose.service':'mongo'}]) {
    assert.throws(() => assertOwned(invalid, 'api'));
  }
});

test('equal-budget topologies use the same CPU, memory and total API pool', () => {
  const options = {root:'/lab',runtime:'/lab/artifacts',image:'sha256:'+'a'.repeat(64),sourceHash:'b'.repeat(64)};
  const horizontal=composeModel({...options,topology:'horizontal'}), vertical=composeModel({...options,topology:'vertical'});
  assert.equal(horizontal.services.api.cpus*4, vertical.services.api.cpus);
  assert.equal(horizontal.services.api.mem_limit*4, vertical.services.api.mem_limit);
  assert.equal(Number(horizontal.services.api.environment.MONGO_POOL_MAX)*4, Number(vertical.services.api.environment.MONGO_POOL_MAX)*4);
  assert.equal(horizontal.name,'scaling-learning-lab');
  assert.equal(horizontal.services.api.environment.MONGO_URI,'mongodb://mongo:27017/learning_lab?replicaSet=production-lab');
  assert.equal(horizontal.services.api.environment.SQS_LOCAL_EMULATOR,'true');
  for(const service of ['mongo','restore']){
    assert.equal(horizontal.services[service].environment.GLIBC_TUNABLES,'glibc.pthread.rseq=1');
    assert.match(horizontal.services[service].healthcheck.test.at(-1),/usingPerCPUCaches===false/);
  }
  assert.equal(horizontal.services.api.environment.JWT_ACCESS_EXPIRES_IN,'6h');
  assert.equal(horizontal.services.gateway.user,'101:101');
  assert.deepEqual(horizontal.services.gateway.cap_drop,['ALL']);
  assert.equal(horizontal.networks.backend.internal,true);
  for (const service of Object.values(horizontal.services)) {
    assert.equal(service.labels['scaling.owner'],'learning-lab');
    for (const port of service.ports??[]) assert.match(port,/^127\.0\.0\.1:/);
  }
  assert.ok(!JSON.stringify(horizontal).includes('AKIA'));
});

test('result qualification uses failures, drops and correctness, never fabricates capacity', () => {
  const raw={metrics:{http_reqs:{values:{count:600,rate:20}},http_req_failed:{values:{rate:0}},http_req_duration:{values:{'p(95)':12,'p(99)':20}},checks:{values:{passes:600,fails:0}},dropped_iterations:{values:{count:0}},data_received:{values:{count:1000}}}};
  assert.equal(summarizeLoad(raw,0).passed,true);
  const legacy={metrics:Object.fromEntries(Object.entries(raw.metrics).map(([key,row])=>[key,key==='http_req_failed'?{...row.values,value:row.values.rate,rate:undefined}:row.values]))};
  assert.equal(summarizeLoad(legacy,0).passed,true);
  assert.equal(summarizeLoad(raw,99).passed,false);
  assert.equal(summarizeLoad({...raw,metrics:{...raw.metrics,dropped_iterations:{values:{count:1}}}},0).passed,false);
  assert.equal(summarizeLoad({...raw,metrics:{...raw.metrics,checks:{values:{passes:599,fails:1}}}},0).passed,false);
  assert.throws(()=>summarizeLoad({metrics:{}},0));
  const fault={metrics:{...raw.metrics,http_req_failed:{values:{rate:0.001,passes:1,fails:599}},checks:{values:{passes:1199,fails:1}},learning_correctness_failures:{values:{count:0}}}};
  assert.equal(summarizeLoad(fault,0).passed,false);
  assert.equal(summarizeLoad(fault,0,{faultWindow:true}).passed,true);
  assert.equal(summarizeLoad({...fault,metrics:{...fault.metrics,learning_correctness_failures:{values:{count:1}}}},0,{faultWindow:true}).passed,false);
  assert.throws(()=>summarizeLoad(raw,0,{faultWindow:true}));
});

test('dashboard scopes all measurements to the learning namespace and does not sum global state', () => {
  const value=dashboard();
  assert.equal(value.uid,'local-learning-lab');
  for (const panel of value.panels) for (const target of panel.targets??[]) {
    assert.match(target.expr,/learning-/);
    if(target.expr.includes('app_ingestion_state')) assert.match(target.expr,/^max/);
  }
  assert.equal(Object.keys(scenarios).length,11);
});
test('dashboard contract detects stale provisioning and admission remains a per-process budget',()=>{
  const value=dashboard();const stale=structuredClone(value);stale.panels.pop();
  assert.notDeepEqual(dashboardContract(value),dashboardContract(stale));
  const options={root:'/lab',runtime:'/lab/artifacts',image:'sha256:'+'a'.repeat(64),sourceHash:'b'.repeat(64)};
  assert.equal(composeModel({...options,admissionLimit:2}).services.api.environment.REQUEST_MAX_INFLIGHT,'2');
  assert.throws(()=>composeModel({...options,admissionLimit:0}));
});
test('real readiness probe waits through startup 503 and fails closed on persistent unavailability',async()=>{
  let requests=0,available=true;
  const server=createServer((_request,response)=>{response.writeHead(available&&++requests>=3?200:503);response.end('readiness');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/-/ready`;
  try{
    await waitForHttpReady(url,{timeoutMs:2000,intervalMs:10});assert.equal(requests,3);
    available=false;await assert.rejects(waitForHttpReady(url,{timeoutMs:100,intervalMs:10}),/Readiness timeout/);
    await assert.rejects(waitForHttpReady('https://example.invalid/ready'),/must remain local/);
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
});
