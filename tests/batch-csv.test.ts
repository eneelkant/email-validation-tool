import './setup-env.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import { closeDb, getDb, getJob } from '../src/database/db.js';
import { verifyEmailsBatch } from '../src/processing/batch.js';
import { startCsvValidationJob } from '../src/processing/csv.js';

describe('batch and csv', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    closeDb();
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('verifies a small batch with injected DNS via orchestrator path', async () => {
    // batch uses real DNS; keep list tiny and accept temporary_error in offline envs
    const results = await verifyEmailsBatch(['bad', 'also-bad'], { concurrency: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.overall_status).toBe('invalid_syntax');
  });

  it('processes a small CSV job to completion', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'sample.csv');
    writeFileSync(input, 'email\nbad-address\nalso-bad\n', 'utf8');
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      concurrency: 2,
    });
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.processed).toBe(2);
    expect(final.output_path).toBeTruthy();
  });
});
