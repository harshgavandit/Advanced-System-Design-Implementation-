import test from 'node:test';
import assert from 'node:assert/strict';
import {mongoDiagnostics} from './diagnostics.mjs';

test('failure diagnostics stay scoped, bounded and redact known secrets',()=>{
  const calls=[],output=[],compose=['compose','-p','owned-test','-f','test.yaml'];
  mongoDiagnostics(compose,{env:{LAB_ACCESS_SECRET:'synthetic-secret-value'},run:(binary,args,options)=>{
    calls.push({binary,args,options});return {stdout:'startup failed synthetic-secret-value'};
  },log:value=>output.push(value)});
  assert.deepEqual(calls.map(c=>c.args),[[...compose,'ps','-a'],[...compose,'logs','--no-color','--tail','100','mongo']]);
  assert.ok(calls.every(c=>c.binary==='docker'&&c.options.timeout===10000&&c.options.maxBuffer===1024*1024));
  assert.ok(output.every(line=>line.includes('[REDACTED]')&&!line.includes('synthetic-secret-value')));
});

test('unavailable diagnostics cannot replace the original failure',()=>{
  assert.doesNotThrow(()=>mongoDiagnostics(['compose'],{run:()=>{throw new Error('daemon unavailable');}}));
});
