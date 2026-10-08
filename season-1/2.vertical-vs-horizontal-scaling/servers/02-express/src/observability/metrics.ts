import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import {readFile} from 'node:fs/promises';
import {parseCgroup} from './cgroup.ts';

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

export const routeLabel = (rawPath: string): string | null => {
  let path = (rawPath.split("?", 1)[0] || "/").toLowerCase();
  if(path.length>1 && path.endsWith('/'))path=path.slice(0,-1);
  if (path === "/metrics") return null;
  if (path === "/api-docs" || path.startsWith("/api-docs/")) return "/api-docs/*";
  if (STATIC_ROUTES.has(path)) return path;
  if (/^\/products\/[0-9a-f]{24}$/i.test(path)) return "/products/:id";
  if (/^\/cart\/[0-9a-f]{24}\/quantity$/i.test(path)) return "/cart/:id/quantity";
  if (/^\/cart\/[0-9a-f]{24}$/i.test(path)) return "/cart/:id";
  if (/^\/wishlist\/[0-9a-f]{24}$/i.test(path)) return "/wishlist/:id";
  if(/^\/ingestion-jobs\/[0-9a-f]{24}$/.test(path))return '/ingestion-jobs/:id';
  if(/^\/ingestion-jobs\/[0-9a-f]{24}\/redrive$/.test(path))return '/ingestion-jobs/:id/redrive';
  return "__unmatched__";
};

export const createHttpMetrics = (implementation: string, options: MetricsOptions = {}) => {
  const registry = new Registry();
  const role=process.env.SERVICE_ROLE??'api';
  registry.setDefaultLabels({ implementation, service:role==='worker'?'catalog-worker':role==='outbox'?'outbox-relay':'catalog-api', environment: process.env.NODE_ENV || "development", version: process.env.SERVICE_VERSION || "0.4.0", replica: process.env.HOSTNAME || "local", worker: process.env.WORKER_SLOT || "1" });
  let readiness=()=>false;
  let ingestionProvider:(()=>Promise<Record<string,unknown>>)|undefined;
  let cacheProvider:(()=>Record<string,number>)|undefined;
  new Gauge({name:'app_readiness',help:'Serving process readiness, distinct from scrape reachability',registers:[registry],collect(){this.set(readiness()?1:0);}});
  const cacheOperations=new Gauge({name:'app_catalog_cache_operations_total',help:'Process cumulative cache operations, reset only on process restart',labelNames:['outcome'],registers:[registry],collect(){for(const [outcome,value] of Object.entries(cacheProvider?.()??{}))this.set({outcome},value);}});
  void cacheOperations;
  const ingestionFields=['accepted','queued','flushed','failed','unsent','oldestPendingSeconds','oldestOutboxSeconds','queueVisible','queueInFlight','dlqVisible','catalogProducts','syntheticProfiles'];
  new Gauge({name:'app_ingestion_state',help:'Authoritative global state or transport count; use max, never sum across relay replicas',labelNames:['state'],registers:[registry],async collect(){if(!ingestionProvider)return;try{const values=await ingestionProvider();for(const state of ingestionFields){const value=values[state];if(typeof value==='number' && Number.isFinite(value))this.set({state},value);}}catch{this.reset();}}});
  const attempts=new Histogram({name:'app_ingestion_attempt_seconds',help:'Worker delivery processing time including duplicate decisions',labelNames:['outcome'],buckets:[0.005,0.01,0.05,0.1,0.5,1,5,30],registers:[registry]});
  const completion=new Histogram({name:'app_ingestion_completion_seconds',help:'Durable acceptance to successful commit observed by this worker, excludes duplicate acknowledgements',buckets:[0.1,0.5,1,2,5,10,20,30,60,300],registers:[registry]});
  if(options.collectRuntimeMetrics!==false){
    const cgLabels=['worker'] as const;
    const cgAvailable=new Gauge({name:'container_cgroup_available',help:'Whether real cgroup v2 counters can be read',labelNames:cgLabels,aggregator:'max',registers:[registry],async collect(){
      if(process.platform!=='linux'){this.set({worker:'container'},0);return;}
      try{
        const [cpu,quota,memory,limit]=await Promise.all(['cpu.stat','cpu.max','memory.current','memory.max'].map(file=>readFile('/sys/fs/cgroup/'+file,'utf8')));
        const values=parseCgroup(cpu,quota,memory,limit),labels={worker:'container'};
        cpuUsage.reset();cpuUsage.inc(labels,values.cpuSeconds);throttled.reset();throttled.inc(labels,values.throttledSeconds);throttledPeriods.reset();throttledPeriods.inc(labels,values.throttledPeriods);
        memoryCurrent.set(labels,values.memoryBytes);cpuLimit.reset();memoryLimit.reset();
        if(values.cpuLimit!==undefined)cpuLimit.set(labels,values.cpuLimit);
        if(values.memoryLimit!==undefined)memoryLimit.set(labels,values.memoryLimit);
        this.set(labels,1);
      }catch{this.set({worker:'container'},0);}
    }});
    void cgAvailable;
    const cpuUsage=new Counter({name:'container_cpu_usage_seconds_total',help:'Whole cgroup CPU time including cluster supervisor',labelNames:cgLabels,aggregator:'max',registers:[registry]});
    const throttled=new Counter({name:'container_cpu_throttled_seconds_total',help:'Whole cgroup CPU throttling time',labelNames:cgLabels,aggregator:'max',registers:[registry]});
    const throttledPeriods=new Counter({name:'container_cpu_throttled_periods_total',help:'Throttled CPU periods',labelNames:cgLabels,aggregator:'max',registers:[registry]});
    const memoryCurrent=new Gauge({name:'container_memory_current_bytes',help:'Whole cgroup memory, not process RSS',labelNames:cgLabels,aggregator:'max',registers:[registry]});
    const memoryLimit=new Gauge({name:'container_memory_limit_bytes',help:'Configured cgroup memory limit; absent if unlimited',labelNames:cgLabels,aggregator:'max',registers:[registry]});
    const cpuLimit=new Gauge({name:'container_cpu_limit_cores',help:'Configured cgroup CPU quota; absent if unlimited',labelNames:cgLabels,aggregator:'max',registers:[registry]});
  }

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
  const checkout = new Histogram({ name: "app_mongo_pool_checkout_seconds", help: "Mongo driver checkout latency including connection establishment", buckets: [0.001,0.005,0.01,0.05,0.1,0.5,1,2], registers: [registry] });
  const checkoutFailures = new Counter({ name: "app_mongo_pool_checkout_failures_total", help: "Failed Mongo pool checkouts", registers: [registry] });
  const commands = new Histogram({ name: "app_mongo_command_seconds", help: "Mongo command duration from driver monitoring, excluding pool wait", labelNames: ["command","outcome"], buckets: [0.001,0.005,0.01,0.05,0.1,0.5,1,2], registers: [registry] });
  const commandAllowlist = new Set(["find","insert","update","delete","aggregate","count","getMore","commitTransaction","abortTransaction"]);

  return {
    registry,
    setReadiness(provider:()=>boolean):void{readiness=provider;},
    setCacheProvider(provider:()=>Record<string,number>):void{cacheProvider=provider;},
    setIngestionProvider(provider:()=>Promise<Record<string,unknown>>):void{ingestionProvider=provider;},
    ingestionAttempt(outcome:'ack'|'retry'|'busy',seconds:number):void{attempts.observe({outcome},seconds);},
    ingestionCompletion(seconds:number):void{completion.observe(Math.max(0,seconds));},
    mongoCheckout(durationMS: number, failed = false): void {
      checkout.observe(Math.max(0, durationMS) / 1000);
      if (failed) checkoutFailures.inc();
    },
    mongoCommand(command: string, durationMS: number, failed = false): void {
      commands.observe({ command: commandAllowlist.has(command) ? command : "other", outcome: failed ? "failed" : "succeeded" }, Math.max(0, durationMS) / 1000);
    },
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
            method: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method.toUpperCase())?method.toUpperCase():'OTHER',
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

export const httpMetrics = createHttpMetrics("express");

