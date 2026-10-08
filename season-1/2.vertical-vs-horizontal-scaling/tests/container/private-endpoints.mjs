import assert from 'node:assert/strict';
for(const path of ['/metrics','/metrics/','/METRICS','/MeTrIcS/','/api-docs','/API-DOCS/']){
  const response=await fetch('http://127.0.0.1:18082'+path,{signal:AbortSignal.timeout(5000)});
  await response.arrayBuffer();
  assert.equal(response.status,404,`Operational endpoint must stay private: ${path}`);
}
console.log('PRIVATE_ENDPOINTS_PASS aliases and trailing slashes cannot bypass gateway restrictions');
