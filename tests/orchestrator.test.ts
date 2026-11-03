import './setup-env.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { validateEmail } from '../src/validators/orchestrator.js';
import type { DnsLookupResult } from '../src/validators/dns.js';

describe('validateEmail orchestrator', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
  });

  it('returns invalid_syntax for bad addresses', async () => {
    const r = await validateEmail('not-valid');
    expect(r.overall_status).toBe('invalid_syntax');
    expect(r.syntax_valid).toBe(false);
  });

  it('returns valid_domain for good DNS without claiming deliverability', async () => {
    const dns: DnsLookupResult = {
      domain: 'example.com',
      domain_exists: true,
      mx_exists: true,
      a_records: ['93.184.216.34'],
      aaaa_records: [],
      mx_hosts: ['mail.example.com'],
      error_code: null,
      temporary: false,
    };
    const r = await validateEmail('john@example.com', { dnsLookup: async () => dns });
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
