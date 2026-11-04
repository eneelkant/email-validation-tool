import './setup-env.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import {
  ensureDisposableDatasetFile,
  isDisposableDomain,
  loadDisposableDomains,
  updateDisposableDomainsFromText,
} from '../src/validators/disposable.js';

describe('disposable domains', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
    ensureDisposableDatasetFile();
    loadDisposableDomains(true);
  });

  it('flags known disposable domains', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('sub.mailinator.com')).toBe(true);
  });

  it('does not flag normal domains', () => {
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isDisposableDomain('example.com')).toBe(false);
  });

  it('merges updates without duplicates', () => {
    const meta = updateDisposableDomainsFromText(
      'mailinator.com\ncustom-disposable.test\n',
      'test',
    );
    expect(meta.count).toBeGreaterThan(0);
    expect(isDisposableDomain('custom-disposable.test')).toBe(true);
  });
});
