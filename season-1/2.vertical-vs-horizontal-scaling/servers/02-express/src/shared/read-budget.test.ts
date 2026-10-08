import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadBudget,cacheRemainingMs} from './read-budget.ts';
test('rejects excess work without an unbounded wait queue and releases capacity after errors',async()=>{
  const budget=new ReadBudget(2);
  let release!:()=>void;
  const held=new Promise<void>(done=>{release=done;});
  const first=budget.run(()=>held),second=budget.run(()=>held);
  try {await assert.rejects(budget.run(async()=>3),error=>(error as {status?:number}).status===503);}
  finally {release();await Promise.all([first,second]);}
  await assert.rejects(budget.run(async()=>{throw new Error('loader failed');}));
  assert.equal(await budget.run(async()=>7),7);
});
test('cache lifetime is bounded from load start, with only downward jitter',()=>{
  assert.equal(cacheRemainingMs(0,1000,0),23000);
  assert.equal(cacheRemainingMs(0,29000,1),1000);
  assert.equal(cacheRemainingMs(0,31000,1),0);
  for(const random of [-1,0,0.5,1,2]) assert.ok(cacheRemainingMs(0,0,random)<=30000);
});
