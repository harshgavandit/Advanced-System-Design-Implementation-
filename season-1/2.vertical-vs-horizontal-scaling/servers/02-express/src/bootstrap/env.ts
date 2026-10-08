import dotenv from "dotenv";
import { z } from "zod";

// NODE_ENV=test (set by the caller/pm2 env, before this file runs) loads .env.test
// instead of .env - a persistent, separate DB/port for repeatable perf/functional
// testing without ever touching the main .env or its database.
dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SERVICE_ROLE: z.enum(['api','worker','outbox','migration']).default('api'),
  MONGO_AUTO_INDEX: z.enum(['true','false']).optional(),
  PORT: z.coerce.number().int().positive().default(5002),
  // z.string().url() rejects replica URIs — comma-separated hosts are not a WHATWG URL
  MONGO_URI: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("mongodb://") || v.startsWith("mongodb+srv://"), {
      message: "MONGO_URI must start with mongodb:// or mongodb+srv://",
    })
    .default(
      "mongodb://127.0.0.1:27017/flip-commerce",
    ),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "debug"]).default("info"),
  // z.coerce.boolean() would treat the literal string "false" as truthy - explicit
  // enum + transform avoids that footgun. Opt-in (needs Node 22.15+ for zlib zstd).
  ENABLE_ZSTD: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // 1 = fastest, least CPU. Higher = smaller body, more CPU.
  // gzip uses 1-9, brotli 0-11, zstd 1-19. One number, each codec clamps it.
  COMPRESSION_LEVEL: z.coerce.number().int().min(1).max(19).default(1),
  // no default on either secret - a leaked/forgotten one must fail startup, not silently sign tokens
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_KEY_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).default("v1"),
  JWT_PREVIOUS_KEY_ID: z.string().optional(),
  JWT_ACCESS_PREVIOUS_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_PREVIOUS_SECRET: z.string().min(32).optional(),
  JWT_ISSUER: z.string().min(1).default("scaling-api"),
  JWT_AUDIENCE: z.string().min(1).default("scaling-clients"),
  CORS_ORIGINS: z.string().default(""),
  PUBLIC_CATALOG_CACHE: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  CACHE_NAMESPACE: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('catalog-v1'),
  JWT_ACCESS_EXPIRES_IN: z.string().default("6h"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  MONGO_CIRCUIT_MS: z.coerce.number().int().positive().default(2000),
  MONGO_CIRCUIT_FAILS: z.coerce.number().int().positive().default(3),
  MONGO_SELECT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  MONGO_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  MONGO_POOL_WAIT_MS: z.coerce.number().int().min(50).max(2000).default(500),
}).superRefine((value,ctx)=>{
  if (value.SERVICE_ROLE==='api') {
    for (const key of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET'] as const) {
      if (!value[key]) ctx.addIssue({code:'custom',path:[key],message:'API signing secret is required'});
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  serviceRole: parsed.data.SERVICE_ROLE,
  port: parsed.data.PORT,
  mongoUri: parsed.data.MONGO_URI,
  redisUrl: parsed.data.REDIS_URL,
  logLevel: parsed.data.LOG_LEVEL,
  isProd: parsed.data.NODE_ENV === "production",
  enableZstd: parsed.data.ENABLE_ZSTD,
  compressionLevel: parsed.data.COMPRESSION_LEVEL,
  jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET ?? '',
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET ?? '',
  jwtKeyId: parsed.data.JWT_KEY_ID,
  jwtPreviousKeyId: parsed.data.JWT_PREVIOUS_KEY_ID,
  jwtAccessPreviousSecret: parsed.data.JWT_ACCESS_PREVIOUS_SECRET,
  jwtRefreshPreviousSecret: parsed.data.JWT_REFRESH_PREVIOUS_SECRET,
  jwtIssuer: parsed.data.JWT_ISSUER,
  jwtAudience: parsed.data.JWT_AUDIENCE,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map(v => v.trim()).filter(Boolean),
  publicCatalogCache:parsed.data.PUBLIC_CATALOG_CACHE,
  cacheNamespace:parsed.data.CACHE_NAMESPACE,
  jwtAccessExpiresIn: parsed.data.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: parsed.data.JWT_REFRESH_EXPIRES_IN,
  mongoCircuitMs: parsed.data.MONGO_CIRCUIT_MS,
  mongoCircuitFails: parsed.data.MONGO_CIRCUIT_FAILS,
  mongoSelectTimeoutMs: parsed.data.MONGO_SELECT_TIMEOUT_MS,
  mongoPoolMax: parsed.data.MONGO_POOL_MAX??(parsed.data.SERVICE_ROLE==='worker'?3:parsed.data.SERVICE_ROLE==='outbox'?2:10),
  mongoPoolWaitMs: parsed.data.MONGO_POOL_WAIT_MS,
  mongoAutoIndex: parsed.data.MONGO_AUTO_INDEX ? parsed.data.MONGO_AUTO_INDEX==='true' : parsed.data.NODE_ENV!=='production',
};
