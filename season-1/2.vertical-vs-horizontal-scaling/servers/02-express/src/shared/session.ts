import { createHash } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { httpError } from "./error.js";
import { audit } from "./security.js";

const sessionSchema = new Schema({
  _id: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  refreshHash: { type: String, required: true, select: false },
  revoked: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true, expires: 0 },
});
const Session = mongoose.model("Session", sessionSchema);
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export const createSession = async (userId: string, jti: string, expiresAt: Date, refreshToken: string): Promise<void> => {
  await Session.create({ _id: jti, userId, expiresAt, refreshHash: hash(refreshToken) });
};

// Redis never authorizes. Requests starting after completed majority revocation
// fail closed through a linearizable primary read. Already authorized work may finish.
export const isSessionValid = async (jti: string, userId: string): Promise<boolean> => {
  try {
    return !!await Session.findOne({ _id: jti, userId, revoked: false, expiresAt: { $gt: new Date() } })
      .read("primary").readConcern("linearizable").maxTimeMS(2000).lean();
  } catch { throw httpError(503, "Authorization authority unavailable"); }
};

// One CAS succeeds. Reuse (including a concurrent loser) revokes the family.
// Clients must serialize refresh; a race requires reauthentication.
export const rotateSession = async (jti: string, userId: string, oldToken: string, newToken: string): Promise<void> => {
  const rotated = await Session.findOneAndUpdate(
    { _id: jti, userId, revoked: false, expiresAt: { $gt: new Date() }, refreshHash: hash(oldToken) },
    { $set: { refreshHash: hash(newToken) } }, { new: true, maxTimeMS: 2000 },
  );
  if (rotated) return;
  await revokeSession(jti);
  await audit(userId, "refresh-family-revoked", "session-family", "rejected");
  throw httpError(401, "Refresh token reused or session expired; sign in again");
};
export const revokeSession = async (jti: string): Promise<void> => {
  await Session.updateOne({ _id: jti }, { $set: { revoked: true } }).maxTimeMS(2000);
};
export const revokeAllSessions = async (userId: string): Promise<void> => {
  await Session.updateMany({ userId }, { $set: { revoked: true } }).maxTimeMS(2000);
};
