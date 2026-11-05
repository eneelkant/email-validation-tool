import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined || v === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const EnvSchema = z.object({
  OPENVERIFY_TRANSPORT: z.enum(['stdio', 'http', 'both']).default('stdio'),
  OPENVERIFY_HTTP_HOST: z.string().default('127.0.0.1'),
  OPENVERIFY_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  OPENVERIFY_MCP_PATH: z.string().default('/mcp'),
  OPENVERIFY_HTTP_AUTH_TOKEN: z.string().optional().default(''),
  OPENVERIFY_ALLOWED_HOSTS: z.string().optional().default('127.0.0.1,localhost'),
  OPENVERIFY_CORS_ORIGINS: z.string().optional().default(''),
  OPENVERIFY_DATA_DIR: z.string().default('./data/runtime'),
  // File path, or ":memory:" for process-lifetime SQLite (free-tier / no disk).
  OPENVERIFY_DB_PATH: z.string().default('./data/runtime/openverify.sqlite'),
  OPENVERIFY_DISPOSABLE_PATH: z.string().default('./data/disposable-domains.txt'),
  OPENVERIFY_UPLOAD_DIR: z.string().default('./data/uploads'),
  OPENVERIFY_OUTPUT_DIR: z.string().default('./data/runtime/output'),
  // When true: treat storage as ephemeral (free-tier Render). Enables upload cleanup
  // after CSV jobs and advertises storage=ephemeral on /health. Does not remove SQLite.
  OPENVERIFY_EPHEMERAL_STORAGE: bool(false),
  OPENVERIFY_DNS_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  OPENVERIFY_DNS_SERVERS: z.string().optional().default(''),
  OPENVERIFY_CONCURRENCY: z.coerce.number().int().positive().default(8),
  OPENVERIFY_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(86400),
  OPENVERIFY_DOMAIN_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(86400),
  OPENVERIFY_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  OPENVERIFY_CSV_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),
  OPENVERIFY_MAX_CSV_BYTES: z.coerce.number().int().positive().default(104_857_600),
  OPENVERIFY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  OPENVERIFY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  // MailSure website API (verify-only; off by default — does not expose MCP admin tools)
  OPENVERIFY_WEBSITE_API_ENABLED: bool(false),
  OPENVERIFY_WEBSITE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  OPENVERIFY_WEBSITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  OPENVERIFY_WEBSITE_MAX_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(50),
  OPENVERIFY_SMTP_ENABLED: bool(false),
  OPENVERIFY_SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  OPENVERIFY_SMTP_CONCURRENCY: z.coerce.number().int().positive().default(2),
  OPENVERIFY_CATCH_ALL_ENABLED: bool(false),
  OPENVERIFY_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  OPENVERIFY_LOG_EMAILS: bool(false),
  OPENVERIFY_JOB_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  npm_package_version: z.string().optional(),
});

export type AppConfig = {
  transport: 'stdio' | 'http' | 'both';
  httpHost: string;
  httpPort: number;
  mcpPath: string;
  httpAuthToken: string;
  allowedHosts: string[];
  corsOrigins: string[];
  dataDir: string;
  dbPath: string;
  disposablePath: string;
  uploadDir: string;
  outputDir: string;
  ephemeralStorage: boolean;
  dnsTimeoutMs: number;
  dnsServers: string[];
  concurrency: number;
  cacheTtlSeconds: number;
  domainCacheTtlSeconds: number;
  maxBatchSize: number;
  csvBatchSize: number;
  maxCsvBytes: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  websiteApiEnabled: boolean;
  websiteRateLimitWindowMs: number;
  websiteRateLimitMax: number;
  websiteMaxBatchSize: number;
  smtpEnabled: boolean;
  smtpTimeoutMs: number;
  smtpConcurrency: number;
  catchAllEnabled: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  logEmails: boolean;
  jobRetentionDays: number;
  version: string;
  roleLocalParts: string[];
};

const DEFAULT_ROLE_LOCAL_PARTS = [
  'admin',
  'info',
  'support',
  'sales',
  'contact',
  'help',
  'marketing',
  'billing',
  'webmaster',
];

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True for SQLite in-memory targets that must not be path-resolved or mkdir'd. */
export function isMemoryDbPath(dbPath: string): boolean {
  const v = dbPath.trim();
  return v === ':memory:' || v.startsWith('file:memdb');
}

function resolvePath(p: string): string {
  if (isMemoryDbPath(p)) return p.trim();
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let cached: AppConfig | undefined;

/**
 * Resolve listen port. Cloud platforms (Render, etc.) inject `PORT`; prefer it when set
 * so Docker/`OPENVERIFY_HTTP_PORT` defaults keep working locally without conflicting.
 * Env var names stay OPENVERIFY_* for compatibility — do not rename them.
 */
export function resolveHttpPort(
  env: NodeJS.ProcessEnv,
  openverifyHttpPort: number,
): number {
  const raw = env.PORT;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return openverifyHttpPort;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const config: AppConfig = {
    transport: parsed.OPENVERIFY_TRANSPORT,
    httpHost: parsed.OPENVERIFY_HTTP_HOST,
    httpPort: resolveHttpPort(env, parsed.OPENVERIFY_HTTP_PORT),
    mcpPath: parsed.OPENVERIFY_MCP_PATH.startsWith('/')
      ? parsed.OPENVERIFY_MCP_PATH
      : `/${parsed.OPENVERIFY_MCP_PATH}`,
    httpAuthToken: parsed.OPENVERIFY_HTTP_AUTH_TOKEN ?? '',
    allowedHosts: splitCsv(parsed.OPENVERIFY_ALLOWED_HOSTS ?? ''),
    corsOrigins: splitCsv(parsed.OPENVERIFY_CORS_ORIGINS ?? ''),
    dataDir: resolvePath(parsed.OPENVERIFY_DATA_DIR),
    dbPath: resolvePath(parsed.OPENVERIFY_DB_PATH),
    disposablePath: resolvePath(parsed.OPENVERIFY_DISPOSABLE_PATH),
    uploadDir: resolvePath(parsed.OPENVERIFY_UPLOAD_DIR),
    outputDir: resolvePath(parsed.OPENVERIFY_OUTPUT_DIR),
    ephemeralStorage: parsed.OPENVERIFY_EPHEMERAL_STORAGE,
    dnsTimeoutMs: parsed.OPENVERIFY_DNS_TIMEOUT_MS,
    dnsServers: splitCsv(parsed.OPENVERIFY_DNS_SERVERS ?? ''),
    concurrency: parsed.OPENVERIFY_CONCURRENCY,
    cacheTtlSeconds: parsed.OPENVERIFY_CACHE_TTL_SECONDS,
    domainCacheTtlSeconds: parsed.OPENVERIFY_DOMAIN_CACHE_TTL_SECONDS,
    maxBatchSize: parsed.OPENVERIFY_MAX_BATCH_SIZE,
    csvBatchSize: Math.min(1000, parsed.OPENVERIFY_CSV_BATCH_SIZE),
    maxCsvBytes: parsed.OPENVERIFY_MAX_CSV_BYTES,
    rateLimitWindowMs: parsed.OPENVERIFY_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: parsed.OPENVERIFY_RATE_LIMIT_MAX,
    websiteApiEnabled: parsed.OPENVERIFY_WEBSITE_API_ENABLED,
    websiteRateLimitWindowMs: parsed.OPENVERIFY_WEBSITE_RATE_LIMIT_WINDOW_MS,
    websiteRateLimitMax: parsed.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX,
    websiteMaxBatchSize: Math.min(100, parsed.OPENVERIFY_WEBSITE_MAX_BATCH_SIZE),
    smtpEnabled: parsed.OPENVERIFY_SMTP_ENABLED,
    smtpTimeoutMs: parsed.OPENVERIFY_SMTP_TIMEOUT_MS,
    smtpConcurrency: parsed.OPENVERIFY_SMTP_CONCURRENCY,
    catchAllEnabled: parsed.OPENVERIFY_CATCH_ALL_ENABLED,
    logLevel: parsed.OPENVERIFY_LOG_LEVEL,
    logEmails: parsed.OPENVERIFY_LOG_EMAILS,
    jobRetentionDays: parsed.OPENVERIFY_JOB_RETENTION_DAYS,
    version: parsed.npm_package_version ?? '0.1.0',
    roleLocalParts: DEFAULT_ROLE_LOCAL_PARTS,
  };

  for (const dir of [config.dataDir, config.uploadDir, config.outputDir]) {
    ensureDir(dir);
  }
  if (!isMemoryDbPath(config.dbPath)) {
    ensureDir(path.dirname(config.dbPath));
  }

  cached = config;
  return config;
}

/** Describe DB backend for health/ops (no secrets). */
export function describeDbBackend(dbPath: string = getConfig().dbPath): 'memory' | 'file' {
  return isMemoryDbPath(dbPath) ? 'memory' : 'file';
}

export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}

export function resetConfigCache(): void {
  cached = undefined;
}
