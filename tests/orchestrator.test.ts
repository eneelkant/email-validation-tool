import './setup-env.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { validateEmail } from '../src/validators/orchestrator.js';
import type { DnsLookupResult } from '../src/validators/dns.js';
import type { ReacherCheckResult } from '../src/validators/reacher.js';

const goodDns: DnsLookupResult = {
  domain: 'example.com',
  domain_exists: true,
  mx_exists: true,
  a_records: ['93.184.216.34'],
  aaaa_records: [],
  mx_hosts: ['mail.example.com'],
  error_code: null,
  temporary: false,
};

describe('validateEmail orchestrator', () => {
  beforeAll(() => {
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    resetConfigCache();
    loadConfig();
  });

  it('returns invalid_syntax for bad addresses', async () => {
    const r = await validateEmail('not-valid');
    expect(r.overall_status).toBe('invalid_syntax');
    expect(r.syntax_valid).toBe(false);
  });

  it('returns valid_domain for good DNS without claiming deliverability', async () => {
    const r = await validateEmail('john@example.com', { dnsLookup: async () => goodDns });
    expect(r.overall_status).toBe('valid_domain');
    expect(r.confidence).toBe('medium');
    expect(r.smtp_status).toBe('not_checked');
  });

  it('returns disposable for disposable domains', async () => {
    const dns: DnsLookupResult = {
      domain: 'mailinator.com',
      domain_exists: true,
      mx_exists: true,
      a_records: [],
      aaaa_records: [],
      mx_hosts: ['mx.mailinator.com'],
      error_code: null,
      temporary: false,
    };
    const r = await validateEmail('a@mailinator.com', { dnsLookup: async () => dns });
    expect(r.overall_status).toBe('disposable');
  });

  it('returns temporary_error on DNS timeout-like results', async () => {
    const dns: DnsLookupResult = {
      domain: 'example.com',
      domain_exists: null,
      mx_exists: null,
      a_records: [],
      aaaa_records: [],
      mx_hosts: [],
      error_code: 'DNS_TIMEOUT',
      temporary: true,
    };
    const r = await validateEmail('a@example.com', { dnsLookup: async () => dns });
    expect(r.overall_status).toBe('temporary_error');
  });
});

describe('validateEmail Reacher integration', () => {
  beforeEach(() => {
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    process.env.OPENVERIFY_SMTP_ENABLED = 'false';
    resetConfigCache();
    loadConfig();
  });

  afterEach(() => {
    process.env.REACHER_ENABLED = 'false';
    process.env.REACHER_API_URL = '';
    process.env.OPENVERIFY_SMTP_ENABLED = 'false';
    resetConfigCache();
  });

  it('does not call Reacher when REACHER_ENABLED=false', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => {
      throw new Error('should not be called');
    });
    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => goodDns,
      reacherCheck,
    });
    expect(reacherCheck).not.toHaveBeenCalled();
    expect(r.smtp_status).toBe('not_checked');
    expect(r.overall_status).toBe('valid_domain');
  });

  it('does not call Reacher for invalid syntax', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => {
      throw new Error('should not be called');
    });
    await validateEmail('not-valid', { enableReacher: true, reacherCheck });
    expect(reacherCheck).not.toHaveBeenCalled();
  });

  it('calls Reacher once when enabled with MX and maps smtp ok', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: false,
      smtp: {
        status: 'ok',
        reason_codes: ['REACHER_SMTP', 'REACHER_DELIVERABLE', 'REACHER_HINT_SAFE'],
      },
      catch_all_status: 'no',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_NO'],
      is_reachable_hint: 'safe',
    }));

    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => goodDns,
      enableReacher: true,
      enableCatchAll: true,
      reacherCheck,
    });

    expect(reacherCheck).toHaveBeenCalledTimes(1);
    expect(r.smtp_status).toBe('ok');
    expect(r.catch_all_status).toBe('no');
    expect(r.overall_status).toBe('valid_domain');
    expect(r.reason_codes).toContain('REACHER_DELIVERABLE');
    // Must not promote raw is_reachable into overall_status
    expect(r.overall_status).not.toBe('safe' as typeof r.overall_status);
  });

  it('Reacher timeout without local SMTP → temporary/risky, never Invalid overall', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: true,
      smtp: { status: 'temporary_error', reason_codes: ['REACHER_TIMEOUT'] },
      catch_all_status: 'not_checked',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_SKIPPED'],
    }));

    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => goodDns,
      enableReacher: true,
      enableSmtp: false,
      reacherCheck,
    });

    expect(r.smtp_status).toBe('temporary_error');
    expect(r.overall_status).toBe('risky');
    expect(r.overall_status).not.toBe('invalid_domain');
    expect(r.reason_codes).toContain('REACHER_TIMEOUT');
  });

  it('falls back to local SMTP path marker when Reacher fails and SMTP enabled', async () => {
    // Local diagnoseSmtp still respects OPENVERIFY_SMTP_ENABLED from getConfig().
    process.env.OPENVERIFY_SMTP_ENABLED = 'true';
    process.env.OPENVERIFY_SMTP_TIMEOUT_MS = '500';
    resetConfigCache();
    loadConfig();

    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: true,
      smtp: { status: 'temporary_error', reason_codes: ['REACHER_TIMEOUT'] },
      catch_all_status: 'not_checked',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_SKIPPED'],
    }));

    // Loopback MX → fast ECONNREFUSED (avoids slow external timeout in CI)
    const dns: DnsLookupResult = { ...goodDns, mx_hosts: ['127.0.0.1'] };

    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => dns,
      enableReacher: true,
      enableSmtp: true,
      reacherCheck,
    });

    expect(reacherCheck).toHaveBeenCalledTimes(1);
    expect(r.reason_codes).toContain('REACHER_FALLBACK_LOCAL_SMTP');
    expect(r.reason_codes).toContain('REACHER_TIMEOUT');
    // Local probe failure must not invent Invalid
    expect(r.overall_status).not.toBe('invalid_domain');
    expect(['risky', 'unknown', 'valid_domain', 'temporary_error']).toContain(r.overall_status);

    process.env.OPENVERIFY_SMTP_TIMEOUT_MS = '5000';
  });

  it('skips Reacher when DNS has no MX', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => {
      throw new Error('should not be called');
    });
    const dns: DnsLookupResult = {
      ...goodDns,
      mx_exists: false,
      mx_hosts: [],
    };
    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => dns,
      enableReacher: true,
      reacherCheck,
    });
    expect(reacherCheck).not.toHaveBeenCalled();
    expect(r.overall_status).toBe('no_mx');
  });

  it('Socks5 Operation timed out → temporary_error and local SMTP fallback when enabled', async () => {
    process.env.OPENVERIFY_SMTP_ENABLED = 'true';
    process.env.OPENVERIFY_SMTP_TIMEOUT_MS = '500';
    resetConfigCache();
    loadConfig();

    // Exact proxy timeout shape: HTTP 200 body with nested smtp.error
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: true,
      smtp: {
        status: 'temporary_error',
        reason_codes: [
          'REACHER_SMTP_ERROR',
          'REACHER_ERR_Socks5',
          'REACHER_SMTP_TRANSIENT',
        ],
      },
      catch_all_status: 'not_checked',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_SKIPPED'],
      is_reachable_hint: 'unknown',
    }));

    const dns: DnsLookupResult = { ...goodDns, mx_hosts: ['127.0.0.1'] };
    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => dns,
      enableReacher: true,
      enableSmtp: true,
      reacherCheck,
    });

    expect(reacherCheck).toHaveBeenCalledTimes(1);
    expect(r.reason_codes).toContain('REACHER_FALLBACK_LOCAL_SMTP');
    expect(r.reason_codes).toContain('REACHER_SMTP_TRANSIENT');
    expect(r.smtp_status).not.toBe('invalid');
    expect(r.overall_status).not.toBe('invalid_domain');
    // Must never become Invalid solely from the Socks5 proxy timeout
    expect(['risky', 'unknown', 'valid_domain', 'temporary_error']).toContain(r.overall_status);

    process.env.OPENVERIFY_SMTP_TIMEOUT_MS = '5000';
  });

  it('Socks5 timed out without local SMTP stays temporary/risky — never Invalid', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: true,
      smtp: {
        status: 'temporary_error',
        reason_codes: [
          'REACHER_SMTP_ERROR',
          'REACHER_ERR_Socks5',
          'REACHER_SMTP_TRANSIENT',
        ],
      },
      catch_all_status: 'not_checked',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_SKIPPED'],
    }));

    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => goodDns,
      enableReacher: true,
      enableSmtp: false,
      reacherCheck,
    });

    expect(r.smtp_status).toBe('temporary_error');
    expect(r.overall_status).toBe('risky');
    expect(r.overall_status).not.toBe('invalid_domain');
    expect(r.smtp_status).not.toBe('invalid');
  });

  it('IpBlacklisted smtp.error alone → unknown overall, never Invalid', async () => {
    const reacherCheck = vi.fn(async (): Promise<ReacherCheckResult> => ({
      transportFailed: false,
      smtp: {
        status: 'unknown',
        reason_codes: [
          'REACHER_SMTP_ERROR',
          'REACHER_ERR_SmtpError',
          'REACHER_DESC_IpBlacklisted',
        ],
      },
      catch_all_status: 'unknown',
      catch_all_reason_codes: ['REACHER_CATCH_ALL_UNKNOWN'],
      is_reachable_hint: 'unknown',
    }));

    const r = await validateEmail('john@example.com', {
      dnsLookup: async () => goodDns,
      enableReacher: true,
      enableSmtp: false,
      reacherCheck,
    });

    expect(r.smtp_status).toBe('unknown');
    expect(r.overall_status).toBe('unknown');
    expect(r.overall_status).not.toBe('invalid_domain');
    expect(r.smtp_status).not.toBe('invalid');
    expect(r.reason_codes).toContain('REACHER_DESC_IpBlacklisted');
  });
});
