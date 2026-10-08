import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedLogWriter} from './log-buffer.ts';
test('coalesces burst events into bounded writes and resolves only after persistence',async()=>{
  const batches:string[][]=[];
  const writer=new BoundedLogWriter(100,100,async lines=>{batches.push(lines);});
  const receipts=Array.from({length:100},(_,index)=>writer.enqueue(String(index)));
  assert.equal(writer.pending,100);
  await writer.flush();
  assert.ok((await Promise.all(receipts)).every(value=>value==='written'));
  assert.equal(batches.length,1);assert.equal(batches[0].length,100);assert.equal(writer.pending,0);
});
test('rejects excess buffering and reports write failure without unbounded retries',async()=>{
  const writer=new BoundedLogWriter(2,2,async()=>{throw new Error('disk unavailable');});
  const receipts=[writer.enqueue('a'),writer.enqueue('b')];
  assert.equal(await writer.enqueue('c'),'capacity');
  await writer.flush();
  assert.deepEqual(await Promise.all(receipts),['write_failed','write_failed']);assert.equal(writer.pending,0);
});
