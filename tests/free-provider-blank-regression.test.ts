/**
 * Regression: live Enzonic CSV showed blank is_free_provider / provider_type for
 * test@gmail.com while is_disposable=false and overall_status=valid_domain.
 * Root causes covered here:
 * 1) Stale validation_cache JSON omitting free-provider keys (pre-schema rows)
 * 2) Client CSV mapping undefined → blank
 * 3) Majors must classify free via dataset + API / batch serialization
 */
import './setup-env.js';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import {
  resetConfigCache,
  loadConfig,
  getConfig,
} from '../src/config/env.js';
import {
  closeDb,
  getDb,
  getCachedValidation,
} from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import { startCsvValidationJob } from '../src/processing/csv.js';
import { verifyEmailsBatch } from '../src/processing/batch.js';
import type { ValidationResult } from '../src/types/results.js';
import {
  ensureFreeProvidersDatasetFile,
  loadFreeProviders,
  resetFreeProvidersCache,
} from '../src/validators/free-provider.js';
import {
  ensureDisposableDatasetFile,
  loadDisposableDomains,
  resetDisposableCache,
} from '../src/validators/disposable.js';
import {
  ensureProviderClassification,
  missingProviderClassification,
  toPublicValidationResult,
} from '../src/validators/result-normalize.js';
import { validateEmail } from '../src/validators/orchestrator.js';
import type { DnsLookupResult } from '../src/validators/dns.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const FREE_MAJORS = [
  'test@gmail.com',
  'user@outlook.com',
  'a@yahoo.com',
  'b@qq.com',
] as const;

function okDns(domain: string): DnsLookupResult {
  return {
    domain,
    domain_exists: true,
    mx_exists: true,
    a_records: ['1.2.3.4'],
    aaaa_records: [],
    mx_hosts: [`mx.${domain}`],
    error_code: null,
    temporary: false,
  };
}

/** Pre-PR#13 shaped result (no free-provider keys) — matches live Enzonic omission. */
function legacyGmailResult(): ValidationResult {
  return {
    email: 'test@gmail.com',
    normalized_email: 'test@gmail.com',
    syntax_valid: true,
    domain_exists: true,
    mx_exists: true,
    is_disposable: false,
    // Intentionally omit is_free_provider + provider_type (pre-schema cache).
    is_role_based: false,
    smtp_status: 'not_checked',
    catch_all_status: 'not_checked',
    overall_status: 'valid_domain',
    confidence: 'medium',
    reason_codes: ['SMTP_DISABLED', 'CATCH_ALL_DISABLED'],
    checked_at: '2026-11-12T00:00:00.000Z',
    mx_hosts: ['mx.gmail.com'],
  } as ValidationResult;
}

async function listen(app: ReturnType<typeof createHttpApp>): Promise<{
  server: Server;
  base: string;
}> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe('free-provider blank-field regression', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    closeDb();
    getDb();
    resetFreeProvidersCache();
    resetDisposableCache();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  beforeEach(() => {
    resetFreeProvidersCache();
    resetDisposableCache();
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  afterAll(() => {
    closeDb();
  });

  it('detects missing provider classification on legacy payloads', () => {
    const legacy = legacyGmailResult();
    expect(missingProviderClassification(legacy)).toBe(true);
    expect('is_free_provider' in legacy).toBe(false);
    expect('provider_type' in legacy).toBe(false);
  });

  it('rehydrates legacy gmail payload to free provider fields', () => {
    const fixed = ensureProviderClassification(legacyGmailResult());
    expect(fixed.is_disposable).toBe(false);
    expect(fixed.is_free_provider).toBe(true);
    expect(fixed.provider_type).toBe('free');
    expect(fixed.overall_status).toBe('valid_domain');
    expect(fixed.reason_codes).toContain('FREE_EMAIL_PROVIDER');
  });

  it('classifies gmail/outlook/yahoo/qq as free via orchestrator', async () => {
    for (const email of FREE_MAJORS) {
      const domain = email.split('@')[1]!;
      const r = await validateEmail(email, {
        dnsLookup: async () => okDns(domain),
      });
      expect(r.is_free_provider, email).toBe(true);
      expect(r.provider_type, email).toBe('free');
      expect(r.is_disposable, email).toBe(false);
      expect(r.overall_status, email).toBe('valid_domain');
      expect(r.reason_codes, email).toContain('FREE_EMAIL_PROVIDER');
    }
  });

  it('cache read rehydrates stale rows missing free-provider keys', () => {
    const legacy = legacyGmailResult();
    // Bypass setCachedValidation shape — write raw pre-schema JSON.
    const db = getDb();
    const expires = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(
      `INSERT INTO validation_cache (email_hash, normalized_email, result_json, overall_status, checked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_hash) DO UPDATE SET
         result_json = excluded.result_json,
         overall_status = excluded.overall_status,
         checked_at = excluded.checked_at,
         expires_at = excluded.expires_at`,
    ).run(
      createHash('sha256').update('test@gmail.com').digest('hex'),
      'test@gmail.com',
      JSON.stringify(legacy),
      'valid_domain',
      legacy.checked_at,
      expires,
    );

    const cached = getCachedValidation('test@gmail.com');
    expect(cached).not.toBeNull();
    expect(cached!.is_free_provider).toBe(true);
    expect(cached!.provider_type).toBe('free');
    expect(cached!.is_disposable).toBe(false);
  });

  it('batch path returns free fields for majors (not blank)', async () => {
    const results = await verifyEmailsBatch([...FREE_MAJORS], {
      skipCache: true,
      concurrency: 2,
    });
    // DNS is live here — may fail in offline CI; assert only classification fields when domain ok.
    for (const r of results) {
      expect(r).toHaveProperty('is_free_provider');
      expect(r).toHaveProperty('provider_type');
      if (r.overall_status === 'valid_domain' || r.overall_status === 'risky') {
        expect(r.is_free_provider).toBe(true);
        expect(r.provider_type).toBe('free');
      }
    }
  });

  it('server CSV never emits blank free fields for legacy validateBatch results', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'free-blank-regression.csv');
    writeFileSync(input, 'email\ntest@gmail.com\n', 'utf8');

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      concurrency: 1,
      hooks: {
        validateBatch: async () => [legacyGmailResult()],
      },
    });
    expect(job.status).toBe('completed');
    const out = readFileSync(job.output_path!, 'utf8');
    const lines = out.trim().split(/\r?\n/);
    expect(lines[0]).toContain('is_free_provider');
    expect(lines[0]).toContain('provider_type');
    const cols = lines[0]!.split(',');
    const freeIdx = cols.indexOf('is_free_provider');
    const typeIdx = cols.indexOf('provider_type');
    const row = lines[1]!.split(',');
    expect(row[freeIdx]).toBe('true');
    expect(row[typeIdx]).toBe('free');
  });
});

describe('website API serializes free-provider fields for majors', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_WEBSITE_MAX_BATCH_SIZE = '10';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX = '100';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    resetFreeProvidersCache();
    resetDisposableCache();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    loadFreeProviders(true);
    loadDisposableDomains(true);
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
  });

  it('health advertises classification_schema 3 and free_providers > 0', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      free_providers: number | null;
      classification_schema: number;
      db_status: string;
    };
    expect(body.db_status).toBe('ready');
    expect(body.classification_schema).toBe(3);
    expect(typeof body.free_providers).toBe('number');
    expect(body.free_providers!).toBeGreaterThan(0);
  });

  it('POST /api/verify returns is_free_provider + provider_type for gmail', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'test@gmail.com' }),
    });
    expect(res.status).toBe(200);
    const rawText = await res.text();
    const body = JSON.parse(rawText) as { result: ValidationResult };
    // Raw JSON must include the key (live Enzonic currently omits it).
    expect(rawText).toContain('"is_free_provider"');
    expect(body.result).toHaveProperty('is_free_provider');
    expect(body.result).toHaveProperty('provider_type');
    expect(typeof body.result.is_free_provider).toBe('boolean');
    // Live DNS — only assert free when domain path succeeded.
    if (body.result.overall_status === 'valid_domain') {
      expect(body.result.is_free_provider).toBe(true);
      expect(body.result.provider_type).toBe('free');
      expect(body.result.is_disposable).toBe(false);
      expect(body.result.reason_codes).toContain('FREE_EMAIL_PROVIDER');
    }
  });

  it('POST /api/verify/batch returns free fields for gmail/outlook/yahoo/qq', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: [...FREE_MAJORS] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: ValidationResult[]; count: number };
    expect(body.count).toBe(4);
    for (const r of body.results) {
      expect(r).toHaveProperty('is_free_provider');
      expect(r).toHaveProperty('provider_type');
      expect(typeof r.is_free_provider).toBe('boolean');
      expect(r.is_free_provider).not.toBeUndefined();
      expect(r.provider_type).not.toBeUndefined();
      if (r.overall_status === 'valid_domain' || r.overall_status === 'risky') {
        expect(r.is_free_provider).toBe(true);
        expect(r.provider_type).toBe('free');
      }
    }
  });

  it('POST /api/verify custom domain emits boolean is_free_provider=false', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'hello@example.com' }),
    });
    expect(res.status).toBe(200);
    const rawText = await res.text();
    expect(rawText).toContain('"is_free_provider"');
    const body = JSON.parse(rawText) as { result: ValidationResult };
    expect(typeof body.result.is_free_provider).toBe('boolean');
    if (body.result.syntax_valid) {
      expect(body.result.is_free_provider).toBe(false);
      expect(body.result.provider_type).toBe('custom');
    }
  });
});

describe('toPublicValidationResult wire contract', () => {
  beforeAll(() => {
    process.env.OPENVERIFY_DB_PATH = ':memory:';
    process.env.OPENVERIFY_CACHE_TTL_SECONDS = '3600';
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'true';
    resetConfigCache();
    loadConfig();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    resetFreeProvidersCache();
    resetDisposableCache();
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  it('JSON round-trip always includes boolean is_free_provider for legacy gmail', () => {
    const publicResult = toPublicValidationResult(legacyGmailResult());
    const raw = JSON.stringify(publicResult);
    const parsed = JSON.parse(raw) as ValidationResult;
    expect(raw).toContain('"is_free_provider":true');
    expect(raw).toContain('"provider_type":"free"');
    expect(typeof parsed.is_free_provider).toBe('boolean');
    expect(parsed.is_free_provider).toBe(true);
    expect(parsed.provider_type).toBe('free');
  });

  it('JSON round-trip emits boolean false for custom domain legacy shape', () => {
    const legacy = {
      ...legacyGmailResult(),
      email: 'a@custom-domain.example',
      normalized_email: 'a@custom-domain.example',
    } as ValidationResult;
    delete (legacy as { is_free_provider?: boolean }).is_free_provider;
    delete (legacy as { provider_type?: string }).provider_type;
    const publicResult = toPublicValidationResult(legacy);
    const raw = JSON.stringify(publicResult);
    expect(raw).toContain('"is_free_provider":false');
    expect(raw).toContain('"provider_type":"custom"');
    expect(publicResult.is_free_provider).toBe(false);
  });

  it('invalid syntax keeps null is_free_provider (key present)', () => {
    const invalid: ValidationResult = {
      email: 'not-an-email',
      normalized_email: 'not-an-email',
      syntax_valid: false,
      domain_exists: null,
      mx_exists: null,
      is_disposable: null,
      is_free_provider: null,
      provider_type: null,
      is_role_based: null,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'invalid_syntax',
      confidence: 'high',
      reason_codes: ['INVALID_SYNTAX'],
      checked_at: '2026-11-12T00:00:00.000Z',
    };
    const publicResult = toPublicValidationResult(invalid);
    const raw = JSON.stringify(publicResult);
    expect(raw).toContain('"is_free_provider":null');
    expect(publicResult.is_free_provider).toBeNull();
  });
});

describe('frontend rejects API payloads missing free-provider fields', () => {
  it('assertValidationResult requires is_free_provider and provider_type', () => {
    const window = new Window({ url: 'https://eneelkant.github.io/' });
    const root = path.resolve('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'https://example.test' });
    window.eval(readFileSync(path.join(root, 'public/js/verify.js'), 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).MailSureApi;
    const incomplete = {
      email: 'test@gmail.com',
      normalized_email: 'test@gmail.com',
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: false,
      // missing is_free_provider + provider_type (live Enzonic shape)
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: [],
      checked_at: '2026-11-12T00:00:00.000Z',
    };
    expect(() => api.assertValidationResult(incomplete, 'live')).toThrow(/is_free_provider/);
  });

  it('assertValidationResult rejects null is_free_provider when syntax_valid', () => {
    const window = new Window({ url: 'https://eneelkant.github.io/' });
    const root = path.resolve('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'https://example.test' });
    window.eval(readFileSync(path.join(root, 'public/js/verify.js'), 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).MailSureApi;
    const nullFree = {
      email: 'test@gmail.com',
      normalized_email: 'test@gmail.com',
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: false,
      is_free_provider: null,
      provider_type: null,
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: [],
      checked_at: '2026-11-12T00:00:00.000Z',
    };
    expect(() => api.assertValidationResult(nullFree, 'null-free')).toThrow(
      /is_free_provider must be a boolean/,
    );
  });

  it('resultsToCsv maps missing free fields to blank (documents live bug surface)', () => {
    const window = new Window({ url: 'https://eneelkant.github.io/' });
    const root = path.resolve('.');
    window.eval(readFileSync(path.join(root, 'public/js/csv.js'), 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const csv = (window as any).MailSureCsv;
    const out = csv.resultsToCsv([
      {
        email: 'test@gmail.com',
        normalized_email: 'test@gmail.com',
        syntax_valid: true,
        domain_exists: true,
        mx_exists: true,
        is_disposable: false,
        // omit free fields
        is_role_based: false,
        smtp_status: 'not_checked',
        catch_all_status: 'not_checked',
        overall_status: 'valid_domain',
        confidence: 'medium',
        reason_codes: [],
        checked_at: '2026-11-12T00:00:00.000Z',
      },
    ]);
    const lines = out.split('\n');
    const cols = lines[0].split(',');
    const freeIdx = cols.indexOf('is_free_provider');
    const typeIdx = cols.indexOf('provider_type');
    const row = lines[1].split(',');
    expect(row[freeIdx]).toBe('');
    expect(row[typeIdx]).toBe('');
  });
});

/**
 * Phase 3 — null / partial-null classification rehydration.
 * Valid syntax with null provider fields must reclassify; invalid syntax keeps nulls;
 * complete valid results stay untouched.
 */
describe('Phase 3 null-classification rehydration', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    closeDb();
    getDb();
    resetFreeProvidersCache();
    resetDisposableCache();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  beforeEach(() => {
    resetFreeProvidersCache();
    resetDisposableCache();
    loadFreeProviders(true);
    loadDisposableDomains(true);
  });

  afterAll(() => {
    closeDb();
  });

  function validNullProvider(email: string, extras: Partial<ValidationResult> = {}): ValidationResult {
    return {
      email,
      normalized_email: email.toLowerCase(),
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: null,
      is_free_provider: null,
      provider_type: null,
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: ['SMTP_DISABLED', 'CATCH_ALL_DISABLED'],
      checked_at: '2026-11-12T09:00:00.000Z',
      mx_hosts: ['mx.example'],
      ...extras,
    };
  }

  it('treats null and partial-null free fields as missing', () => {
    expect(
      missingProviderClassification(
        validNullProvider('test@gmail.com'),
      ),
    ).toBe(true);
    expect(
      missingProviderClassification({
        ...validNullProvider('test@gmail.com'),
        is_free_provider: true,
        provider_type: null,
      }),
    ).toBe(true);
    expect(
      missingProviderClassification({
        ...validNullProvider('test@gmail.com'),
        is_free_provider: null,
        provider_type: 'free',
      }),
    ).toBe(true);
    expect(
      missingProviderClassification({
        ...validNullProvider('test@gmail.com'),
        is_disposable: false,
        is_free_provider: true,
        provider_type: 'free',
      }),
    ).toBe(false);
  });

  it('rehydrates null free fields for gmail/outlook/yahoo/qq', () => {
    for (const email of FREE_MAJORS) {
      const fixed = ensureProviderClassification(validNullProvider(email));
      expect(fixed.is_free_provider, email).toBe(true);
      expect(fixed.provider_type, email).toBe('free');
      expect(fixed.is_disposable, email).toBe(false);
      expect(fixed.reason_codes, email).toContain('FREE_EMAIL_PROVIDER');
    }
  });

  it('rehydrates null fields for disposable domains', () => {
    const fixed = ensureProviderClassification(
      validNullProvider('a@mailinator.com', { overall_status: 'disposable' }),
    );
    expect(fixed.is_disposable).toBe(true);
    expect(fixed.is_free_provider).toBe(false);
    expect(fixed.provider_type).toBe('disposable');
    expect(fixed.reason_codes).toContain('DISPOSABLE_DOMAIN');
  });

  it('keeps nulls for invalid syntax', () => {
    const invalid: ValidationResult = {
      email: 'not-an-email',
      normalized_email: 'not-an-email',
      syntax_valid: false,
      domain_exists: null,
      mx_exists: null,
      is_disposable: null,
      is_free_provider: null,
      provider_type: null,
      is_role_based: null,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'invalid_syntax',
      confidence: 'high',
      reason_codes: ['MISSING_AT'],
      checked_at: '2026-11-12T09:00:00.000Z',
    };
    expect(missingProviderClassification(invalid)).toBe(true);
    const fixed = ensureProviderClassification(invalid);
    expect(fixed.is_free_provider).toBeNull();
    expect(fixed.provider_type).toBeNull();
    expect(fixed.is_disposable).toBeNull();
    expect(fixed.syntax_valid).toBe(false);
  });

  it('leaves complete valid classification unchanged (identity)', () => {
    const complete: ValidationResult = {
      email: 'user@corp.example',
      normalized_email: 'user@corp.example',
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: false,
      is_free_provider: false,
      provider_type: 'custom',
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: ['SMTP_DISABLED'],
      checked_at: '2026-11-12T09:00:00.000Z',
    };
    expect(missingProviderClassification(complete)).toBe(false);
    const out = ensureProviderClassification(complete);
    expect(out).toBe(complete); // same reference — early return
    expect(out.is_free_provider).toBe(false);
    expect(out.provider_type).toBe('custom');
  });

  it('cache read rehydrates rows with explicit null free fields', () => {
    const nullRow = validNullProvider('test@gmail.com');
    const db = getDb();
    const expires = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(
      `INSERT INTO validation_cache (email_hash, normalized_email, result_json, overall_status, checked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_hash) DO UPDATE SET
         result_json = excluded.result_json,
         overall_status = excluded.overall_status,
         checked_at = excluded.checked_at,
         expires_at = excluded.expires_at`,
    ).run(
      createHash('sha256').update('test@gmail.com').digest('hex'),
      'test@gmail.com',
      JSON.stringify(nullRow),
      'valid_domain',
      nullRow.checked_at,
      expires,
    );
    const cached = getCachedValidation('test@gmail.com');
    expect(cached).not.toBeNull();
    expect(cached!.is_free_provider).toBe(true);
    expect(cached!.provider_type).toBe('free');
    expect(cached!.is_disposable).toBe(false);
  });

  it('server CSV rehydrates null free fields for majors + disposable', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'phase3-null-classification.csv');
    writeFileSync(
      input,
      'email\ntest@gmail.com\nuser@outlook.com\na@yahoo.com\nb@qq.com\nx@mailinator.com\n',
      'utf8',
    );
    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      concurrency: 1,
      hooks: {
        validateBatch: async (emails) =>
          emails.map((email) =>
            email.includes('mailinator')
              ? validNullProvider(email, { overall_status: 'disposable' })
              : validNullProvider(email),
          ),
      },
    });
    expect(job.status).toBe('completed');
    const out = readFileSync(job.output_path!, 'utf8');
    const lines = out.trim().split(/\r?\n/);
    const cols = lines[0]!.split(',');
    const freeIdx = cols.indexOf('is_free_provider');
    const typeIdx = cols.indexOf('provider_type');
    const dispIdx = cols.indexOf('is_disposable');
    expect(freeIdx).toBeGreaterThan(-1);
    expect(typeIdx).toBeGreaterThan(-1);

    const byEmail = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
      const row = line.split(',');
      byEmail.set(row[0]!, row);
    }
    for (const email of ['test@gmail.com', 'user@outlook.com', 'a@yahoo.com', 'b@qq.com']) {
      const row = byEmail.get(email)!;
      expect(row[freeIdx], email).toBe('true');
      expect(row[typeIdx], email).toBe('free');
      expect(row[dispIdx], email).toBe('false');
    }
    const disp = byEmail.get('x@mailinator.com')!;
    expect(disp[freeIdx]).toBe('false');
    expect(disp[typeIdx]).toBe('disposable');
    expect(disp[dispIdx]).toBe('true');
  });
});

describe('Phase 3 website API null-payload rehydration', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_WEBSITE_MAX_BATCH_SIZE = '10';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX = '100';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    resetFreeProvidersCache();
    resetDisposableCache();
    ensureFreeProvidersDatasetFile();
    ensureDisposableDatasetFile();
    loadFreeProviders(true);
    loadDisposableDomains(true);

    // Seed cache with valid-syntax null classification for gmail.
    const nullRow = {
      email: 'test@gmail.com',
      normalized_email: 'test@gmail.com',
      syntax_valid: true,
      domain_exists: true,
      mx_exists: true,
      is_disposable: null,
      is_free_provider: null,
      provider_type: null,
      is_role_based: false,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'valid_domain',
      confidence: 'medium',
      reason_codes: ['SMTP_DISABLED', 'CATCH_ALL_DISABLED'],
      checked_at: '2026-11-12T09:00:00.000Z',
      mx_hosts: ['mx.gmail.com'],
    } satisfies ValidationResult;
    const db = getDb();
    const expires = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(
      `INSERT INTO validation_cache (email_hash, normalized_email, result_json, overall_status, checked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_hash) DO UPDATE SET
         result_json = excluded.result_json,
         overall_status = excluded.overall_status,
         checked_at = excluded.checked_at,
         expires_at = excluded.expires_at`,
    ).run(
      createHash('sha256').update('test@gmail.com').digest('hex'),
      'test@gmail.com',
      JSON.stringify(nullRow),
      'valid_domain',
      nullRow.checked_at,
      expires,
    );

    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
  });

  it('GET path via batch serves rehydrated free fields from null cache', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: ['test@gmail.com'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: ValidationResult[] };
    expect(body.results[0]!.is_free_provider).toBe(true);
    expect(body.results[0]!.provider_type).toBe('free');
    expect(body.results[0]!.is_disposable).toBe(false);
  });
});
