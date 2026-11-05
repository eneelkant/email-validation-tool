import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfig, isMemoryDbPath } from '../config/env.js';
import type { DomainCheckResult, JobStatus, ValidationResult } from '../types/results.js';
import { getLogger } from '../utils/logger.js';
import { MIGRATIONS } from './migrations.js';

const log = getLogger('db');

let dbInstance: Database.Database | null = null;

export function emailHash(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail.toLowerCase()).digest('hex');
}

/**
 * Open SQLite. Supports file paths and `:memory:` (process-lifetime; free-tier friendly).
 * Retained intentionally: caches + MCP CSV job tracking need a DB during the process life.
 * Auth/tokens are NOT stored here. Persistence across redeploys is NOT required on free tier.
 */
export function getDb(dbPath?: string): Database.Database {
  if (dbInstance && !dbPath) return dbInstance;
  const cfg = getConfig();
  const target = dbPath ?? cfg.dbPath;
  if (!isMemoryDbPath(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new Database(target);
  // WAL is for on-disk DBs; in-memory uses MEMORY journal.
  db.pragma(isMemoryDbPath(target) ? 'journal_mode = MEMORY' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  if (!dbPath) {
    dbInstance = db;
    log.info(
      {
        backend: isMemoryDbPath(target) ? 'memory' : 'file',
        ephemeral: cfg.ephemeralStorage,
      },
      'SQLite ready',
    );
  }
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
      ).run(m.id, m.name, new Date().toISOString());
    });
    tx();
    log.info({ id: m.id, name: m.name }, 'Applied migration');
  }
}

export function getCachedValidation(normalizedEmail: string): ValidationResult | null {
  const cfg = getConfig();
  if (cfg.cacheTtlSeconds === 0) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT result_json FROM validation_cache
       WHERE email_hash = ? AND expires_at > ?`,
    )
    .get(emailHash(normalizedEmail), new Date().toISOString()) as
    | { result_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as ValidationResult;
  } catch {
    return null;
  }
}

export function setCachedValidation(result: ValidationResult): void {
  const cfg = getConfig();
  if (cfg.cacheTtlSeconds === 0) return;
  const db = getDb();
  const expires = new Date(Date.now() + cfg.cacheTtlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO validation_cache (email_hash, normalized_email, result_json, overall_status, checked_at, expires_at)
     VALUES (@email_hash, @normalized_email, @result_json, @overall_status, @checked_at, @expires_at)
     ON CONFLICT(email_hash) DO UPDATE SET
       result_json = excluded.result_json,
       overall_status = excluded.overall_status,
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at`,
  ).run({
    email_hash: emailHash(result.normalized_email),
    normalized_email: result.normalized_email,
    result_json: JSON.stringify(result),
    overall_status: result.overall_status,
    checked_at: result.checked_at,
    expires_at: expires,
  });
}

export function getCachedDomain(domain: string): DomainCheckResult | null {
  const cfg = getConfig();
  if (cfg.domainCacheTtlSeconds === 0) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT result_json FROM domain_cache WHERE domain = ? AND expires_at > ?`,
    )
    .get(domain.toLowerCase(), new Date().toISOString()) as { result_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as DomainCheckResult;
  } catch {
    return null;
  }
}

export function setCachedDomain(result: DomainCheckResult): void {
  const cfg = getConfig();
  if (cfg.domainCacheTtlSeconds === 0) return;
  const db = getDb();
  const expires = new Date(Date.now() + cfg.domainCacheTtlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO domain_cache (domain, result_json, checked_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       result_json = excluded.result_json,
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at`,
  ).run(result.normalized_domain.toLowerCase(), JSON.stringify(result), result.checked_at, expires);
}

export function clearCaches(): { validation: number; domain: number } {
  const db = getDb();
  const v = db.prepare('DELETE FROM validation_cache').run().changes;
  const d = db.prepare('DELETE FROM domain_cache').run().changes;
  return { validation: v, domain: d };
}

export type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  input_path: string | null;
  output_path: string | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested: number;
  meta_json: string | null;
};

export function createJob(input: {
  id: string;
  type: string;
  input_path?: string;
  output_path?: string;
  total?: number;
  meta?: Record<string, unknown>;
}): JobRow {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO validation_jobs
      (id, type, status, input_path, output_path, total, processed, succeeded, failed,
       created_at, updated_at, meta_json)
     VALUES (?, ?, 'queued', ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
  ).run(
    input.id,
    input.type,
    input.input_path ?? null,
    input.output_path ?? null,
    input.total ?? 0,
    now,
    now,
    input.meta ? JSON.stringify(input.meta) : null,
  );
  return getJob(input.id)!;
}

export function getJob(id: string): JobRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM validation_jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
}

export function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus;
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    error_message: string | null;
    started_at: string | null;
    finished_at: string | null;
    cancel_requested: number;
    output_path: string | null;
    meta_json: string | null;
  }>,
): JobRow | null {
  const db = getDb();
  const current = getJob(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE validation_jobs SET
      status = @status,
      total = @total,
      processed = @processed,
      succeeded = @succeeded,
      failed = @failed,
      error_message = @error_message,
      updated_at = @updated_at,
      started_at = @started_at,
      finished_at = @finished_at,
      cancel_requested = @cancel_requested,
      output_path = @output_path,
      meta_json = @meta_json
     WHERE id = @id`,
  ).run(next);
  return getJob(id);
}

export function requestCancelJob(id: string): JobRow | null {
  const job = getJob(id);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  return updateJob(id, { cancel_requested: 1 });
}

export function addJobError(jobId: string, error: string, rowNumber?: number, email?: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO validation_job_errors (job_id, row_number, email, error, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(jobId, rowNumber ?? null, email ?? null, error, new Date().toISOString());
}

export function getStatistics(): Record<string, unknown> {
  const db = getDb();
  const cacheCount = (
    db.prepare('SELECT COUNT(*) AS c FROM validation_cache').get() as { c: number }
  ).c;
  const domainCount = (
    db.prepare('SELECT COUNT(*) AS c FROM domain_cache').get() as { c: number }
  ).c;
  const jobs = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM validation_jobs GROUP BY status`,
    )
    .all() as { status: string; c: number }[];
  const statusBreakdown = db
    .prepare(
      `SELECT overall_status, COUNT(*) AS c FROM validation_cache GROUP BY overall_status`,
    )
    .all() as { overall_status: string; c: number }[];
  return {
    validation_cache_entries: cacheCount,
    domain_cache_entries: domainCount,
    jobs_by_status: Object.fromEntries(jobs.map((j) => [j.status, j.c])),
    cached_results_by_status: Object.fromEntries(
      statusBreakdown.map((s) => [s.overall_status, s.c]),
    ),
  };
}

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}
