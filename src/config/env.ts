import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
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
  // When true: treat storage as ephemeral (free-tier / serverless). Enables upload cleanup
  // after CSV jobs and advertises storage=ephemeral on /health. Does not remove SQLite.
  // On read-only deploy roots (e.g. AWS Lambda / Enzonic `/var/task`), remaps writable
  // paths to os.tmpdir() so startup never mkdir's under the package directory.
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
  // Optional remote Reacher SMTP (separate deploy). Names are REACHER_* by design.
  REACHER_ENABLED: bool(false),
  REACHER_API_URL: z.string().optional().default(''),
  // Default 15s; capped at 60s in loadConfig (safe request budget / cold-start headroom).
  REACHER_TIMEOUT: z.coerce.number().int().positive().default(15_000),
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
  /** Remote Reacher SMTP provider (opt-in). When false, behavior matches pre-Reacher MailSure. */
  reacherEnabled: boolean;
  /** Origin only (no path), e.g. https://reacher-render-deploy.onrender.com */
  reacherApiUrl: string;
  reacherTimeoutMs: number;
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

/** Lambda / Enzonic-style package roots — read-only; never mkdir here when ephemeral. */
const READONLY_DEPLOY_ROOTS = ['/var/task', '/var/runtime'] as const;

let ephemeralRootCache: string | undefined;

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

/** True when an absolute path is under a known serverless read-only package root. */
export function isReadonlyDeployPath(absPath: string): boolean {
  if (isMemoryDbPath(absPath)) return false;
  const normalized = path.resolve(absPath);
  return READONLY_DEPLOY_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
  );
}

/**
 * Process-scoped writable root for ephemeral remaps (tmpdir — not /var/task).
 * Stable for the process lifetime so CSV/upload paths stay coherent.
 */
export function getEphemeralRuntimeRoot(): string {
  if (!ephemeralRootCache) {
    ephemeralRootCache = path.join(os.tmpdir(), `mailsure-ephemeral-${process.pid}`);
  }
  return ephemeralRootCache;
}

/** Test helper — clear cached ephemeral root between suites. */
export function resetEphemeralRuntimeRootCache(): void {
  ephemeralRootCache = undefined;
}

/**
 * When ephemeral, relocate paths that would land under read-only deploy roots
 * (e.g. Enzonic/Lambda `/var/task/...`) into os.tmpdir(). Leave Render `/data`,
 * local project dirs, and explicit writable absolute paths unchanged.
 */
export function relocateEphemeralPath(
  resolved: string,
  ephemeral: boolean,
  relativeUnderTemp: string,
): string {
  if (!ephemeral || isMemoryDbPath(resolved)) return resolved;
  if (!isReadonlyDeployPath(resolved)) return resolved;
  return path.join(getEphemeralRuntimeRoot(), relativeUnderTemp);
}

/**
 * Disposable dataset: prefer an existing packaged file even under /var/task (read-only OK).
 * Only relocate when the file is missing and the path is not writable (ephemeral + readonly root).
 */
export function resolveDisposablePath(resolved: string, ephemeral: boolean): string {
  if (!ephemeral || isMemoryDbPath(resolved)) return resolved;
  if (!isReadonlyDeployPath(resolved)) return resolved;
  if (existsSync(resolved)) return resolved;
  return path.join(getEphemeralRuntimeRoot(), 'disposable-domains.txt');
}

function ensureDir(dir: string): void {
  if (isReadonlyDeployPath(dir)) {
    throw new Error(
      `Refusing to create directory under read-only deploy root: ${dir}. ` +
        `Set OPENVERIFY_EPHEMERAL_STORAGE=true (auto-remaps to temp) or point OPENVERIFY_* paths at a writable location.`,
    );
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let cached: AppConfig | undefined;

/**
 * Resolve listen port. Cloud platforms (Render, Enzonic, etc.) inject `PORT`; prefer it when set
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

/**
 * Resolve HTTP bind host. When the platform injects `PORT` and the operator did not
 * set OPENVERIFY_HTTP_HOST, bind `0.0.0.0` (Render / Enzonic / containers). Explicit
 * OPENVERIFY_HTTP_HOST always wins. Local defaults stay 127.0.0.1 when PORT is unset.
 */
export function resolveHttpHost(
  env: NodeJS.ProcessEnv,
  configuredHost: string,
): string {
  const explicit = env.OPENVERIFY_HTTP_HOST;
  if (explicit !== undefined && explicit !== '') {
    return configuredHost;
  }
  const port = env.PORT;
  if (port !== undefined && port !== '') {
    return '0.0.0.0';
  }
  return configuredHost;
}

/**
 * Normalize REACHER_API_URL to an http(s) origin with no path/query/hash.
 * Empty string is allowed when Reacher is disabled.
 */
export function normalizeReacherApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `REACHER_API_URL must be a valid absolute URL (got "${raw.trim()}"). ` +
        'Example: https://reacher-render-deploy.onrender.com',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `REACHER_API_URL must use http or https (got protocol "${url.protocol}").`,
    );
  }
  if (url.username || url.password) {
    throw new Error('REACHER_API_URL must not include credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '') || '';
  if (path && path !== '') {
    throw new Error(
      'REACHER_API_URL must be an origin only (no path). ' +
        'MailSure appends /v1/check_email. Example: https://reacher-render-deploy.onrender.com',
    );
  }
  if (url.search || url.hash) {
    throw new Error('REACHER_API_URL must not include query string or hash.');
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Fail closed when Reacher is enabled without a usable API origin.
 */
export function assertReacherConfig(
  cfg: Pick<AppConfig, 'reacherEnabled' | 'reacherApiUrl'> = getConfig(),
): void {
  if (!cfg.reacherEnabled) return;
  if (cfg.reacherApiUrl) return;
  throw new Error(
    'REACHER_API_URL is required when REACHER_ENABLED=true. ' +
      'Set the Reacher service origin (no path), or set REACHER_ENABLED=false.',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const ephemeralStorage = parsed.OPENVERIFY_EPHEMERAL_STORAGE;

  const rawDataDir = resolvePath(parsed.OPENVERIFY_DATA_DIR);
  const rawDbPath = resolvePath(parsed.OPENVERIFY_DB_PATH);
  const rawDisposable = resolvePath(parsed.OPENVERIFY_DISPOSABLE_PATH);
  const rawUpload = resolvePath(parsed.OPENVERIFY_UPLOAD_DIR);
  const rawOutput = resolvePath(parsed.OPENVERIFY_OUTPUT_DIR);

  const dataDir = relocateEphemeralPath(rawDataDir, ephemeralStorage, 'runtime');
  const dbPath = isMemoryDbPath(rawDbPath)
    ? rawDbPath
    : relocateEphemeralPath(rawDbPath, ephemeralStorage, 'runtime/openverify.sqlite');
  const disposablePath = resolveDisposablePath(rawDisposable, ephemeralStorage);
  const uploadDir = relocateEphemeralPath(rawUpload, ephemeralStorage, 'uploads');
  const outputDir = relocateEphemeralPath(rawOutput, ephemeralStorage, 'runtime/output');

  const config: AppConfig = {
    transport: parsed.OPENVERIFY_TRANSPORT,
    httpHost: resolveHttpHost(env, parsed.OPENVERIFY_HTTP_HOST),
    httpPort: resolveHttpPort(env, parsed.OPENVERIFY_HTTP_PORT),
    mcpPath: parsed.OPENVERIFY_MCP_PATH.startsWith('/')
      ? parsed.OPENVERIFY_MCP_PATH
      : `/${parsed.OPENVERIFY_MCP_PATH}`,
    httpAuthToken: parsed.OPENVERIFY_HTTP_AUTH_TOKEN ?? '',
    allowedHosts: splitCsv(parsed.OPENVERIFY_ALLOWED_HOSTS ?? ''),
    corsOrigins: splitCsv(parsed.OPENVERIFY_CORS_ORIGINS ?? ''),
    dataDir,
    dbPath,
    disposablePath,
    uploadDir,
    outputDir,
    ephemeralStorage,
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
    reacherEnabled: parsed.REACHER_ENABLED,
    reacherApiUrl: normalizeReacherApiUrl(parsed.REACHER_API_URL ?? ''),
    // Clamp into [1000, 60000] — same safe budget as fetchWithSafeTimeout.
    reacherTimeoutMs: Math.min(60_000, Math.max(1_000, parsed.REACHER_TIMEOUT)),
    logLevel: parsed.OPENVERIFY_LOG_LEVEL,
    logEmails: parsed.OPENVERIFY_LOG_EMAILS,
    jobRetentionDays: parsed.OPENVERIFY_JOB_RETENTION_DAYS,
    version: parsed.npm_package_version ?? '0.1.0',
    roleLocalParts: DEFAULT_ROLE_LOCAL_PARTS,
  };

  // Fail closed before serving when Reacher is enabled without an API origin.
  assertReacherConfig(config);

  // Never mkdir under /var/task (guarded inside ensureDir). Ephemeral remaps land in tmpdir.
  for (const dir of [config.dataDir, config.uploadDir, config.outputDir]) {
    ensureDir(dir);
  }
  if (!isMemoryDbPath(config.dbPath)) {
    ensureDir(path.dirname(config.dbPath));
  }
  // Disposable: only ensure parent when we may need to create the seed file.
  // Packaged read-only files under /var/task are used as-is without mkdir.
  if (!existsSync(config.disposablePath) && !isReadonlyDeployPath(config.disposablePath)) {
    ensureDir(path.dirname(config.disposablePath));
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
