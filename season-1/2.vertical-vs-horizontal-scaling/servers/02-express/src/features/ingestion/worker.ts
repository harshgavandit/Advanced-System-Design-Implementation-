import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import {collections, transaction, transactionalAudit, type Job} from './store.js';
import type {IngestionEvent} from './policy.js';
import {validateCreate} from '../products/products.validation.js';
import {invalidateCatalog} from '../products/products.cache.js';
import {httpMetrics} from '../../observability/metrics.js';

type Claim = {job:Job; token:string};
type Decision = 'ack' | 'retry' | 'busy';
export async function leaseJob(event:IngestionEvent): Promise<Claim|Decision> {
  const {jobs}=collections(),id=new mongoose.mongo.ObjectId(event.jobId),now=new Date();
  const job=await jobs.findOne({_id:id},{readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
  if (!job || event.generation>job.generation) return 'retry';
  if (event.generation<job.generation || job.status==='succeeded') return 'ack';
  if (job.status==='failed') return 'retry';
  if (job.leaseUntil && job.leaseUntil>now) return 'busy';
  if (job.attempts>=5) {
    await transaction(async session=>{
      const changed=await jobs.updateOne({_id:id,generation:event.generation,status:{$in:['accepted','processing']},attempts:{$gte:5},$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now}}]},{$set:{status:'failed',errorCode:'RETRY_BUDGET_EXHAUSTED',completedAt:now,updatedAt:now},$unset:{leaseUntil:'',leaseToken:''}},{session});
      if (changed.modifiedCount) {
        await collections().counters.updateOne({_id:'products'},{$inc:{pending:-1,failed:1}},{session});
        await transactionalAudit(session,'ingestion-worker','ingestion-failed',event.jobId);
      }
    });
    return 'retry';
  }
  const token=randomUUID();
  const claimed=await jobs.findOneAndUpdate({_id:id,generation:event.generation,status:{$in:['accepted','processing']},attempts:{$lt:5},$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now}}]},{$set:{status:'processing',leaseUntil:new Date(Date.now()+30000),leaseToken:token,updatedAt:new Date()},$inc:{attempts:1}},{returnDocument:'after',readPreference:'primary',writeConcern:{w:'majority'},timeoutMS:2000});
  return claimed?{job:claimed,token}:'busy';
}
async function applyEffect(claim:Claim): Promise<Decision> {
  const payload=validateCreate(claim.job.payload);
  return transaction(async session=>{
    const {jobs,products,counters}=collections();
    const current=await jobs.findOne({_id:claim.job._id,generation:claim.job.generation,status:'processing',leaseToken:claim.token,leaseUntil:{$gt:new Date()}},{session});
    if (!current) return 'retry';
    await products.updateOne({_id:current.productId},{$setOnInsert:{...payload,createdAt:current.createdAt,updatedAt:new Date()}},{upsert:true,session});
    await jobs.updateOne({_id:current._id,leaseToken:claim.token},{$set:{status:'succeeded',completedAt:new Date(),updatedAt:new Date()},$unset:{leaseUntil:'',leaseToken:'',errorCode:''}},{session});
    await counters.updateOne({_id:'products'},{$inc:{pending:-1,succeeded:1}},{session});
    await transactionalAudit(session,'ingestion-worker','ingestion-succeeded',current._id.toHexString());
    return 'ack';
  });
}
async function failedAttempt(claim:Claim, permanent:boolean): Promise<void> {
  await transaction(async session=>{
    const {jobs,counters}=collections(),failed=claim.job.attempts>=5;
    const now=new Date();
    const updated=await jobs.updateOne({_id:claim.job._id,generation:claim.job.generation,status:'processing',leaseToken:claim.token},{$set:{status:failed?'failed':'accepted',updatedAt:now,errorCode:permanent?'INVALID_PAYLOAD':'TRANSIENT_DEPENDENCY',...(failed?{completedAt:now}:{})},$unset:{leaseUntil:'',leaseToken:''}},{session});
    if (failed && updated.modifiedCount) {
      await counters.updateOne({_id:'products'},{$inc:{pending:-1,failed:1}},{session});
      await transactionalAudit(session,'ingestion-worker','ingestion-failed',claim.job._id.toHexString());
    }
  });
}
export async function completeEvent(event:IngestionEvent): Promise<Decision> {
  const claim=await leaseJob(event);
  if (typeof claim==='string') return claim;
  try {
    const result=await applyEffect(claim);
    if(result==='ack'){
      httpMetrics.ingestionCompletion((Date.now()-claim.job.createdAt.getTime())/1000);
      await invalidateCatalog(claim.job.productId.toHexString());
    }
    return result;
  }
  catch (error) {
    // Resolve a potentially committed transaction before recording a failure.
    const committed=await collections().jobs.findOne({_id:claim.job._id,generation:event.generation,status:'succeeded'},{readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
    if (committed) return 'ack';
    await failedAttempt(claim,(error as {status?:number}).status===400);
    return 'retry';
  }
}
