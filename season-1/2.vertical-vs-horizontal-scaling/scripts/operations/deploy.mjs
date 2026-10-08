import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';import {validateTarget,validatePromotion,assessWindow,rollout} from './release-policy.mjs';import {journey} from './journey.mjs';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),folder=resolve(topic,'infra/compose/artifacts/ci');await mkdir(folder,{recursive:true});
const target=validateTarget(JSON.parse(process.env.CLOUD_TARGET_JSON??'{}'));assert.equal(process.env.GITHUB_REF,'refs/heads/main');
assert.ok(Number.isFinite(target.baselineP95Ms)&&target.baselineP95Ms>0,'A measured staging ALB latency baseline is required before changing services');
assert.equal(target.subnets?.length,2);assert.ok(target.subnets.every(value=>/^subnet-[a-f0-9]+$/.test(value)));assert.match(target.securityGroup,/^sg-[a-f0-9]+$/);assert.match(target.migrationTask,new RegExp('^arn:aws:ecs:'+target.region+':'+target.accountId+':task-definition/'+target.cluster+'-migration:[0-9]+$'));
const release=JSON.parse(await readFile(resolve(folder,'release.json'),'utf8'));assert.match(release.digest,/^sha256:[a-f0-9]{64}$/);assert.match(release.sourceSha,/^[a-f0-9]{40}$/);
assert.equal(release.image,target.repository+'@'+release.digest);
if(target.environment==='production')validatePromotion(release,JSON.parse(await readFile(resolve(folder,'staging.json'),'utf8')));
const repository=process.env.GITHUB_REPOSITORY;assert.match(repository??'',/^[\w.-]+\/[\w.-]+$/);
const certificateIdentity='https://github.com/'+repository+'/.github/workflows/vertical-scaling-release.yml@refs/heads/main';
function run(binary,args){const result=spawnSync(binary,args,{encoding:'utf8',timeout:120000});assert.equal(result.status,0,binary+' operation failed');return result.stdout.trim();}
function aws(args){return JSON.parse(run('aws',[...args,'--region',target.region,'--output','json']));}
assert.equal(aws(['sts','get-caller-identity']).Account,target.accountId);
const login=spawnSync('docker',['login','--username','AWS','--password-stdin',target.repository.split('/')[0]],{input:run('aws',['ecr','get-login-password','--region',target.region]),encoding:'utf8',timeout:120000});assert.equal(login.status,0,'Registry authentication failed');
const verifyArgs=['--certificate-identity',certificateIdentity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com'];
run('cosign',['verify',...verifyArgs,release.image]);
const attestations=run('cosign',['verify-attestation',...verifyArgs,'--type','https://scaling-lab.example/provenance/v1',release.image]).split('\n').filter(Boolean).map(line=>JSON.parse(Buffer.from(JSON.parse(line).payload,'base64').toString()));
assert.ok(attestations.some(row=>row.predicate.sourceSha===release.sourceSha&&row.predicate.archiveSha256===release.archiveSha256),'Signed provenance must match this release manifest');
const allowed=['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','runtimePlatform','ephemeralStorage','proxyConfiguration'];
const previous={},definitions={},events=[];const report={startedAt:new Date().toISOString(),passed:false,environment:target.environment,digest:release.digest,sourceSha:release.sourceSha,sourceTreeSha256:release.sourceTreeSha256,imageId:release.imageId,cloud:true,baselineP95Ms:target.baselineP95Ms};
async function waitService(role){const deadline=Date.now()+5*60000;while(Date.now()<deadline){const service=aws(['ecs','describe-services','--cluster',target.cluster,'--services',target.services[role]]).services[0];assert.ok(service);if(service.deployments.some(d=>d.rolloutState==='FAILED'))throw Error(role+' rollout failed');if(service.deployments.length===1&&service.runningCount===service.desiredCount&&service.pendingCount===0)return;await delay(10000);}throw Error(role+' did not stabilize within five minutes');}
function definition(arn){return aws(['ecs','describe-task-definition','--task-definition',arn]).taskDefinition;}
function register(old){const body=Object.fromEntries(allowed.filter(key=>old[key]!==undefined).map(key=>[key,old[key]]));assert.ok(body.family.startsWith(target.cluster+'-'));const app=body.containerDefinitions.find(c=>c.name==='app');assert.ok(app);app.image=release.image;return aws(['ecs','register-task-definition','--cli-input-json',JSON.stringify(body)]).taskDefinition.taskDefinitionArn;}
const adapter={
 async current(role){const service=aws(['ecs','describe-services','--cluster',target.cluster,'--services',target.services[role]]).services[0];previous[role]=service.taskDefinition;definitions[role]=definition(service.taskDefinition);return service.taskDefinition;},
 async migrate(){const task=register(definition(target.migrationTask));const result=aws(['ecs','run-task','--cluster',target.cluster,'--launch-type','FARGATE','--task-definition',task,'--network-configuration',JSON.stringify({awsvpcConfiguration:{subnets:target.subnets,securityGroups:[target.securityGroup],assignPublicIp:'DISABLED'}})]);assert.deepEqual(result.failures,[]);const arn=result.tasks[0].taskArn;const deadline=Date.now()+10*60000;while(Date.now()<deadline){const current=aws(['ecs','describe-tasks','--cluster',target.cluster,'--tasks',arn]).tasks[0];if(current.lastStatus==='STOPPED'){assert.equal(current.containers.find(c=>c.name==='app').exitCode,0,'Migration must succeed before any rollout');return;}await delay(10000);}aws(['ecs','stop-task','--cluster',target.cluster,'--task',arn,'--reason','Migration deadline exceeded']);throw Error('Migration timed out');},
 async deploy(role){aws(['ecs','update-service','--cluster',target.cluster,'--service',target.services[role],'--task-definition',register(definitions[role])]);},
 ready:waitService,
 async verifyRollback(){report.previousVersionJourney=await journey({base:target.url,...credentials});},
 async rollback(role,arn){aws(['ecs','update-service','--cluster',target.cluster,'--service',target.services[role],'--task-definition',arn]);}
};
const credentials=JSON.parse(process.env.SYNTHETIC_JOURNEY_JSON??'{}');assert.equal(credentials.users?.length,2);assert.ok(credentials.admin,'A pre-authorized synthetic admin is required, no automatic cloud privilege grant');
async function verify(){report.journey=await journey({base:target.url,...credentials});}
async function observe(){
 assert.ok(Number.isFinite(target.baselineP95Ms)&&target.baselineP95Ms>0);
 const started=Date.now();let complete=0;
 while(Date.now()-started<20*60000&&complete<3){
  await delay(5*60000);await verify();
  const end=new Date(Math.floor(Date.now()/300000)*300000),start=new Date(end.getTime()-300000);
  const metric=(id,name,stat)=>({Id:id,MetricStat:{Metric:{Namespace:'AWS/ApplicationELB',MetricName:name,Dimensions:[{Name:'LoadBalancer',Value:target.loadBalancerDimension}]},Period:300,Stat:stat},ReturnData:true});
  const data=aws(['cloudwatch','get-metric-data','--start-time',start.toISOString(),'--end-time',end.toISOString(),'--metric-data-queries',JSON.stringify([metric('requests','RequestCount','Sum'),metric('target_errors','HTTPCode_Target_5XX_Count','Sum'),metric('edge_errors','HTTPCode_ELB_5XX_Count','Sum'),metric('latency','TargetResponseTime','p95')])]).MetricDataResults;
  assert.ok(data.every(row=>row.StatusCode==='Complete'),'Incomplete telemetry cannot pass promotion');
  const value=id=>data.find(row=>row.Id===id)?.Values[0];const requests=value('requests'),p95=value('latency');
  const sample={seconds:300,requests:requests??0,failed:(value('target_errors')??0)+(value('edge_errors')??0),p95Ms:p95===undefined?Infinity:p95*1000};
  const gate=assessWindow(sample,{baselineP95Ms:target.baselineP95Ms});events.push({at:end.toISOString(),...sample,...gate});
  if(gate.decision==='rollback')throw Error('SLO gate: '+gate.reason);
  if(gate.decision==='continue')complete++;else complete=0;
 }
 assert.equal(complete,3,'Three full five-minute windows with enough traffic are mandatory');
}
try{Object.assign(report,await rollout({adapter,verify,observe}));report.sloWindows=events;assert.equal(report.passed,true,'Deployment failed; inspect rollback status');}
finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(folder,target.environment+'.json'),JSON.stringify(report,null,2)+'\n');}
