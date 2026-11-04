import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { getConfig } from '../config/env.js';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Compare equal-length buffers to reduce timing oracle on length.
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** True when the HTTP bind address is loopback-only (local development). */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (h === '127.0.0.1') return true;
  if (h === '::1' || h === '[::1]') return true;
  return false;
}

/**
 * Fail closed for non-loopback HTTP: require a non-empty bearer token
 * before the listener starts. Does not generate or log token values.
 */
export function assertHttpAuthConfig(
  cfg: Pick<AppConfig, 'httpHost' | 'httpAuthToken'> = getConfig(),
): void {
  if (isLoopbackBindHost(cfg.httpHost)) return;
  if (cfg.httpAuthToken && cfg.httpAuthToken.length > 0) return;
  throw new Error(
    'OPENVERIFY_HTTP_AUTH_TOKEN is required when OPENVERIFY_HTTP_HOST is not loopback ' +
      `(got "${cfg.httpHost}"). Set a strong bearer token, or bind HTTP to 127.0.0.1 / ::1 for local development.`,
  );
}

export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/**
 * When a token is configured, require a matching Bearer token (constant-time).
 * When no token is configured (loopback-only startups), allow the request.
 * External binds without a token are rejected at startup via assertHttpAuthConfig.
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
