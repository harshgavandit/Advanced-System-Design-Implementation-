import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('every pinned mongod in canonical local and CI stacks uses the safe allocator fallback',()=>{
  let count=0;
  for(const path of ['../../infra/compose/production-like.yaml','../phase0/compose.yaml','../operations/compose.yaml']){
    const text=readFileSync(new URL(path,import.meta.url),'utf8');
    const blocks=text.split(/\r?\n(?=  [\w-]+:\s*\r?\n)/);
    for(const block of blocks.filter(value=>/command: \[mongod,/.test(value))){
      count++;
      assert.match(block,/image: mongo@sha256:[a-f0-9]{64}/);
      assert.match(block,/environment: \{GLIBC_TUNABLES: 'glibc\.pthread\.rseq=1'\}/);
      const check=block.match(/--eval, '(const s=db\.serverStatus\(\);[^']+)'/);
      assert.ok(check,'Actual healthcheck must verify allocator state, not only ping');
      for(const [status,expected] of [[{ok:1,tcmalloc:{usingPerCPUCaches:false}},0],[{ok:1,tcmalloc:{usingPerCPUCaches:true}},1],[{ok:1},1],[{ok:0,tcmalloc:{usingPerCPUCaches:false}},1]]){
        let exit;runInNewContext(check[1],{db:{serverStatus:()=>status},quit:code=>{exit=code;}});assert.equal(exit,expected);
      }
    }
  }
  assert.equal(count,4,'Cover contract, ingestion/local, recovery source and restore servers');
});
