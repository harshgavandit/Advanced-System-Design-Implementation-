import test from 'node:test';import assert from 'node:assert/strict';import {assessMixed,profiles} from './mixed-policy.mjs';
test('long soak is four hours and every profile bounds generator concurrency',()=>{
 assert.equal(profiles.soak.duration,'4h');assert.equal(profiles.support.duration,'10m');
 for(const profile of Object.values(profiles))assert.equal(profile.maxVUs,100);
});
test('mixed launch evidence rejects drops, isolation failures, lost jobs and leftover writes',()=>{
 const summary={metrics:{checks:{value:1},http_req_failed:{value:0},dropped_iterations:{count:0}}},reconciliation={acknowledged:4,succeeded:4,productEffects:4,pending:0,failed:0,duplicateEffects:0,outstandingCarts:0,outstandingWishlists:0};
 assert.equal(assessMixed(summary,reconciliation),true);
 for(const key of ['pending','failed','duplicateEffects','outstandingCarts','outstandingWishlists'])assert.throws(()=>assessMixed(summary,{...reconciliation,[key]:1}));
 assert.throws(()=>assessMixed({...summary,metrics:{...summary.metrics,dropped_iterations:{count:1}}},reconciliation));
 assert.throws(()=>assessMixed(summary,{...reconciliation,succeeded:3}));
});
