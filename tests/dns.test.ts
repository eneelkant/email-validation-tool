import './setup-env.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { lookupDomainDns } from '../src/validators/dns.js';

describe('lookupDomainDns', () => {
  beforeAll(() => {
    resetConfigCache();
    loadConfig();
  });

  it('resolves example.com MX or A', async () => {
    const r = await lookupDomainDns('example.com');
    // example.com is reserved and typically has A records; MX may vary
    expect(r.temporary === true || r.domain_exists === true).toBe(true);
    if (r.domain_exists) {
      expect(r.a_records.length + r.aaaa_records.length + r.mx_hosts.length).toBeGreaterThan(0);
    }
  });

  it('marks clearly nonexistent domains without treating timeout as invalid when NXDOMAIN', async () => {
    const r = await lookupDomainDns('this-domain-definitely-does-not-exist-openverify-test.invalid');
    // .invalid is reserved and should NXDOMAIN; if DNS is flaky, temporary is also acceptable
    if (!r.temporary) {
      expect(r.domain_exists).toBe(false);
    }
  });
});
