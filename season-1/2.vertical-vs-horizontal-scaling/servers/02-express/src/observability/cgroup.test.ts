import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCgroup} from './cgroup.ts';
test('converts real cgroup units and limits without inventing process/container equivalence',()=>{
  const result=parseCgroup('usage_usec 1500000\nthrottled_usec 250000\nnr_throttled 7\n','50000 100000','1048576','268435456');
  assert.deepEqual(result,{cpuSeconds:1.5,throttledSeconds:0.25,throttledPeriods:7,cpuLimit:0.5,memoryBytes:1048576,memoryLimit:268435456});
  const unlimited=parseCgroup('usage_usec 1000\nthrottled_usec 0\nnr_throttled 0\n','max 100000','100','max');
  assert.equal(unlimited.cpuLimit,undefined);assert.equal(unlimited.memoryLimit,undefined);
  assert.throws(()=>parseCgroup('bad','bad','not-a-number','0'));
});
