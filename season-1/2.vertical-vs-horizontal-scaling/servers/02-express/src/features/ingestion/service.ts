import mongoose from 'mongoose';
import {httpError} from '../../shared/error.js';
import {idempotencyHash, payloadHash} from './policy.js';
import {collections, transaction, transactionalAudit, backlogLimit, type Job} from './store.js';
import type {CreateProductInput} from '../products/products.types.js';
import {currentTraceParent} from '../../observability/trace-context.js';

function replay(job:Job, hash:string): {jobId:string; status:'accepted'} {
  if (job.requestHash !== hash) throw httpError(409, 'Idempotency-Key was already used with a different payload');
  return {jobId:job._id.toHexString(), status:'accepted'};
}
export async function acceptIngestion(owner:string, key:unknown, payload:CreateProductInput): Promise<{jobId:string;status:'accepted'}> {
  const keyHash = idempotencyHash(key), requestHash = payloadHash(payload);
  const {jobs,outbox,counters} = collections();
  const scope = {owner, operation:'product-ingest' as const, keyHash};
  const id = new mongoose.mongo.ObjectId(), productId = new mongoose.mongo.ObjectId();
  try {
    return await transaction(async session => {
      const existing = await jobs.findOne(scope, {session});
      if (existing) return replay(existing, requestHash);
      const admitted = await counters.updateOne({_id:'products',pending:{$lt:backlogLimit()}}, {$inc:{accepted:1,pending:1}}, {session});
      if (admitted.modifiedCount !== 1) throw httpError(429, 'Ingestion backlog is full; retry later');
      const now = new Date();
      const traceParent=currentTraceParent();
      await jobs.insertOne({_id:id, ...scope, requestHash, productId, payload, status:'accepted',generation:1,attempts:0,createdAt:now,updatedAt:now,...(traceParent?{traceParent}:{})}, {session});
      await outbox.insertOne({_id:new mongoose.mongo.ObjectId(),jobId:id,generation:1,state:'pending',createdAt:now,dueAt:now,sends:0,...(traceParent?{traceParent}:{})}, {session});
      await transactionalAudit(session, owner, 'ingestion-accepted', id.toHexString());
      return {jobId:id.toHexString(),status:'accepted' as const};
    });
  } catch (error) {
    if ((error as {code?:number}).code !== 11000) throw error;
    // A competing transaction may have committed the unique key. A primary
    // majority read resolves the collision without accepting a second effect.
    const existing = await jobs.findOne(scope, {readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
    if (!existing) throw httpError(503,'Idempotency resolution unavailable');
    return replay(existing,requestHash);
  }
}
export async function getJob(id:string, owner:string, admin:boolean): Promise<Record<string,unknown>> {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw httpError(400,'Invalid job ID');
  const job = await collections().jobs.findOne({_id:new mongoose.mongo.ObjectId(id), ...(admin?{}:{owner})}, {readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
  if (!job) throw httpError(404,'Ingestion job not found');
  return {jobId:job._id.toHexString(),status:job.status,attempts:job.attempts,generation:job.generation,createdAt:job.createdAt,updatedAt:job.updatedAt,completedAt:job.completedAt,...(job.status==='succeeded'?{productId:job.productId.toHexString()}:{}),...(job.errorCode?{errorCode:job.errorCode}:{})};
}
export async function redrive(id:string, actor:string): Promise<{jobId:string;status:string}> {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw httpError(400,'Invalid job ID');
  const {jobs,outbox,counters}=collections();
  return transaction(async session => {
    const job = await jobs.findOne({_id:new mongoose.mongo.ObjectId(id)}, {session});
    if (!job) throw httpError(404,'Ingestion job not found');
    if (job.status !== 'failed') return {jobId:id,status:job.status};
    const admitted = await counters.updateOne({_id:'products',pending:{$lt:backlogLimit()}}, {$inc:{pending:1,failed:-1}}, {session});
    if (admitted.modifiedCount !== 1) throw httpError(429,'Ingestion backlog is full; retry later');
    const now=new Date(), generation=job.generation+1;
    await jobs.updateOne({_id:job._id,generation:job.generation,status:'failed'}, {$set:{status:'accepted',generation,attempts:0,updatedAt:now},$unset:{leaseUntil:'',leaseToken:'',errorCode:'',completedAt:''}}, {session});
    await outbox.insertOne({_id:new mongoose.mongo.ObjectId(),jobId:job._id,generation,state:'pending',createdAt:now,dueAt:now,sends:0,traceParent:currentTraceParent()}, {session});
    await transactionalAudit(session,actor,'ingestion-redriven',id);
    return {jobId:id,status:'accepted'};
  });
}
export async function ingestionStats(): Promise<Record<string,unknown>> {
  const {counters,outbox,jobs}=collections();
  const counts=await counters.findOne({_id:'products'},{readPreference:'primary',timeoutMS:2000});
  const oldest=await jobs.findOne({status:{$in:['accepted','processing']}},{sort:{createdAt:1},projection:{createdAt:1},readPreference:'primary',timeoutMS:2000});
  return {accepted:counts?.accepted??0,queued:counts?.pending??0,flushed:counts?.succeeded??0,failed:counts?.failed??0,unsent:await outbox.countDocuments({state:'pending'},{readPreference:'primary',timeoutMS:2000}),oldestPendingSeconds:oldest?Math.max(0,(Date.now()-oldest.createdAt.getTime())/1000):0};
}
