import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readFile, writeFile, appendFile, stat, open} from 'node:fs/promises';
import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {journey} from '../../scripts/operations/journey.mjs';
import {runMixed} from '../../bench/scenarios/mixed-run.mjs';

const topic = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const folder = resolve(topic, 'infra/compose/artifacts/operations/recovery');
await mkdir(folder, {recursive:true});
const keys = JSON.parse((await readFile(resolve(topic, 'infra/compose/artifacts/local-keys.json'), 'utf8')).replace(/^\uFEFF/, ''));
const env = {...process.env, LAB_ACCESS_SECRET:keys.access, LAB_REFRESH_SECRET:keys.refresh};
const project = 'scaling-operations-test', database = 'operations_test';
const compose = ['compose', '-p', project, '-f', resolve(topic, 'tests/operations/compose.yaml'), '--profile', 'restore', '--profile', 'load'];
const image = process.env.LAB_IMAGE ?? 'scaling-express:ci';
const profile=process.argv.find(arg=>arg.startsWith('--profile='))?.slice(10)??'smoke';
assert.ok(['smoke','support','stress','spike','soak'].includes(profile),'Choose a known isolated workload before database setup');
const report = {profile,startedAt:new Date().toISOString(), passed:false, cloud:false, synthetic:true, checks:[]};
let paused = false;
function docker(args, {expected=0, input}={}) {
  const result = spawnSync('docker', args, {env, encoding:'utf8', input, timeout:120000, maxBuffer:8*1024*1024});
  assert.equal(result.status, expected, result.error?.message || result.stderr || 'Docker operation failed');
  return result.stdout.trim();
}
function service(name) {return project+'-'+name+'-1';}
function mongo(name, code) {
  const config = JSON.parse(docker(['inspect', service(name)]))[0];
  assert.equal(config.Config.Labels['com.docker.compose.project'], project);
  return JSON.parse(docker(['exec', service(name), 'mongosh', '--quiet', '--eval', 'const dbx=db.getSiblingDB("operations_test"); print(JSON.stringify((()=>{'+code+'})()));']));
}
async function until(fn, label, ms=60000) {
  const end=Date.now()+ms;let last;
  while(Date.now()<end) {try {if(await fn())return;}catch(error){last=error.message;}await delay(250);}
  throw Error(label+' deadline: '+last);
}
async function initialize(name, replica) {
  docker(['exec',service(name),'mongosh','--quiet','--eval',`try { rs.status() } catch(e) { if(e.code===94) rs.initiate({_id:${JSON.stringify(replica)},members:[{_id:0,host:${JSON.stringify(name+':27017')}}]}); else throw e; }`]);
  await until(()=>mongo(name,'return db.adminCommand({hello:1}).isWritablePrimary;'),'replica primary');
}
function resetOwned(name) {
  mongo(name, `const names=dbx.getCollectionNames(); if(names.length && dbx.getCollection('_operations_owner').findOne({_id:'synthetic'})?.owner!==${JSON.stringify(project)})throw Error('Refuse an unowned database'); if(names.length)dbx.dropDatabase(); dbx.getCollection('_operations_owner').insertOne({_id:'synthetic',owner:${JSON.stringify(project)}}); return true;`);
}
function migration(args=[], crash=false, expected=0, host='mongo', replica='operations') {
  return docker(['run','--rm','--network',project+'_backend','--cpus=1','--memory=512m','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','-e',`MONGO_URI=mongodb://${host}:27017/${database}?replicaSet=${replica}`,'-e','MIGRATION_TARGET_DB='+database,'-e','MIGRATION_CONFIRM='+database,...(crash?['-e','MIGRATION_TEST_CRASH_AFTER_BATCH=1']:[]),image,'node','dist/migrate.js',...args],{expected});
}
async function request(base,path,{method='GET',body,token,key=randomUUID(),status=200}={}) {
  const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{}),...(['GET','HEAD'].includes(method)?{}:{'idempotency-key':key})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  const value=await response.json();assert.equal(response.status,status,method+' '+path+' status '+response.status);return value;
}
function snapshot(name) {
  // Compute document hashes next to the database. Returning every populated
  // record exceeded child-process output limits and exposed private fixture
  // contents to the host; the reconciliation needs only counts and hashes.
  return mongo(name, `const crypto=require('node:crypto');const collections=['products','users','sessions','cartitems','wishlistitems','mutation_receipts','ingestion_jobs','ingestion_outbox','ingestion_counters','_schema_migrations','product_catalog_versions']; return Object.fromEntries(collections.map(c=>{const hash=crypto.createHash('sha256');const rows=dbx.getCollection(c).find({}).sort({_id:1}).toArray();for(const row of rows)hash.update(EJSON.stringify(row,{relaxed:false})).update('\\n');return [c,{count:rows.length,sha256:hash.digest('hex')}];}));`);
}
function semanticHash(value) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function exitOf(child) {return new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolveExit():reject(Error('Mongo archive tool failed with code '+code)));});}
const backup=resolve(folder,'database.archive.aes256gcm'),keyPath=resolve(folder,'backup-key.bin');
async function encryptBackup() {
  const key=randomBytes(32),iv=randomBytes(12);
  await writeFile(keyPath,key,{mode:0o600});
  if(process.platform==='win32') {const acl=spawnSync('icacls',[keyPath,'/inheritance:r','/grant:r',process.env.USERNAME+':F'],{encoding:'utf8'});assert.equal(acl.status,0,'Backup key ACL failed');}
  const child=spawn('docker',['exec',service('mongo'),'mongodump','--uri=mongodb://127.0.0.1:27017/?replicaSet=operations','--archive','--oplog','--gzip'],{env,stdio:['ignore','pipe','ignore']});
  const completed=exitOf(child),cipher=createCipheriv('aes-256-gcm',key,iv),output=createWriteStream(backup,{mode:0o600});
  output.write(Buffer.concat([Buffer.from('SCALBKP1'),iv]));
  await Promise.all([pipeline(child.stdout,cipher,output),completed]);
  await appendFile(backup,cipher.getAuthTag());
  report.backup={algorithm:'AES-256-GCM',bytes:(await stat(backup)).size,ciphertextSha256:createHash('sha256').update(await readFile(backup)).digest('hex'),oplogIncluded:true,keyStoredSeparately:true};
}
async function decipher() {
  const size=(await stat(backup)).size,handle=await open(backup,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16);
  try {await handle.read(header,0,20,0);await handle.read(tag,0,16,size-16);}finally{await handle.close();}
  assert.equal(header.subarray(0,8).toString(),'SCALBKP1');
  const decrypt=createDecipheriv('aes-256-gcm',await readFile(keyPath),header.subarray(8));decrypt.setAuthTag(tag);
  return {input:createReadStream(backup,{start:20,end:size-17}),decrypt};
}
async function restoreBackup() {
  // Authenticate the entire archive before giving any bytes to mongorestore.
  const checked=await decipher();await pipeline(checked.input,checked.decrypt,new Writable({write(_chunk,_encoding,done){done();}}));
  const child=spawn('docker',['exec','-i',service('mongo-restore'),'mongorestore','--uri=mongodb://127.0.0.1:27017/?replicaSet=operations-restore','--archive','--oplogReplay','--gzip'],{env,stdio:['pipe','ignore','ignore']});
  const completed=exitOf(child),decoded=await decipher();await Promise.all([pipeline(decoded.input,decoded.decrypt,child.stdin),completed]);
}

try {
  report.image=docker(['image','inspect','--format','{{.Id}}',image]);
  for(const volume of [project+'_mongo-data',project+'_restore-data']) {
    const names=docker(['volume','ls','--format','{{.Name}}']).split(/\r?\n/);
    if(!names.includes(volume))docker(['volume','create','--label','scaling.owner=operations-test',volume]);
    assert.equal(docker(['volume','inspect','--format','{{index .Labels "scaling.owner"}}',volume]),'operations-test');
  }
  docker([...compose,'up','-d','--wait','mongo','redis','queue']);await initialize('mongo','operations');resetOwned('mongo');
  const loadFolder=resolve(topic,'infra/compose/artifacts/operations/load');await mkdir(loadFolder,{recursive:true});
  docker(['run','--rm','--user',process.platform==='win32'?'1000:1000':String(process.getuid())+':'+String(process.getgid()),'--network',project+'_backend','--cpus=1','--memory=512m','--read-only','--cap-drop=ALL','-v',resolve(topic,'tests/operations/load-fixture.mjs')+':/checks/load-fixture.mjs:ro','-v',resolve(topic,'bench/fixtures')+':/fixture:ro','-v',loadFolder+':/results','-e','MONGO_URI=mongodb://mongo:27017/operations_test?replicaSet=operations','-e','LAB_ACCESS_SECRET','-e','LAB_REFRESH_SECRET',image,'node','/checks/load-fixture.mjs']);
  if(process.platform==='win32'){const acl=spawnSync('icacls',[resolve(loadFolder,'sessions.json'),'/inheritance:r','/grant:r',process.env.USERNAME+':F'],{encoding:'utf8'});assert.equal(acl.status,0);}
  migration([],true,86);
  const checkpoint=mongo('mongo',`return dbx.getCollection('_schema_migrations').findOne({_id:'002-expand-catalog-read-model'});`);
  assert.equal(checkpoint.processed,100);assert.equal(checkpoint.status,'running');
  migration([],false,1);report.checks.push('abrupt migration exit preserves committed batch checkpoint; concurrent runner is rejected');
  await delay(10500);migration();migration();migration(['--verify']);
  assert.equal(mongo('mongo',`return dbx.product_catalog_versions.countDocuments({});`),10000);
  report.checks.push('expired lease resumes the next batch; full rerun is idempotent; indexes are verified');
  docker([...compose,'up','-d','--wait','api','worker','outbox']);
  const base='http://127.0.0.1:18086',restored='http://127.0.0.1:18087';
  const id=randomUUID(),password='Synthetic-recovery-password',credentials=[];
  for(let i=0;i<3;i++) {
    const body={name:'Recovery synthetic '+i,email:'recovery-'+id+'-'+i+'@example.invalid',password};
    const user=await request(base,'/users/signup',{method:'POST',body,status:201});credentials.push({email:body.email,password});
    if(i===2)mongo('mongo',`dbx.users.updateOne({_id:new ObjectId(${JSON.stringify(user.user.id)})},{$set:{role:'admin'}});return true;`);
  }
  const users=credentials.slice(0,2),admin=credentials[2];
  report.journey=await journey({base,users,admin});
  const rollback=spawnSync(process.execPath,[resolve(topic,'tests/operations/rollback.mjs')],{env:{...env,ROLLBACK_NETWORK:project+'_backend',ROLLBACK_MONGO_URI:'mongodb://mongo:27017/operations_test?replicaSet=operations',ROLLBACK_CATALOG_SIZE:'10000',ROLLBACK_CURRENT_IMAGE:image,ROLLBACK_PREVIOUS_IMAGE:process.env.ROLLBACK_PREVIOUS_IMAGE??image,ROLLBACK_JOURNEY_JSON:JSON.stringify({users,admin})},stdio:'inherit'});assert.equal(rollback.status,0);
  try {
    report.mixed=await runMixed({profile,environment:env,query:code=>mongo('mongo',code)});
  } catch (error) {
    // Load and recovery are separate gates. Preserve the failed workload and
    // finish the restore exercise instead of discarding independent proof.
    report.mixed={passed:false,profile,failure:String(error.message).slice(0,300)};
    report.loadGateFailed=true;
  }
  // Fault injection is confined to the standalone rollback fixture process.
  report.checks.push('real two-user ownership, replay, revocation and asynchronous write journey');
  docker([...compose,'stop','worker']);
  const login=await request(base,'/users/login',{method:'POST',body:admin}),accepted=[];
  for(let i=0;i<2;i++)accepted.push(await request(base,'/products/ingest',{method:'POST',token:login.accessToken,status:202,body:{name:'Recovered acknowledged '+id+'-'+i,description:'Pre-backup acknowledged work',price:1,stock:1,category:'books',imageUrl:'https://example.invalid/synthetic'}}));
  await until(()=>mongo('mongo',`return dbx.ingestion_outbox.countDocuments({jobId:{$in:${JSON.stringify(accepted.map(j=>j.jobId))}.map(id=>new ObjectId(id))},state:'sent'});`)===accepted.length,'queued durable jobs');
  docker([...compose,'stop','api','outbox']);
  const before=snapshot('mongo'),cutoff=new Date();await encryptBackup();
  const incident=Date.now();docker(['pause',service('mongo')]);paused=true;
  docker([...compose,'up','-d','--wait','mongo-restore']);await initialize('mongo-restore','operations-restore');resetOwned('mongo-restore');
  assert.equal(mongo('mongo-restore',`return dbx.products.countDocuments({});`),0,'Restore must start with an empty owned target');
  await restoreBackup();migration(['--verify'],false,0,'mongo-restore','operations-restore');
  const after=snapshot('mongo-restore');assert.equal(semanticHash(after),semanticHash(before),'All durable snapshot collections must reconcile before accepting traffic');
  docker([...compose,'up','-d','--wait','api-restore','worker-restore','outbox-restore']);
  await until(async()=>{for(const job of accepted){const row=await request(restored,'/ingestion-jobs/'+job.jobId,{token:login.accessToken});if(row.status!=='succeeded')return false;}return true;},'restored accepted jobs',60000);
  const effects=mongo('mongo-restore',`return dbx.ingestion_jobs.find({_id:{$in:${JSON.stringify(accepted.map(j=>j.jobId))}.map(id=>new ObjectId(id))}}).toArray().map(j=>({job:String(j._id),status:j.status,effects:dbx.products.countDocuments({_id:j.productId})}));`);
  assert.equal(effects.length,2);assert.ok(effects.every(row=>row.status==='succeeded'&&row.effects===1));
  report.restoredJourney=await journey({base:restored,users,admin});
  report.recovery={acknowledgedAtCutoff:accepted.length,recoveredJobs:effects.length,exactlyOneEffectPerJob:true,lostAcknowledgements:0,rpoSeconds:(incident-cutoff.getTime())/1000,rtoSeconds:(Date.now()-incident)/1000,scope:'Encrypted local replica-set snapshot and oplog replay. Not Atlas PIT or multi-AZ recovery.'};
  report.checks.push('AES-GCM archive authenticated before restore; durable snapshot hashes, migration ledger and queued acknowledgements reconcile; restored two-user mutation/revocation/ingestion journey passes');
  report.passed=true;console.log('RECOVERY_DRILL_PASS migration crash/resume, encrypted restore, acknowledged jobs exactly once');
} catch(error) {report.failure=error.message;throw error;}
finally {
  if(paused)docker(['unpause',service('mongo')]);
  docker([...compose,'down']);
  report.finishedAt=new Date().toISOString();
  await writeFile(resolve(folder,'recovery.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(resolve(folder,'recovery-'+profile+'.json'),JSON.stringify(report,null,2)+'\n');
}
if(report.loadGateFailed)throw Error('Recovery finished, but the independent mixed workload gate failed');
