import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflowRun,validateReleaseReference} from './workflow-policy.mjs';

const repository='owner/project',sourceSha='a'.repeat(40);
const run={id:123,run_attempt:2,name:'Vertical scaling CI',path:'.github/workflows/vertical-scaling-ci.yml',event:'push',status:'completed',conclusion:'success',head_branch:'main',head_sha:sourceSha,repository:{full_name:repository},head_repository:{full_name:repository}};
const jobs=['changes','static','contract','image','security','terraform','operations','Scaling required checks'].map(name=>({name,run_id:123,run_attempt:2,conclusion:'success'}));

test('only the complete successful CI attempt can authorize a release',()=>{
  assert.equal(validateWorkflowRun({kind:'ci',run,jobs,repository,sourceSha}),true);
  for(const bad of ['failure','cancelled','skipped']){
    assert.throws(()=>validateWorkflowRun({kind:'ci',run,jobs:jobs.map(job=>job.name==='security'?{...job,conclusion:bad}:job),repository,sourceSha}));
  }
  assert.throws(()=>validateWorkflowRun({kind:'ci',run,jobs:jobs.slice(1),repository,sourceSha}));
  assert.throws(()=>validateWorkflowRun({kind:'ci',run,jobs:[...jobs,jobs[0]],repository,sourceSha}));
  assert.throws(()=>validateWorkflowRun({kind:'ci',run,jobs:jobs.map(job=>({...job,run_attempt:1})),repository,sourceSha}));
});

test('a README-only green CI run is not a releasable tested artifact',()=>{
  const skipped=jobs.map(job=>['changes','Scaling required checks'].includes(job.name)?job:{...job,conclusion:'skipped'});
  assert.equal(validateWorkflowRun({kind:'ci',run,jobs:skipped,repository,sourceSha}),false);
});

test('forks, other workflows, failed runs and substituted source cannot authorize cloud operations',()=>{
  for(const patch of [{head_sha:'b'.repeat(40)},{head_branch:'feature'},{event:'pull_request'},{path:'.github/workflows/untrusted.yml'},{status:'in_progress'},{conclusion:'failure'},{head_repository:{full_name:'fork/project'}},{repository:{full_name:'other/project'}}]){
    assert.throws(()=>validateWorkflowRun({kind:'ci',run:{...run,...patch},jobs,repository,sourceSha}));
  }
});

test('deployment references must come from successful release and staging workflow jobs',()=>{
  const releaseRun={...run,name:'Scaling signed release',path:'.github/workflows/vertical-scaling-release.yml',event:'workflow_run'};
  const releaseJobs=['qualify','publish'].map(name=>({...jobs[0],name}));
  assert.equal(validateWorkflowRun({kind:'release',run:releaseRun,jobs:releaseJobs,repository,sourceSha}),true);
  const stagingRun={...run,name:'Scaling digest promotion',path:'.github/workflows/vertical-scaling-deploy.yml',event:'workflow_dispatch'};
  assert.equal(validateWorkflowRun({kind:'staging',run:stagingRun,jobs:[{...jobs[0],name:'deploy'}],repository,sourceSha}),true);
  assert.throws(()=>validateWorkflowRun({kind:'release',run:releaseRun,jobs:releaseJobs.map(job=>({...job,conclusion:'skipped'})),repository,sourceSha}));
});

test('release manifests and staging evidence bind the selected workflow run IDs',()=>{
  const release={sourceSha,releaseRunId:'123',ciRunId:'99'};
  const staging={environment:'staging',passed:true,cloud:true,releaseRunId:'123',runId:'456',sourceSha};
  validateReleaseReference(release,'123');
  validateReleaseReference(release,'123',staging,'456');
  for(const patch of [{releaseRunId:'789'},{runId:'789'},{sourceSha:'b'.repeat(40)},{cloud:false},{environment:'production'},{passed:false}])assert.throws(()=>validateReleaseReference(release,'123',{...staging,...patch},'456'));
  assert.throws(()=>validateReleaseReference(release,'789'));
  assert.throws(()=>validateReleaseReference({...release,ciRunId:undefined},'123'));
});
