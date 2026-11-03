import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getConfig } from '../config/env.js';
import {
  clearCaches,
  getJob,
  getStatistics,
  getCachedDomain,
  setCachedDomain,
} from '../database/db.js';
import { verifyEmailsBatch } from '../processing/batch.js';
import { cancelCsvJob, startCsvValidationJob } from '../processing/csv.js';
import { sanitizeErrorMessage } from '../security/http-guards.js';
import {
  getDisposableMeta,
  loadDisposableDomains,
  updateDisposableDomainsFromText,
  updateDisposableDomainsFromUrl,
} from '../validators/disposable.js';
import { checkDomain, validateEmail } from '../validators/orchestrator.js';
import { getCachedValidation, setCachedValidation } from '../database/db.js';
import { validateSyntax } from '../validators/syntax.js';

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: sanitizeErrorMessage(err) }),
      },
    ],
  };
}

/**
 * Register all OpenVerify MCP tools on a server instance.
 * Call inside a per-request / per-connection factory.
 */
export function registerTools(server: McpServer): void {
  const cfg = getConfig();

  server.registerTool(
    'verify_email',
    {
      title: 'Verify email',
      description:
        'Validate a single email address (syntax, DNS/MX, disposable, role-based). Does not prove mailbox existence. SMTP is off unless enabled in config.',
      inputSchema: z.object({
        email: z.string().describe('Email address to validate'),
        skip_cache: z.boolean().optional().describe('Bypass validation cache'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ email, skip_cache }) => {
      try {
        const syntax = validateSyntax(email);
        if (syntax.syntax_valid && !skip_cache) {
          const cached = getCachedValidation(syntax.normalized_email);
          if (cached) return textResult({ ...cached, cached: true });
        }
        const result = await validateEmail(email);
        if (result.syntax_valid && result.overall_status !== 'temporary_error') {
          setCachedValidation(result);
        }
        return textResult({ ...result, cached: false });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'verify_emails_batch',
    {
      title: 'Verify emails batch',
      description: `Validate up to ${cfg.maxBatchSize} emails concurrently with caching. Returns structured results per address.`,
      inputSchema: z.object({
        emails: z.array(z.string()).min(1).max(cfg.maxBatchSize),
        concurrency: z.number().int().positive().max(64).optional(),
        skip_cache: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ emails, concurrency, skip_cache }) => {
      try {
        if (emails.length > cfg.maxBatchSize) {
          throw new Error(`Batch exceeds max size ${cfg.maxBatchSize}`);
        }
        const results = await verifyEmailsBatch(emails, {
          concurrency,
          skipCache: skip_cache,
        });
        return textResult({ count: results.length, results });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'verify_csv',
    {
      title: 'Verify CSV',
      description:
        'Start (or run) a streaming CSV email validation job. Provide a path under allowed data directories. Returns a job id for progress tracking.',
      inputSchema: z.object({
        input_path: z.string().describe('Path to input CSV'),
        output_path: z.string().optional().describe('Optional output CSV path'),
        email_column: z.string().optional().describe('Column name containing emails'),
        wait: z
          .boolean()
          .optional()
          .describe('If true, wait for job completion (small files only)'),
        concurrency: z.number().int().positive().max(64).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ input_path, output_path, email_column, wait, concurrency }) => {
      try {
        const job = await startCsvValidationJob({
          inputPath: input_path,
          outputPath: output_path,
          emailColumn: email_column,
          wait: wait ?? false,
          concurrency,
        });
        return textResult(job);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'check_domain',
    {
      title: 'Check domain',
      description: 'DNS/MX/A/AAAA lookup and disposable check for a domain (no mailbox probe).',
      inputSchema: z.object({
        domain: z.string(),
        skip_cache: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain, skip_cache }) => {
      try {
        const normalized = domain.trim().toLowerCase();
        if (!skip_cache) {
          const cached = getCachedDomain(normalized);
          if (cached) return textResult({ ...cached, cached: true });
        }
        const result = await checkDomain(domain);
        setCachedDomain(result);
        return textResult({ ...result, cached: false });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_validation_job',
    {
      title: 'Get validation job',
      description: 'Fetch status and progress for a CSV/batch validation job by id.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        const job = getJob(job_id);
        if (!job) return errorResult(new Error('Job not found'));
        return textResult(job);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cancel_validation_job',
    {
      title: 'Cancel validation job',
      description: 'Request cancellation of a running validation job.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        const job = cancelCsvJob(job_id);
        if (!job) return errorResult(new Error('Job not found'));
        return textResult(job);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_statistics',
    {
      title: 'Get statistics',
      description: 'Return cache and job statistics for this OpenVerify instance.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return textResult({
          ...getStatistics(),
          disposable: getDisposableMeta(),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'clear_cache',
    {
      title: 'Clear cache',
      description: 'Clear validation and domain DNS caches stored in SQLite.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return textResult(clearCaches());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'update_disposable_domains',
    {
      title: 'Update disposable domains',
      description:
        'Update the local disposable-domain dataset from inline text and/or an allowlisted HTTPS URL. Not fetched on every validation.',
      inputSchema: z.object({
        domains_text: z
          .string()
          .optional()
          .describe('Newline-separated domains to merge'),
        url: z
          .string()
          .url()
          .optional()
          .describe('Allowlisted HTTPS URL (raw.githubusercontent.com or cdn.jsdelivr.net)'),
        reload_only: z
          .boolean()
          .optional()
          .describe('Only reload the local file without changes'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ domains_text, url, reload_only }) => {
      try {
        if (reload_only) {
          loadDisposableDomains(true);
          return textResult(getDisposableMeta());
        }
        let meta = getDisposableMeta();
        if (domains_text) {
          meta = updateDisposableDomainsFromText(domains_text, 'mcp-tool');
        }
        if (url) {
          meta = await updateDisposableDomainsFromUrl(url);
        }
        if (!domains_text && !url) {
          loadDisposableDomains(true);
          meta = getDisposableMeta();
        }
        return textResult(meta);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
