import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mongoPoolBudget} from '../../scripts/local/pool-budget.mjs';

export async function measureIndexCost(db){
  assert.equal(db.databaseName,'phase0_contract_test');
  assert.ok(await db.collection('_phase0_owner').findOne({_id:'phase0-contract-tests',version:1}));
  const rows=await db.collection('products').find({}).sort({_id:1}).toArray();
  assert.equal(rows.length,10000,'Use the deterministic isolated fixture');
  const measurements=[];
  for(let trial=1;trial<=3;trial++){
    for(const compound of (trial%2?[false,true]:[true,false])){
      const name=compound?'phase5_index_compound':'phase5_index_base';
      await db.createCollection(name);
      const collection=db.collection(name);
      await collection.createIndex({name:'text'});
      await collection.createIndex({category:1});
      if(compound)await collection.createIndex({category:1,_id:1});
      const started=performance.now();
      await collection.insertMany(rows,{writeConcern:{w:'majority'}});
      const insertMs=performance.now()-started;
      // WiredTiger file allocation stats are checkpoint-based. Flush this
      // explicitly owned test instance before calling a tiny empty file "cost".
      await db.admin().command({fsync:1});
      const stats=await db.command({collStats:name});
      const explain=await collection.find({category:'books'}).sort({_id:1}).limit(20).explain('executionStats');
      assert.equal(explain.executionStats.nReturned,20);
      if(compound)assert.equal(explain.executionStats.totalDocsExamined,20);
      measurements.push({trial,compound,rows:10000,insertMs,totalIndexBytes:stats.totalIndexSize,compoundIndexBytes:stats.indexSizes.category_1__id_1??0,keysExamined:explain.executionStats.totalKeysExamined,documentsExamined:explain.executionStats.totalDocsExamined});
      await collection.drop();
    }
  }
  const median=values=>[...values].sort((a,b)=>a-b)[1];
  return {passed:true,synthetic:true,measurements,summary:{baseInsertMedianMs:median(measurements.filter(row=>!row.compound).map(row=>row.insertMs)),compoundInsertMedianMs:median(measurements.filter(row=>row.compound).map(row=>row.insertMs)),compoundIndexMedianBytes:median(measurements.filter(row=>row.compound).map(row=>row.compoundIndexBytes))},localPoolBudget:mongoPoolBudget(),rolloutExamplePoolBudget:mongoPoolBudget({apiTasks:16,workerTasks:8,relayTasks:2,members:3,overlap:2}),limitations:['Local three-trial insert micro-benchmark with alternating order, not a production write-capacity limit.','Insert timings exclude the forced checkpoint. Index bytes are measured after it.','Rollout inputs are a planning example, not approved cloud capacity.','Other Docker apps share the host.']};
}
