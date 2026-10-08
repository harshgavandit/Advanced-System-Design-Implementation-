import {context,propagation,trace,SpanKind,SpanStatusCode} from '@opentelemetry/api';
import {validTraceParent} from './trace-policy.js';
export function currentTraceParent():string|undefined{
  const carrier:Record<string,string>={};propagation.inject(context.active(),carrier);
  return validTraceParent(carrier.traceparent)?carrier.traceparent:undefined;
}
export function currentTraceId():string|undefined{return trace.getSpan(context.active())?.spanContext().traceId;}
export async function ingestionSpan<T>(name:'ingestion.publish'|'ingestion.process',parent:string|undefined,work:()=>Promise<T>):Promise<T>{
  const parentContext=validTraceParent(parent)?propagation.extract(context.active(),{traceparent:parent}):context.active();
  return trace.getTracer('catalog-lab').startActiveSpan(name,{kind:name==='ingestion.publish'?SpanKind.PRODUCER:SpanKind.CONSUMER,attributes:{'messaging.system':'aws_sqs','messaging.operation.type':name==='ingestion.publish'?'send':'process'}},parentContext,async span=>{
    try{return await work();}catch(error){span.setStatus({code:SpanStatusCode.ERROR});throw error;}finally{span.end();}
  });
}
