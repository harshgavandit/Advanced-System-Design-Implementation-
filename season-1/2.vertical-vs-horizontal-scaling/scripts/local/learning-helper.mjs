// Runs only inside an ownership-checked learning API container. No host packages.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {generateProducts,createManifest} from '/fixtures/generate.mjs';
const require=createRequire('/app/package.json');
const mongoose=require('mongoose');
const input=JSON.parse(await readFile('/dev/stdin','utf8'));
const source='mongodb://mongo:27017/learning_lab?replicaSet=production-lab';
assert.equal(process.env.MONGO_URI,source,'Helper refuses non-learning API configuration');
const uri=input.action==='restore-digest'?'mongodb://restore:27017/learning_lab':source;
await mongoose.connect(uri,{serverSelectionTimeoutMS:5000});
const db=mongoose.connection.db;
const owner='scaling-learning-lab';
const collection=name=>db.collection(name);
const marker=await collection('_learning_owner').findOne({_id:'lab'});
assert.ok(marker?.owner===owner || (!marker&&input.action==='seed'),'Unowned synthetic database');
const oid=value=>new mongoose.mongo.ObjectId(value);
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
async function digest(){
  const result={};
  for(const {name} of (await db.listCollections().toArray()).sort((a,b)=>a.name.localeCompare(b.name))){
    if(name.startsWith('system.'))continue;
    const rows=await collection(name).find({}).sort({_id:1}).toArray();
    const serialized=mongoose.mongo.BSON.EJSON.serialize(rows);
    result[name]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(canonical(serialized))).digest('hex')};
  }
  return result;
}
let result;
try{
  if(input.action==='seed'){
    if(!marker){
      for(const {name} of await db.listCollections().toArray())assert.equal(await collection(name).countDocuments({}),name==='ingestion_counters'?1:0,`Refusing existing unowned ${name}`);
      const products=generateProducts();
      const passwordHash=await require('bcrypt').hash(input.password,10);
      const session=await mongoose.startSession();
      try{await session.withTransaction(async()=>{
        await collection('_learning_owner').insertOne({_id:'lab',owner,synthetic:true},{session});
        await collection('products').insertMany(products.map(row=>({...row,_id:oid(row._id),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)})),{session});
        await collection('users').insertMany(Array.from({length:20},(_,i)=>({name:`Synthetic learner ${i+1}`,email:`learning-${i+1}@example.invalid`,passwordHash,isActive:true,role:'user',createdAt:new Date(),updatedAt:new Date()})),{session});
      },{writeConcern:{w:'majority'}});}finally{await session.endSession();}
    }
    assert.ok(await collection('products').countDocuments({})>=10000);
    assert.equal(await collection('users').countDocuments({email:{$regex:'^learning-[0-9]+@example\\.invalid$'}}),20,'Incomplete learner fixture');
    result={products:await collection('products').countDocuments({}),users:await collection('users').countDocuments({}),fixture:createManifest(generateProducts(),42)};
  }else if(input.action==='grant'){
    assert.equal((await collection('users').updateOne({_id:oid(input.id)},{$set:{role:'admin'}})).matchedCount,1);result={granted:true};
  }else if(input.action==='job'){
    const job=await collection('ingestion_jobs').findOne({_id:oid(input.id)});
    result={status:job?.status,attempts:job?.attempts,productId:job?.productId?.toHexString(),effects:job?await collection('products').countDocuments({_id:job.productId}):0};
  }else if(input.action==='expire'){
    assert.equal((await collection('ingestion_jobs').updateOne({_id:oid(input.id),status:'processing'},{$set:{leaseUntil:new Date(0)}})).matchedCount,1);result={expired:true};
  }else if(input.action==='state'){
    const counters=await collection('ingestion_counters').findOne({_id:'products'});
    result={accepted:counters.accepted,pending:counters.pending,succeeded:counters.succeeded,failed:counters.failed,products:await collection('products').countDocuments({}),users:await collection('users').countDocuments({})};
  }else if(input.action==='digest'||input.action==='restore-digest')result=await digest();
  else if(input.action==='component'){
    const ingestion=await import('/app/dist/ingestion.js');
    assert.ok(['relay','lease','complete'].includes(input.operation));
    if(input.operation==='relay')result=await ingestion.relayOnce();
    if(input.operation==='lease'){
      const claim=await ingestion.leaseJob(input.event);
      result={leased:typeof claim==='object'};
    }
    if(input.operation==='complete')result=await ingestion.completeEvent(input.event);
    console.log('LAB_RESULT:'+JSON.stringify(result));
    if(input.crash)process.exit(73);
    result=undefined;
  }else if(input.action==='queue'){
    const sdk=require('@aws-sdk/client-sqs');
    const client=new sdk.SQSClient({region:'us-east-1',endpoint:'http://queue:9324',credentials:{accessKeyId:'local',secretAccessKey:'local'},maxAttempts:1});
    const QueueUrl='http://queue:9324/000000000000/ingestion-jobs';
    try{
      if(input.operation==='receive')result=(await client.send(new sdk.ReceiveMessageCommand({QueueUrl,MaxNumberOfMessages:1,WaitTimeSeconds:1,VisibilityTimeout:60}),{abortSignal:AbortSignal.timeout(5000)})).Messages?.[0]??null;
      else if(input.operation==='send')result=await client.send(new sdk.SendMessageCommand({QueueUrl,MessageBody:JSON.stringify(input.event)}));
      else if(input.operation==='release')result=await client.send(new sdk.ChangeMessageVisibilityCommand({QueueUrl,ReceiptHandle:input.receipt,VisibilityTimeout:0}));
      else if(input.operation==='delete')result=await client.send(new sdk.DeleteMessageCommand({QueueUrl,ReceiptHandle:input.receipt}));
      else if(input.operation==='attributes')result=(await client.send(new sdk.GetQueueAttributesCommand({QueueUrl,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}))).Attributes;
      else assert.fail('Unknown queue operation');
    }finally{client.destroy();}
  }else assert.fail('Unknown helper operation');
  if(result!==undefined)console.log('LAB_RESULT:'+JSON.stringify(result));
}finally{await mongoose.disconnect();}
