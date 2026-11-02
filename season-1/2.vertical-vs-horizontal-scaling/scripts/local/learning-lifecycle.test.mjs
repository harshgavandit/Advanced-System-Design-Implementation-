import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {hostname} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireRunnerLock,runCommand,trafficStart} from './learning-lifecycle.mjs';
const temporaryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../infra/compose/artifacts/tool-temp');
await mkdir(temporaryRoot,{recursive:true});

test('concurrent recovery of one dead runner admits exactly one new owner',async()=>{
  const folder=await mkdtemp(join(temporaryRoot,'learning-lock-')),path=join(folder,'runner.lock');
  try{
    await writeFile(path,JSON.stringify({owner:'learning-lab',host:hostname(),pid:2147483647,lease:'dead'}));
    const results=await Promise.allSettled([acquireRunnerLock(path),acquireRunnerLock(path)]);
    const winners=results.filter(row=>row.status==='fulfilled');assert.equal(winners.length,1);
    const winner=winners[0].value;assert.equal(JSON.parse(await readFile(path,'utf8')).lease,winner.lease);
    await assert.rejects(acquireRunnerLock(path),/active/);
    await winner.release();
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('stale-recovery guard and foreign lock fail closed without deleting a marker',async()=>{
  const folder=await mkdtemp(join(temporaryRoot,'learning-lock-')),path=join(folder,'runner.lock');
  try{
    const marker=JSON.stringify({owner:'other',host:hostname(),pid:2147483647,lease:'foreign'});
    await writeFile(path,marker);await assert.rejects(acquireRunnerLock(path),/owner/);
    assert.equal(await readFile(path,'utf8'),marker);
    await mkdir(path+'.acquiring');await assert.rejects(acquireRunnerLock(path),/acquisition/);
    assert.equal(await readFile(path,'utf8'),marker);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('cancelled child command settles promptly and no later command executes',async()=>{
  const controller=new AbortController(),started=Date.now();
  const command=runCommand(process.execPath,['-e','setTimeout(()=>{},10000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(new Error('Interrupted by SIGINT')),50);
  await assert.rejects(command,/Interrupted by SIGINT/);
  assert.ok(Date.now()-started<2000);
  await assert.rejects(runCommand(process.execPath,['-e',"console.log('should not execute')"],{signal:controller.signal}),/Interrupted by SIGINT/);
});
test('traffic handshake requires the real scenario marker across chunk boundaries',async()=>{
  const start=trafficStart();let ready=false;start.promise.then(()=>{ready=true;});
  start.observe('Pulling image\n');await Promise.resolve();assert.equal(ready,false);
  start.observe('LEARNING_TRAFFIC_');await Promise.resolve();assert.equal(ready,false);
  start.observe('STARTED\n');await start.promise;assert.equal(ready,true);
});
test('generator handshake receives stderr console output as well as stdout',async()=>{
  const start=trafficStart();let observed=false;start.promise.then(()=>{observed=true;});
  await runCommand(process.execPath,['-e',"console.error('LEARNING_TRAFFIC_STARTED')"],{onOutput:start.observe});
  await Promise.resolve();assert.equal(observed,true);
});
