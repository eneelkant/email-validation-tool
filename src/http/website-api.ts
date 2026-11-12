/**
 * MailSure website API — verify-only HTTP surface for the static frontend.
 * Does NOT expose MCP tools (no cache clear, job admin, disposable updates, etc.).
 * Mounted only when OPENVERIFY_WEBSITE_API_ENABLED=true.
 */
import type { Express, Request, Response, NextFunction, Router } from 'express';
import { Router as createRouter } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getConfig } from '../config/env.js';
import { verifyEmailsBatch } from '../processing/batch.js';
import { validateEmail } from '../validators/orchestrator.js';
import { ensureProviderClassification } from '../validators/result-normalize.js';
import { sanitizeErrorMessage } from '../security/http-guards.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('website-api');

const VerifyBodySchema = z.object({
  email: z.string().min(1).max(320),
});

const BatchBodySchema = z.object({
  emails: z.array(z.string().min(1).max(320)).min(1),
});

function jsonError(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

/**
 * Reject requests when website API is not enabled (defense in depth if routes are mounted incorrectly).
 */
export function requireWebsiteApiEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!getConfig().websiteApiEnabled) {
    jsonError(res, 404, 'not_found');
    return;
  }
  next();
}

export function createWebsiteApiRouter(): Router {
  const router = createRouter();
  const cfg = getConfig();

  router.use(
    rateLimit({
      windowMs: cfg.websiteRateLimitWindowMs,
      max: cfg.websiteRateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  router.post('/verify', async (req: Request, res: Response) => {
    try {
      const parsed = VerifyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        jsonError(res, 400, 'invalid_request', 'Expected JSON body { "email": string }');
        return;
      }
      const result = ensureProviderClassification(await validateEmail(parsed.data.email));
      res.json({ result });
    } catch (err) {
      log.error({ err: sanitizeErrorMessage(err) }, 'verify failed');
      jsonError(res, 500, 'internal_error');
    }
  });

  router.post('/verify/batch', async (req: Request, res: Response) => {
    try {
      const parsed = BatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        jsonError(res, 400, 'invalid_request', 'Expected JSON body { "emails": string[] }');
        return;
      }
      const max = getConfig().websiteMaxBatchSize;
      if (parsed.data.emails.length > max) {
        jsonError(
          res,
          413,
          'batch_too_large',
          `Maximum ${max} emails per request`,
        );
        return;
      }
      const results = (
        await verifyEmailsBatch(parsed.data.emails, {
          concurrency: Math.min(getConfig().concurrency, 4),
        })
      ).map(ensureProviderClassification);
      res.json({ results, count: results.length });
    } catch (err) {
      log.error({ err: sanitizeErrorMessage(err) }, 'batch verify failed');
      jsonError(res, 500, 'internal_error');
    }
  });

  return router;
}

/**
 * Mount MailSure website API routes when enabled.
 * Leaves MCP (/mcp) and existing health endpoints unchanged.
 */
export function mountWebsiteApi(app: Express): void {
  const cfg = getConfig();
  if (!cfg.websiteApiEnabled) {
    log.info('Website API disabled (OPENVERIFY_WEBSITE_API_ENABLED=false)');
    return;
  }

  if (cfg.corsOrigins.length === 0) {
    log.warn(
      'Website API enabled without OPENVERIFY_CORS_ORIGINS — browser clients from other origins will be blocked. Set CORS allowlist for GitHub Pages / your domain.',
    );
  }

  const router = createWebsiteApiRouter();
  app.use('/api', requireWebsiteApiEnabled, router);
  log.info(
    {
      max_batch: cfg.websiteMaxBatchSize,
      rate_limit_max: cfg.websiteRateLimitMax,
      rate_window_ms: cfg.websiteRateLimitWindowMs,
    },
    'MailSure website API mounted at /api/verify and /api/verify/batch',
  );
}
