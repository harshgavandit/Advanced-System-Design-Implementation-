import test from 'node:test';import assert from 'node:assert/strict';import {assertTarget,checksum,indexes,versions} from './schema.ts';
test('migration writes require exact database and confirmation, never the active lab or a default URI',()=>{
 assertTarget('mongodb://mongo:27017/operations_test?replicaSet=operations','operations_test','operations_test');
 assertTarget('mongodb+srv://placeholder.example.invalid/catalog_staging','catalog_staging','catalog_staging');
 assertTarget('mongodb://a:27017,b:27017,c:27017/catalog_production?replicaSet=rs','catalog_production','catalog_production');
 for(const [uri,db,confirm] of [['mongodb://mongo/production_lab','production_lab','production_lab'],['mongodb://mongo/operations_test','operations_test',''],['mongodb://mongo/another','operations_test','operations_test']])assert.throws(()=>assertTarget(uri!,db!,confirm!));
});
test('versioned schema keeps deterministic checksums, unique effect/receipt indexes and TTL retention',()=>{
 assert.equal(checksum(versions),checksum(versions));assert.notEqual(checksum(versions),checksum([...versions,{id:'changed'}]));
 assert.ok(indexes.some(row=>row.collection==='ingestion_jobs'&&row.unique&&row.name==='owner_operation_key'));
 assert.ok(indexes.some(row=>row.collection==='mutation_receipts'&&row.unique));
 assert.ok(indexes.some(row=>row.collection==='sessions'&&row.expireAfterSeconds===0));
});
