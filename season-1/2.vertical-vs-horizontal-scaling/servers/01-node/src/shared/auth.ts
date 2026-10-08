import type { Next, Request, Response } from "../http/types.js";
import { verifyAccessToken } from "./jwt.js";
import { isSessionValid } from "./session.js";
import { httpError } from "./error.js";

export const requireAuth = async (req: Request, res: Response, next: Next): Promise<void> => {
  void res;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw httpError(401, "Missing bearer token");

  const payload = verifyAccessToken(header.slice("Bearer ".length));

  const valid = await isSessionValid(payload.jti);
  if (!valid) throw httpError(401, "Session has been revoked or expired");

  req.user = { id: payload.sub, jti: payload.jti };
  next();
};
