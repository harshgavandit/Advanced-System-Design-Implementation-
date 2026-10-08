import mongoose, {type mongo} from 'mongoose';
import {env} from '../../bootstrap/env.js';
import {verifySchema} from '../../migrations/schema.js';
import type {CreateProductInput} from '../products/products.types.js';

export type JobState = 'accepted' | 'processing' | 'succeeded' | 'failed';
export interface Job {
  _id: mongo.ObjectId; owner: string; operation: 'product-ingest'; keyHash: string; requestHash: string;
  productId: mongo.ObjectId; payload: CreateProductInput; status: JobState; generation: number; attempts: number;
  createdAt: Date; updatedAt: Date; completedAt?: Date; leaseUntil?: Date; leaseToken?: string; errorCode?: string;
  traceParent?:string;
}
export interface Outbox {
  _id: mongo.ObjectId; jobId: mongo.ObjectId; generation: number; state: 'pending' | 'sent';
  createdAt: Date; dueAt: Date; leaseUntil?: Date; leaseToken?: string; sentAt?: Date; sends: number;
  traceParent?:string;
}
export interface Counts { _id:string; accepted:number; pending:number; succeeded:number; failed:number }
export const collections = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  return {jobs:db.collection<Job>('ingestion_jobs'), outbox:db.collection<Outbox>('ingestion_outbox'), counters:db.collection<Counts>('ingestion_counters'), products:db.collection('products'), users:db.collection('users'), audits:db.collection('securityaudits')};
};
export async function initializeIngestion(): Promise<void> {
  if(!env.mongoAutoIndex){await verifySchema(mongoose.connection.db!);return;}
  const {jobs, outbox, counters} = collections();
  await jobs.createIndex({owner:1, operation:1, keyHash:1}, {unique:true, name:'owner_operation_key'});
  await jobs.createIndex({productId:1}, {unique:true});
  await jobs.createIndex({status:1, leaseUntil:1, updatedAt:1});
  await jobs.createIndex({status:1,createdAt:1});
  await outbox.createIndex({jobId:1, generation:1}, {unique:true});
  await outbox.createIndex({state:1, dueAt:1, leaseUntil:1});
  await outbox.createIndex({state:1,createdAt:1});
  try { await counters.updateOne({_id:'products'}, {$setOnInsert:{accepted:0,pending:0,succeeded:0,failed:0}}, {upsert:true,writeConcern:{w:'majority'}}); }
  catch (error) { if ((error as {code?:number}).code !== 11000) throw error; }
}
// A deadline covers retries and the entire callback. Do not run parallel commands
// in a transaction. Session propagation is mandatory for every authoritative write.
export async function transaction<T>(body:(session:mongo.ClientSession)=>Promise<T>): Promise<T> {
  const session = mongoose.connection.getClient().startSession();
  try {
    return await session.withTransaction(() => body(session), {readPreference:'primary', readConcern:{level:'snapshot'}, writeConcern:{w:'majority'}, timeoutMS:5000});
  } finally { await session.endSession(); }
}
export async function transactionalAudit(session:mongo.ClientSession, actor:string, action:string, target:string): Promise<void> {
  await collections().audits.insertOne({actor,action,target,outcome:'succeeded',at:new Date()}, {session});
}
export function backlogLimit(): number {
  const value = Number(process.env.INGESTION_BACKLOG_LIMIT ?? 10000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error('Invalid ingestion backlog limit');
  return value;
}
