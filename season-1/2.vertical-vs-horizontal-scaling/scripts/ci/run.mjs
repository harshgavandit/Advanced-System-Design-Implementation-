import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.platform==='win32')assert.equal(topic.slice(0,3).toUpperCase(),'D:\\','Local CI files must stay on D:');
if(process.platform==='win32'){
  process.env.XDG_CACHE_HOME='D:\\DevCaches\\pnpm\\cache';process.env.XDG_DATA_HOME='D:\\DevCaches\\pnpm\\data';process.env.XDG_STATE_HOME='D:\\DevCaches\\pnpm\\state';
}
const stage=process.argv.find(arg=>arg.startsWith('--stage='))?.slice(8);
assert.ok(['static','contract','image','security','terraform','operations'].includes(stage),'Choose an explicit CI stage');
const artifacts=resolve(topic,'infra/compose/artifacts/ci');await mkdir(artifacts,{recursive:true});
process.env.TEMP=resolve(topic,'infra/compose/artifacts/tool-temp');process.env.TMP=process.env.TEMP;
await mkdir(process.env.TEMP,{recursive:true});
const report={stage,startedAt:new Date().toISOString(),passed:false,sourceSha:process.env.GITHUB_SHA??null,ciRunId:process.env.GITHUB_RUN_ID??null,ciRunAttempt:process.env.GITHUB_RUN_ATTEMPT??null,checks:[]};
const fingerprint=spawnSync(process.execPath,[resolve(topic,'scripts/local/source-hash.mjs')],{encoding:'utf8'});
assert.equal(fingerprint.status,0,'Cannot identify the source under verification');
report.sourceTreeSha256=fingerprint.stdout.trim();
function run(binary,args,cwd=topic){const result=spawnSync(binary,args,{cwd,env:process.env,stdio:'inherit'});assert.equal(result.status,0,`${binary} ${args[0]} failed`);}
function pnpm(command){
  const cwd=resolve(topic,'servers/02-express');
  if(process.platform==='win32')run('powershell.exe',['-NoProfile','-Command',`& 'D:\\DevTools\\pnpm\\pnpm.cmd' --pm-on-fail=ignore ${command.join(' ')}`],cwd);
  else run('pnpm',['--pm-on-fail=ignore',...command],cwd);
}
try{
  if(stage==='static'||stage==='contract')pnpm(['install','--frozen-lockfile']);
  if(stage==='static'){
    pnpm(['typecheck']);pnpm(['test']);
    const files=[];
    for(const folder of ['tests/phase0/unit','tests/container','bench/scenarios','scripts/local','scripts/ci','scripts/operations'])for(const file of await readdir(resolve(topic,folder)))if(file.endsWith('.test.mjs'))files.push(resolve(topic,folder,file));
    run(process.execPath,['--test',...files]);
    for(const folder of ['scripts/ci','scripts/operations','tests/browser','tests/operations'])for(const file of await readdir(resolve(topic,folder)))if(file.endsWith('.mjs'))run(process.execPath,['--check',resolve(topic,folder,file)]);
    report.checks=['frozen install','canonical TypeScript typecheck','canonical unit suite','contract/schema/fixture and infrastructure-policy units','CI/browser JavaScript syntax'];
  }else if(stage==='contract'){
    const compose=resolve(topic,'tests/phase0/compose.yaml');
    await mkdir(resolve(topic,'tests/phase0/artifacts'),{recursive:true});
    try{
      run('docker',['compose','-f',compose,'up','-d','--wait']);
      run('docker',['compose','-f',compose,'exec','-T','mongo','mongosh','--port','28027','--quiet','--eval','try { rs.status() } catch (e) { if(e.code===94)rs.initiate({_id:"phase0",members:[{_id:0,host:"127.0.0.1:28027"}]});else throw e }']);
      run(process.execPath,[resolve(topic,'tests/phase0/run-contract.mjs'),'--implementation=express','--reset-test-db']);
      report.checks=['28 canonical contract operations','real Mongo transactions','ownership, security, idempotency and cache/concurrency regressions'];
    }finally{run('docker',['compose','-f',compose,'down']);}
  }else{
    run(process.execPath,[resolve(topic,`scripts/ci/${stage}.mjs`)]);
    report.checks=[{image:'Linux image tested through crash/replay/DLQ recovery',security:'redacted secret scan, Dockerfile lint, exact image vulnerability scan and SBOM',terraform:'Terraform schema validation and mocked infrastructure security checks; no cloud apply',operations:'exact tested image migration, encrypted restore, rollback and mixed-workload verification'}[stage]];
  }
  report.passed=true;console.log(`CI_${stage.toUpperCase()}_PASS`);
}finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(artifacts,`ci-${stage}.json`),JSON.stringify(report,null,2)+'\n');}
