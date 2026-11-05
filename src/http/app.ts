import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { Express, Request, Response } from 'express';
import { describeDbBackend, getConfig } from '../config/env.js';
import { createOpenVerifyServer } from '../mcp/server.js';
import { assertHttpAuthConfig, requireHttpAuth } from '../security/auth.js';
import { getLogger } from '../utils/logger.js';
import { closeDb, getDb } from '../database/db.js';
import { mountWebsiteApi } from './website-api.js';

const log = getLogger('http');

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
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'mailsure-api',
      product: 'MailSure MCP',
      website_api: cfg.websiteApiEnabled,
      storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
      db: describeDbBackend(cfg.dbPath),
    });
  });

  app.get('/ready', (_req: Request, res: Response) => {
    try {
      getDb().prepare('SELECT 1 AS ok').get();
      res.json({
        status: 'ready',
        storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
        db: describeDbBackend(cfg.dbPath),
      });
    } catch (err) {
      log.error({ err }, 'Readiness check failed');
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.get('/version', (_req: Request, res: Response) => {
    res.json({
      name: 'mailsure-mcp',
      version: cfg.version,
      product: 'MailSure MCP',
      service: 'mailsure-api',
      website_api: cfg.websiteApiEnabled,
      storage: cfg.ephemeralStorage ? 'ephemeral' : 'persistent',
      db: describeDbBackend(cfg.dbPath),
    });
  });

  // MailSure verify-only API (optional). Never mounts MCP admin tools.
  mountWebsiteApi(app);

  const mcpHandler = createMcpHandler(() => createOpenVerifyServer());
  const nodeHandler = toNodeHandler(mcpHandler);

  app.all(cfg.mcpPath, requireHttpAuth, (req: Request, res: Response) => {
    void nodeHandler(req, res, req.body);
  });

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
