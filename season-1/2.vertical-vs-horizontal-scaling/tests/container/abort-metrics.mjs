import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const script=`
import http from 'node:http';
const value=async()=>{const text=await(await fetch('http://127.0.0.1:5002/metrics')).text();return text.split('\\n').filter(row=>row.startsWith('app_http_requests_total{')&&row.includes('route="/products"')&&row.includes('status_code="499"')&&row.includes('method="POST"')).reduce((sum,row)=>sum+Number(row.split(' ').at(-1)),0);};
const before=await value();
await new Promise(done=>{const request=http.request('http://127.0.0.1:5002/products',{method:'POST',headers:{'content-type':'application/json','content-length':'1000'}});request.on('error',()=>done());request.write('{');setTimeout(()=>request.destroy(),150);});
await new Promise(done=>setTimeout(done,300));
if(await value()!==before+1)throw new Error('A disconnected early request must be counted exactly once as 499');
console.log('ABORT_METRICS_PASS incomplete client request counted once as 499');
`;
const result=spawnSync('docker',['exec','scaling-production-lab-api-1','node','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
