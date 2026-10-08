import {randomUUID} from 'node:crypto';
import {collections, type Outbox} from './store.js';
import {publishEvent as sendEvent} from '../../queue/sqs.js';
import {ingestionSpan,currentTraceParent} from '../../observability/trace-context.js';

export async function leaseOutbox(): Promise<Outbox|null> {
  const now=new Date(),token=randomUUID();
  return collections().outbox.findOneAndUpdate({state:'pending',dueAt:{$lte:now},$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now}}]},{$set:{leaseToken:token,leaseUntil:new Date(now.getTime()+30000)}},{sort:{createdAt:1},returnDocument:'after',readPreference:'primary',writeConcern:{w:'majority'},timeoutMS:2000});
}
export async function publishEvent(row:Outbox): Promise<void> {
  if (!row) throw new Error('No outbox lease');
  await ingestionSpan('ingestion.publish',row.traceParent,()=>sendEvent({version:1,jobId:row.jobId.toHexString(),generation:row.generation,traceParent:currentTraceParent()}));
}
export async function markSent(row:Outbox): Promise<void> {
  await collections().outbox.updateOne({_id:row._id,state:'pending',leaseToken:row.leaseToken},{$set:{state:'sent',sentAt:new Date(),dueAt:new Date(Date.now()+300000)},$inc:{sends:1},$unset:{leaseToken:'',leaseUntil:''}},{writeConcern:{w:'majority'},timeoutMS:2000});
}
export async function relayOnce(): Promise<boolean> {
  const row=await leaseOutbox();
  if (!row) return false;
  try { await publishEvent(row); await markSent(row); return true; }
  catch (error) {
    await collections().outbox.updateOne({_id:row._id,state:'pending',leaseToken:row.leaseToken},{$set:{dueAt:new Date(Date.now()+2000)},$unset:{leaseToken:'',leaseUntil:''}},{writeConcern:{w:'majority'},timeoutMS:2000});
    throw error;
  }
}
// MongoDB is authoritative even if transport storage expired or was lost. A
// bounded scan resends only nonterminal jobs whose processing lease is stale.
export async function reconcileOutbox(): Promise<number> {
  const {outbox,jobs}=collections(),now=new Date();
  const candidates=await outbox.find({state:'sent',dueAt:{$lte:now}},{readPreference:'primary',timeoutMS:2000}).sort({dueAt:1}).limit(50).toArray();
  let restored=0;
  for (const event of candidates) {
    const job=await jobs.findOne({_id:event.jobId},{readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
    if (job && job.generation===event.generation && ['accepted','processing'].includes(job.status) && (!job.leaseUntil || job.leaseUntil<=now)) {
      restored+=(await outbox.updateOne({_id:event._id,state:'sent',dueAt:{$lte:now}},{$set:{state:'pending',dueAt:now}},{writeConcern:{w:'majority'},timeoutMS:2000})).modifiedCount;
    } else {
      await outbox.updateOne({_id:event._id,state:'sent',dueAt:{$lte:now}},{$set:{dueAt:new Date(Date.now()+300000)}},{timeoutMS:2000});
    }
  }
  return restored;
}
