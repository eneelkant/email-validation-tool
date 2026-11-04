export type Migration = {
  id: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS validation_cache (
  email_hash TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  result_json TEXT NOT NULL,
  overall_status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validation_cache_expires ON validation_cache(expires_at);

CREATE TABLE IF NOT EXISTS domain_cache (
  domain TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_cache_expires ON domain_cache(expires_at);

CREATE TABLE IF NOT EXISTS validation_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_path TEXT,
  output_path TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_jobs_status ON validation_jobs(status);

CREATE TABLE IF NOT EXISTS validation_job_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  row_number INTEGER,
  email TEXT,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES validation_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_errors_job ON validation_job_errors(job_id);

CREATE TABLE IF NOT EXISTS disposable_domains (
  domain TEXT PRIMARY KEY,
  source TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
