import {createHash,randomUUID} from 'node:crypto';
import type {Request,Response} from 'express';
import {redisClient} from '../../bootstrap/redis.js';
import {logger} from '../../bootstrap/logger.js';
import {ReadBudget,cacheRemainingMs} from '../../shared/read-budget.js';
import {httpError} from '../../shared/error.js';
import {env} from '../../bootstrap/env.js';

const enabled=env.publicCatalogCache;
const prefix=env.cacheNamespace;
if(!/^[A-Za-z0-9_-]{1,32}$/.test(prefix))throw new Error('Invalid catalog cache namespace');
const budget=new ReadBudget(8);
const inFlight=new Map<string,Promise<unknown>>();
const stats={hits:0,misses:0,joined:0,loads:0,errors:0,invalidationErrors:0,rejected:0};
export const catalogCacheStats=()=>({...stats});
export async function invalidateCatalog(id?:string):Promise<void>{
  if(!enabled)return;
  if(!redisClient.isReady){stats.invalidationErrors++;return;}
  try{
    const client=redisClient.withAbortSignal(AbortSignal.timeout(200));
    const old=await client.get(`${prefix}:version`);
    if(old && id && /^[a-f0-9]{24}$/i.test(id))await client.del(`${prefix}:${old}:item:${id.toLowerCase()}`);
    await client.set(`${prefix}:version`,randomUUID());
  }catch{stats.invalidationErrors++;logger.warn({event:'catalog-cache-invalidation-unavailable',maxStalenessSeconds:30});}
}
async function namespace():Promise<string>{
  const client=redisClient.withAbortSignal(AbortSignal.timeout(200)),key=`${prefix}:version`;
  const prior=await client.get(key);
  if(prior)return prior;
  await client.set(key,randomUUID(),{condition:'NX'});
  const current=await client.get(key);
  if(!current)throw new Error('Cache namespace unavailable');
  return current;
}
async function loadBounded<T>(loader:()=>Promise<T>):Promise<T>{
  try{return await budget.run(async()=>{stats.loads++;return loader();});}
  catch(error){if((error as {status?:number}).status===503)stats.rejected++;throw error;}
}
export async function readCatalog<T>(req:Request,res:Response,variant:unknown,loader:()=>Promise<T>,cacheable=true):Promise<T>{
  if(!enabled || !cacheable || req.get('authorization') || req.get('cookie'))return loadBounded(loader);
  const signature=typeof variant==='string' && variant.startsWith('item:')?variant:createHash('sha256').update(JSON.stringify(variant)).digest('hex');
  let key:string|undefined;
  if(redisClient.isReady){
    try{
      key=`${prefix}:${await namespace()}:${signature}`;
      const cached=await redisClient.withAbortSignal(AbortSignal.timeout(200)).get(key);
      if(cached){
        const value=JSON.parse(cached) as {expiresAt:number;value:T};
        if(Number.isFinite(value.expiresAt) && value.expiresAt>Date.now()){
          stats.hits++;res.setHeader('X-Catalog-Cache','hit');return value.value;
        }
      }
    }catch{stats.errors++;key=undefined;}
  }
  stats.misses++;
  // This local single-flight remains available when the disposable cache is down.
  const flightKey=key??`offline:${signature}`,pending=inFlight.get(flightKey);
  if(pending){stats.joined++;res.setHeader('X-Catalog-Cache','joined');return await pending as T;}
  if(inFlight.size>=64)throw httpError(503,'Catalog miss capacity is busy');
  const startedAt=Date.now();
  const work=(async()=>{
    const result=await loadBounded(loader),now=Date.now(),remaining=cacheRemainingMs(startedAt,now,Math.random());
    if(key && redisClient.isReady && remaining>0){
      const body=JSON.stringify({expiresAt:now+remaining,value:result});
      if(Buffer.byteLength(body)<=256*1024){
        try{await redisClient.withAbortSignal(AbortSignal.timeout(200)).set(key,body,{expiration:{type:'PX',value:Math.max(1,now+remaining-Date.now())}});}
        catch{stats.errors++;}
      }
    }
    return result;
  })();
  inFlight.set(flightKey,work);
  try{res.setHeader('X-Catalog-Cache','miss');return await work;}
  finally{inFlight.delete(flightKey);}
}
