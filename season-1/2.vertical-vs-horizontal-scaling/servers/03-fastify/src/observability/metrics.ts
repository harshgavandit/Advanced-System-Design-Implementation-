import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

type MetricsOptions = {
  collectRuntimeMetrics?: boolean;
};

type RequestObservation = {
  finish(statusCode: number): void;
};

const STATIC_ROUTES = new Set([
  "/health",
  "/ready",
  "/users/signup",
  "/users/login",
  "/users/refresh",
  "/users/me",
  "/users/logout",
  "/products",
  "/products/ingest",
  "/products/ingest/stats",
  "/cart",
  "/wishlist",
]);

const routeLabel = (rawPath: string): string | null => {
  const path = rawPath.split("?", 1)[0] || "/";
  if (path === "/metrics") return null;
  if (path === "/api-docs" || path.startsWith("/api-docs/")) return "/api-docs/*";
  if (STATIC_ROUTES.has(path)) return path;
  if (/^\/products\/[0-9a-f]{24}$/i.test(path)) return "/products/:id";
  if (/^\/cart\/[0-9a-f]{24}\/quantity$/i.test(path)) return "/cart/:id/quantity";
  if (/^\/cart\/[0-9a-f]{24}$/i.test(path)) return "/cart/:id";
  if (/^\/wishlist\/[0-9a-f]{24}$/i.test(path)) return "/wishlist/:id";
  return "__unmatched__";
};

export const createHttpMetrics = (implementation: string, options: MetricsOptions = {}) => {
  const registry = new Registry();
  registry.setDefaultLabels({ implementation });

  if (options.collectRuntimeMetrics !== false) {
    collectDefaultMetrics({
      register: registry,
      prefix: "runtime_",
      labels: { implementation },
    });
  }

  const requests = new Counter({
    name: "app_http_requests_total",
    help: "Completed application HTTP requests",
    labelNames: ["implementation", "method", "route", "status_code"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "app_http_request_duration_seconds",
    help: "Application HTTP request duration in seconds",
    labelNames: ["implementation", "method", "route", "status_code"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: "app_http_requests_in_flight",
    help: "Application HTTP requests currently being handled",
    labelNames: ["implementation"] as const,
    registers: [registry],
  });

  return {
    contentType: registry.contentType,
    observe(method: string, path: string): RequestObservation | null {
      const route = routeLabel(path);
      if (route === null) return null;

      const activeLabels = { implementation };
      inFlight.inc(activeLabels);
      const startedAt = process.hrtime.bigint();
      let finished = false;

      return {
        finish(statusCode: number): void {
          if (finished) return;
          finished = true;
          inFlight.dec(activeLabels);
          const labels = {
            implementation,
            method: method.toUpperCase(),
            route,
            status_code: String(statusCode),
          };
          requests.inc(labels);
          duration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1e9);
        },
      };
    },
    render: () => registry.metrics(),
  };
};

export const httpMetrics = createHttpMetrics("fastify");

