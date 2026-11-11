import './setup-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertReacherConfig,
  loadConfig,
  normalizeReacherApiUrl,
  resetConfigCache,
} from '../src/config/env.js';
import {
  checkEmailWithReacher,
  classifyReachability,
  fetchWithSafeTimeout,
  mapReacherCatchAll,
  mapReacherSmtpToDiag,
  ReacherResponseSchema,
  REACHER_TIMEOUT_MAX_MS,
  safeReacherTimeoutMs,
} from '../src/validators/reacher.js';

describe('normalizeReacherApiUrl / assertReacherConfig', () => {
  afterEach(() => {
    resetConfigCache();
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    delete process.env.REACHER_TIMEOUT;
  });

  it('strips trailing slash and keeps origin', () => {
    expect(normalizeReacherApiUrl('https://reacher.example.com/')).toBe(
      'https://reacher.example.com',
    );
  });

  it('rejects path beyond origin', () => {
    expect(() =>
      normalizeReacherApiUrl('https://reacher.example.com/v1/check_email'),
    ).toThrow(/origin only/);
  });

  it('fail-closes when enabled without URL', () => {
    process.env.REACHER_ENABLED = 'true';
    process.env.REACHER_API_URL = '';
    resetConfigCache();
    expect(() => loadConfig()).toThrow(/REACHER_API_URL is required/);
  });

  it('loads when enabled with valid URL', () => {
    process.env.REACHER_ENABLED = 'true';
    process.env.REACHER_API_URL = 'https://reacher-render-deploy.onrender.com';
    process.env.REACHER_TIMEOUT = '12000';
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.reacherEnabled).toBe(true);
    expect(cfg.reacherApiUrl).toBe('https://reacher-render-deploy.onrender.com');
    expect(cfg.reacherTimeoutMs).toBe(12000);
    expect(() => assertReacherConfig(cfg)).not.toThrow();
  });

  it('defaults disabled (current behavior)', () => {
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.reacherEnabled).toBe(false);
    expect(cfg.reacherApiUrl).toBe('');
    expect(cfg.reacherTimeoutMs).toBe(15_000);
  });
});

describe('mapReacherSmtpToDiag / catch-all', () => {
  it('maps deliverable → ok', () => {
    const r = mapReacherSmtpToDiag({
      can_connect_smtp: true,
      has_full_inbox: false,
      is_catch_all: false,
      is_deliverable: true,
      is_disabled: false,
    });
    expect(r.status).toBe('ok');
    expect(r.reason_codes).toContain('REACHER_DELIVERABLE');
  });

  it('maps disabled → invalid', () => {
    const r = mapReacherSmtpToDiag({
      can_connect_smtp: true,
      has_full_inbox: false,
      is_catch_all: false,
      is_deliverable: false,
      is_disabled: true,
    });
    expect(r.status).toBe('invalid');
  });

  it('maps not deliverable (connected) → invalid', () => {
    const r = mapReacherSmtpToDiag({
      can_connect_smtp: true,
      has_full_inbox: false,
      is_catch_all: false,
      is_deliverable: false,
      is_disabled: false,
    });
    expect(r.status).toBe('invalid');
  });

  it('maps full inbox → temporary_error (not Invalid)', () => {
    const r = mapReacherSmtpToDiag({
      can_connect_smtp: true,
      has_full_inbox: true,
      is_catch_all: false,
      is_deliverable: false,
      is_disabled: false,
    });
    expect(r.status).toBe('temporary_error');
    expect(r.reason_codes).toContain('REACHER_FULL_INBOX');
  });

  it('maps no connect → temporary_error (not Invalid)', () => {
    const r = mapReacherSmtpToDiag({
      can_connect_smtp: false,
      has_full_inbox: false,
      is_catch_all: false,
      is_deliverable: false,
      is_disabled: false,
    });
    expect(r.status).toBe('temporary_error');
  });

  it('maps flat CoreError → unknown', () => {
    const r = mapReacherSmtpToDiag({ type: 'SmtpError', message: 'blocked' });
    expect(r.status).toBe('unknown');
    expect(r.reason_codes).toContain('REACHER_SMTP_ERROR');
  });

  it('maps nested smtp.error (AsyncSmtpError transient) → temporary_error, not Invalid', () => {
    // Real payload shape from reacherhq/check-if-email-exists#1674
    const nested = {
      error: {
        type: 'AsyncSmtpError',
        message: 'transient: 4.5.3 Too many recipients',
      },
    };
    const parsed = ReacherResponseSchema.safeParse({
      input: 'gerard.butler@example.com',
      is_reachable: 'unknown',
      smtp: nested,
      misc: { is_disposable: false, is_role_account: false },
      mx: { accepts_mail: true, records: ['mail.example.com.'] },
      syntax: { domain: 'example.com', is_valid_syntax: true, username: 'gerard.butler' },
    });
    expect(parsed.success).toBe(true);
    const r = mapReacherSmtpToDiag(nested);
    expect(r.status).toBe('temporary_error');
    expect(r.status).not.toBe('invalid');
    expect(r.reason_codes).toContain('REACHER_SMTP_ERROR');
    expect(r.reason_codes).toContain('REACHER_SMTP_TRANSIENT');
    expect(r.reason_codes).toContain('REACHER_ERR_AsyncSmtpError');
  });

  it('maps nested smtp.error with description (IpBlacklisted) → unknown, not Invalid', () => {
    const nested = {
      error: {
        type: 'SmtpError',
        message: 'permanent: zen.mimecast.org blacklisted',
      },
      description: 'IpBlacklisted',
    };
    expect(ReacherResponseSchema.safeParse({ smtp: nested }).success).toBe(true);
    const r = mapReacherSmtpToDiag(nested);
    expect(r.status).toBe('unknown');
    expect(r.status).not.toBe('invalid');
    expect(r.reason_codes).toContain('REACHER_DESC_IpBlacklisted');
  });

  it('end-to-end: nested smtp.error response is not SCHEMA_MISMATCH', async () => {
    process.env.REACHER_ENABLED = 'true';
    process.env.REACHER_API_URL = 'https://reacher.test';
    resetConfigCache();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            input: 'a@example.com',
            is_reachable: 'unknown',
            smtp: {
              error: {
                type: 'AsyncSmtpError',
                message: 'transient: 4.5.3 Too many recipients',
              },
            },
            misc: { is_disposable: false, is_role_account: false },
            mx: { accepts_mail: true, records: ['mail.example.com.'] },
            syntax: {
              domain: 'example.com',
              is_valid_syntax: true,
              username: 'a',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = await checkEmailWithReacher(
      'a@example.com',
      loadConfig(),
      fetchMock as unknown as typeof fetch,
    );
    expect(result.transportFailed).toBe(false);
    expect(result.smtp.reason_codes).not.toContain('REACHER_SCHEMA_MISMATCH');
    expect(result.smtp.status).toBe('temporary_error');
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    resetConfigCache();
  });

  it('maps catch-all flag', () => {
    expect(
      mapReacherCatchAll({
        can_connect_smtp: true,
        has_full_inbox: false,
        is_catch_all: true,
        is_deliverable: true,
        is_disabled: false,
      }).status,
    ).toBe('yes');
    expect(
      mapReacherCatchAll({
        can_connect_smtp: true,
        has_full_inbox: false,
        is_catch_all: false,
        is_deliverable: true,
        is_disabled: false,
      }).status,
    ).toBe('no');
  });
});

describe('classifyReachability (MailSure-owned; not is_reachable)', () => {
  it('does not copy is_reachable: disposable stays Risky even if hint was safe', () => {
    // Upstream might claim safe; MailSure classification uses local disposable signal.
    const classification = classifyReachability({
      syntaxValid: true,
      dnsTemporary: false,
      domainExists: true,
      mxExists: true,
      disposable: true,
      role: false,
      smtpStatus: 'ok',
      catchAll: 'no',
    });
    expect(classification).toBe('risky');
    expect(classification).not.toBe('safe');
  });

  it('maps definitive SMTP reject facet to invalid', () => {
    expect(
      classifyReachability({
        syntaxValid: true,
        dnsTemporary: false,
        domainExists: true,
        mxExists: true,
        disposable: false,
        role: false,
        smtpStatus: 'invalid',
        catchAll: 'no',
      }),
    ).toBe('invalid');
  });

  it('maps timeout-like smtp to risky/unknown — never invents invalid from temporary', () => {
    expect(
      classifyReachability({
        syntaxValid: true,
        dnsTemporary: false,
        domainExists: true,
        mxExists: true,
        disposable: false,
        role: false,
        smtpStatus: 'temporary_error',
        catchAll: 'not_checked',
      }),
    ).toBe('risky');
  });

  it('maps smtp ok + clean signals to safe', () => {
    expect(
      classifyReachability({
        syntaxValid: true,
        dnsTemporary: false,
        domainExists: true,
        mxExists: true,
        disposable: false,
        role: false,
        smtpStatus: 'ok',
        catchAll: 'no',
      }),
    ).toBe('safe');
  });
});

describe('checkEmailWithReacher (mocked fetch)', () => {
  beforeEach(() => {
    process.env.REACHER_ENABLED = 'true';
    process.env.REACHER_API_URL = 'https://reacher.test';
    process.env.REACHER_TIMEOUT = '5000';
    resetConfigCache();
  });

  afterEach(() => {
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    resetConfigCache();
  });

  it('POSTs /v1/check_email with to_email and maps body', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://reacher.test/v1/check_email');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({ to_email: 'a@example.com' });
      return new Response(
        JSON.stringify({
          input: 'a@example.com',
          is_reachable: 'safe',
          smtp: {
            can_connect_smtp: true,
            has_full_inbox: false,
            is_catch_all: false,
            is_deliverable: true,
            is_disabled: false,
          },
          misc: { is_disposable: false, is_role_account: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const cfg = loadConfig();
    const result = await checkEmailWithReacher('a@example.com', cfg, fetchMock as unknown as typeof fetch);
    expect(result.transportFailed).toBe(false);
    expect(result.smtp.status).toBe('ok');
    expect(result.smtp.reason_codes).toContain('REACHER_HINT_SAFE');
    expect(result.is_reachable_hint).toBe('safe');
    // Classification must not be taken from hint alone when disposable
    expect(
      classifyReachability({
        syntaxValid: true,
        dnsTemporary: false,
        domainExists: true,
        mxExists: true,
        disposable: true,
        role: false,
        smtpStatus: result.smtp.status,
        catchAll: result.catch_all_status,
      }),
    ).toBe('risky');
  });

  it('maps timeout to temporary_error transport failure (not Invalid)', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    const cfg = loadConfig();
    const result = await checkEmailWithReacher('a@example.com', cfg, fetchMock as unknown as typeof fetch);
    expect(result.transportFailed).toBe(true);
    expect(result.smtp.status).toBe('temporary_error');
    expect(result.smtp.reason_codes).toContain('REACHER_TIMEOUT');
    expect(result.smtp.status).not.toBe('invalid');
  });

  it('maps HTTP 503 to temporary_error', async () => {
    const fetchMock = vi.fn(
      async () => new Response('unavailable', { status: 503 }),
    );
    const cfg = loadConfig();
    const result = await checkEmailWithReacher('a@example.com', cfg, fetchMock as unknown as typeof fetch);
    expect(result.transportFailed).toBe(true);
    expect(result.smtp.status).toBe('temporary_error');
    expect(result.smtp.reason_codes).toContain('REACHER_HTTP_503');
  });

  it('safe timeout aborts hung fetch and returns temporary_error (not Invalid)', async () => {
    process.env.REACHER_TIMEOUT = '50';
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.reacherTimeoutMs).toBe(1000); // clamped floor

    // Simulate hung Reacher (cold start) that ignores abort for a while
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
          // Never resolve otherwise — race deadline must win
        }),
    );

    const started = Date.now();
    const result = await checkEmailWithReacher(
      'a@example.com',
      { ...cfg, reacherTimeoutMs: 80 },
      fetchMock as unknown as typeof fetch,
    );
    const elapsed = Date.now() - started;

    expect(result.transportFailed).toBe(true);
    expect(result.smtp.status).toBe('temporary_error');
    expect(result.smtp.reason_codes).toContain('REACHER_TIMEOUT');
    expect(result.smtp.status).not.toBe('invalid');
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('safeReacherTimeoutMs / fetchWithSafeTimeout', () => {
  it('clamps timeout into [1000, REACHER_TIMEOUT_MAX_MS]', () => {
    expect(safeReacherTimeoutMs(15_000)).toBe(15_000);
    expect(safeReacherTimeoutMs(50)).toBe(1_000);
    expect(safeReacherTimeoutMs(999_999)).toBe(REACHER_TIMEOUT_MAX_MS);
  });

  it('Promise.race deadline rejects hung fetch that ignores AbortSignal', async () => {
    const hung = vi.fn(async () => new Promise<Response>(() => {}));
    await expect(
      fetchWithSafeTimeout(
        hung as unknown as typeof fetch,
        'https://reacher.test/v1/check_email',
        { method: 'POST', body: '{}' },
        60,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
