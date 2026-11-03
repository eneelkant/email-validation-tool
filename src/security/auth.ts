import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/env.js';
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // still compare to reduce timing oracle on length
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/**
 * If OPENVERIFY_HTTP_AUTH_TOKEN is set, require matching Bearer token.
 * If unset, allow (suitable for local stdio-adjacent localhost use).
 */
export function requireHttpAuth(req: Request, res: Response, next: NextFunction): void {
  const cfg = getConfig();
  const expected = cfg.httpAuthToken;
  if (!expected) {
    next();
    return;
  }
  const token = extractBearerToken(req);
  if (!token || !safeEqual(token, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
