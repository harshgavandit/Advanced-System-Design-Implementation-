import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),artifacts=resolve(topic,'infra/compose/artifacts');
await mkdir(resolve(artifacts,'ci'),{recursive:true});
function docker(args,{capture=false,env=process.env}={}){const result=spawnSync('docker',args,{cwd:topic,env,encoding:'utf8',stdio:capture?'pipe':'inherit'});assert.equal(result.status,0,result.stderr??'Docker gate failed');return result.stdout?.trim();}
const hashResult=spawnSync(process.execPath,[resolve(topic,'scripts/local/source-hash.mjs')],{encoding:'utf8'});assert.equal(hashResult.status,0);
const sourceHash=hashResult.stdout.trim();assert.match(sourceHash,/^[a-f0-9]{64}$/);
const image='scaling-express:ci';
docker(['build','--build-arg','SOURCE_TREE_SHA256='+sourceHash,'-t',image,resolve(topic,'servers/02-express')]);
const id=docker(['image','inspect','--format','{{.Id}}',image],{capture:true});
docker(['run','--rm','--read-only','--cpus=1','--memory=512m','--cap-drop=ALL','--security-opt=no-new-privileges:true','-v',resolve(topic,'tests/container/runtime-dependencies.mjs')+':/checks/runtime-dependencies.mjs:ro',id,'node','/checks/runtime-dependencies.mjs']);
const keyFile=resolve(artifacts,'local-keys.json');
let keys;
try{keys=JSON.parse((await readFile(keyFile,'utf8')).replace(/^\uFEFF/,''));}catch(error){
  if(error.code!=='ENOENT')throw error;
  keys={access:randomBytes(32).toString('base64'),refresh:randomBytes(32).toString('base64')};
  await writeFile(keyFile,JSON.stringify(keys),{mode:0o600,flag:'wx'});
}
const env={...process.env,LAB_IMAGE:id,LAB_ACCESS_SECRET:keys.access,LAB_REFRESH_SECRET:keys.refresh};
const compose=['compose','-p','scaling-ingestion-test','-f',resolve(topic,'infra/compose/production-like.yaml'),'-f',resolve(topic,'infra/compose/ingestion.yaml'),'-f',resolve(topic,'infra/compose/ingestion-test.yaml')];
const volume='scaling-ingestion-test_mongo-data';
const volumes=docker(['volume','ls','--format','{{.Name}}'],{capture:true}).split(/\r?\n/);
if(!volumes.includes(volume))docker(['volume','create','--label','scaling.owner=ingestion-test',volume]);
assert.equal(docker(['volume','inspect','--format','{{index .Labels "scaling.owner"}}',volume],{capture:true}),'ingestion-test','Refuse an unowned volume');
try{
  docker([...compose,'stop','worker','outbox'],{env});
  docker([...compose,'up','-d','--wait','--wait-timeout','120'],{env});
  docker([...compose,'up','--no-deps','--no-start','worker','outbox'],{env});
  const result=spawnSync(process.execPath,[resolve(topic,'tests/integration/ingestion-durability.mjs')],{env,stdio:'inherit'});assert.equal(result.status,0);
  const proof=JSON.parse(await readFile(resolve(artifacts,'ingestion/durability.json'),'utf8'));assert.equal(proof.passed,true);assert.equal(proof.image,id,'Crash/recovery tests must use this exact built image');
  const archive=resolve(artifacts,'ci/ci-image.tar');docker(['save','--output',archive,image]);
  const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
  await writeFile(resolve(artifacts,'ci/image-identity.json'),JSON.stringify({imageId:id,sourceTreeSha256:sourceHash,archiveSha256:hash.digest('hex'),durabilityPassed:true,createdAt:new Date().toISOString()},null,2)+'\n');
}finally{docker([...compose,'--profile','manual','down'],{env});}
