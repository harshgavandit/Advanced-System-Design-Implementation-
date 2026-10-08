import { env } from "./bootstrap/env.js";
import { logger } from "./bootstrap/logger.js";
import { connectDatabase } from "./bootstrap/database.js";
import { connectRedis } from "./bootstrap/redis.js";
import { registerGracefulShutdown, registerProcessHandlers } from "./bootstrap/shutdown.js";
import mongoose from "mongoose";

registerProcessHandlers();
// Establish the database before models. One serving process, no supervisor.
await connectDatabase();
await connectRedis();
const { default: app } = await import("./app.js");
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
const {initializeIngestion} = await import('./features/ingestion/store.js');
await initializeIngestion();
const {initializeMutations}=await import('./shared/mutations.js');
await initializeMutations();
const server = app.listen(env.port, "0.0.0.0", () => logger.info({ event: "listening", port: env.port }));
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
registerGracefulShutdown(server);
