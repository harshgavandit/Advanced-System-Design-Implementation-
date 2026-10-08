import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from './policy.mjs';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
test('topic changes and delivery workflow changes must run checks while unrelated topics can skip',()=>{
  assert.equal(policy.topicChanged(['season-1/2.vertical-vs-horizontal-scaling/servers/02-express/src/app.ts']),true);
  assert.equal(policy.topicChanged(['.github/workflows/vertical-scaling-ci.yml']),true);
  assert.equal(policy.topicChanged(['season-1/1.compressions/example.ts']),false);
});
test('the actual delivery workflow uses immutable actions and explicit safe evidence uploads',()=>{
  const workflow=readFileSync(new URL('../../../../.github/workflows/vertical-scaling-ci.yml',import.meta.url),'utf8');
  const actions=[...workflow.matchAll(/uses:\s+(\S+)/g)].map(match=>match[1]);
  assert.ok(actions.length>0);
  for(const action of actions)assert.match(action,/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
  assert.ok(!workflow.includes('pull_request_target'));
  assert.ok(!workflow.includes('id-token: write'));
  assert.ok(!workflow.includes('${{ secrets.'));
  const paths=[...workflow.matchAll(/path: \|\r?\n((?:[ ]{12}[^\r\n]+\r?\n?)+)/g)].flatMap(match=>match[1].trim().split(/\r?\n/).map(path=>path.trim()));
  assert.ok(paths.length>=7,'Inspect actual upload paths, not only a standalone allowlist');
  for(const path of paths){assert.match(path,/^season-1\/2\.vertical-vs-horizontal-scaling\/(tests\/phase0\/artifacts|infra\/compose\/artifacts\/ci)\/[\w.-]+$/);assert.equal(policy.safeArtifact(basename(path)),true,path);}
});
test('the real always-reporting entrypoint fails closed for incomplete and cancelled checks',()=>{
  const script=new URL('./changes.mjs',import.meta.url);
  const run=(changed,checks)=>spawnSync(process.execPath,[fileURLToPath(script),'--required'],{env:{...process.env,TOPIC_CHANGED:changed,CHECK_RESULTS:JSON.stringify(checks)},encoding:'utf8'});
  const success={static:'success',contract:'success',image:'success',security:'success',terraform:'success',operations:'success'};
  assert.equal(run('true',success).status,0);
  assert.notEqual(run('true',{...success,security:'cancelled'}).status,0);
  assert.notEqual(run('',success).status,0);
  assert.equal(run('false',{}).status,0);
});
test('the always-reporting required gate rejects missing, cancelled or failing relevant checks',()=>{
  assert.equal(policy.requiredCheck(true,{static:'success',contract:'success',image:'success',security:'success',terraform:'success',operations:'success'}),true);
  for(const bad of ['failure','cancelled','skipped',undefined])assert.equal(policy.requiredCheck(true,{static:'success',contract:bad,image:'success',security:'success'}),false);
  assert.equal(policy.requiredCheck(false,{static:'skipped',contract:'skipped',image:'skipped',security:'skipped'}),true);
});
test('evidence upload cannot include secrets, raw logs, databases or a broad artifacts directory',()=>{
  assert.equal(policy.safeArtifact('phase6-observability.json'),true);
  assert.equal(policy.safeArtifact('image-sbom.spdx.json'),true);
  for(const path of ['local-keys.json','events.jsonl','artifacts/**','.env','mongo','server-output-express.txt','../local-keys.json'])assert.equal(policy.safeArtifact(path),false);
});
