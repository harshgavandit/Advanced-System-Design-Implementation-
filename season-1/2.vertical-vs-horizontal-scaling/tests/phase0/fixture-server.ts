import mongoose from 'mongoose';
import app from '../../servers/02-express/src/app.js';
import { connectDatabase, disconnectDatabase } from '../../servers/02-express/src/bootstrap/database.js';
import { connectRedis, disconnectRedis } from '../../servers/02-express/src/bootstrap/redis.js';
import {initializeIngestion} from '../../servers/02-express/src/features/ingestion/store.js';
import {completeEvent} from '../../servers/02-express/src/features/ingestion/worker.js';
import {initializeMutations} from '../../servers/02-express/src/shared/mutations.js';
import {CartItem} from '../../servers/02-express/src/features/cart/cart.model.js';
import {catalogCacheStats,invalidateCatalog} from '../../servers/02-express/src/features/products/products.cache.js';
import { logger } from '../../servers/02-express/src/bootstrap/logger.js';

// Test-owned lifecycle only. The runner supplies an isolated URI and temporary
// signing keys. Redis is intentionally not connected, exercising Mongo fallback.
if (process.env.MONGO_URI !== 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true') {
  throw new Error('Refusing nonisolated Phase 0 server target');
}
await connectDatabase();
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
await initializeIngestion();
await initializeMutations();
let armDeleteRace=false;
let cacheBaseline=catalogCacheStats();
const originalDelete=CartItem.findOneAndDelete.bind(CartItem);
// Test-only interposition executes one competing native write after a guard miss
// and before deletion. No production handler contains a fault-injection hook.
(CartItem as any).findOneAndDelete=(...args:any[])=>{
  const query=originalDelete(...args as [any]);
  const execute=query.exec.bind(query);
  (query as any).exec=async()=>{
    if(armDeleteRace){armDeleteRace=false;await CartItem.collection.updateOne({_id:new mongoose.Types.ObjectId(String(query.getFilter()._id))},{$inc:{qty:4}},{writeConcern:{w:'majority'}});}
    return execute();
  };
  return query;
};
const server = app.listen(5102, '127.0.0.1', () => process.send?.({ ready: true, port: 5102 }));
server.on('error', err => { console.error(err.message); process.exitCode = 1; });
process.on('message', async message => {
  if(message==='cache-reset'){await invalidateCatalog();cacheBaseline=catalogCacheStats();process.send?.({dependency:message});return;}
  if(message==='cache-stats'){
    const current=catalogCacheStats();
    process.send?.({dependency:message,value:Object.fromEntries(Object.entries(current).map(([key,value])=>[key,value-cacheBaseline[key as keyof typeof cacheBaseline]]))});return;
  }
  if(message==='arm-cart-delete-race'){armDeleteRace=true;process.send?.({dependency:message});return;}
  if (message && typeof message==='object' && 'processIngestion' in message) {
    const jobId=String(message.processIngestion);
    const result=await completeEvent({version:1,jobId,generation:1});
    process.send?.({dependency:`ingestion:${jobId}`,result});
    return;
  }
  if (message === 'redis-online') { await connectRedis(); process.send?.({dependency:message}); return; }
  if (message === 'redis-offline') { await disconnectRedis(); process.send?.({dependency:message}); return; }
  if (message === 'mongo-offline') { await mongoose.disconnect(); process.send?.({dependency:message}); return; }
  if (message === 'resources') process.send?.({ resources: { memory: process.memoryUsage(), cpu: process.cpuUsage() } });
  if (message !== 'shutdown') return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await disconnectRedis();
  await disconnectDatabase();
  logger.close();
  process.disconnect?.();
});
