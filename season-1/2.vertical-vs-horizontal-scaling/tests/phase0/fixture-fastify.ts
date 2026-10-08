import mongoose from 'mongoose';
import app from '../../servers/03-fastify/src/app.js';
import { connectDatabase, disconnectDatabase } from '../../servers/03-fastify/src/bootstrap/database.js';
import { flushIngestOnShutdown } from '../../servers/03-fastify/src/features/products/products.ingest.js';
import { logger } from '../../servers/03-fastify/src/bootstrap/logger.js';

if (process.env.MONGO_URI !== 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true') throw new Error('Nonisolated target');
await connectDatabase();
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
await app.listen({ port: 5102, host: '127.0.0.1' });
process.send?.({ ready: true });
process.on('message', async message => {
  if (message !== 'shutdown') return;
  await app.close();
  await flushIngestOnShutdown();
  await disconnectDatabase();
  logger.close();
  process.disconnect?.();
});
