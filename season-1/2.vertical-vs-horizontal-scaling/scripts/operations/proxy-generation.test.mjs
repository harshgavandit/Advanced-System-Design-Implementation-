import test from 'node:test';
import assert from 'node:assert/strict';
import {nginxWorkerPids,generationDrained} from './proxy-generation.mjs';

test('reload drain includes retiring nginx workers but excludes the master and unrelated processes',()=>{
  const rows='PID COMMAND\n 100 nginx: master process nginx -g daemon off;\n 101 nginx: worker process is shutting down\n 102 nginx: worker process\n 103 node dist/container.js\n';
  assert.deepEqual(nginxWorkerPids(rows),['101','102']);
});

test('one successful new-worker probe cannot pass while old workers may still serve pooled connections',()=>{
  assert.equal(generationDrained(['101'],['101','102']),false);
  assert.equal(generationDrained(['101'],['102']),true);
  assert.equal(generationDrained(['101'],[]),false);
  assert.throws(()=>generationDrained([],['102']));
});
