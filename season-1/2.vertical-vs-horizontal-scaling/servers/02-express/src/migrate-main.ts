import mongoose from 'mongoose';import {assertTarget,verifySchema} from './migrations/schema.js';import {migrate} from './migrations/runner.js';
const uri=process.env.MONGO_URI??'',database=process.env.MIGRATION_TARGET_DB??'';
assertTarget(uri,database,process.env.MIGRATION_CONFIRM??'');
await mongoose.connect(uri,{autoIndex:false,autoCreate:false,maxPoolSize:5,minPoolSize:0,maxConnecting:1,waitQueueTimeoutMS:500,serverSelectionTimeoutMS:5000,writeConcern:{w:'majority'},readPreference:'primary'});
try{
 const db=mongoose.connection.db!;if(db.databaseName!==database)throw Error('Connected migration database differs from target');
 if(process.argv.includes('--verify'))await verifySchema(db);
 else{
  const crash=Number(process.env.MIGRATION_TEST_CRASH_AFTER_BATCH??0);
  if(crash&&(!['operations_test','migration_test'].includes(database)||!await db.collection('_operations_owner').findOne({_id:'synthetic' as unknown as mongoose.mongo.ObjectId})))throw Error('Crash injection is restricted to a marked synthetic test database');
  await migrate(mongoose.connection.getClient(),db,{leaseMs:crash?10000:60000,onBatch:async()=>{if(crash)process.exit(86);}});
 }
 console.log('MIGRATION_PASS '+database);
}finally{await mongoose.disconnect();}
