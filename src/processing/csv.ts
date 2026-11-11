import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
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
import { sanitizeErrorMessage } from '../security/http-guards.js';
import { verifyEmailsBatch } from './batch.js';
import type { ValidationResult } from '../types/results.js';

const log = getLogger('csv');

const EMAIL_HEADERS = new Set([
  'email',
  'e-mail',
  'mail',
  'email_address',
  'emailaddress',
  'address',
]);

const VALIDATION_COLUMNS = [
  'normalized_email',
  'syntax_valid',
  'domain_exists',
  'mx_exists',
  'is_disposable',
  'is_free_provider',
  'provider_type',
  'is_role_based',
  'smtp_status',
  'catch_all_status',
  'overall_status',
  'confidence',
  'reason_codes',
  'checked_at',
] as const;

export type CsvJobOptions = {
  inputPath: string;
  outputPath?: string;
  emailColumn?: string;
  concurrency?: number;
  wait?: boolean;
  /** Test / advanced: override batch size (capped). */
  batchSize?: number;
  hooks?: CsvPipelineHooks;
};

export type CsvPipelineHooks = {
  /** Fired after each in-memory batch is filled (before validation). */
  onBatchBuffered?: (info: {
    jobId: string;
    batchIndex: number;
    batchSize: number;
    /** Rows currently held for this batch only (bounded). */
    bufferedRows: number;
  }) => void;
  /** Optional injectable validator for deterministic tests. */
  validateBatch?: (
    emails: string[],
    options?: { concurrency?: number; shouldStop?: () => boolean },
  ) => Promise<ValidationResult[]>;
};

function detectEmailColumn(headers: string[], preferred?: string): string {
  if (preferred) {
    const found = headers.find((h) => h.toLowerCase() === preferred.toLowerCase());
    if (found) return found;
    throw new Error(`Email column "${preferred}" not found in CSV headers`);
  }
  const found = headers.find((h) => EMAIL_HEADERS.has(h.toLowerCase().trim()));
  if (found) return found;
  if (headers[0]) return headers[0];
  throw new Error('CSV has no headers / columns');
}

function resolveBatchSize(override?: number): number {
  const cfg = getConfig();
  const raw = override ?? cfg.csvBatchSize;
  return Math.max(1, Math.min(1000, raw));
}

async function writeRowWithBackpressure(
  sink: { write: (chunk: unknown) => boolean } & NodeJS.EventEmitter,
  row: Record<string, string>,
): Promise<void> {
  const ok = sink.write(row);
  if (ok) return;
  // Wait for drain, but fail fast if the stream errors (avoid hanging forever).
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      sink.off('drain', onDrain);
      sink.off('error', onError);
    };
    sink.once('drain', onDrain);
    sink.once('error', onError);
  });
}

function closeQuietly(stream: { destroy?: (err?: Error) => void } | null | undefined): void {
  if (!stream?.destroy) return;
  try {
    stream.destroy();
  } catch {
    // ignore
  }
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Free-tier / ephemeral mode: remove finished CSV uploads under OPENVERIFY_UPLOAD_DIR.
 * Keeps MCP output CSV (caller may still read it during this process). Does nothing when
 * ephemeralStorage is false or the input path is outside the upload root.
 */
export function cleanupEphemeralUpload(job: JobRow): boolean {
  const cfg = getConfig();
  if (!cfg.ephemeralStorage) return false;
  if (!job.input_path) return false;
  if (!isPathInsideRoot(job.input_path, cfg.uploadDir)) return false;
  try {
    if (!existsSync(job.input_path)) return false;
    unlinkSync(job.input_path);
    log.info({ jobId: job.id, path: job.input_path }, 'Removed ephemeral CSV upload after job');
    return true;
  } catch (err) {
    log.warn(
      { jobId: job.id, err: sanitizeErrorMessage(err) },
      'Failed to remove ephemeral CSV upload',
    );
    return false;
  }
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
    options.outputPath ?? path.join(cfg.outputDir, `openverify-${jobId}.csv`);
  const safeOutput = assertSafeUserPath(outputPath, {
    mustExist: false,
    allowedRoots: [cfg.outputDir, cfg.dataDir, process.cwd()],
  });

  const job = createJob({
    id: jobId,
    type: 'csv',
    input_path: inputPath,
    output_path: safeOutput,
    meta: {
      emailColumn: options.emailColumn ?? null,
      batchSize: resolveBatchSize(options.batchSize),
    },
  });

  const run = () =>
    processCsvJob(jobId, {
      concurrency: options.concurrency,
      batchSize: options.batchSize,
      hooks: options.hooks,
    });

  if (options.wait) {
    await run();
    return getJob(jobId)!;
  }
  void run().catch((err) => {
    log.error({ err: sanitizeErrorMessage(err), jobId }, 'CSV job crashed');
  });
  return job;
}

/**
 * Bounded-memory CSV pipeline:
 * Read Stream → Parser → Bounded Batch → Validate → Ordered Writer
 * Never accumulates the full input or all results in memory.
 */
export async function processCsvJob(
  jobId: string,
  options: {
    concurrency?: number;
    batchSize?: number;
    hooks?: CsvPipelineHooks;
  } = {},
): Promise<void> {
  const cfg = getConfig();
  const job = getJob(jobId);
  if (!job || !job.input_path || !job.output_path) return;

  updateJob(jobId, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

  const batchSize = resolveBatchSize(options.batchSize);
  const validateBatch = options.hooks?.validateBatch ?? verifyEmailsBatch;

  let input: ReturnType<typeof createReadStream> | null = null;
  let parser: Readable | null = null;
  let writers:
    | {
        stringifier: ReturnType<typeof stringify>;
        out: ReturnType<typeof createWriteStream>;
      }
    | undefined;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let totalSeen = 0;
  let batchIndex = 0;
  let headers: string[] = [];
  let emailCol: string | null = null;
  let cancelled = false;

  const failJob = (err: unknown) => {
    const message = sanitizeErrorMessage(err);
    addJobError(jobId, message);
    updateJob(jobId, {
      status: 'failed',
      error_message: message,
      processed,
      succeeded,
      failed,
      total: totalSeen,
      finished_at: new Date().toISOString(),
    });
  };

  try {
    input = createReadStream(job.input_path);
    parser = input.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }),
    );

    const meta = job.meta_json
      ? (JSON.parse(job.meta_json) as { emailColumn?: string | null })
      : {};

    // Deferred writer setup until first row (need headers).
    const ensureWriter = (rowHeaders: string[]) => {
      if (writers) return writers;
      const stringifier = stringify({
        header: true,
        columns: [...rowHeaders, ...VALIDATION_COLUMNS],
        cast: {
          string: (value) => sanitizeCsvCell(String(value ?? '')),
        },
      });
      const out = createWriteStream(job.output_path!);
      stringifier.pipe(out);
      stringifier.on('error', () => {
        // surfaced via finished()/write failures
      });
      out.on('error', () => {
        // surfaced via finished()
      });
      writers = { stringifier, out };
      return writers;
    };

    const flushBatch = async (batch: Record<string, string>[]) => {
      if (batch.length === 0) return;
      if (!writers) throw new Error('CSV writer not initialized');
      options.hooks?.onBatchBuffered?.({
        jobId,
        batchIndex,
        batchSize: batch.length,
        bufferedRows: batch.length,
      });
      batchIndex += 1;

      if (getJob(jobId)?.cancel_requested) {
        cancelled = true;
        return;
      }

      const emails = batch.map((r) => r[emailCol!] ?? '');
      const results = await validateBatch(emails, {
        concurrency: options.concurrency ?? cfg.concurrency,
        shouldStop: () => Boolean(getJob(jobId)?.cancel_requested),
      });

      // mapPool may leave holes when shouldStop trips mid-batch — never write undefined results.
      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (!result) {
          cancelled = true;
          break;
        }
        const row = batch[j]!;
        processed += 1;
        if (result.syntax_valid) succeeded += 1;
        else failed += 1;

        await writeRowWithBackpressure(writers.stringifier, {
          ...Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, sanitizeCsvCell(String(v ?? ''))]),
          ),
          normalized_email: result.normalized_email,
          syntax_valid: String(result.syntax_valid),
          domain_exists: String(result.domain_exists),
          mx_exists: String(result.mx_exists),
          is_disposable: String(result.is_disposable),
          is_free_provider: String(result.is_free_provider),
          provider_type: String(result.provider_type ?? ''),
          is_role_based: String(result.is_role_based),
          smtp_status: result.smtp_status,
          catch_all_status: result.catch_all_status,
          overall_status: result.overall_status,
          confidence: result.confidence,
          reason_codes: result.reason_codes.join('|'),
          checked_at: result.checked_at,
        });
      }

      if (getJob(jobId)?.cancel_requested) {
        cancelled = true;
      }

      updateJob(jobId, {
        processed,
        succeeded,
        failed,
        total: totalSeen,
      });
    };

    let batch: Record<string, string>[] = [];

    for await (const record of parser) {
      if (getJob(jobId)?.cancel_requested) {
        cancelled = true;
        break;
      }

      const row = record as Record<string, string>;
      if (headers.length === 0) {
        headers = Object.keys(row);
        if (headers.length === 0) {
          throw new Error('CSV has no headers / columns');
        }
        emailCol = detectEmailColumn(headers, meta.emailColumn ?? undefined);
        ensureWriter(headers);
      }

      totalSeen += 1;
      batch.push(row);

      if (batch.length >= batchSize) {
        const toFlush = batch;
        batch = [];
        await flushBatch(toFlush);
        if (cancelled || getJob(jobId)?.cancel_requested) {
          cancelled = true;
          break;
        }
      }
    }

    if (!cancelled && batch.length > 0) {
      if (getJob(jobId)?.cancel_requested) {
        cancelled = true;
      } else {
        await flushBatch(batch);
        batch = [];
        if (getJob(jobId)?.cancel_requested) cancelled = true;
      }
    }
    // Drop any unprocessed remainder on cancel without validating further.
    batch = [];

    if (!emailCol && totalSeen === 0) {
      // Empty CSV (headers-only may still yield zero data rows with some parsers)
      updateJob(jobId, {
        status: 'completed',
        total: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        finished_at: new Date().toISOString(),
      });
      closeQuietly(parser);
      closeQuietly(input);
      const emptyJob = getJob(jobId);
      if (emptyJob) cleanupEphemeralUpload(emptyJob);
      return;
    }

    if (writers) {
      writers.stringifier.end();
      await finished(writers.out);
    }

    if (cancelled) {
      updateJob(jobId, {
        status: 'cancelled',
        processed,
        succeeded,
        failed,
        total: totalSeen,
        finished_at: new Date().toISOString(),
      });
    } else {
      updateJob(jobId, {
        status: 'completed',
        processed,
        succeeded,
        failed,
        total: totalSeen,
        finished_at: new Date().toISOString(),
      });
    }
    const finishedJob = getJob(jobId);
    if (finishedJob) cleanupEphemeralUpload(finishedJob);
  } catch (err) {
    closeQuietly(parser);
    closeQuietly(input);
    closeQuietly(writers?.stringifier);
    closeQuietly(writers?.out);
    failJob(err);
    const failedJob = getJob(jobId);
    if (failedJob) cleanupEphemeralUpload(failedJob);
    return;
  } finally {
    closeQuietly(parser);
    closeQuietly(input);
  }
}

export function cancelCsvJob(jobId: string): JobRow | null {
  return requestCancelJob(jobId);
}

/** Exported for tests — max allowed batch size. */
export const CSV_BATCH_SIZE_CAP = 1000;
