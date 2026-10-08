import {NodeSDK} from '@opentelemetry/sdk-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {BatchSpanProcessor,AlwaysOnSampler,type ReadableSpan,type SpanExporter} from '@opentelemetry/sdk-trace-base';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {HttpInstrumentation} from '@opentelemetry/instrumentation-http';
import {ExpressInstrumentation} from '@opentelemetry/instrumentation-express';
import {MongoDBInstrumentation} from '@opentelemetry/instrumentation-mongodb';
import {safeTraceAttributes} from './trace-policy.js';

let sdk:NodeSDK|undefined;
if(process.env.TRACING_ENABLED==='true'){
  const endpoint=process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if(!endpoint)throw new Error('Tracing requires an explicit OTLP endpoint');
  const url=new URL(endpoint);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['collector','localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Tracing endpoint must be private local HTTP or HTTPS');
  const delegate=new OTLPTraceExporter({url:endpoint,timeoutMillis:5000});
  const sanitize=(span:ReadableSpan):ReadableSpan=>{
    const manual=['ingestion.publish','ingestion.process'].includes(span.name);
    const attributes=safeTraceAttributes(span.attributes);
    return {...span,spanContext:()=>span.spanContext(),name:manual?span.name:attributes['http.route']?`${attributes['http.request.method']??attributes['http.method']??'HTTP'} ${attributes['http.route']}`:attributes['db.operation.name']?`mongodb.${attributes['db.operation.name']}`:'dependency.operation',attributes,status:{code:span.status.code},links:[],events:span.events.filter(event=>event.name==='exception').map(event=>({name:'exception',time:event.time,attributes:{'exception.type':'DependencyError'}}))};
  };
  const exporter:SpanExporter={export(spans,callback){delegate.export(spans.map(sanitize),callback);},shutdown:()=>delegate.shutdown(),forceFlush:()=>delegate.forceFlush()};
  const role=process.env.SERVICE_ROLE??'api';
  const environment=process.env.DEPLOYMENT_ENVIRONMENT??'local-synthetic';
  if(!['local-synthetic','staging','production'].includes(environment))throw Error('Tracing environment must be an explicit known deployment');
  sdk=new NodeSDK({autoDetectResources:false,resourceDetectors:[],resource:resourceFromAttributes({'service.name':role==='worker'?'catalog-worker':role==='outbox'?'outbox-relay':'catalog-api','service.version':process.env.SERVICE_VERSION??'0.4.0','service.instance.id':process.env.HOSTNAME??'local','deployment.environment.name':environment}),sampler:new AlwaysOnSampler(),spanLimits:{attributeCountLimit:32,attributeValueLengthLimit:120,eventCountLimit:2,linkCountLimit:0},spanProcessors:[new BatchSpanProcessor(exporter,{maxQueueSize:2048,maxExportBatchSize:128,scheduledDelayMillis:1000,exportTimeoutMillis:5000})],instrumentations:[new HttpInstrumentation({ignoreIncomingRequestHook:request=>/^\/(health|ready|metrics)(\/|\?|$)/i.test(request.url??''),ignoreOutgoingRequestHook:request=>['collector','tempo','loki'].includes(String(request.hostname??''))}),new ExpressInstrumentation(),new MongoDBInstrumentation({enhancedDatabaseReporting:false,dbStatementSerializer:()=>'',requireParentSpan:true})]});
  sdk.start();
}
export async function shutdownTracing():Promise<void>{await sdk?.shutdown();}
