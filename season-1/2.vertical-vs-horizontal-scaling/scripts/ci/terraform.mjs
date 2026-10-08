import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(topic,'infra/terraform'),results=resolve(topic,'infra/compose/artifacts/ci');
await mkdir(results,{recursive:true});
const report={startedAt:new Date().toISOString(),passed:false,cloudApplied:false,proof:'Terraform schema and mocked providers only',checks:[]};
const image='hashicorp/terraform:1.16.5@sha256:c7926feace05d0f7e73542842bf3945924e955a1f782cf000ccbb8d18fa42d77';
function run(folder,args,offline=false){
  const result=spawnSync('docker',['run','--rm','--cpus=1','--memory=2g',...(offline?['--network','none']:[]),'-v',root+':/work','-w','/work/'+folder,image,...args],{stdio:'inherit'});
  assert.equal(result.status,0,'Terraform validation failed, never replace mocks with a real apply');
}
try{
  run('platform',['fmt','-check','-recursive','/work']);
  for(const folder of ['platform','bootstrap']){
    run(folder,['init','-backend=false','-input=false','-lockfile=readonly','-no-color']);
    run(folder,['validate','-no-color'],true);
    if(folder==='platform')run(folder,['test','-no-color'],true);
    report.checks.push(folder+' schema validated without network access');
  }
  report.checks.push('mocked private network, encryption, OIDC, runtime hardening and bounded scaling assertions; invalid digest and disabled placeholders rejected');
  report.passed=true;
}finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(results,'terraform-verification.json'),JSON.stringify(report,null,2)+'\n');}
