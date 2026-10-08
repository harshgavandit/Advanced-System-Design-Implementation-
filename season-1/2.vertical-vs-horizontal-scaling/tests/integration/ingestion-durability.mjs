import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';
import {waitForGateway} from '../container/gateway-ready.mjs';

const topic = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireServer = createRequire(resolve(topic, 'servers/02-express/package.json'));
const {mongo} = requireServer('mongoose');
const report = {startedAt:new Date().toISOString(), passed:false, synthetic:true, checks:[]};
report.gate=process.argv.includes('--accept-only')?'acceptance-only':'durability';
const client = new mongo.MongoClient('mongodb://127.0.0.1:28047/ingestion_test?directConnection=true', {serverSelectionTimeoutMS:3000});
const base = 'http://127.0.0.1:18084';
const payload = {name:'Durable synthetic product',description:'Crash and retry test',price:1,stock:0,category:'test',imageUrl:'https://example.invalid/test.jpg'};
async function request(path, {method='GET', body, token, key, status=200}={}) {
  const response = await fetch(base+path, {method, headers:{...(body?{'content-type':'application/json'}:{}), ...(token?{authorization:`Bearer ${token}`} : {}), ...(key?{'idempotency-key':key}: {})}, body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(10000)});
  const json = await response.json();
  assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}
function docker(args) {
  const result = spawnSync('docker', args, {encoding:'utf8', timeout:60000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
try {
  const ids = docker(['ps','--filter','label=com.docker.compose.project=scaling-ingestion-test','--filter','label=com.docker.compose.service=api','--format','{{.ID}}']).split(/\r?\n/).filter(Boolean);
  assert.equal(ids.length,1,'Only the dedicated ingestion test project may be mutated');
  const config = JSON.parse(docker(['inspect',ids[0]]))[0];
  report.image=config.Image;
  report.sourceTreeSha256=config.Config.Labels['org.scaling.source.sha256'];
  report.environment={database:'ingestion_test',project:'scaling-ingestion-test',apiCpu:config.HostConfig.NanoCpus/1e9,apiMemoryBytes:config.HostConfig.Memory,backlogLimit:3,visibilitySeconds:60,receiveBudget:5};
  assert.ok(config.Config.Env.includes('MONGO_URI=mongodb://mongo:27017/ingestion_test?replicaSet=production-lab'));
  await client.connect();
  const db = client.db('ingestion_test');
  assert.equal(db.databaseName,'ingestion_test');
  const owners = db.collection('test_owners');
  const prior = await owners.findOne({_id:'ingestion-durability'});
  assert.ok(!prior || prior.owner==='scaling-ingestion-test');
  await owners.updateOne({_id:'ingestion-durability'},{$set:{owner:'scaling-ingestion-test'}},{upsert:true});
  const queueConfig=JSON.parse(docker(['inspect','scaling-ingestion-test-queue-1']))[0];
  assert.equal(queueConfig.Config.Labels['com.docker.compose.project'],'scaling-ingestion-test');
  assert.ok(queueConfig.HostConfig.PortBindings['9324/tcp'].some(row=>row.HostIp==='127.0.0.1' && row.HostPort==='19324'));
  const cleanupSdk=requireServer('@aws-sdk/client-sqs');
  const cleanupQueue=new cleanupSdk.SQSClient({region:'us-east-1',endpoint:'http://127.0.0.1:19324',credentials:{accessKeyId:'local',secretAccessKey:'local'},maxAttempts:1});
  try {
    for(const name of ['ingestion-jobs','ingestion-dlq']) {
      const {QueueUrl}=await cleanupQueue.send(new cleanupSdk.GetQueueUrlCommand({QueueName:name}),{abortSignal:AbortSignal.timeout(5000)});
      await cleanupQueue.send(new cleanupSdk.PurgeQueueCommand({QueueUrl}),{abortSignal:AbortSignal.timeout(5000)});
    }
  } finally {cleanupQueue.destroy();}
  // Reset only named synthetic collections in the explicitly owned test database.
  for (const name of ['users','sessions','requestquotas','securityaudits','products','ingestion_jobs','ingestion_outbox','ingestion_counters']) await db.collection(name).deleteMany({});
  await db.collection('ingestion_counters').insertOne({_id:'products',accepted:0,pending:0,succeeded:0,failed:0});
  await waitForGateway(base);
  const user = await request('/users/signup', {method:'POST', body:{name:'Ingestion operator',email:`ingest-${Date.now()}@example.invalid`,password:'Synthetic-test-password'},status:201});
  await db.collection('users').updateOne({_id:new mongo.ObjectId(user.user.id)},{$set:{role:'admin'}},{writeConcern:{w:'majority'}});
  const token=user.accessToken;
  await request('/products/ingest', {method:'POST',body:payload,token,status:400});
  const initialRace=await Promise.all(Array.from({length:8},()=>request('/products/ingest', {method:'POST',body:payload,token,key:'durability-1',status:202})));
  const accepted=initialRace[0];
  assert.ok(initialRace.every(row=>row.jobId===accepted.jobId));
  assert.match(accepted.jobId,/^[a-f0-9]{24}$/);
  assert.equal(accepted.status,'accepted');
  assert.equal(await db.collection('ingestion_jobs').countDocuments({_id:new mongo.ObjectId(accepted.jobId)}),1);
  assert.equal(await db.collection('ingestion_outbox').countDocuments({jobId:new mongo.ObjectId(accepted.jobId)}),1);
  report.checks.push('202 requires a committed job and outbox; missing key is rejected');
  const copies=await Promise.all(Array.from({length:8},()=>request('/products/ingest',{method:'POST',body:payload,token,key:'durability-1',status:202})));
  assert.ok(copies.every(row=>row.jobId===accepted.jobId));
  await request('/products/ingest',{method:'POST',body:{...payload,price:2},token,key:'durability-1',status:409});
  const status=await request(`/ingestion-jobs/${accepted.jobId}`,{token});
  assert.equal(status.status,'accepted');
  const outsider=await request('/users/signup',{method:'POST',body:{name:'Other user',email:`other-${Date.now()}@example.invalid`,password:'Synthetic-test-password'},status:201});
  await request(`/ingestion-jobs/${accepted.jobId}`,{token:outsider.accessToken,status:404});
  await request(`/ingestion-jobs/${accepted.jobId}/redrive`,{method:'POST',token:outsider.accessToken,status:403});
  await request('/products/ingest',{method:'POST',body:payload,token:outsider.accessToken,key:'no-admin',status:403});
  const second=await request('/products/ingest',{method:'POST',body:{...payload,name:'Second'},token,key:'durability-2',status:202});
  const third=await request('/products/ingest',{method:'POST',body:{...payload,name:'Third'},token,key:'durability-3',status:202});
  await request('/products/ingest',{method:'POST',body:payload,token,key:'over-capacity',status:429});
  assert.equal(await db.collection('ingestion_jobs').countDocuments({}),3);
  const replayFull=await request('/products/ingest',{method:'POST',body:payload,token,key:'durability-1',status:202});
  assert.equal(replayFull.jobId,accepted.jobId,'An existing key remains replayable when admission is full');
  report.checks.push('concurrent identical keys replay; changed input conflicts; ownership and backlog bound hold');
  if (!process.argv.includes('--accept-only')) {
    const sdk=requireServer('@aws-sdk/client-sqs');
    const sqs=new sdk.SQSClient({region:'us-east-1',endpoint:'http://127.0.0.1:19324',credentials:{accessKeyId:'local',secretAccessKey:'local'},maxAttempts:1});
    const queue=(await sqs.send(new sdk.GetQueueUrlCommand({QueueName:'ingestion-jobs'}))).QueueUrl;
    const dlq=(await sqs.send(new sdk.GetQueueUrlCommand({QueueName:'ingestion-dlq'}))).QueueUrl;
    async function command(name, input) { return sqs.send(new sdk[name](input),{abortSignal:AbortSignal.timeout(10000)}); }
    function inside(code, expectedExit=0) {
      const result=spawnSync('docker',['exec',ids[0],'node','--input-type=module','-e',`import mongoose from 'mongoose'; import * as ingestion from './dist/ingestion.js'; await mongoose.connect(process.env.MONGO_URI); try { ${code} } finally { await mongoose.disconnect(); }`],{encoding:'utf8',timeout:20000});
      assert.equal(result.status,expectedExit,[result.stderr,result.error?.message,result.stdout.slice(-500)].filter(Boolean).join('\n'));
      return result.stdout;
    }
    function role(name, action) { return docker([action,`scaling-ingestion-test-${name}-1`]); }
    async function stopWorker() {
      role('worker','stop');
      assert.equal(docker(['inspect','scaling-ingestion-test-worker-1','--format','{{.State.ExitCode}}']),'0','Worker must drain cleanly');
      // A cancelled client long poll may still exist at the provider until its
      // ten-second wait expires. Do not publish a new test message into that gap.
      await new Promise(done=>setTimeout(done,11000));
    }
    async function until(check, label, timeout=90000) {
      const deadline=Date.now()+timeout;
      while (Date.now()<deadline) { if (await check()) return; await new Promise(done=>setTimeout(done,500)); }
      assert.fail(`Timed out: ${label}`);
    }
    async function receive(url=queue) {
      const row=await command('ReceiveMessageCommand',{QueueUrl:url,MaxNumberOfMessages:1,WaitTimeSeconds:1,VisibilityTimeout:60,MessageSystemAttributeNames:['ApproximateReceiveCount']});
      return row.Messages?.[0];
    }
    async function messageFor(jobId) {
      let message;
      await until(async()=>{ message=await receive(); if (!message) return false; assert.equal(JSON.parse(message.Body).jobId,jobId); return true; },'expected transport delivery',90000);
      return message;
    }
    function processMessage(message, exit=0) {
      return inside(`const result=await ingestion.completeEvent(${JSON.stringify(JSON.parse(message.Body))}); console.log('RESULT:'+result); ${exit?`process.exit(${exit});`:''}`,exit);
    }
    // Crash at the real boundaries: no test-only fault hook in application code.
    docker(['restart',ids[0]]);
    await waitForGateway(base);
    assert.equal((await request(`/ingestion-jobs/${accepted.jobId}`,{token})).status,'accepted');
    report.checks.push('API restart after acceptance preserves committed jobs');
    inside(`const event=await ingestion.leaseOutbox(); await ingestion.publishEvent(event); process.exit(73);`,73);
    const firstEvent=await db.collection('ingestion_outbox').findOne({jobId:new mongo.ObjectId(accepted.jobId)});
    assert.equal(firstEvent.state,'pending','Send-before-mark crash must leave a retryable outbox');
    await db.collection('ingestion_outbox').updateOne({_id:firstEvent._id},{$set:{leaseUntil:new Date(0)}});
    inside('await ingestion.relayOnce();');
    const firstMessage=await messageFor(accepted.jobId);
    assert.ok(processMessage(firstMessage,73).includes('RESULT:ack'));
    const completed=await db.collection('ingestion_jobs').findOne({_id:new mongo.ObjectId(accepted.jobId)});
    assert.equal(completed.status,'succeeded');
    assert.equal(await db.collection('products').countDocuments({_id:completed.productId}),1);
    const duplicate=await messageFor(accepted.jobId);
    assert.ok(processMessage(duplicate).includes('RESULT:ack'));
    await command('DeleteMessageCommand',{QueueUrl:queue,ReceiptHandle:duplicate.ReceiptHandle});
    await command('ChangeMessageVisibilityCommand',{QueueUrl:queue,ReceiptHandle:firstMessage.ReceiptHandle,VisibilityTimeout:0});
    role('worker','start');
    await until(async()=>{
      const attrs=await command('GetQueueAttributesCommand',{QueueUrl:queue,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']});
      return Object.values(attrs.Attributes).every(value=>Number(value)===0);
    },'worker acknowledges redelivered committed effect');
    await stopWorker();
    assert.equal(await db.collection('products').countDocuments({_id:completed.productId}),1);
    report.checks.push('crash after queue send republishes; crash after product commit and before ack creates one effect');
    inside('await ingestion.relayOnce();');
    const secondMessage=await messageFor(second.jobId);
    inside(`await ingestion.leaseJob(${JSON.stringify(JSON.parse(secondMessage.Body))}); process.exit(73);`,73);
    const partial=await db.collection('ingestion_jobs').findOne({_id:new mongo.ObjectId(second.jobId)});
    assert.equal(partial.status,'processing');
    assert.equal(await db.collection('products').countDocuments({_id:partial.productId}),0);
    await db.collection('ingestion_jobs').updateOne({_id:partial._id},{$set:{leaseUntil:new Date(0)}});
    await command('ChangeMessageVisibilityCommand',{QueueUrl:queue,ReceiptHandle:secondMessage.ReceiptHandle,VisibilityTimeout:0});
    role('worker','start');
    await until(async()=>(await db.collection('ingestion_jobs').findOne({_id:partial._id})).status==='succeeded','worker recovers expired lease');
    await stopWorker();
    report.checks.push('worker crash before effect leaves no partial product and lease expiry permits recovery');
    await db.collection('ingestion_jobs').updateOne({_id:new mongo.ObjectId(third.jobId)},{$set:{'payload.stock':-1}});
    inside('await ingestion.relayOnce();');
    for(let attempt=1;attempt<=5;attempt++) {
      const poison=await messageFor(third.jobId);
      assert.ok(processMessage(poison).includes('RESULT:retry'));
      await command('ChangeMessageVisibilityCommand',{QueueUrl:queue,ReceiptHandle:poison.ReceiptHandle,VisibilityTimeout:0});
    }
    let failed=await db.collection('ingestion_jobs').findOne({_id:new mongo.ObjectId(third.jobId)});
    assert.equal(failed.status,'failed'); assert.equal(failed.attempts,5);
    assert.equal(await db.collection('products').countDocuments({_id:failed.productId}),0);
    let dead;
    await until(async()=>{ await receive(); dead=await receive(dlq); return Boolean(dead); },'five-receive poison reaches the actual DLQ',15000);
    assert.equal(JSON.parse(dead.Body).jobId,third.jobId);
    await db.collection('ingestion_jobs').updateOne({_id:failed._id},{$set:{'payload.stock':0}});
    const redriven=await request(`/ingestion-jobs/${third.jobId}/redrive`,{method:'POST',token,status:202});
    assert.equal(redriven.status,'accepted');
    await request(`/ingestion-jobs/${third.jobId}/redrive`,{method:'POST',token,status:202});
    assert.ok(processMessage(dead).includes('RESULT:ack'),'Old generation has a durable superseding decision');
    await command('DeleteMessageCommand',{QueueUrl:dlq,ReceiptHandle:dead.ReceiptHandle});
    role('outbox','start'); role('worker','start');
    await until(async()=>(await db.collection('ingestion_jobs').findOne({_id:failed._id})).status==='succeeded','audited redrive succeeds');
    failed=await db.collection('ingestion_jobs').findOne({_id:failed._id});
    assert.equal(failed.generation,2); assert.equal(await db.collection('products').countDocuments({_id:failed.productId}),1);
    assert.equal(await db.collection('securityaudits').countDocuments({action:'ingestion-redriven',target:third.jobId}),1);
    report.checks.push('five failed attempts reach DLQ; corrected audited redrive increments generation once and creates one product');
    role('queue','stop');
    const outage=await request('/products/ingest',{method:'POST',body:{...payload,name:'Queue outage'},token,key:'outage',status:202});
    await new Promise(done=>setTimeout(done,3000));
    assert.equal((await request(`/ingestion-jobs/${outage.jobId}`,{token})).status,'accepted');
    assert.equal(await db.collection('ingestion_outbox').countDocuments({jobId:new mongo.ObjectId(outage.jobId),state:'pending'}),1);
    role('queue','start');
    await until(async()=>(await db.collection('ingestion_jobs').findOne({_id:new mongo.ObjectId(outage.jobId)})).status==='succeeded','queue recovery completes durable backlog');
    const counts=await db.collection('ingestion_counters').findOne({_id:'products'});
    assert.deepEqual({accepted:counts.accepted,pending:counts.pending,succeeded:counts.succeeded,failed:counts.failed},{accepted:4,pending:0,succeeded:4,failed:0});
    assert.equal(await db.collection('products').countDocuments({}),4);
    report.checks.push('queue outage preserves acceptance and recovery reconciles every acknowledged job');
    role('outbox','stop'); await stopWorker();
    const lost=await request('/products/ingest',{method:'POST',body:{...payload,name:'Transport-loss reconciliation'},token,key:'lost-transport',status:202});
    inside('await ingestion.relayOnce();');
    const lostMessage=await messageFor(lost.jobId);
    await command('DeleteMessageCommand',{QueueUrl:queue,ReceiptHandle:lostMessage.ReceiptHandle});
    await db.collection('ingestion_outbox').updateOne({jobId:new mongo.ObjectId(lost.jobId)},{$set:{dueAt:new Date(0)}});
    assert.ok(inside('console.log("RECONCILED:"+await ingestion.reconcileOutbox());').includes('RECONCILED:1'));
    inside('await ingestion.relayOnce();');
    const recoveredMessage=await messageFor(lost.jobId);
    assert.ok(processMessage(recoveredMessage).includes('RESULT:ack'));
    await command('DeleteMessageCommand',{QueueUrl:queue,ReceiptHandle:recoveredMessage.ReceiptHandle});
    const finalCounts=await db.collection('ingestion_counters').findOne({_id:'products'});
    assert.deepEqual({accepted:finalCounts.accepted,pending:finalCounts.pending,succeeded:finalCounts.succeeded,failed:finalCounts.failed},{accepted:5,pending:0,succeeded:5,failed:0});
    assert.equal(await db.collection('products').countDocuments({}),5);
    role('mongo','stop');
    try { await request('/products/ingest',{method:'POST',body:payload,token,key:'mongo-unavailable',status:503}); }
    finally { role('mongo','start'); }
    await waitForGateway(base);
    await until(async()=>{try{return await db.collection('ingestion_jobs').countDocuments({})===5;}catch{return false;}},'Mongo recovery reconciliation');
    role('outbox','start'); role('worker','start');
    report.checks.push('transport-loss reconciliation republishes overdue accepted work; Mongo outage returns no false 202');
    report.reconciliation={accepted:5,succeeded:5,failed:0,pending:0,products:5};
    report.limitations=['Synthetic isolated single-primary MongoDB and ElasticMQ, not AWS/AZ proof.','ElasticMQ 1.7.1 does not expose/enforce AWS message-retention attributes. Cloud startup strictly requires source 4 days and DLQ 14 days.','Crash boundaries use real component functions in intentionally terminated helper processes.','Five poison deliveries are accelerated with explicit test-only ChangeMessageVisibility calls; production visibility remains 60 seconds.'];
    sqs.destroy();
  }
  console.log(report.gate==='durability'?'INGESTION_DURABILITY_PASS accepted=5 succeeded=5 products=5 pending=0 failed=0':'INGESTION_ACCEPTANCE_PASS');
  report.passed=true;
} finally {
  await client.close();
  report.finishedAt=new Date().toISOString();
  await mkdir(resolve(topic,'infra/compose/artifacts/ingestion'),{recursive:true});
  await writeFile(resolve(topic,'infra/compose/artifacts/ingestion/durability.json'),JSON.stringify(report,null,2)+'\n');
}
