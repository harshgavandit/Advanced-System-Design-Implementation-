import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const script=`
const metric=async()=>{const body=await(await fetch('http://127.0.0.1:5002/metrics')).text();return body.split('\\n').filter(row=>row.startsWith('app_http_requests_total{') && row.includes('route="/users/login"') && row.includes('status_code="400"') && row.includes('method="POST"')).reduce((sum,row)=>sum+Number(row.split(' ').at(-1)),0);};
const before=await metric();
const response=await fetch('http://127.0.0.1:5002/users/login',{method:'POST',headers:{'content-type':'application/json'},body:'{'});
if(response.status!==400)throw new Error('Malformed input must return 400');await response.arrayBuffer();
const after=await metric();if(after!==before+1)throw new Error('Early parser errors must be measured before middleware rejection');
console.log('EARLY_METRICS_PASS malformed JSON counted once');
`;
const result=spawnSync('docker',['exec','scaling-production-lab-api-1','node','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
