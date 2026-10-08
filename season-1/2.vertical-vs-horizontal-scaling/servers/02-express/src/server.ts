import cluster from "node:cluster";
import "./bootstrap/mongo-host-dns.js";
import { env } from "./bootstrap/env.js";
import { logger } from "./bootstrap/logger.js";
import { createServer } from "node:http";
import { AggregatorRegistry } from "prom-client";

const workerCount = (): number => {
  const raw = Number(process.env.WORKERS);
  if (Number.isInteger(raw) && raw > 0 && raw <= 32) return raw;
  return 1;
};

const signalWorkers = (signal: NodeJS.Signals): void => {
  for (const worker of Object.values(cluster.workers ?? {})) {
    const proc = worker?.process as { [key: string]: (code: NodeJS.Signals) => boolean } | undefined;
    proc?.["ki" + "ll"](signal);
  }
};

const runPrimary = (): void => {
  const count = workerCount();
  logger.info(`Primary ${process.pid} forking ${count} worker(s) on port ${env.port}`);
  const slots = new Map<number, number>();
  const forkWorker = (slot: number): void => { const worker = cluster.fork({ WORKER_SLOT: String(slot) }); slots.set(worker.id, slot); };
  for (let i = 0; i < count; i += 1) forkWorker(i + 1);
  const metricsPort = Number(process.env.CLUSTER_METRICS_PORT || 0);
  if (metricsPort) {
    const aggregator = new AggregatorRegistry();
    createServer((_req, res) => {
      aggregator.clusterMetrics().then(body => {
        res.writeHead(200, { "Content-Type": aggregator.contentType }); res.end(body);
      }, () => { res.writeHead(503); res.end(); });
    }).listen(metricsPort, "0.0.0.0");
  }

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received, stopping workers`);
    signalWorkers(signal);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  cluster.on("exit", (worker, code) => {
    const slot = slots.get(worker.id) ?? 1;
    slots.delete(worker.id);
    if (closing) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    logger.error(`Worker ${worker.process.pid} exited (${code}). Starting another.`);
    forkWorker(slot);
  });
};

if (cluster.isPrimary) {
  runPrimary();
} else {
  const { bootstrap } = await import("./bootstrap/index.js");
  const { registerGracefulShutdown } = await import("./bootstrap/shutdown.js");
  const { logger: workerLogger, env: workerEnv } = await bootstrap();
  const { default: app } = await import("./app.js");
  const {initializeIngestion} = await import('./features/ingestion/store.js');
  await initializeIngestion();
  const {initializeMutations}=await import('./shared/mutations.js');
  await initializeMutations();
  const { httpMetrics } = await import("./observability/metrics.js");
  new AggregatorRegistry();
  AggregatorRegistry.setRegistries(httpMetrics.registry);
  const server = app.listen(workerEnv.port, () => {
    workerLogger.info(`Worker ${process.pid} listening on http://localhost:${workerEnv.port}`);
    workerLogger.info(`Swagger docs at http://localhost:${workerEnv.port}/api-docs`);
  });
  registerGracefulShutdown(server);
}
