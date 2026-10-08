import test from 'node:test';
import assert from 'node:assert/strict';
import {safeTraceAttributes,validTraceParent} from './trace-policy.ts';
test('keeps bounded operational attributes and drops payloads, URLs and identities',()=>{
  const result=safeTraceAttributes({'http.request.method':'POST','http.response.status_code':202,'http.route':'/products/ingest','db.operation.name':'insert','url.full':'https://example.invalid/?token=secret','db.query.text':'email=private@example.invalid','user.id':'private','authorization':'Bearer secret'});
  assert.deepEqual(result,{'http.request.method':'POST','http.response.status_code':202,'http.route':'/products/ingest','db.operation.name':'insert'});
});
test('accepts only bounded W3C parent context and rejects zero/malformed identities',()=>{
  assert.equal(validTraceParent('00-11111111111111111111111111111111-2222222222222222-01'),true);
  for(const value of [undefined,'wrong','00-00000000000000000000000000000000-2222222222222222-01','00-11111111111111111111111111111111-0000000000000000-01','00-11111111111111111111111111111111-2222222222222222-ff'])assert.equal(validTraceParent(value),false);
});
