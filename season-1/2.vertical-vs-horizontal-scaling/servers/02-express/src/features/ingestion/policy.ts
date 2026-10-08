import {createHash} from 'node:crypto';
import type {CreateProductInput} from '../products/products.types.js';
import {validTraceParent} from '../../observability/trace-policy.ts';
export function idempotencyHash(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw Object.assign(new Error('Idempotency-Key must contain 1-128 letters, digits or . _ : -'), {status:400});
  }
  return createHash('sha256').update(key).digest('hex');
}
export function payloadHash(payload: CreateProductInput): string {
  const {name, description, price, stock, category, imageUrl} = payload;
  return createHash('sha256').update(JSON.stringify({name, description, price, stock, category, imageUrl})).digest('hex');
}
export type IngestionEvent = {version:1; jobId:string; generation:number;traceParent?:string};
export function parseEvent(body: string): IngestionEvent {
  if (Buffer.byteLength(body) > 1024) throw new Error('Invalid ingestion event');
  const event = JSON.parse(body) as IngestionEvent;
  if (!event || event.version !== 1 || typeof event.jobId !== 'string' || !/^[a-f0-9]{24}$/.test(event.jobId) || !Number.isSafeInteger(event.generation) || event.generation < 1) throw new Error('Invalid ingestion event');
  if(event.traceParent!==undefined && !validTraceParent(event.traceParent))throw new Error('Invalid trace context');
  return {version:1, jobId:event.jobId, generation:event.generation,...(event.traceParent?{traceParent:event.traceParent}:{})};
}
