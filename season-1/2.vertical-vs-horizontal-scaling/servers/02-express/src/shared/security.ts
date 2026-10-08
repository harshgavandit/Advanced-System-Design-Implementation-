import { createHash, randomUUID } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import type { Request, Response, NextFunction } from "express";
import { httpError } from "./error.js";

const Audit = mongoose.model("SecurityAudit", new Schema({
  actor: { type: String, required: true }, action: { type: String, required: true },
  target: { type: String, required: true }, outcome: { type: String, required: true },
  at: { type: Date, default: Date.now },
}, { versionKey: false }));
// Restricted collection: no public endpoint, credentials, tokens or payloads.
export const audit = async (actor: string, action: string, target: string, outcome: string): Promise<void> => {
  await Audit.create({ actor, action, target, outcome });
};

const Quota = mongoose.model("RequestQuota", new Schema({
  _id: String, count: { type: Number, default: 0 }, expiresAt: { type: Date, expires: 0 },
}));
export async function consumeQuota(key: string, limit: number): Promise<void> {
  const window = Math.floor(Date.now() / 60000);
  const id = createHash("sha256").update(`${key}:${window}`).digest("hex");
  let row;
  try {
    row = await Quota.findOneAndUpdate({ _id: id }, {
      $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * 60000) },
    }, { upsert: true, new: true, maxTimeMS: 2000 });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw httpError(503, "Request quota unavailable");
    row = await Quota.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true, maxTimeMS: 2000 });
  }
  if (!row || row.count > limit) throw httpError(429, "Request limit reached; retry next minute");
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get("x-request-id");
  res.setHeader("X-Request-ID", supplied && /^[A-Za-z0-9_-]{1,64}$/.test(supplied) ? supplied : randomUUID());
  res.setHeader("Cache-Control", "no-store");
  next();
}
export async function authQuota(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.method === "POST" && ["/login", "/signup", "/refresh"].includes(req.path)) {
    // Forwarded headers are untrusted by default; limits are shared in Mongo.
    await consumeQuota(`auth:${req.ip ?? "unknown"}`, 30);
    if (typeof req.body?.email === "string") await consumeQuota(`account:${req.body.email.trim().toLowerCase()}`, 10);
  }
  next();
}
