import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash,randomBytes} from 'node:crypto';import {createReadStream} from 'node:fs';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),folder=resolve(topic,'infra/compose/artifacts/ci');await mkdir(folder,{recursive:true});
const identity=JSON.parse(await readFile(resolve(folder,'image-identity.json'),'utf8')),hash=createHash('sha256');for await(const chunk of createReadStream(resolve(folder,'ci-image.tar')))hash.update(chunk);assert.equal(hash.digest('hex'),identity.archiveSha256);
function run(binary,args,environment=process.env){const result=spawnSync(binary,args,{env:environment,stdio:'inherit'});assert.equal(result.status,0,'Operations gate failed');}
run('docker',['load','--input',resolve(folder,'ci-image.tar')]);
const inspected=spawnSync('docker',['image','inspect','--format','{{.Id}}','scaling-express:ci'],{encoding:'utf8'});assert.equal(inspected.stdout.trim(),identity.imageId);
const keyPath=resolve(topic,'infra/compose/artifacts/local-keys.json');try{await readFile(keyPath);}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(keyPath,JSON.stringify({access:randomBytes(32).toString('base64'),refresh:randomBytes(32).toString('base64')}),{mode:0o600,flag:'wx'});}
const report={startedAt:new Date().toISOString(),passed:false,imageId:identity.imageId,sourceTreeSha256:identity.sourceTreeSha256,cloud:false};
try {
 run(process.execPath,[resolve(topic,'tests/operations/recovery.mjs'),'--profile=smoke'],{...process.env,LAB_IMAGE:identity.imageId});
 for(const [name,file] of [['recovery','recovery/recovery.json'],['rollback','rollback/rollback.json'],['mixed','load/smoke.json']]){const value=JSON.parse(await readFile(resolve(topic,'infra/compose/artifacts/operations',file),'utf8'));assert.equal(value.passed,true);if(name==='recovery')assert.equal(value.image,identity.imageId);if(name==='mixed')assert.ok(value.configuration.every(c=>c.image===identity.imageId));report[name]={passed:true};await writeFile(resolve(folder,name+'-verification.json'),JSON.stringify(value,null,2)+'\n');}
 report.passed=true;
}catch(error){
 report.failure=String(error.message).slice(0,300);
 // Preserve safe synthetic failure reports as well as the stage result. Never
 // upload backups, signing keys, sessions, database files or raw service logs.
 for(const [name,file] of [['recovery','recovery/recovery.json'],['rollback','rollback/rollback.json'],['mixed','load/smoke.json']]){
  try{
   const value=JSON.parse(await readFile(resolve(topic,'infra/compose/artifacts/operations',file),'utf8'));
   if(Date.parse(value.startedAt)>=Date.parse(report.startedAt))await writeFile(resolve(folder,name+'-verification.json'),JSON.stringify(value,null,2)+'\n');
  }catch(failureReportError){if(failureReportError.code!=='ENOENT')throw failureReportError;}
 }
 throw error;
}finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(folder,'operations-summary.json'),JSON.stringify(report,null,2)+'\n');}
