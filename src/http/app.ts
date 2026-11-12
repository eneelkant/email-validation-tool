import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { Express, NextFunction, Request, Response } from 'express';
import { describeDbBackend, getConfig } from '../config/env.js';
import { createOpenVerifyServer } from '../mcp/server.js';
import { assertHttpAuthConfig, requireHttpAuth } from '../security/auth.js';
import { getLogger } from '../utils/logger.js';
import { closeDb, getDb } from '../database/db.js';
import {
  getHealthStatus,
  getRuntimeLifecycle,
  isRuntimeReady,
} from '../runtime/lifecycle.js';
import { getFreeProvidersMeta } from '../validators/free-provider.js';
import { mountWebsiteApi } from './website-api.js';

const log = getLogger('http');

/**
 * Gate DB-dependent routes until runtime init succeeds.
 * Does not apply to /health, /ready, or /version.
 */
export function requireRuntimeReady(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isRuntimeReady()) {
    next();
    return;
  }
  const life = getRuntimeLifecycle();
  res.status(503).json({
    error: 'not_ready',
    status: life.dbStatus === 'failed' ? 'degraded' : 'starting',
    db_status: life.dbStatus,
  });
}

/**
 * createMcpExpressApp `allowedOrigins` expects Origin *hostnames* (port-agnostic),
 * while the `cors` package expects full origins (scheme + host [+ port]).
 * OPENVERIFY_CORS_ORIGINS is documented as full origins for browser CORS;
 * derive hostnames for the MCP DNS-rebinding / Origin guard.
 */
export function corsOriginHostnames(origins: string[]): string[] {
  const hosts = new Set<string>();
  for (const raw of origins) {
    const value = raw.trim();
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
      continue;
    } catch {
      // Fall through — accept bare hostnames already in hostname form.
    }
    const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const hostPart = withoutScheme.split('/')[0]?.split(':')[0]?.trim();
    if (hostPart) hosts.add(hostPart.toLowerCase());
  }
  return [...hosts];
}

export function createHttpApp(): Express {
  const cfg = getConfig();
  // Defense in depth: refuse to build an HTTP app for non-loopback binds without a token,
  // even if a caller bypasses startHttpServer().
  assertHttpAuthConfig(cfg);

  const originHostnames = corsOriginHostnames(cfg.corsOrigins);

  const app = createMcpExpressApp({
    host: cfg.httpHost,
    allowedHosts: cfg.allowedHosts.length > 0 ? cfg.allowedHosts : undefined,
    // Hostnames only — passing full https://… URLs causes 403 "Invalid Origin" for browsers.
    allowedOrigins: originHostnames.length > 0 ? originHostnames : undefined,
    jsonLimit: '1mb',
  });

  if (cfg.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: cfg.corsOrigins,
        exposedHeaders: ['Mcp-Session-Id'],
      }),
    );
  }

  app.use(
    rateLimit({
      windowMs: cfg.rateLimitWindowMs,
      max: cfg.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // Health endpoints — unauthenticated for orchestrators; no sensitive data.
  // /health stays reachable during init (200 starting) and after failure (503 degraded)
  // so platforms like Enzonic can complete cold-start probes without false "ready".
  app.get('/health', (_req: Request, res: Response) => {
    const life = getRuntimeLifecycle();
    const status = getHealthStatus();
    let freeProvidersCount: number | null = null;
    if (life.dbStatus === 'ready') {
      try {
        freeProvidersCount = getFreeProvidersMeta().count;
      } catch {
        freeProvidersCount = null;
      }
    }
    const body = {
      status,
      service: 'mailsure-api',
      product: 'MailSure MCP',
      website_api: cfg.websiteApiEnabled,
      storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
      db: describeDbBackend(cfg.dbPath),
      db_status: life.dbStatus,
      // Ops signal: 0/null after ready ⇒ free-provider dataset failed to load (blank CSV risk).
      free_providers: freeProvidersCount,
      classification_schema: 2,
    };
    if (status === 'degraded') {
      res.status(503).json(body);
      return;
    }
    res.json(body);
  });

  app.get('/ready', (_req: Request, res: Response) => {
    const life = getRuntimeLifecycle();
    if (life.dbStatus !== 'ready') {
      res.status(503).json({
        status: 'not_ready',
        db_status: life.dbStatus,
      });
      return;
    }
    try {
      getDb().prepare('SELECT 1 AS ok').get();
      res.json({
        status: 'ready',
        storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
        db: describeDbBackend(cfg.dbPath),
        db_status: life.dbStatus,
      });
    } catch (err) {
      log.error({ err }, 'Readiness check failed');
      res.status(503).json({ status: 'not_ready', db_status: 'failed' });
    }
  });

  app.get('/version', (_req: Request, res: Response) => {
    const life = getRuntimeLifecycle();
    res.json({
      name: 'mailsure-mcp',
      version: cfg.version,
      product: 'MailSure MCP',
      service: 'mailsure-api',
      website_api: cfg.websiteApiEnabled,
      storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
      db: describeDbBackend(cfg.dbPath),
      db_status: life.dbStatus,
    });
  });

  // MailSure verify-only API (optional). Never mounts MCP admin tools.
  // Gate before /api so verify routes cannot race SQLite init.
  app.use('/api', requireRuntimeReady);
  mountWebsiteApi(app);

  const mcpHandler = createMcpHandler(() => createOpenVerifyServer());
  const nodeHandler = toNodeHandler(mcpHandler);

  app.all(
    cfg.mcpPath,
    requireRuntimeReady,
    requireHttpAuth,
    (req: Request, res: Response) => {
      void nodeHandler(req, res, req.body);
    },
  );

  return app;
}

export async function startHttpServer(): Promise<{ close: () => Promise<void> }> {
  const cfg = getConfig();
  // Fail closed before binding: non-loopback HTTP requires a bearer token.
  assertHttpAuthConfig(cfg);
  const app = createHttpApp();

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(cfg.httpPort, cfg.httpHost, () => resolve(s));
    s.on('error', reject);
  });

  log.info(
    {
      host: cfg.httpHost,
      port: cfg.httpPort,
      path: cfg.mcpPath,
      auth_required: Boolean(cfg.httpAuthToken),
      website_api: cfg.websiteApiEnabled,
      cors_origins: cfg.corsOrigins.length,
    },
    'MailSure MCP HTTP server listening',
  );

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      closeDb();
    },
  };
}
