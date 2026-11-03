import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { getConfig } from '../config/env.js';
import {
  addJobError,
  createJob,
  getJob,
  requestCancelJob,
  updateJob,
  type JobRow,
} from '../database/db.js';
import { getLogger } from '../utils/logger.js';
import { assertSafeUserPath } from '../security/paths.js';
import { sanitizeCsvCell } from '../security/csv.js';
import { verifyEmailsBatch } from './batch.js';

const log = getLogger('csv');

const EMAIL_HEADERS = new Set([
  'email',
  'e-mail',
  'mail',
  'email_address',
  'emailaddress',
  'address',
]);

export type CsvJobOptions = {
  inputPath: string;
  outputPath?: string;
  emailColumn?: string;
  concurrency?: number;
  wait?: boolean;
};

function detectEmailColumn(headers: string[], preferred?: string): string {
  if (preferred) {
    const found = headers.find((h) => h.toLowerCase() === preferred.toLowerCase());
    if (found) return found;
    throw new Error(`Email column "${preferred}" not found in CSV headers`);
  }
  const found = headers.find((h) => EMAIL_HEADERS.has(h.toLowerCase().trim()));
  if (found) return found;
  // fallback: first column
  if (headers[0]) return headers[0];
  throw new Error('CSV has no headers / columns');
}

export async function startCsvValidationJob(options: CsvJobOptions): Promise<JobRow> {
  const cfg = getConfig();
  const inputPath = assertSafeUserPath(options.inputPath, {
    mustExist: true,
    allowedRoots: [cfg.uploadDir, cfg.dataDir, process.cwd()],
  });

  const st = statSync(inputPath);
  if (st.size > cfg.maxCsvBytes) {
    throw new Error(`CSV exceeds max size (${cfg.maxCsvBytes} bytes)`);
  }

  const jobId = randomUUID();
  const outputPath =
    options.outputPath ??
    path.join(cfg.outputDir, `openverify-${jobId}.csv`);
  const safeOutput = assertSafeUserPath(outputPath, {
    mustExist: false,
    allowedRoots: [cfg.outputDir, cfg.dataDir, process.cwd()],
  });

  const job = createJob({
    id: jobId,
    type: 'csv',
    input_path: inputPath,
    output_path: safeOutput,
    meta: { emailColumn: options.emailColumn ?? null },
  });

  const run = () => processCsvJob(jobId, options.concurrency);
  if (options.wait) {
    await run();
    return getJob(jobId)!;
  }
  void run().catch((err) => {
    log.error({ err, jobId }, 'CSV job crashed');
  });
  return job;
}

async function processCsvJob(jobId: string, concurrency?: number): Promise<void> {
  const cfg = getConfig();
  const job = getJob(jobId);
  if (!job || !job.input_path || !job.output_path) return;

  updateJob(jobId, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

  const rows: Record<string, string>[] = [];
  let headers: string[] = [];

  try {
    const parser = createReadStream(job.input_path).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }),
    );

    for await (const record of parser) {
      const row = record as Record<string, string>;
      if (headers.length === 0) headers = Object.keys(row);
      rows.push(row);
      const current = getJob(jobId);
      if (current?.cancel_requested) {
        updateJob(jobId, {
          status: 'cancelled',
          finished_at: new Date().toISOString(),
          total: rows.length,
        });
        return;
      }
    }

    const meta = job.meta_json ? (JSON.parse(job.meta_json) as { emailColumn?: string }) : {};
    const emailCol = detectEmailColumn(headers, meta.emailColumn ?? undefined);
    updateJob(jobId, { total: rows.length });

    const stringifier = stringify({
      header: true,
      columns: [
        ...headers,
        'normalized_email',
        'syntax_valid',
        'domain_exists',
        'mx_exists',
        'is_disposable',
        'is_role_based',
        'smtp_status',
        'catch_all_status',
        'overall_status',
        'confidence',
        'reason_codes',
        'checked_at',
      ],
      cast: {
        string: (value) => sanitizeCsvCell(String(value ?? '')),
      },
    });
    const out = createWriteStream(job.output_path);
    stringifier.pipe(out);

    const batchSize = Math.min(100, Math.max(1, cfg.concurrency * 4));
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const current = getJob(jobId);
      if (current?.cancel_requested) {
        stringifier.end();
        await finished(out).catch(() => undefined);
        updateJob(jobId, {
          status: 'cancelled',
          processed,
          succeeded,
          failed,
          finished_at: new Date().toISOString(),
        });
        return;
      }

      const slice = rows.slice(i, i + batchSize);
      const emails = slice.map((r) => r[emailCol] ?? '');
      const results = await verifyEmailsBatch(emails, {
        concurrency: concurrency ?? cfg.concurrency,
        shouldStop: () => Boolean(getJob(jobId)?.cancel_requested),
      });

      for (let j = 0; j < slice.length; j++) {
        const row = slice[j]!;
        const result = results[j]!;
        processed++;
        if (result.overall_status === 'temporary_error' || result.overall_status === 'invalid_syntax') {
          // still counted; temporary isn't a hard "fail" for job metrics of write success
        }
        if (result.syntax_valid) succeeded++;
        else failed++;

        stringifier.write({
          ...Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, sanitizeCsvCell(v)]),
          ),
          normalized_email: result.normalized_email,
          syntax_valid: String(result.syntax_valid),
          domain_exists: String(result.domain_exists),
          mx_exists: String(result.mx_exists),
          is_disposable: String(result.is_disposable),
          is_role_based: String(result.is_role_based),
          smtp_status: result.smtp_status,
          catch_all_status: result.catch_all_status,
          overall_status: result.overall_status,
          confidence: result.confidence,
          reason_codes: result.reason_codes.join('|'),
          checked_at: result.checked_at,
        });
      }

      updateJob(jobId, { processed, succeeded, failed });
    }

    stringifier.end();
    await finished(out);

    updateJob(jobId, {
      status: 'completed',
      processed,
      succeeded,
      failed,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addJobError(jobId, message);
    updateJob(jobId, {
      status: 'failed',
      error_message: message,
      finished_at: new Date().toISOString(),
    });
  }
}

export function cancelCsvJob(jobId: string): JobRow | null {
  return requestCancelJob(jobId);
}
