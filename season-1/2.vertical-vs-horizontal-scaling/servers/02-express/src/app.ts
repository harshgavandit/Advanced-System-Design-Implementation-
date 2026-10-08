import express from "express";
import zlib from "node:zlib";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import swaggerUi from "swagger-ui-express";
import type { Request, Response, NextFunction } from "express";

import productsRouter from "./features/products/products.router.js";
import cartRouter from "./features/cart/cart.router.js";
import wishlistRouter from "./features/wishlist/wishlist.router.js";
import usersRouter from "./features/users/users.router.js";
import ingestionRouter from "./features/ingestion/router.js";
import { swaggerSpec } from "./docs/swagger.js";
import { notFound, errorHandler, httpError } from "./shared/error.js";
import { requestContext, authQuota } from "./shared/security.js";
import { mongoGate } from "./shared/mongo-gate.js";
import { requestTimeout } from "./shared/timeout.js";
import { zstdCompression } from "./shared/zstd-compression.js";
import { env } from "./bootstrap/env.js";
import { logger } from "./bootstrap/logger.js";
import { redisClient } from "./bootstrap/redis.js";
import { getMongoTopology, isMongoShuttingDown } from "./bootstrap/mongo-topology.js";
import { httpMetrics,routeLabel } from "./observability/metrics.js";
import {ReadBudget} from './shared/read-budget.js';
import {currentTraceId} from './observability/trace-context.js';
import {catalogCacheStats} from './features/products/products.cache.js';
import {sendOperationalLog} from './observability/log-transport.js';

const app = express();

app.use(helmet());
app.use(requestContext);
httpMetrics.setReadiness(()=>{const topology=getMongoTopology();return topology.connected && topology.writes && !isMongoShuttingDown();});
httpMetrics.setCacheProvider(catalogCacheStats);
app.use((req:Request,res:Response,next:NextFunction)=>{
  const observation=httpMetrics.observe(req.method,req.path),started=process.hrtime.bigint(),path=routeLabel(req.path);
  let completed=false;
  const traceId=currentTraceId();if(traceId)res.setHeader('X-Trace-ID',traceId);
  const finish=(status:number)=>{
    if(completed)return;completed=true;
    observation?.finish(status);
    if(observation){
      const event={event:'http-request',method:req.method,route:path,status,durationMs:Number(process.hrtime.bigint()-started)/1e6,requestId:res.getHeader('X-Request-ID'),traceId,service:'catalog-api',version:process.env.SERVICE_VERSION??'0.4.0',replica:process.env.HOSTNAME??'local'};
      logger.info(event);sendOperationalLog(event);
    }
  };
  res.once('finish',()=>finish(res.statusCode));
  res.once('close',()=>{if(!res.writableFinished)finish(499);});
  next();
});
const requestBudget=new ReadBudget(64);
app.use(async(req,res,next)=>{
  if(['/health','/ready','/metrics'].includes(req.path)){next();return;}
  await requestBudget.run(()=>new Promise<void>(done=>{
    res.once('finish',done);res.once('close',done);next();
  }));
});
app.use(cors({ origin(origin, callback) {
  if (!origin || env.corsOrigins.includes(origin)) callback(null, true);
  else callback(httpError(403, "Origin not allowed"));
} }));
app.use(zstdCompression); // zstd first (Node 22.15+ only) - falls through to gzip/brotli below otherwise
app.use(
  compression({
    level: env.compressionLevel,
    brotli: {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: Math.min(env.compressionLevel, 11),
      },
    },
  }),
);
app.use(express.json({ limit: "32kb", strict: true }));
app.use(requestTimeout);

app.get("/health", (req: Request, res: Response) => res.json({ status: "ok" }));

app.get("/metrics", (_req: Request, res: Response, next: NextFunction) => {
  httpMetrics.render().then(
    (body) => res.type(httpMetrics.contentType).send(body),
    next,
  );
});

// Protected traffic requires an available primary. Disposable Redis loss does
// not remove an otherwise healthy API; shutdown stops new traffic immediately.
app.get("/ready", (req: Request, res: Response) => {
  const topology = getMongoTopology();
  const ready = topology.connected && topology.writes && !isMongoShuttingDown();
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    mongo: topology.connected ? "connected" : "disconnected",
    membersUp: `${topology.membersUp}/${topology.membersTotal}`,
    primary: topology.primaryHost,
    writes: topology.writes,
    reads: topology.reads,
    electionPossible: topology.electionPossible,
    redis: redisClient.isReady ? "up" : "down",
  });
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use(mongoGate);
app.use("/users", authQuota, usersRouter);
app.use("/products", productsRouter);
app.use("/cart", cartRouter);
app.use("/wishlist", wishlistRouter);
app.use("/ingestion-jobs", ingestionRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
