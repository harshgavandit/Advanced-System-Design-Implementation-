import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQueuePolicy} from './policy.ts';
const source={VisibilityTimeout:'60',MessageRetentionPeriod:'345600',RedrivePolicy:JSON.stringify({maxReceiveCount:5,deadLetterTargetArn:'arn:dlq'})};
const dead={MessageRetentionPeriod:'1209600',QueueArn:'arn:dlq'};
test('cloud policy requires retention, visibility and the correct dead-letter queue',()=>{
  assertQueuePolicy(source,dead,false);
  for(const change of [{VisibilityTimeout:'30'},{MessageRetentionPeriod:undefined},{RedrivePolicy:'{}'}]) assert.throws(()=>assertQueuePolicy({...source,...change},dead,false));
  assert.throws(()=>assertQueuePolicy(source,{...dead,QueueArn:'wrong'},false));
  assert.throws(()=>assertQueuePolicy(source,{...dead,MessageRetentionPeriod:'345600'},false));
});
test('local emulator may explicitly report unsupported retention without weakening cloud policy',()=>{
  const limited={...source,MessageRetentionPeriod:undefined};
  const limitedDead={...dead,MessageRetentionPeriod:undefined};
  assert.equal(assertQueuePolicy(limited,limitedDead,true).retentionSupported,false);
  assert.throws(()=>assertQueuePolicy(limited,limitedDead,false));
  assert.throws(()=>assertQueuePolicy({...limited,VisibilityTimeout:'30'},limitedDead,true));
});
