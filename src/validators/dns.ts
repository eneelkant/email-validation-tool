import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { getConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('dns');

export type DnsLookupResult = {
  domain: string;
  domain_exists: boolean | null;
  mx_exists: boolean | null;
  a_records: string[];
  aaaa_records: string[];
  mx_hosts: string[];
  error_code: string | null;
  temporary: boolean;
};

function createResolver(): Resolver {
  const cfg = getConfig();
  const resolver = new Resolver();
  if (cfg.dnsServers.length > 0) {
    resolver.setServers(cfg.dnsServers);
  }
  return resolver;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS_TIMEOUT'), { code: 'DNS_TIMEOUT' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyDnsError(err: unknown): { code: string; temporary: boolean; nxdomain: boolean } {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'DNS_ERROR';

  if (code === 'DNS_TIMEOUT' || code === 'ETIMEOUT') {
    return { code: 'DNS_TIMEOUT', temporary: true, nxdomain: false };
  }
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === dns.NODATA || code === 'NXDOMAIN') {
    // ENODATA for MX often means no MX but domain may still exist via A
    return { code, temporary: false, nxdomain: code === 'ENOTFOUND' || code === 'NXDOMAIN' };
  }
  if (code === 'ESERVFAIL' || code === 'EREFUSED' || code === 'ECONNREFUSED') {
    return { code, temporary: true, nxdomain: false };
  }
  return { code, temporary: true, nxdomain: false };
}

/**
 * Resolve MX / A / AAAA for a domain.
 * DNS timeouts and temporary failures must NOT be treated as invalid email.
 */
export async function lookupDomainDns(domain: string): Promise<DnsLookupResult> {
  const cfg = getConfig();
  const resolver = createResolver();
  const timeout = cfg.dnsTimeoutMs;

  let mx_hosts: string[] = [];
  let a_records: string[] = [];
  let aaaa_records: string[] = [];
  let mxError: ReturnType<typeof classifyDnsError> | null = null;
  let aError: ReturnType<typeof classifyDnsError> | null = null;

  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeout);
    mx_hosts = mx
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
  } catch (err) {
    mxError = classifyDnsError(err);
    log.debug({ domain, code: mxError.code }, 'MX lookup failed');
  }

  try {
    a_records = await withTimeout(resolver.resolve4(domain), timeout);
  } catch (err) {
    aError = classifyDnsError(err);
  }

  try {
    aaaa_records = await withTimeout(resolver.resolve6(domain), timeout);
  } catch {
    // AAAA absence is common; ignore unless both A and MX fail
  }

  const hasAddress = a_records.length > 0 || aaaa_records.length > 0;
  const hasMx = mx_hosts.length > 0;

  // Temporary DNS failure: do not claim domain invalid
  if (!hasMx && !hasAddress) {
    const temp = Boolean(mxError?.temporary || aError?.temporary);
    const nx = Boolean(mxError?.nxdomain || aError?.nxdomain);
    if (temp && !nx) {
      return {
        domain,
        domain_exists: null,
        mx_exists: null,
        a_records,
        aaaa_records,
        mx_hosts,
        error_code: mxError?.code ?? aError?.code ?? 'DNS_TEMPORARY',
        temporary: true,
      };
    }
    if (nx || (mxError && !mxError.temporary && aError && !aError.temporary)) {
      return {
        domain,
        domain_exists: false,
        mx_exists: false,
        a_records,
        aaaa_records,
        mx_hosts,
        error_code: mxError?.code ?? aError?.code ?? 'NXDOMAIN',
        temporary: false,
      };
    }
    // ENODATA-only for both → treat as no mail / no host
    return {
      domain,
      domain_exists: false,
      mx_exists: false,
      a_records,
      aaaa_records,
      mx_hosts,
      error_code: mxError?.code ?? aError?.code ?? 'NO_RECORDS',
      temporary: false,
    };
  }

  return {
    domain,
    domain_exists: true,
    mx_exists: hasMx || hasAddress, // implicit MX via A/AAAA per SMTP fallback
    a_records,
    aaaa_records,
    mx_hosts: hasMx ? mx_hosts : hasAddress ? [domain] : [],
    error_code: null,
    temporary: false,
  };
}
