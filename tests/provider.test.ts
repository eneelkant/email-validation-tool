import './setup-env.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import {
  ensureDisposableDatasetFile,
  isDisposableDomain,
  isDisposableDomainListed,
  loadDisposableDomains,
  replaceDisposableDomainsFromText,
  resetDisposableCache,
  updateDisposableDomainsFromText,
} from '../src/validators/disposable.js';
import {
  ensureFreeProvidersDatasetFile,
  isFreeProviderDomain,
  loadFreeProviders,
  resetFreeProvidersCache,
  updateFreeProvidersFromText,
} from '../src/validators/free-provider.js';
import { classifyProvider, providerTypeLabel } from '../src/validators/provider.js';
import { validateEmail } from '../src/validators/orchestrator.js';
import type { DnsLookupResult } from '../src/validators/dns.js';

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

describe('provider classification', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
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

  it('flags known disposable domains', () => {
    const c = classifyProvider('mailinator.com');
    expect(c).toEqual({
      provider_type: 'disposable',
      is_disposable: true,
      is_free_provider: false,
    });
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(providerTypeLabel(c.provider_type)).toBe('Disposable email address');
  });

  it('matches disposable parent domains', () => {
    expect(classifyProvider('sub.mailinator.com').provider_type).toBe('disposable');
  });

  it('classifies major free providers (never disposable)', () => {
    for (const domain of [
      'gmail.com',
      'outlook.com',
      'hotmail.com',
      'yahoo.com',
      'qq.com',
    ]) {
      const c = classifyProvider(domain);
      expect(c.provider_type).toBe('free');
      expect(c.is_free_provider).toBe(true);
      expect(c.is_disposable).toBe(false);
      expect(isDisposableDomain(domain)).toBe(false);
      expect(providerTypeLabel(c.provider_type)).toBe('Free email provider');
    }
  });

  it('matches free-provider parent domains', () => {
    expect(classifyProvider('mail.gmail.com').provider_type).toBe('free');
  });

  it('classifies custom/corporate domains', () => {
    const c = classifyProvider('example.com');
    expect(c).toEqual({
      provider_type: 'custom',
      is_disposable: false,
      is_free_provider: false,
    });
    expect(providerTypeLabel(c.provider_type)).toBeNull();
  });

  it('never marks free as disposable even when listed on disposable set', () => {
    updateDisposableDomainsFromText('gmail.com\noverlap-free.test\n', 'overlap-test');
    updateFreeProvidersFromText('overlap-free.test\n', 'overlap-test');
    resetDisposableCache();
    resetFreeProvidersCache();
    loadFreeProviders(true);
    loadDisposableDomains(true);

    expect(isDisposableDomainListed('overlap-free.test')).toBe(true);
    expect(isFreeProviderDomain('overlap-free.test')).toBe(true);
    expect(isDisposableDomain('overlap-free.test')).toBe(false);
    expect(classifyProvider('overlap-free.test')).toEqual({
      provider_type: 'free',
      is_disposable: false,
      is_free_provider: true,
    });
    expect(classifyProvider('gmail.com').is_disposable).toBe(false);
  });

  it('orchestrator returns free fields without disposable overall_status', async () => {
    const r = await validateEmail('user@gmail.com', {
      dnsLookup: async () => okDns('gmail.com'),
    });
    expect(r.is_free_provider).toBe(true);
    expect(r.is_disposable).toBe(false);
    expect(r.provider_type).toBe('free');
    expect(r.reason_codes).toContain('FREE_EMAIL_PROVIDER');
    expect(r.overall_status).toBe('valid_domain');
  });

  it('orchestrator returns disposable overall_status for throwaways', async () => {
    const r = await validateEmail('a@mailinator.com', {
      dnsLookup: async () => okDns('mailinator.com'),
    });
    expect(r.is_disposable).toBe(true);
    expect(r.is_free_provider).toBe(false);
    expect(r.provider_type).toBe('disposable');
    expect(r.overall_status).toBe('disposable');
    expect(r.reason_codes).toContain('DISPOSABLE_DOMAIN');
  });

  it('invalid syntax yields null provider fields', async () => {
    const r = await validateEmail('not-an-email');
    expect(r.provider_type).toBeNull();
    expect(r.is_disposable).toBeNull();
    expect(r.is_free_provider).toBeNull();
  });

  it('fail-safe replace keeps previous file when list is too small', () => {
    const file = getConfig().disposablePath;
    ensureDisposableDatasetFile();
    loadDisposableDomains(true);
    const before = readFileSync(file, 'utf8');
    const beforeCount = loadDisposableDomains(true).size;

    expect(() =>
      replaceDisposableDomainsFromText('tiny.test\n', 'too-small', { minCount: 500 }),
    ).toThrow(/rejected/i);

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
    resetDisposableCache();
    expect(loadDisposableDomains(true).size).toBe(beforeCount);
  });

  it('atomic replace succeeds for a large enough list and strips free domains', () => {
    const domains = Array.from({ length: 520 }, (_, i) => `disp-${i}.test`);
    domains.push('gmail.com'); // must be stripped
    const meta = replaceDisposableDomainsFromText(domains.join('\n'), 'replace-ok', {
      minCount: 500,
    });
    expect(meta.count).toBe(520);
    resetDisposableCache();
    const set = loadDisposableDomains(true);
    expect(set.has('gmail.com')).toBe(false);
    expect(set.has('disp-0.test')).toBe(true);
    expect(isDisposableDomain('disp-0.test')).toBe(true);
  });
});

describe('frontend provider labels', () => {
  it('exports matching human labels from classifyProvider helper', () => {
    expect(providerTypeLabel('disposable')).toBe('Disposable email address');
    expect(providerTypeLabel('free')).toBe('Free email provider');
    expect(providerTypeLabel('custom')).toBeNull();
    expect(providerTypeLabel(null)).toBeNull();
  });
});
