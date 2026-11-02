import assert from 'node:assert/strict';
import {join} from 'node:path';

export const project='scaling-learning-lab';
export const owner='learning-lab';
export const ports={api:18090,prometheus:19094,grafana:13004};
export const images={
  mongo:'mongo@sha256:5d7043a4ffe02b9ed1b6e0bab057546981af5ca0a79107e9c461e49bc44c0a7b',
  redis:'redis@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0',
  nginx:'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236',
  queue:'softwaremill/elasticmq-native@sha256:e4580ab9ad1bd5cd37b4ba04911bc5ccc8cd2d9ab4de56ece65acee71c24e05c',
  prometheus:'prom/prometheus@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e',
  grafana:'grafana/grafana@sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572',
  k6:'grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603',
};
export const scenarios={
  baseline:{expected:'Catalog and authenticated user reads succeed under a bounded offered load.',lesson:'Separate offered rate, completed throughput, latency, errors and correctness.',panels:[1,2,3,7]},
  scaling:{expected:'One four-worker container and four one-worker containers share the same total API resources.',lesson:'Topology is not free capacity. Compare equal CPU, RAM and connection budgets, with repeated trials.',panels:[1,2,3,4]},
  cache:{expected:'Warm public reads hit Redis; authenticated reads remain private and uncached.',lesson:'Compare database-read work and hit rate, not only latency at a low offered rate.',panels:[2,5,6]},
  'api-failure':{expected:'During one API hard kill, transient read failures remain below 1%, successful bodies remain correct, and the pool recovers.',lesson:'Hard kills can lose in-flight reads. Retry/discovery reduces the failure window but is not host or AZ resilience.',panels:[1,2,3,4]},
  'redis-outage':{expected:'Catalog reads fall back to Mongo while Redis is stopped, then warm hits return.',lesson:'A disposable cache should not become an authoritative-data dependency.',panels:[2,5,6]},
  'worker-crash':{expected:'A leased job has no partial product; after crash and lease expiry, the real worker commits one effect.',lesson:'Leases and atomic effect/completion enable recovery from interrupted work.',panels:[8,9]},
  'duplicate-delivery':{expected:'Repeated transport delivery after effect commit is acknowledged without a second product.',lesson:'At-least-once delivery plus idempotent effects is not exactly-once transport.',panels:[8,9]},
  rollback:{expected:'A deliberately bad candidate returns 503; traffic is rolled back to the unchanged known-good image.',lesson:'Readiness and a post-switch probe must control promotion and rollback.',panels:[1,2,3]},
  restore:{expected:'A quiesced synthetic database archive restores into a separate owned Mongo instance with identical content.',lesson:'A backup is only demonstrated when an independent restore and content check succeed.',panels:[7,8,9]},
  capacity:{expected:'An ascending/descending repeated rate ladder retains every result and identifies only supported tested rates.',lesson:'Fixed-rate success is not maximum capacity. Distinguish latency qualification, errors, generator drops and sample length.',panels:[1,2,10,11,13,14]},
  'mongo-outage':{expected:'A frozen Mongo peer produces bounded explicit 503s while process health stays available; normal traffic recovers after unpause.',lesson:'Server-side query limits do not bound a network blackhole. Shed work before dependencies and avoid retry amplification.',panels:[3,6,12,13,14]},
};

export function parseOptions(args){
  const result={scenarios:['baseline'],duration:'30s',rate:20,repeat:2,build:false,down:false,list:false};
  let all=false,selected=false;
  for(const arg of args){
    if(arg==='--all'){all=true;continue;}
    if(arg==='--build'){result.build=true;continue;}
    if(arg==='--down'){result.down=true;continue;}
    if(arg==='--list'||arg==='--help'){result.list=true;continue;}
    const match=arg.match(/^--(scenario|duration|rate|repeat)=(.+)$/);
    assert.ok(match,`Unknown argument: ${arg}`);
    const [,key,value]=match;
    if(key==='scenario'){assert.ok(Object.hasOwn(scenarios,value),`Unknown scenario: ${value}`);result.scenarios=[value];selected=true;}
    else if(key==='duration'){assert.match(value,/^\d+(s|m)$/,'Duration must be 15s through 10m');const seconds=Number(value.slice(0,-1))*(value.endsWith('m')?60:1);assert.ok(seconds>=15&&seconds<=600);result.duration=value;}
    else{assert.match(value,/^\d+$/);result[key]=Number(value);assert.ok(result[key]>=1&&result[key]<=(key==='rate'?200:5),`Invalid ${key}`);}
  }
  assert.ok(!(all&&selected),'Choose --all or --scenario, not both');
  if(all)result.scenarios=Object.keys(scenarios);
  assert.ok(!(result.down&&(all||selected||result.build)),'--down cannot also run experiments');
  return result;
}
export function assertOwned(labels,service){
  assert.equal(labels?.['com.docker.compose.project'],project,'Foreign Compose project');
  assert.equal(labels?.['scaling.owner'],owner,'Missing learning ownership');
  assert.equal(labels?.['com.docker.compose.service'],service,'Unexpected service');
}
export async function waitForHttpReady(url,{timeoutMs=30000,intervalMs=100}={}){
  const target=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(target.hostname),'Readiness probes must remain local');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{const response=await fetch(url,{signal:AbortSignal.timeout(Math.min(2000,Math.max(1,deadline-Date.now())))});await response.arrayBuffer();if(response.status===200)return;}catch{}
    await new Promise(done=>setTimeout(done,intervalMs));
  }
  throw new Error(`Readiness timeout: ${target.pathname}`);
}

export function composeModel({root,runtime,image,sourceHash,topology='horizontal',cache=false,admissionLimit=64}){
  assert.ok(['horizontal','vertical'].includes(topology));
  assert.match(image,/^sha256:[a-f0-9]{64}$/);
  assert.match(sourceHash,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(admissionLimit)&&admissionLimit>=1&&admissionLimit<=1024);
  const mount=(host,target)=>`${host.replaceAll('\\','/')}:${target}:ro`;
  const labels={'scaling.owner':owner,'org.scaling.source.sha256':sourceHash};
  const local={labels,networks:['backend'],restart:'no',security_opt:['no-new-privileges:true']};
  const environment={NODE_ENV:'production',PORT:'5002',MONGO_AUTO_INDEX:'true',MONGO_URI:'mongodb://mongo:27017/learning_lab?replicaSet=production-lab',REDIS_URL:'redis://redis:6379',JWT_ACCESS_SECRET:'${LEARNING_ACCESS_SECRET:?Private local key required}',JWT_REFRESH_SECRET:'${LEARNING_REFRESH_SECRET:?Private local key required}',JWT_ACCESS_EXPIRES_IN:'6h',JWT_REFRESH_EXPIRES_IN:'1d',PUBLIC_CATALOG_CACHE:String(cache),CACHE_NAMESPACE:'learning',MONGO_POOL_MAX:'10',MONGO_POOL_WAIT_MS:'2000',MONGO_SELECT_TIMEOUT_MS:'2000',SQS_LOCAL_EMULATOR:'true',SQS_REGION:'us-east-1',SQS_ENDPOINT:'http://queue:9324',SQS_QUEUE_URL:'http://queue:9324/000000000000/ingestion-jobs',SQS_DLQ_URL:'http://queue:9324/000000000000/ingestion-dlq',INGESTION_BACKLOG_LIMIT:'1000'};
  const app={...local,image,init:true,read_only:true,cap_drop:['ALL'],tmpfs:['/tmp:size=32m'],stop_grace_period:'25s',environment,volumes:[mount(join(root,'scripts/local/learning-helper.mjs'),'/lab/helper.mjs'),mount(join(root,'bench/fixtures'),'/fixtures')],depends_on:{'mongo-init':{condition:'service_completed_successfully'},redis:{condition:'service_healthy'},queue:{condition:'service_started'}}};
  const mongo={...local,image:images.mongo,cpus:0.75,mem_limit:'768m',environment:{GLIBC_TUNABLES:'glibc.pthread.rseq=1'},command:['mongod','--replSet','production-lab','--bind_ip_all','--wiredTigerCacheSizeGB','0.25'],healthcheck:{test:['CMD','mongosh','--quiet','--eval','const s=db.serverStatus(); quit(s.ok===1 && s.tcmalloc?.usingPerCPUCaches===false ? 0 : 1)'],interval:'5s',timeout:'4s',retries:30},volumes:['mongo-data:/data/db',`${join(runtime,'backup').replaceAll('\\','/')}:/backup`]};
  const api={...app,cpus:topology==='vertical'?1:0.25,mem_limit:topology==='vertical'?2147483648:536870912,command:topology==='vertical'?['node','dist/server.js']:['node','dist/container.js'],environment:{...environment,REQUEST_MAX_INFLIGHT:String(admissionLimit),MONGO_SOCKET_TIMEOUT_MS:'5000',...(topology==='vertical'?{WORKERS:'4',CLUSTER_METRICS_PORT:'5006'}:{})}};
  return {name:project,services:{
    mongo,
    'mongo-init':{...local,image:images.mongo,command:['mongosh','--host','mongo','--quiet','/init.js'],volumes:[mount(join(root,'infra/compose/init-mongo.js'),'/init.js')],depends_on:{mongo:{condition:'service_healthy'}}},
    redis:{...local,image:images.redis,cpus:0.2,mem_limit:'128m',command:['redis-server','--save','','--appendonly','no','--maxmemory','64mb','--maxmemory-policy','allkeys-lru'],healthcheck:{test:['CMD','redis-cli','ping'],interval:'5s',timeout:'3s',retries:20}},
    queue:{...local,image:images.queue,cpus:0.25,mem_limit:'256m',volumes:[mount(join(root,'infra/compose/ingestion.conf'),'/opt/elasticmq.conf'),'queue-data:/data']},
    api,
    worker:{...app,cpus:0.25,mem_limit:'256m',command:['node','dist/worker.js'],environment:{...environment,SERVICE_ROLE:'worker',MONGO_POOL_MAX:'3'}},
    outbox:{...app,cpus:0.2,mem_limit:'256m',command:['node','dist/outbox.js'],environment:{...environment,SERVICE_ROLE:'outbox',MONGO_POOL_MAX:'2'}},
    gateway:{...local,image:images.nginx,user:'101:101',cpus:0.2,mem_limit:'128m',networks:['backend','edge'],read_only:true,cap_drop:['ALL'],tmpfs:['/tmp:size=32m','/var/cache/nginx:size=8m'],ports:[`127.0.0.1:${ports.api}:8080`],volumes:[mount(join(runtime,'gateway'),'/etc/nginx/lab')],command:['nginx','-c','/etc/nginx/lab/gateway.conf','-g','daemon off;'],depends_on:{api:{condition:'service_healthy'}}},
    candidate:{...app,profiles:['manual'],cpus:0.1,mem_limit:'128m',command:['node','-e',"require('node:http').createServer((q,s)=>{s.writeHead(503,{'content-type':'application/json'});s.end(JSON.stringify({error:'Deliberately bad learning release'}))}).listen(5002,'0.0.0.0')"],healthcheck:{disable:true}},
    restore:{...local,profiles:['manual'],image:images.mongo,cpus:0.5,mem_limit:'512m',environment:mongo.environment,command:['mongod','--bind_ip_all','--wiredTigerCacheSizeGB','0.25'],volumes:['restore-data:/data/db',`${join(runtime,'backup').replaceAll('\\','/')}:/backup`],healthcheck:mongo.healthcheck},
    prometheus:{...local,image:images.prometheus,cpus:0.25,mem_limit:'256m',networks:['backend','edge'],ports:[`127.0.0.1:${ports.prometheus}:9090`],command:['--config.file=/etc/prometheus/lab.yml','--storage.tsdb.path=/prometheus','--storage.tsdb.retention.time=24h','--storage.tsdb.retention.size=128MB'],volumes:['prometheus-data:/prometheus',mount(join(runtime,'prometheus.yml'),'/etc/prometheus/lab.yml')]},
    grafana:{...local,image:images.grafana,cpus:0.5,mem_limit:'512m',networks:['backend','edge'],ports:[`127.0.0.1:${ports.grafana}:3000`],environment:{GF_SECURITY_ADMIN_USER:'learning-admin',GF_SECURITY_ADMIN_PASSWORD:'${LEARNING_GRAFANA_SECRET:?Private local key required}',GF_AUTH_ANONYMOUS_ENABLED:'true',GF_AUTH_ANONYMOUS_ORG_ROLE:'Viewer',GF_USERS_ALLOW_SIGN_UP:'false',GF_SECURITY_DISABLE_GRAVATAR:'true',GF_ANALYTICS_REPORTING_ENABLED:'false',GF_ANALYTICS_CHECK_FOR_UPDATES:'false',GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES:'false',GF_PLUGINS_PREINSTALL_DISABLED:'true',GF_USERS_DEFAULT_THEME:'light'},volumes:['grafana-data:/var/lib/grafana',mount(join(runtime,'provisioning'),'/etc/grafana/provisioning'),mount(join(runtime,'dashboards'),'/var/lib/grafana/dashboards')]},
  },networks:{backend:{internal:true},edge:{}},volumes:Object.fromEntries(['mongo','queue','restore','prometheus','grafana'].map(name=>[`${name}-data`,{external:true,name:`${project}_${name}-data`}]))};
}

export function summarizeLoad(raw,exitCode,{faultWindow=false}={}){
  const values=name=>raw.metrics?.[name]?.values??raw.metrics?.[name];
  for(const name of ['http_reqs','http_req_failed','http_req_duration','checks'])assert.ok(values(name),`Missing k6 ${name}`);
  const failures=values('checks').fails,failedRate=values('http_req_failed').rate??values('http_req_failed').value,drops=values('dropped_iterations')?.count??0;
  assert.ok([failures,failedRate,values('http_reqs').count,values('http_reqs').rate,values('http_req_duration')['p(95)']].every(Number.isFinite),'Incomplete k6 measurements');
  const correctness=values('learning_correctness_failures')?.count;
  if(faultWindow)assert.ok(Number.isFinite(correctness),'Fault budget requires independent correctness measurements');
  return {compression:'off',requests:values('http_reqs').count,reqPerSec:values('http_reqs').rate,dataOutBytes:values('data_received')?.count??0,dataOutBytesPerSec:values('data_received')?.rate??0,passResponses:values('http_req_failed').fails,failResponses:values('http_req_failed').passes,p95Ms:values('http_req_duration')['p(95)'],p99Ms:values('http_req_duration')['p(99)'],failedRate,checkPasses:values('checks').passes,checkFailures:failures,correctnessFailures:correctness??null,faultWindow,qualification:faultWindow?'Transient fault errors below 1%; no incorrect successful bodies and no dropped arrivals.':'Every response succeeds with correct content; no dropped arrivals.',droppedIterations:drops,exitCode,passed:exitCode===0&&failedRate<0.01&&(faultWindow?correctness===0:failures===0)&&drops===0};
}

export function dashboard(){
  const definitions=[
    ['Completed requests/s','sum(rate(app_http_requests_total{job=~"learning-api.*"}[1m]))','reqps'],
    ['HTTP p95','histogram_quantile(0.95, sum by (le)(rate(app_http_request_duration_seconds_bucket{job=~"learning-api.*"}[1m])))','s'],
    ['Application HTTP errors/s','sum(rate(app_http_requests_total{job=~"learning-api.*",status_code=~"5.."}[1m])) or sum(rate(app_http_requests_total{job=~"learning-api.*"}[1m])) * 0','reqps'],
    ['Serving replicas / workers','sum(app_readiness{job=~"learning-api.*"})','short'],
    ['Cache operations/s','sum by(outcome)(rate(app_catalog_cache_operations_total{job=~"learning-api.*"}[1m]))','ops'],
    ['Mongo commands/s','sum by(command)(rate(app_mongo_command_seconds_count{job=~"learning-api.*"}[1m]))','ops'],
    ['Synthetic users','max(app_ingestion_state{job="learning-outbox",state="syntheticProfiles"})','short'],
    ['Durable ingestion state','max by(state)(app_ingestion_state{job="learning-outbox",state=~"accepted|queued|flushed|failed|unsent|queueVisible|queueInFlight|dlqVisible"})','short'],
    ['Catalog products','max(app_ingestion_state{job="learning-outbox",state="catalogProducts"})','short'],
    ['API CPU cores used','sum(rate(container_cpu_usage_seconds_total{job=~"learning-api.*"}[1m]))','short'],
    ['API memory','sum(container_memory_current_bytes{job=~"learning-api.*"})','bytes'],
    ['Mongo checkout p95','histogram_quantile(0.95,sum by(le)(rate(app_mongo_pool_checkout_seconds_bucket{job=~"learning-api.*"}[1m])))','s'],
    ['Admitted responses / budget','sum by(__name__)( {__name__=~"app_admission_active|app_admission_limit|app_admission_high_water",job=~"learning-api.*"} )','short'],
    ['Admission rejections/s','sum(rate(app_admission_rejected_total{job=~"learning-api.*"}[1m]))','reqps'],
  ];
  return {uid:'local-learning-lab',title:'Local learning lab · synthetic users only',tags:['learning','local','synthetic'],schemaVersion:39,version:1,refresh:'15s',time:{from:'now-1h',to:'now'},timezone:'browser',annotations:{list:[{name:'Experiments',type:'dashboard',builtIn:1,enable:true,hide:false,iconColor:'blue',datasource:{type:'grafana',uid:'-- Grafana --'}}]},panels:definitions.map(([title,expr,unit],index)=>({id:index+1,title,type:'timeseries',gridPos:{x:(index%3)*8,y:Math.floor(index/3)*8,w:8,h:8},datasource:{type:'prometheus',uid:'learning-prometheus'},targets:[{refId:'A',expr,legendFormat:index===12?'{{__name__}}':'{{outcome}}{{command}}{{state}}'}],fieldConfig:{defaults:{unit},overrides:[]},options:{legend:{displayMode:'list',placement:'bottom'}}}))};
}

export function dashboardContract(value){
  assert.equal(value.uid,'local-learning-lab');
  return value.panels.map(panel=>({id:panel.id,title:panel.title,expressions:panel.targets.map(target=>target.expr)}));
}
