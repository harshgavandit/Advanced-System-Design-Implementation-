import test from 'node:test';
import assert from 'node:assert/strict';
import {scannerArguments} from './scanner-policy.mjs';

const options={name:'scaling-ci-scan-0123456789abcdef',scratch:'/private/temp',snapshot:'/private/source',results:'/private/results',cache:'/private/cache',image:'scanner/tool@sha256:'+'a'.repeat(64),args:['dir','/src'],platform:'linux',uid:1001,gid:1001};

test('Linux scanners use the owner identity without weakening private mounts or container isolation',()=>{
  const args=scannerArguments(options);
  assert.equal(args[args.indexOf('--user')+1],'1001:1001');
  assert.equal(args[args.indexOf('--cap-drop')+1],'ALL');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges:true'));
  assert.ok(args.includes('/private/source:/src:ro'));
  assert.deepEqual(args.slice(-3),[options.image,'dir','/src']);
});

test('Windows mounts do not invent Unix ownership, while missing Linux ownership fails closed',()=>{
  assert.ok(!scannerArguments({...options,platform:'win32',uid:undefined,gid:undefined}).includes('--user'));
  for(const patch of [{uid:undefined},{gid:undefined},{uid:-1},{gid:NaN}])assert.throws(()=>scannerArguments({...options,...patch}));
});

test('scanner commands retain pinned images and accept stdin only for a supplied input',()=>{
  assert.ok(scannerArguments({...options,input:'FROM scratch'}).includes('-i'));
  assert.ok(!scannerArguments(options).includes('-i'));
  assert.throws(()=>scannerArguments({...options,image:'scanner/tool:latest'}));
});
