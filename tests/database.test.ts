import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import {
  closeDb,
  getDb,
  setCachedValidation,
  getCachedValidation,
  clearCaches,
  createJob,
  getJob,
  getStatistics,
} from '../src/database/db.js';
import type { ValidationResult } from '../src/types/results.js';

describe('database', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    closeDb();
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('migrates and caches validation results', () => {
    const result: ValidationResult = {
      email: 'a@example.com',
      normalized_email: 'a@example.com',
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: false,
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: [],
      checked_at: new Date().toISOString(),
    };
    setCachedValidation(result);
    const cached = getCachedValidation('a@example.com');
    expect(cached?.overall_status).toBe('valid_domain');
    const cleared = clearCaches();
    expect(cleared.validation).toBeGreaterThanOrEqual(1);
  });

  it('tracks jobs', () => {
    const job = createJob({ id: '11111111-1111-4111-8111-111111111111', type: 'csv', total: 10 });
    expect(getJob(job.id)?.status).toBe('queued');
    const stats = getStatistics();
    expect(stats.jobs_by_status).toBeTruthy();
  });
});
