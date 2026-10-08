import {createServer} from 'node:http';
import {createSocket} from 'node:dgram';
import {appendFile,mkdir,stat,rename,rm} from 'node:fs/promises';
import {Registry,Counter,Histogram,Gauge} from 'prom-client';
import {BoundedLogWriter} from './log-buffer.js';

const registry=new Registry();registry.setDefaultLabels({service:'catalog-edge',environment:'local-synthetic',version:'0.4.0',replica:process.env.HOSTNAME??'local'});
const requests=new Counter({name:'edge_http_requests_total',help:'Gateway completed requests including failures that never reach an API',labelNames:['method','route','status_code'],registers:[registry]});
const duration=new Histogram({name:'edge_http_request_duration_seconds',help:'Gateway observed request duration',labelNames:['method','route'],buckets:[0.005,0.01,0.025,0.05,0.1,0.15,0.3,0.5,0.75,1,5,15],registers:[registry]});
const dropped=new Counter({name:'telemetry_events_dropped_total',help:'Bounded local telemetry delivery failures',labelNames:['reason'],registers:[registry]});
const received=new Counter({name:'telemetry_events_received_total',help:'Accepted telemetry events',labelNames:['kind'],registers:[registry]});
const retries=new Counter({name:'telemetry_export_retries_total',help:'Bounded transient log-export retries, distinct from dropped events',registers:[registry]});
const buffered=new Gauge({name:'telemetry_buffer_events',help:'Buffered events awaiting export',registers:[registry]});
const routes=new Set(['/health','/ready','/metrics','/products','/products/:id','/products/ingest','/products/ingest/stats','/users/signup','/users/login','/users/refresh','/users/me','/users/logout','/cart','/cart/:id','/cart/:id/quantity','/wishlist','/wishlist/:id','/ingestion-jobs/:id','/ingestion-jobs/:id/redrive','__unmatched__']);
const services=new Set(['catalog-api','catalog-worker','outbox-relay','catalog-edge']);
const queue:Array<{timestamp:string;line:string;service:string;attempts:number}>=[],alerts:Record<string,unknown>[]=[];
let closing=false;
const evidence='/evidence';await mkdir(evidence,{recursive:true});
const disk=new BoundedLogWriter(1024,100,async lines=>{
    const file=evidence+'/events.jsonl';
    if((await stat(file).catch(()=>({size:0}))).size>10*1024*1024){
      // Only this process's known, bounded log files are rotated.
      await rm(file+'.3',{force:true});
      for(const index of [2,1])await rename(file+'.'+index,file+'.'+(index+1)).catch(()=>{});
      await rename(file,file+'.1');
    }
    await appendFile(file,lines.join('\n')+'\n');
});
const diskTimer=setInterval(()=>void disk.flush(),200);
async function persist(event:Record<string,unknown>):Promise<void>{
  const result=await disk.enqueue(JSON.stringify(event));
  if(result!=='written')dropped.inc({reason:result==='capacity'?'disk_queue_full':'disk_write'});
}
function accept(input:Record<string,unknown>):void{
  const kind=input.kind==='edge'?'edge':'application';
  const method=['GET','POST','PATCH','PUT','DELETE','HEAD','OPTIONS'].includes(String(input.method))?String(input.method):'OTHER';
  const route=routes.has(String(input.route))?String(input.route):'__unmatched__';
  const status=Number(input.status),elapsed=Number(input.durationMs??Number(input.duration)*1000);
  if(!Number.isInteger(status)||status<100||status>599||!Number.isFinite(elapsed)||elapsed<0||elapsed>300000){dropped.inc({reason:'invalid_event'});return;}
  const service=services.has(String(input.service))?String(input.service):kind==='edge'?'catalog-edge':'catalog-api';
  const event={at:new Date().toISOString(),kind,service,method,route,status,durationMs:elapsed,version:/^\d+\.\d+\.\d+$/.test(String(input.version))?input.version:'0.4.0',...(/^[a-z0-9-]{1,64}$/i.test(String(input.replica))?{replica:input.replica}:{}),...(/^[a-f0-9-]{32,36}$/i.test(String(input.requestId))?{requestId:input.requestId}:{}),...(/^[a-f0-9]{32}$/i.test(String(input.traceId))?{traceId:input.traceId}:{})};
  if(kind==='edge'){requests.inc({method,route,status_code:String(status)});duration.observe({method,route},elapsed/1000);}
  received.inc({kind});void persist(event);
  if(queue.length<2048)queue.push({timestamp:String(BigInt(Date.now())*1000000n),line:JSON.stringify(event),service,attempts:0});else dropped.inc({reason:'export_queue_full'});
  buffered.set(queue.length);
}
const udp=createSocket('udp4');udp.on('error',()=>{dropped.inc({reason:'udp_socket'});});
udp.on('message',buffer=>{if(buffer.length>4096){dropped.inc({reason:'oversize'});return;}try{const body=buffer.toString();accept(JSON.parse(body.slice(body.indexOf('{'))));}catch{dropped.inc({reason:'invalid_json'});}});udp.bind(1514,'0.0.0.0');
let exporting=false,lokiReady=false;
const timer=setInterval(async()=>{
  if(!lokiReady){try{lokiReady=(await fetch('http://loki:3100/ready',{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(!lokiReady)return;}
  if(exporting||!queue.length)return;exporting=true;
  const batch=queue.splice(0,500);buffered.set(queue.length);
  const streams=[...services].map(service=>({stream:{service,environment:'local-synthetic'},values:batch.filter(row=>row.service===service).map(row=>[row.timestamp,row.line])})).filter(row=>row.values.length);
  try{const response=await fetch('http://loki:3100/loki/api/v1/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({streams}),signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error('Log export rejected');}
  catch{
    const retry=batch.filter(row=>++row.attempts<3),failed=batch.length-retry.length;
    if(queue.length+retry.length<=2048){queue.unshift(...retry);if(retry.length)retries.inc();}
    else dropped.inc({reason:'export_queue_full'},retry.length);
    if(failed)dropped.inc({reason:'loki_export'},failed);
  }finally{exporting=false;buffered.set(queue.length);}
},1000);
const server=createServer(async(req,res)=>{
  if(req.url==='/metrics'){res.writeHead(200,{'content-type':registry.contentType});res.end(await registry.metrics());return;}
  if(['/health','/ready'].includes(req.url??'')){const ready=!closing&&(req.url==='/health'||lokiReady);res.writeHead(ready?200:503,{'content-type':'application/json'});res.end(JSON.stringify({status:ready?'ready':'not_ready'}));return;}
  if(req.url==='/evidence'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({alerts,buffered:queue.length}));return;}
  if(req.url==='/alerts'&&req.method==='POST'){
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536){res.writeHead(413);res.end();return;}}
    try{
      const message=JSON.parse(body);for(const alert of (Array.isArray(message.alerts)?message.alerts:[]).slice(0,20)){
        const event={at:new Date().toISOString(),kind:'alert-delivery',status:alert.status==='resolved'?'resolved':'firing',alertname:String(alert.labels?.alertname??'unknown').slice(0,100),severity:String(alert.labels?.severity??'unknown').slice(0,30),owner:String(alert.labels?.owner??'local-lab-operator').slice(0,60)};
        alerts.push(event);if(alerts.length>100)alerts.shift();received.inc({kind:'alert'});await persist(event);
      }
      res.writeHead(200);res.end('accepted');return;
    }catch{res.writeHead(400);res.end('invalid alert');return;}
  }
  res.writeHead(404);res.end();
});server.listen(5002,'0.0.0.0');
async function shutdown(){if(closing)return;closing=true;clearInterval(timer);clearInterval(diskTimer);udp.close();server.closeIdleConnections();server.close();await disk.flush();process.exit(0);}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
