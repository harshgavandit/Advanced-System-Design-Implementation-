import mongoose, {type mongo} from 'mongoose';
import {env} from '../bootstrap/env.js';
import {createHash} from 'node:crypto';
import type {Request,Response} from 'express';
import {transaction,transactionalAudit} from '../features/ingestion/store.js';
import {idempotencyHash} from '../features/ingestion/policy.js';
import {httpError} from './error.js';

interface Receipt {
  owner:string;operation:string;keyHash:string;requestHash:string;
  status:number;body:Record<string,unknown>;createdAt:Date;expiresAt:Date;
}
const receipts=()=>mongoose.connection.db!.collection<Receipt>('mutation_receipts');
export async function initializeMutations():Promise<void> {
  if(!env.mongoAutoIndex)return;
  await receipts().createIndex({owner:1,operation:1,keyHash:1},{unique:true});
  await receipts().createIndex({expiresAt:1},{expireAfterSeconds:0});
}
export async function mutation(req:Request,operation:string,payload:unknown,work:(session:mongo.ClientSession)=>Promise<{status:number;body:unknown;target:string}>,retryUnique=false):Promise<Receipt> {
  const keyHash=idempotencyHash(req.get('Idempotency-Key'));
  const owner=req.user!.id;
  const requestHash=createHash('sha256').update(JSON.stringify({target:typeof req.params.id==='string'?req.params.id.toLowerCase():null,payload})).digest('hex');
  const scope={owner,operation,keyHash};
  const replay=(row:Receipt):Receipt=>{
    if(row.requestHash!==requestHash) throw httpError(409,'Idempotency-Key was already used with different input');
    return row;
  };
  for(let attempt=0;attempt<3;attempt++) {
    try {
      return await transaction(async session=>{
        const existing=await receipts().findOne(scope,{session});
        if(existing) return replay(existing);
        const result=await work(session);
        const now=new Date();
        const row:Receipt={...scope,requestHash,status:result.status,body:JSON.parse(JSON.stringify(result.body)),createdAt:now,expiresAt:new Date(now.getTime()+30*86400000)};
        await receipts().insertOne(row,{session});
        await transactionalAudit(session,owner,operation,result.target);
        return row;
      });
    } catch(error) {
      if((error as {code?:number}).code!==11000) throw error;
      const existing=await receipts().findOne(scope,{readPreference:'primary',readConcern:{level:'majority'},timeoutMS:2000});
      if(existing) return replay(existing);
      if(!retryUnique) throw error;
      // A distinct key racing an initially absent unique cart line retries from
      // a fresh snapshot. Validation conflicts still propagate, not disappear.
      if(attempt===2) throw httpError(503,'Concurrent mutation must be retried with the same key');
    }
  }
  throw httpError(503,'Mutation could not complete');
}
export function sendMutation(res:Response,row:Receipt):void {res.status(row.status).json(row.body);}
