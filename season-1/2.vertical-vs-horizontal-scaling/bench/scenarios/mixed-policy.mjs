import assert from 'node:assert/strict';
export const profiles = {
  smoke:{executor:'constant-arrival-rate',rate:20,timeUnit:'1s',duration:'2m',preAllocatedVUs:100,maxVUs:100},
  support:{executor:'constant-arrival-rate',rate:50,timeUnit:'1s',duration:'10m',preAllocatedVUs:100,maxVUs:100},
  soak:{executor:'constant-arrival-rate',rate:50,timeUnit:'1s',duration:'4h',preAllocatedVUs:100,maxVUs:100},
  stress:{executor:'ramping-arrival-rate',startRate:25,timeUnit:'1s',stages:[{target:50,duration:'2m'},{target:100,duration:'2m'},{target:150,duration:'2m'},{target:25,duration:'2m'}],preAllocatedVUs:100,maxVUs:100},
  spike:{executor:'ramping-arrival-rate',startRate:20,timeUnit:'1s',stages:[{target:20,duration:'1m'},{target:100,duration:'10s'},{target:100,duration:'30s'},{target:20,duration:'10s'},{target:20,duration:'2m'}],preAllocatedVUs:100,maxVUs:100},
};
export function assessMixed(summary,reconciliation) {
  const metrics=summary.metrics;
  assert.equal(metrics.checks.value,1,'All content, ownership and replay checks must pass');
  assert.equal(metrics.http_req_failed.value,0,'Unexpected transport or API failures');
  assert.equal(metrics.dropped_iterations?.count??0,0,'Generator drops invalidate the capacity claim');
  assert.equal(reconciliation.acknowledged,reconciliation.succeeded);
  assert.equal(reconciliation.succeeded,reconciliation.productEffects);
  assert.equal(reconciliation.pending,0);assert.equal(reconciliation.failed,0);
  assert.equal(reconciliation.duplicateEffects,0);assert.equal(reconciliation.outstandingCarts,0);assert.equal(reconciliation.outstandingWishlists,0);
  return true;
}
