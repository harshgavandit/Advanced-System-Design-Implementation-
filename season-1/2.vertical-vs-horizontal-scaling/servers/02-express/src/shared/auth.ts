import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "./jwt.js";
import { isSessionValid } from "./session.js";
import { httpError } from "./error.js";
import { User } from "../features/users/users.model.js";
import { audit, consumeQuota } from "./security.js";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; jti: string; role: string };
    }
  }
}

// Express 5: async middleware ke rejected promises (throw included) khud errorHandler tak forward ho jaate hain
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  void res;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw httpError(401, "Missing bearer token");

  const payload = verifyAccessToken(header.slice("Bearer ".length));

  let valid, user;
  try {
    // These independent authoritative reads use only the verified token. Run
    // their primary consistency barriers together; neither result authorizes
    // the request until both finish. No quota or mutation starts before that.
    [valid, user] = await Promise.all([
      isSessionValid(payload.jti, payload.sub),
      User.findById(payload.sub).read("primary").readConcern("linearizable").maxTimeMS(2000).lean(),
    ]);
  } catch { throw httpError(503, "Authorization authority unavailable"); }
  if (!valid) throw httpError(401, "Session has been revoked or expired");
  if (!user?.isActive) throw httpError(401, "Account unavailable");
  req.user = { id: payload.sub, jti: payload.jti, role: user.role ?? "user" };
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) await consumeQuota(`write:${payload.sub}`, 120);
  next();
};

export const requireAdmin = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  if (req.user?.role !== "admin") {
    await audit(req.user?.id ?? "anonymous", "product-admin-access", "products", "denied");
    throw httpError(403, "Administrator permission required");
  }
  // Durable admission record before mutation, not a success claim.
  await audit(req.user.id, `${req.method.toLowerCase()}-products`, "products", "authorized");
  next();
};
