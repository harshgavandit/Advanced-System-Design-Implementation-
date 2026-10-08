import mongoose from 'mongoose';
import { createAppServer } from '../../servers/01-node/src/app.js';
import { connectDatabase, disconnectDatabase } from '../../servers/01-node/src/bootstrap/database.js';
import { flushIngestOnShutdown } from '../../servers/01-node/src/features/products/products.ingest.js';
import { logger } from '../../servers/01-node/src/bootstrap/logger.js';

if (process.env.MONGO_URI !== 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true') throw new Error('Nonisolated target');
await connectDatabase();
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
const server = createAppServer();
server.listen(5102, '127.0.0.1', () => process.send?.({ ready: true }));
process.on('message', async message => {
  if (message !== 'shutdown') return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await flushIngestOnShutdown();
  await disconnectDatabase();
  logger.close();
  process.disconnect?.();
});
