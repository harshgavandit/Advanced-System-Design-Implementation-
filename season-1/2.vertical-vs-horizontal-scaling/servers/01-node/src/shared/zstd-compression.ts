import zlib from "node:zlib";
import Negotiator from "negotiator";
import type { Next, Request, Response } from "../http/types.js";
import { env } from "../bootstrap/env.js";
import { logger } from "../bootstrap/logger.js";
import { isIngestPost } from "../features/products/products.ingest.js";

const ZSTD_SUPPORTED = typeof zlib.createZstdCompress === "function";
const MIN_COMPRESS_BYTES = 1024;
const SERVER_ENCODING_PREFERENCE = ["br", "zstd", "gzip", "identity"];

if (env.enableZstd && !ZSTD_SUPPORTED) {
  logger.warn("ENABLE_ZSTD is true but this Node version has no native zstd support (needs 22.15+) - gzip/brotli only");
}

const zstdActive = env.enableZstd && ZSTD_SUPPORTED;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// Header overrides the env default for this request, so the bench script can
// try levels without a restart. Each codec has its own legal range.
export const compressionLevel = (req: Request): number => {
  const raw = req.get("x-compression-level");
  const n = raw === undefined ? env.compressionLevel : Number(raw);
  if (!Number.isInteger(n)) return env.compressionLevel;
  return n;
};

const openStream = (encoding: string, level: number) => {
  if (encoding === "zstd") {
    return zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: clamp(level, 1, 19) },
    });
  }
  if (encoding === "br") {
    return zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: clamp(level, 0, 11) },
    });
  }
  return zlib.createGzip({ level: clamp(level, 1, 9) });
};

// Negotiates Accept-Encoding and compresses JSON for gzip, brotli, and zstd.
// identity and tiny bodies stay plain. zstd needs ENABLE_ZSTD and Node 22.15+.
export const zstdCompression = (req: Request, res: Response, next: Next): void => {
  if (isIngestPost(req)) {
    next();
    return;
  }

  const offered = zstdActive
    ? SERVER_ENCODING_PREFERENCE
    : SERVER_ENCODING_PREFERENCE.filter((item) => item !== "zstd");
  const chosen = new Negotiator(req).encoding(offered);
  if (!chosen || chosen === "identity") {
    next();
    return;
  }

  const level = compressionLevel(req);
  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    if (res.headersSent) return res;

    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length < MIN_COMPRESS_BYTES) return originalJson(body);

    res.setHeader("Content-Encoding", chosen);
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.method === "HEAD") {
      res.end();
      return res;
    }

    const stream = openStream(chosen, level);
    stream.on("error", (err: Error) => {
      logger.error(`${chosen} compression failed, falling back to uncompressed: ${err.message}`);
      if (!res.headersSent) {
        res.removeHeader("Content-Encoding");
        res.removeHeader("Vary");
        originalJson(body);
      }
    });
    stream.pipe(res);
    stream.end(payload);
    return res;
  };

  next();
};
