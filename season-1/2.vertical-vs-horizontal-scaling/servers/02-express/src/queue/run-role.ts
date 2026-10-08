import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {connectDatabase, disconnectDatabase} from '../bootstrap/database.js';
import {env} from '../bootstrap/env.js';
import {logger} from '../bootstrap/logger.js';
import {registerProcessHandlers} from '../bootstrap/shutdown.js';
import {getMongoTopology} from '../bootstrap/mongo-topology.js';
import {initializeIngestion} from '../features/ingestion/store.js';
import {reconcileOutbox, relayOnce} from '../features/ingestion/relay.js';
import {completeEvent} from '../features/ingestion/worker.js';
import {parseEvent} from '../features/ingestion/policy.js';
import {validateQueuePolicy, receiveMessages, acknowledge, deferMessage, closeQueue} from './sqs.js';
import {httpMetrics} from '../observability/metrics.js';
import {connectRedis,disconnectRedis} from '../bootstrap/redis.js';
import {ingestionSpan} from '../observability/trace-context.js';
import {shutdownTracing} from '../observability/tracing.js';
import {ingestionStats} from '../features/ingestion/service.js';
import {collections} from '../features/ingestion/store.js';
import {queueClient,queueUrl} from './sqs.js';
import {GetQueueAttributesCommand} from '@aws-sdk/client-sqs';

export async function runRole(role:'worker'|'outbox'): Promise<void> {
  if (env.serviceRole!==role) throw new Error('Background entrypoint requires matching SERVICE_ROLE');
  registerProcessHandlers();
  await connectDatabase();
  await initializeIngestion();
  if(role==='worker' && env.publicCatalogCache)await connectRedis();
  await validateQueuePolicy();
  const stop=new AbortController();
  let lastTick=Date.now(),healthy=true;
  httpMetrics.setReadiness(()=>!stop.signal.aborted && healthy && getMongoTopology().writes && Date.now()-lastTick<30000);
  if(role==='outbox')httpMetrics.setIngestionProvider(async()=>{
    const result=await ingestionStats();
    const oldest=await collections().outbox.findOne({state:'pending'},{sort:{createdAt:1},projection:{createdAt:1},readPreference:'primary',timeoutMS:2000});
    const attrs=(await queueClient().send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}),{abortSignal:AbortSignal.timeout(2000)})).Attributes;
    const dead=(await queueClient().send(new GetQueueAttributesCommand({QueueUrl:process.env.SQS_DLQ_URL,AttributeNames:['ApproximateNumberOfMessages']}),{abortSignal:AbortSignal.timeout(2000)})).Attributes;
    const db=collections();
    return {...result,oldestOutboxSeconds:oldest?Math.max(0,(Date.now()-oldest.createdAt.getTime())/1000):0,queueVisible:Number(attrs?.ApproximateNumberOfMessages??0),queueInFlight:Number(attrs?.ApproximateNumberOfMessagesNotVisible??0),dlqVisible:Number(dead?.ApproximateNumberOfMessages??0),catalogProducts:await db.products.estimatedDocumentCount({timeoutMS:2000}),syntheticProfiles:await db.users.countDocuments({email:{$regex:'@example\\.invalid$'}},{readPreference:'primary',timeoutMS:2000})};
  });
  const server=createServer((_req,res)=>{
    if (_req.url==='/metrics') { void httpMetrics.render().then(body=>{res.writeHead(200,{'content-type':httpMetrics.contentType});res.end(body);},()=>{res.writeHead(503);res.end();}); return; }
    if (!['/health','/ready'].includes(_req.url??'')) {res.writeHead(404);res.end();return;}
    const ready=!stop.signal.aborted && healthy && getMongoTopology().writes && Date.now()-lastTick<30000;
    res.writeHead(_req.url==='/health'||ready?200:503,{'content-type':'application/json'});
    res.end(JSON.stringify({status:_req.url==='/health'?'ok':ready?'ready':'not_ready',role}));
  });
  server.listen(env.port,'0.0.0.0');
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const shutdown=()=>{
    if (stop.signal.aborted) return;
    stop.abort();
    server.closeIdleConnections();
    server.close();
    deadline=setTimeout(()=>process.exit(1),20000);
    deadline.unref();
  };
  process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
  logger.info({event:'background-started',role});
  try {
    while (!stop.signal.aborted) {
      try {
        if (role==='outbox') {
          await reconcileOutbox();
          const sent=await relayOnce();
          if (!sent) await delay(500,undefined,{signal:stop.signal});
        } else {
          for (const message of await receiveMessages(stop.signal)) {
            if (stop.signal.aborted) break;
            if (!message.ReceiptHandle) continue;
            let event;
            try { event=parseEvent(message.Body??''); }
            catch { logger.warn({event:'invalid-transport-event',role}); continue; }
            const started=process.hrtime.bigint();
            const result=await ingestionSpan('ingestion.process',event.traceParent,()=>completeEvent(event));
            httpMetrics.ingestionAttempt(result,Number(process.hrtime.bigint()-started)/1e9);
            if (result==='ack') await acknowledge(message.ReceiptHandle);
            else if (result==='busy') await deferMessage(message.ReceiptHandle,60);
            // Failed or unknown jobs are deliberately not acknowledged. SQS
            // retries them with bounded receives before isolating them in DLQ.
          }
        }
        healthy=true;
      } catch {
        if (!stop.signal.aborted) {
          healthy=false;
          logger.warn({event:'background-dependency-unavailable',role});
          await delay(2000,undefined,{signal:stop.signal}).catch(()=>{});
        }
      }
      lastTick=Date.now();
    }
  } finally {
    server.close();
    closeQueue();
    await disconnectRedis();
    await disconnectDatabase();
    await shutdownTracing();
    if (deadline) clearTimeout(deadline);
    logger.info({event:'background-stopped',role});
  }
}
