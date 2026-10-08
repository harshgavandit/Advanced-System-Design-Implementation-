import type {mongo} from 'mongoose';
import {randomUUID} from 'node:crypto';
import {indexes,versions,checksum,verifySchema} from './schema.js';
type Ledger={_id:string;checksum:string;status:'running'|'done';checkpoint?:mongo.ObjectId;processed?:number;completedAt?:Date};
type Lock={_id:string;token:string;until:Date};
export async function migrate(client:mongo.MongoClient,db:mongo.Db,{leaseMs=60000,onBatch=async()=>{}}:{leaseMs?:number;onBatch?:(processed:number)=>Promise<void>}={}):Promise<void>{
 if(leaseMs<10000||leaseMs>60000)throw Error('Migration lease must remain bounded');
 const token=randomUUID(),locks=db.collection<Lock>('_migration_lock'),ledger=db.collection<Ledger>('_schema_migrations');
 try{const lock=await locks.findOneAndUpdate({_id:'schema',until:{$lte:new Date()}},{$set:{token,until:new Date(Date.now()+leaseMs)}},{upsert:true,returnDocument:'after',writeConcern:{w:'majority'}});if(!lock||lock.token!==token)throw Error('Migration lease unavailable');}
 catch(error){if((error as {code?:number}).code===11000)throw Error('Another migration runner owns the lease');throw error;}
 async function renew(session?:mongo.ClientSession):Promise<void>{const held=await locks.findOneAndUpdate({_id:'schema',token,until:{$gt:new Date()}},{$set:{until:new Date(Date.now()+leaseMs)}},{returnDocument:'after',...(session?{session}:{writeConcern:{w:'majority'}})});if(!held)throw Error('Migration lease was lost');}
 try{
  for(const version of versions){
   await renew();const hash=checksum(version.definition),existing=await ledger.findOne({_id:version.id});
   if(existing&&existing.checksum!==hash)throw Error('Applied migration checksum changed: '+version.id);
   if(existing?.status==='done')continue;
   await ledger.updateOne({_id:version.id},{$setOnInsert:{checksum:hash,status:'running'}},{upsert:true,writeConcern:{w:'majority'}});
   if(version.id==='001-index-baseline'){
    // DDL is deliberately not inside a data transaction. Identical index creates are resumable.
    for(const spec of indexes){await renew();const {collection,key,...options}=spec;await db.collection(collection).createIndex(key,{...options,maxTimeMS:30000});}
    await db.collection('ingestion_counters').updateOne({_id:'products' as unknown as mongo.ObjectId},{$setOnInsert:{accepted:0,pending:0,succeeded:0,failed:0}},{upsert:true,writeConcern:{w:'majority'}});
   }else{
    let checkpoint=existing?.checkpoint,processed=existing?.processed??0;
    while(true){
     await renew();
     const records=await db.collection('products').find(checkpoint?{_id:{$gt:checkpoint}}:{},{projection:{_id:1,category:1,updatedAt:1},readPreference:'primary',timeoutMS:5000}).sort({_id:1}).limit(100).toArray();
     if(!records.length)break;
     const session=client.startSession();
     try{await session.withTransaction(async()=>{
      await renew(session);
      await db.collection('product_catalog_versions').bulkWrite(records.map(row=>({replaceOne:{filter:{_id:row._id},replacement:{_id:row._id,category:row.category,schemaVersion:1,sourceUpdatedAt:row.updatedAt},upsert:true}})),{session});
      await ledger.updateOne({_id:version.id,checksum:hash},{$set:{checkpoint:records.at(-1)!._id,processed:processed+records.length}},{session});
     },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',timeoutMS:10000});}
     finally{await session.endSession();}
     checkpoint=records.at(-1)!._id;processed+=records.length;await onBatch(processed);
    }
   }
   await renew();await ledger.updateOne({_id:version.id,checksum:hash},{$set:{status:'done',completedAt:new Date()}},{writeConcern:{w:'majority'}});
  }
  await verifySchema(db);
 }finally{await locks.deleteOne({_id:'schema',token},{writeConcern:{w:'majority'}});}
}
