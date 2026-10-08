import assert from 'node:assert/strict';
import test from 'node:test';
import {mongoPoolBudget} from './pool-budget.mjs';
test('counts serving processes, rollover overlap and per-server monitoring sockets',()=>{
  const horizontal=mongoPoolBudget({apiTasks:4,apiWorkers:1,workerTasks:1,relayTasks:1,members:1,overlap:1});
  assert.equal(horizontal.perServerUpperBound,57);
  assert.equal(horizontal.primaryOnlyClusterUpperBound,57);
  const vertical=mongoPoolBudget({apiTasks:1,apiWorkers:4,workerTasks:1,relayTasks:1,members:1,overlap:1});
  assert.equal(vertical.perServerUpperBound,57);
  const rollout=mongoPoolBudget({apiTasks:16,apiWorkers:1,workerTasks:8,relayTasks:2,members:3,overlap:2});
  assert.equal(rollout.perServerUpperBound,432);
  assert.equal(rollout.primaryOnlyClusterUpperBound,600);
  assert.equal(rollout.allPoolsClusterUpperBound,1296);
  assert.equal(rollout.minimumPerServerWithReserve,540);
});
test('rejects invalid pool inputs instead of understating a budget',()=>{
  assert.throws(()=>mongoPoolBudget({apiTasks:0}));
  assert.throws(()=>mongoPoolBudget({members:0}));
  assert.throws(()=>mongoPoolBudget({overlap:0.5}));
  assert.throws(()=>mongoPoolBudget({reserve:1}));
  assert.throws(()=>mongoPoolBudget({apiTask:16}));
});
