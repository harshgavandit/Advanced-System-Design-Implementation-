import { createServer, type Server } from "node:http";
import { logger } from "./bootstrap/logger.js";
import { redisClient } from "./bootstrap/redis.js";
import { getMongoTopology } from "./bootstrap/mongo-topology.js";
import { swaggerSpec } from "./docs/swagger.js";
import { errorHandler, notFound } from "./shared/error.js";
import { mongoGate } from "./shared/mongo-gate.js";
import { requestTimeout } from "./shared/timeout.js";
import { zstdCompression } from "./shared/zstd-compression.js";
import { decorate, findRoute, mountRoutes, readJsonBody, runHandlers } from "./http/router.js";
import type { Handler, Request, Response } from "./http/types.js";
import productsRouter from "./features/products/products.router.js";
import cartRouter from "./features/cart/cart.router.js";
import wishlistRouter from "./features/wishlist/wishlist.router.js";
import usersRouter from "./features/users/users.router.js";
import { httpMetrics } from "./observability/metrics.js";

const routes = [
  ...mountRoutes("/users", usersRouter),
  ...mountRoutes("/products", productsRouter),
  ...mountRoutes("/cart", cartRouter),
  ...mountRoutes("/wishlist", wishlistRouter),
];

const securityHeaders = (res: Response): void => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
};

const corsHeaders = (res: Response): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Encoding, x-compression-level");
};

const accessLog: Handler = (req, res, next) => {
  if (req.method === "POST" && req.path === "/products/ingest") {
    next();
    return;
  }
  res.on("finish", () => logger.http(`${req.method} ${req.originalUrl} ${res.statusCode}`));
  next();
};

const metrics: Handler = (req, res, next) => {
  const observation = httpMetrics.observe(req.method ?? "GET", req.path);
  if (observation) res.on("finish", () => observation.finish(res.statusCode));
  next();
};

const ready = (_req: Request, res: Response): void => {
  const topology = getMongoTopology();
  res.status(topology.reads ? 200 : 503).json({
    status: topology.reads ? "ready" : "not_ready",
    mongo: topology.connected ? "connected" : "disconnected",
    membersUp: `${topology.membersUp}/${topology.membersTotal}`,
    primary: topology.primaryHost,
    writes: topology.writes,
    reads: topology.reads,
    electionPossible: topology.electionPossible,
    redis: redisClient.isReady ? "up" : "down",
  });
};

const earlyRoutes: Handler = (req, res, next) => {
  if (req.method === "GET" && req.path === "/metrics") {
    res.set("Content-Type", httpMetrics.contentType);
    void httpMetrics.render().then((body) => res.end(body), next);
    return;
  }
  if (req.method === "GET" && req.path === "/health") {
    res.json({ status: "ok" });
    return;
  }
  if (req.method === "GET" && req.path === "/ready") {
    ready(req, res);
    return;
  }
  if (req.method === "GET" && req.path === "/api-docs") {
    res.json(swaggerSpec);
    return;
  }
  next();
};

const featureRoutes: Handler = (req, res, next) => {
  const hit = findRoute(routes, req.method ?? "GET", req.path);
  if (!hit) {
    notFound(req, res);
    return;
  }
  req.params = hit.params;
  return runHandlers(hit.route.handlers, req, res).catch((err) => next(err));
};

const pipeline: Handler[] = [zstdCompression, requestTimeout, metrics, accessLog, earlyRoutes, mongoGate, featureRoutes];

export const handle = async (req: Request, res: Response): Promise<void> => {
  securityHeaders(res);
  corsHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  try {
    await readJsonBody(req);
    await runHandlers(pipeline, req, res);
  } catch (err) {
    errorHandler(err as Parameters<typeof errorHandler>[0], req, res, () => {});
  }
};

export const createAppServer = (): Server =>
  createServer((incoming, outgoing) => {
    const { req, res } = decorate(incoming, outgoing);
    void handle(req, res);
  });
