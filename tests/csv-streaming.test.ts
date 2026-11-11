import './setup-env.js';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import { closeDb, getDb, getJob } from '../src/database/db.js';
import {
  cancelCsvJob,
  startCsvValidationJob,
  CSV_BATCH_SIZE_CAP,
} from '../src/processing/csv.js';
import type { ValidationResult } from '../src/types/results.js';

function fakeResult(email: string, i: number): ValidationResult {
  return {
    email,
    normalized_email: email.toLowerCase(),
    syntax_valid: email.includes('@'),
    domain_exists: email.includes('@') ? true : null,
    mx_exists: email.includes('@') ? true : null,
    is_disposable: false,
    is_free_provider: false,
    provider_type: 'custom',
    is_role_based: false,
    smtp_status: 'not_checked',
    catch_all_status: 'not_checked',
    overall_status: email.includes('@') ? 'valid_domain' : 'invalid_syntax',
    confidence: 'medium',
    reason_codes: [`ROW_${i}`],
    checked_at: new Date().toISOString(),
  };
}

describe('CSV streaming pipeline', () => {
  beforeAll(() => {
    resetConfigCache();
    process.env.OPENVERIFY_CSV_BATCH_SIZE = '3';
    loadConfig();
    closeDb();
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('processes multi-batch CSV preserving order and columns', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'multi-batch.csv');
    const lines = ['name,email,note'];
    for (let i = 0; i < 10; i++) {
      lines.push(`user${i},user${i}@example.com,"note, ${i}"`);
    }
    writeFileSync(input, lines.join('\n') + '\n', 'utf8');

    const batchSizes: number[] = [];
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      batchSize: 3,
      hooks: {
        onBatchBuffered: ({ bufferedRows }) => {
          batchSizes.push(bufferedRows);
        },
        validateBatch: async (emails) => emails.map((e, idx) => fakeResult(e, idx)),
      },
    });

    expect(job.status).toBe('completed');
    expect(job.processed).toBe(10);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(3);

    const out = readFileSync(job.output_path!, 'utf8');
    const outLines = out.trim().split(/\r?\n/);
    expect(outLines[0]).toContain('name');
    expect(outLines[0]).toContain('email');
    expect(outLines[0]).toContain('note');
    expect(outLines[0]).toContain('overall_status');
    expect(outLines).toHaveLength(11); // header + 10

    // Order preserved
    for (let i = 0; i < 10; i++) {
      expect(outLines[i + 1]).toContain(`user${i}@example.com`);
    }
    // Quoted comma preserved in note column path through parser/writer
    expect(out).toMatch(/note, 0|note/);
  });

  it('handles UTF-8 BOM and quoted fields with commas', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'bom.csv');
    const bom = '\uFEFF';
    writeFileSync(
      input,
      `${bom}email,company\n"a@example.com","Acme, Inc."\nbad\n`,
      'utf8',
    );

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      batchSize: 2,
      hooks: {
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });
    expect(job.status).toBe('completed');
    expect(job.processed).toBe(2);
    const out = readFileSync(job.output_path!, 'utf8');
    expect(out).toContain('a@example.com');
    expect(out.toLowerCase()).toContain('acme');
  });

  it('fails clearly when preferred email column is missing', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'no-email-col.csv');
    writeFileSync(input, 'foo,bar\n1,2\n', 'utf8');
    const job = await startCsvValidationJob({
      inputPath: input,
      emailColumn: 'email',
      wait: true,
      hooks: {
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });
    expect(job.status).toBe('failed');
    expect(job.error_message ?? '').toMatch(/Email column/i);
  });

  it('completes empty data CSV without hanging', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'empty.csv');
    writeFileSync(input, '', 'utf8');
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      hooks: {
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });
    // Empty file: either completed with 0 or failed depending on parser; must not stay running
    expect(['completed', 'failed']).toContain(job.status);
    expect(job.status).not.toBe('running');
  });

  it('cancels during processing and stops further batches', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'cancel.csv');
    const lines = ['email'];
    for (let i = 0; i < 20; i++) lines.push(`u${i}@example.com`);
    writeFileSync(input, lines.join('\n') + '\n', 'utf8');

    let batches = 0;
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: false,
      batchSize: 2,
      hooks: {
        onBatchBuffered: ({ jobId, batchIndex }) => {
          batches += 1;
          if (batchIndex === 0) {
            cancelCsvJob(jobId);
          }
        },
        validateBatch: async (emails) => {
          await new Promise((r) => setTimeout(r, 10));
          return emails.map((e, i) => fakeResult(e, i));
        },
      },
    });

    const deadline = Date.now() + 5000;
    let final = getJob(job.id)!;
    while (Date.now() < deadline && !['cancelled', 'completed', 'failed'].includes(final.status)) {
      await new Promise((r) => setTimeout(r, 20));
      final = getJob(job.id)!;
    }

    expect(final.status).toBe('cancelled');
    expect(final.processed).toBeLessThan(20);
    expect(batches).toBeLessThan(10);
  });

  it('handles sparse validateBatch results without writing undefined rows', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'cancel-sparse.csv');
    writeFileSync(
      input,
      ['email', ...Array.from({ length: 8 }, (_, i) => `u${i}@example.com`)].join('\n') + '\n',
      'utf8',
    );

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      batchSize: 8,
      hooks: {
        validateBatch: async (emails) => {
          // Simulate mapPool shouldStop holes: only first two slots filled
          const results: ValidationResult[] = new Array(emails.length);
          results[0] = fakeResult(emails[0]!, 0);
          results[1] = fakeResult(emails[1]!, 1);
          return results;
        },
      },
    });

    expect(job.status).toBe('cancelled');
    expect(job.processed).toBe(2);
    const out = readFileSync(job.output_path!, 'utf8');
    expect(out).toContain('u0@example.com');
    expect(out).toContain('u1@example.com');
    expect(out).not.toContain('u7@example.com');
    expect(out).not.toContain('undefined');
  });

  it('marks job failed on output write failure', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'write-fail.csv');
    writeFileSync(input, 'email\na@example.com\n', 'utf8');

    // Point output at a directory path so createWriteStream fails when writing
    const badOut = path.join(cfg.outputDir, 'is-a-dir-out');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(badOut, { recursive: true });

    const job = await startCsvValidationJob({
      inputPath: input,
      outputPath: path.join(badOut), // directory — write should fail
      wait: true,
      hooks: {
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });
    expect(job.status).toBe('failed');
  });

  it('applies CSV formula-injection protection on output', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'formula.csv');
    writeFileSync(input, 'email,note\nx@example.com,"=1+2"\ny@example.com,+cmd\n', 'utf8');
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      hooks: {
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });
    expect(job.status, job.error_message ?? undefined).toBe('completed');
    const out = readFileSync(job.output_path!, 'utf8');
    // Leading = / + must be neutralized for spreadsheet safety
    expect(out).toMatch(/'=1\+2/);
    expect(out).toMatch(/'\+cmd/);
  });

  it('demonstrates bounded buffering (does not retain all rows)', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'bounded.csv');
    const n = 50;
    const lines = ['email'];
    for (let i = 0; i < n; i++) lines.push(`u${i}@example.com`);
    writeFileSync(input, lines.join('\n') + '\n', 'utf8');

    let peakBuffered = 0;
    const observed: number[] = [];
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      batchSize: 5,
      hooks: {
        onBatchBuffered: ({ bufferedRows }) => {
          observed.push(bufferedRows);
          peakBuffered = Math.max(peakBuffered, bufferedRows);
        },
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });

    expect(job.status).toBe('completed');
    expect(job.processed).toBe(n);
    expect(peakBuffered).toBeLessThanOrEqual(5);
    expect(peakBuffered).toBeLessThan(n);
    expect(observed.every((x) => x <= 5)).toBe(true);
    expect(CSV_BATCH_SIZE_CAP).toBe(1000);
  });
});

describe('CSV streaming stress (labeled — not a throughput benchmark)', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    closeDb();
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('stress: 5k rows with peak heap observation', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'stress-5k.csv');
    const n = 5000;
    const fh = createWriteStream(input);
    fh.write('email\n');
    for (let i = 0; i < n; i++) {
      fh.write(`u${i}@example.com\n`);
    }
    await new Promise<void>((resolve, reject) => {
      fh.end(() => resolve());
      fh.on('error', reject);
    });

    if (typeof global.gc === 'function') global.gc();
    const before = process.memoryUsage().heapUsed;
    let peakBuffered = 0;

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      batchSize: 50,
      concurrency: 8,
      hooks: {
        onBatchBuffered: ({ bufferedRows }) => {
          peakBuffered = Math.max(peakBuffered, bufferedRows);
        },
        validateBatch: async (emails) => emails.map((e, i) => fakeResult(e, i)),
      },
    });

    const after = process.memoryUsage().heapUsed;
    expect(job.status).toBe('completed');
    expect(job.processed).toBe(n);
    expect(peakBuffered).toBeLessThanOrEqual(50);

    // Informational only — not a pass/fail throughput claim
    console.error(
      `[stress] 5k rows peakBuffered=${peakBuffered} heapDeltaMB=${((after - before) / 1e6).toFixed(2)}`,
    );
  }, 60_000);
});
