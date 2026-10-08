import assert from 'node:assert/strict';

const definitions={
  ci:{name:'Vertical scaling CI',path:'.github/workflows/vertical-scaling-ci.yml',event:'push',jobs:['changes','static','contract','image','security','terraform','operations','Scaling required checks']},
  release:{name:'Scaling signed release',path:'.github/workflows/vertical-scaling-release.yml',event:'workflow_run',jobs:['qualify','publish']},
  staging:{name:'Scaling digest promotion',path:'.github/workflows/vertical-scaling-deploy.yml',event:'workflow_dispatch',jobs:['deploy']}
};

export function validateWorkflowRun({kind,run,jobs,repository,sourceSha}){
  const definition=definitions[kind];assert.ok(definition,'Unknown trusted workflow kind');
  assert.match(repository,/^[\w.-]+\/[\w.-]+$/);assert.match(sourceSha,/^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(run.id)&&run.id>0&&Number.isInteger(run.run_attempt)&&run.run_attempt>0);
  assert.equal(run.repository?.full_name,repository);assert.equal(run.head_repository?.full_name,repository,'Fork artifacts cannot authorize release');
  assert.equal(run.name,definition.name);assert.equal(run.path,definition.path);assert.equal(run.event,definition.event);
  assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
  assert.equal(run.head_branch,'main');assert.equal(run.head_sha,sourceSha,'Workflow evidence must match the selected source');
  const results={};
  for(const name of definition.jobs){
    const matching=jobs.filter(job=>job.name===name);assert.equal(matching.length,1,'Missing or ambiguous trusted job: '+name);
    const job=matching[0];assert.equal(job.run_id,run.id);assert.equal(job.run_attempt,run.run_attempt,'Only the latest workflow attempt can authorize release');
    results[name]=job.conclusion;
  }
  if(kind==='ci'&&['static','contract','image','security','terraform','operations'].every(name=>results[name]==='skipped')){
    assert.equal(results.changes,'success');assert.equal(results['Scaling required checks'],'success');
    return false;
  }
  for(const name of definition.jobs)assert.equal(results[name],'success','Required trusted job did not pass: '+name);
  return true;
}

export function validateReleaseReference(release,releaseRunId,staging,stagingRunId){
  for(const value of [releaseRunId,release.ciRunId,release.releaseRunId])assert.match(String(value),/^[1-9][0-9]*$/,'A verified workflow run ID is required');
  assert.equal(String(release.releaseRunId),String(releaseRunId),'Release artifact does not belong to the selected workflow');
  assert.match(release.sourceSha,/^[a-f0-9]{40}$/);
  if(staging!==undefined){
    assert.match(String(stagingRunId),/^[1-9][0-9]*$/);
    assert.equal(staging.passed,true);assert.equal(staging.cloud,true);assert.equal(staging.environment,'staging');
    assert.equal(String(staging.runId),String(stagingRunId));assert.equal(String(staging.releaseRunId),String(releaseRunId));
    assert.equal(staging.sourceSha,release.sourceSha);
  }
}
