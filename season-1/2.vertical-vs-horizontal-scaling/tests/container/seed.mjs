import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateProducts, createManifest } from '../../bench/fixtures/generate.mjs';

export function seedLab(compose) {
  const target=spawnSync('docker',['compose','-f',compose,'ps','-q','mongo'],{encoding:'utf8'});
  assert.equal(target.status,0);
  const id=target.stdout.trim();
  assert.match(id,/^[a-f0-9]{64}$/);
  const owner=spawnSync('docker',['inspect','--format','{{index .Config.Labels "scaling.owner"}}',id],{encoding:'utf8'});
  assert.equal(owner.stdout.trim(),'production-lab');
  const products=generateProducts({count:10000,seed:42});
  const manifest=createManifest(products,42);
  const script=`
const target=db.getSiblingDB('production_lab');
if(db.hello().setName!=='production-lab') throw new Error('Wrong replica set');
const count=target.products.countDocuments();
const marker=target.getCollection('_fixture_owner').findOne({_id:'deterministic-v1'});
if(count && (!marker || marker.hash!=='${manifest.sha256}')) throw new Error('Existing unowned products refused');
if(!count) {
  target.getCollection('_fixture_owner').updateOne({_id:'deterministic-v1'},{$set:{hash:'${manifest.sha256}'}},{upsert:true});
  const records=${JSON.stringify(products)};
  for(let start=0;start<records.length;start+=500) target.products.insertMany(records.slice(start,start+500).map(p=>({...p,_id:ObjectId(p._id),createdAt:new Date(p.createdAt),updatedAt:new Date(p.updatedAt)})));
}
if(target.products.countDocuments()!==10000) throw new Error('Fixture count mismatch');
print('FIXTURE_PASS');
`;
  const seeded=spawnSync('docker',['exec','-i',id,'mongosh','--quiet','--file','/dev/stdin'],{input:script,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.equal(seeded.status,0,seeded.stderr);
  assert.match(seeded.stdout,/FIXTURE_PASS/);
  return manifest;
}
