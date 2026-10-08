import {SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, GetQueueAttributesCommand, SetQueueAttributesCommand} from '@aws-sdk/client-sqs';
import type {IngestionEvent} from '../features/ingestion/policy.js';
import {assertQueuePolicy} from './policy.js';
import {logger} from '../bootstrap/logger.js';

const region=process.env.SQS_REGION || process.env.AWS_REGION;
const endpoint=process.env.SQS_ENDPOINT;
const local=process.env.SQS_LOCAL_EMULATOR==='true';
export const queueUrl=process.env.SQS_QUEUE_URL ?? '';
const dlqUrl=process.env.SQS_DLQ_URL ?? '';
let client:SQSClient | undefined;
export function queueClient(): SQSClient {
  if (client) return client;
  if (!region || !queueUrl || !dlqUrl) throw new Error('SQS region, source queue and DLQ URLs are required');
  const queue=new URL(queueUrl), dead=new URL(dlqUrl);
  if (local) {
    if (!endpoint) throw new Error('Local emulator endpoint is required');
    const url=new URL(endpoint);
    if (!['queue','localhost','127.0.0.1'].includes(url.hostname) || url.protocol!=='http:' || queue.origin!==url.origin || dead.origin!==url.origin) throw new Error('Local SQS credentials are restricted to the emulator');
  } else if (endpoint || queue.protocol!=='https:' || dead.protocol!=='https:') {
    throw new Error('Cloud SQS requires HTTPS and the default AWS endpoint/credential chain');
  }
  client=new SQSClient({region,...(local?{endpoint,credentials:{accessKeyId:'local-emulator',secretAccessKey:'local-emulator'}}:{}),maxAttempts:2});
  return client;
}
export async function validateQueuePolicy(): Promise<void> {
  const sqs=queueClient();
  if (local) {
    await sqs.send(new SetQueueAttributesCommand({QueueUrl:queueUrl,Attributes:{VisibilityTimeout:'60',MessageRetentionPeriod:'345600'}}),{abortSignal:AbortSignal.timeout(5000)});
    await sqs.send(new SetQueueAttributesCommand({QueueUrl:dlqUrl,Attributes:{MessageRetentionPeriod:'1209600'}}),{abortSignal:AbortSignal.timeout(5000)});
  }
  const attrs=(await sqs.send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['VisibilityTimeout','MessageRetentionPeriod','RedrivePolicy']}),{abortSignal:AbortSignal.timeout(5000)})).Attributes;
  const dead=(await sqs.send(new GetQueueAttributesCommand({QueueUrl:dlqUrl,AttributeNames:['MessageRetentionPeriod','QueueArn']}),{abortSignal:AbortSignal.timeout(5000)})).Attributes;
  const policy=assertQueuePolicy(attrs??{},dead??{},local);
  if (!policy.retentionSupported) logger.warn({event:'emulator-retention-not-supported',sourceRetentionDays:4,dlqRetentionDays:14,cloudPolicyEnforced:true});
}
export async function publishEvent(event:IngestionEvent): Promise<void> {
  await queueClient().send(new SendMessageCommand({QueueUrl:queueUrl,MessageBody:JSON.stringify(event)}),{abortSignal:AbortSignal.timeout(10000)});
}
export async function receiveMessages(signal:AbortSignal) {
  const result=await queueClient().send(new ReceiveMessageCommand({QueueUrl:queueUrl,MaxNumberOfMessages:1,WaitTimeSeconds:10,VisibilityTimeout:60,MessageSystemAttributeNames:['ApproximateReceiveCount']}),{abortSignal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  return result.Messages ?? [];
}
export async function acknowledge(receipt:string): Promise<void> {
  await queueClient().send(new DeleteMessageCommand({QueueUrl:queueUrl,ReceiptHandle:receipt}),{abortSignal:AbortSignal.timeout(5000)});
}
export async function deferMessage(receipt:string,seconds:number): Promise<void> {
  await queueClient().send(new ChangeMessageVisibilityCommand({QueueUrl:queueUrl,ReceiptHandle:receipt,VisibilityTimeout:seconds}),{abortSignal:AbortSignal.timeout(5000)});
}
export function closeQueue(): void { client?.destroy(); }
