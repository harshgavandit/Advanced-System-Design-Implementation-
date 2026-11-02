import type { RequestHandler } from 'express';

export type AdmissionSnapshot = { active: number; limit: number; highWater: number; accepted: number; rejected: number };

// This bounds live HTTP responses, not database operations after a client abort.
// Query/pool deadlines and the catalog loader budget remain separate safeguards.
export function createAdmission(limit: number, onReject: () => void = () => {}): {
  middleware: RequestHandler; snapshot(): AdmissionSnapshot;
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('Invalid request admission limit');
  let active = 0, highWater = 0, accepted = 0, rejected = 0;
  return {
    snapshot: () => ({ active, limit, highWater, accepted, rejected }),
    middleware(req, res, next) {
      const path = req.path.toLowerCase().replace(/\/$/, '');
      if (['GET', 'HEAD'].includes(req.method) && ['/health', '/ready', '/metrics'].includes(path)) {
        next(); return;
      }
      if (active >= limit) {
        rejected++; onReject();
        res.setHeader('Retry-After', '1');
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({ error: 'Request capacity is busy; retry later', code: 'OVERLOADED' });
        return;
      }
      active++; accepted++; highWater = Math.max(highWater, active);
      let released = false;
      const release = () => {
        if (released) return;
        released = true; active--;
        res.off('finish', release); res.off('close', release);
      };
      res.once('finish', release); res.once('close', release);
      next();
    },
  };
}
