import type {mongo} from 'mongoose';
import {createHash} from 'node:crypto';
export interface IndexSpec {collection:string;key:Record<string,1|'text'>;name:string;unique?:boolean;expireAfterSeconds?:number}
export const indexes:IndexSpec[]=[
 {collection:'products',key:{name:'text'},name:'name_text'},
 {collection:'products',key:{category:1},name:'category_1'},
 {collection:'products',key:{category:1,_id:1},name:'category_1__id_1'},
 {collection:'users',key:{email:1},name:'email_1',unique:true},
 {collection:'cartitems',key:{userId:1,productId:1},name:'userId_1_productId_1',unique:true},
 {collection:'cartitems',key:{userId:1,_id:1},name:'userId_1__id_1'},
 {collection:'wishlistitems',key:{userId:1,productId:1},name:'userId_1_productId_1',unique:true},
 {collection:'sessions',key:{userId:1},name:'userId_1'},
 {collection:'sessions',key:{expiresAt:1},name:'expiresAt_1',expireAfterSeconds:0},
 {collection:'requestquotas',key:{expiresAt:1},name:'expiresAt_1',expireAfterSeconds:0},
 {collection:'ingestion_jobs',key:{owner:1,operation:1,keyHash:1},name:'owner_operation_key',unique:true},
 {collection:'ingestion_jobs',key:{productId:1},name:'productId_1',unique:true},
 {collection:'ingestion_jobs',key:{status:1,leaseUntil:1,updatedAt:1},name:'status_1_leaseUntil_1_updatedAt_1'},
 {collection:'ingestion_jobs',key:{status:1,createdAt:1},name:'status_1_createdAt_1'},
 {collection:'ingestion_outbox',key:{jobId:1,generation:1},name:'jobId_1_generation_1',unique:true},
 {collection:'ingestion_outbox',key:{state:1,dueAt:1,leaseUntil:1},name:'state_1_dueAt_1_leaseUntil_1'},
 {collection:'ingestion_outbox',key:{state:1,createdAt:1},name:'state_1_createdAt_1'},
 {collection:'mutation_receipts',key:{owner:1,operation:1,keyHash:1},name:'owner_1_operation_1_keyHash_1',unique:true},
 {collection:'mutation_receipts',key:{expiresAt:1},name:'expiresAt_1',expireAfterSeconds:0}
];
export const versions=[{id:'001-index-baseline',definition:indexes},{id:'002-expand-catalog-read-model',definition:{collection:'product_catalog_versions',schemaVersion:1,batchSize:100,contract:'additive only; old products and API shapes unchanged'}}];
export const checksum=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assertTarget(uri:string,database:string,confirmation:string):void{
 // Mongo replica-set URIs can contain multiple hosts, which WHATWG URL rejects.
 const path=/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?/#]+)(?:\?[^#]*)?$/.exec(uri)?.[1];
 if(!path||!/^(operations_test|migration_test|catalog_staging|catalog_production)$/.test(database)||confirmation!==database||decodeURIComponent(path)!==database)throw Error('Migration target must match the explicit isolated database confirmation');
}
export async function verifySchema(db:mongo.Db):Promise<void>{
 const baseline=await db.collection('_schema_migrations').findOne({_id:'001-index-baseline' as unknown as mongo.ObjectId});
 if(baseline?.status!=='done'||baseline.checksum!==checksum(versions[0]!.definition))throw Error('Required schema migration has not completed');
 for(const spec of indexes){
  const actual=(await db.collection(spec.collection).listIndexes().toArray()).find(row=>row.name===spec.name);
  if(!actual||(spec.unique===true&&actual.unique!==true)||(spec.expireAfterSeconds!==undefined&&actual.expireAfterSeconds!==spec.expireAfterSeconds))throw Error('Required index missing or incompatible: '+spec.collection+'/'+spec.name);
  if(spec.key.name==='text'){if(actual.weights?.name!==1)throw Error('Required text index is incompatible');}
  else if(JSON.stringify(actual.key)!==JSON.stringify(spec.key))throw Error('Required index key order is incompatible: '+spec.name);
 }
}
