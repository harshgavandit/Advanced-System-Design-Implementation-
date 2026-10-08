import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,appendFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateWorkflowRun,validateReleaseReference} from './workflow-policy.mjs';

const kind=process.argv.find(value=>value.startsWith('--kind='))?.slice(7);
assert.ok(['ci','release','staging'].includes(kind));
const repository=process.env.GITHUB_REPOSITORY;assert.match(repository??'',/^[\w.-]+\/[\w.-]+$/);
const folder=resolve(dirname(fileURLToPath(import.meta.url)),'../../infra/compose/artifacts/ci');
let sourceSha=process.env.SOURCE_SHA,runId=process.env.REFERENCE_RUN_ID;
if(kind!=='ci'){
  const release=JSON.parse(await readFile(resolve(folder,'release.json'),'utf8'));sourceSha=release.sourceSha;
  if(kind==='release')validateReleaseReference(release,runId);
  else validateReleaseReference(release,process.env.RELEASE_RUN_ID,JSON.parse(await readFile(resolve(folder,'staging.json'),'utf8')),runId);
}
assert.match(runId??'',/^[1-9][0-9]*$/);
function github(path,paginate=false){
  const response=spawnSync('gh',['api',path,...(paginate?['--paginate','--slurp']:[])],{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(response.status,0,'Cannot verify trusted workflow metadata');return JSON.parse(response.stdout);
}
const run=github(`repos/${repository}/actions/runs/${runId}`);
const pages=github(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,true);
const jobs=pages.flatMap(page=>page.jobs);assert.equal(jobs.length,pages[0].total_count,'Incomplete job inventory cannot authorize release');
const eligible=validateWorkflowRun({kind,run,jobs,repository,sourceSha});
if(!process.argv.includes('--allow-unrelated'))assert.equal(eligible,true,'Unrelated-path CI has no releasable tested artifact');
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`eligible=${eligible}\n`);
console.log(eligible?'TRUSTED_WORKFLOW_VERIFIED '+kind:'RELEASE_SKIPPED unrelated paths, no tested image');
