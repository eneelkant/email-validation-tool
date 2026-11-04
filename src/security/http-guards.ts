import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/env.js';

/**
 * Host-header validation to mitigate DNS rebinding.
 */
export function validateHostHeader(req: Request, res: Response, next: NextFunction): void {
  const cfg = getConfig();
  const allowed = cfg.allowedHosts;
  if (allowed.length === 0) {
    next();
    return;
  }
  const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (!allowed.map((h) => h.toLowerCase()).includes(host)) {
    res.status(421).json({ error: 'invalid_host' });
    return;
  }
  next();
}

export function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip absolute home paths that might leak environment details
  return msg.replace(/\/home\/[^\s:]+/g, '[path]').slice(0, 500);
}
