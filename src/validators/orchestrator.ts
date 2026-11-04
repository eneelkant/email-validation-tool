import type { AppConfig } from '../config/env.js';
import { getConfig } from '../config/env.js';
import type { Confidence, OverallStatus, ValidationResult } from '../types/results.js';
import { detectCatchAll } from './catch-all.js';
import { lookupDomainDns } from './dns.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleBasedLocalPart } from './role.js';
import { diagnoseSmtp } from './smtp.js';
import { validateSyntax } from './syntax.js';

export type ValidateOptions = {
  skipCache?: boolean;
  enableSmtp?: boolean;
  enableCatchAll?: boolean;
  /** Injected DNS override for tests */
  dnsLookup?: typeof lookupDomainDns;
};

export async function validateEmail(
  rawEmail: string,
  options: ValidateOptions = {},
  config: AppConfig = getConfig(),
): Promise<ValidationResult> {
  const checked_at = new Date().toISOString();
  const syntax = validateSyntax(rawEmail);

  if (!syntax.syntax_valid) {
    return {
      email: syntax.email,
      normalized_email: syntax.normalized_email || syntax.email.trim(),
      syntax_valid: false,
      domain_exists: null,
      mx_exists: null,
      is_disposable: null,
      is_role_based: null,
      smtp_status: 'not_checked',
      catch_all_status: 'not_checked',
      overall_status: 'invalid_syntax',
      confidence: 'high',
      reason_codes: syntax.reason_codes,
      checked_at,
    };
  }

  const dnsFn = options.dnsLookup ?? lookupDomainDns;
  const dns = await dnsFn(syntax.domain);
  const disposable = isDisposableDomain(syntax.domain);
  const role = isRoleBasedLocalPart(syntax.local);

  const reason_codes = [...syntax.reason_codes];
  if (dns.error_code) reason_codes.push(dns.error_code);
  if (disposable) reason_codes.push('DISPOSABLE_DOMAIN');
  if (role) reason_codes.push('ROLE_BASED');

  const smtp_status = await (async () => {
    const wantSmtp = options.enableSmtp ?? config.smtpEnabled;
    if (!wantSmtp) return diagnoseSmtp(syntax.normalized_email, []);
    return diagnoseSmtp(syntax.normalized_email, dns.mx_hosts);
  })();

  const catch_all_status = await (async () => {
    const want = options.enableCatchAll ?? config.catchAllEnabled;
    if (!want) return detectCatchAll(syntax.domain, []);
    return detectCatchAll(syntax.domain, dns.mx_hosts);
  })();

  if (smtp_status.reason_codes.length) reason_codes.push(...smtp_status.reason_codes);
  if (catch_all_status.reason_codes.length) reason_codes.push(...catch_all_status.reason_codes);

  const { overall_status, confidence } = decideOverall({
    dnsTemporary: dns.temporary,
    domainExists: dns.domain_exists,
    mxExists: dns.mx_exists,
    disposable,
    role,
    smtpStatus: smtp_status.status,
    catchAll: catch_all_status.status,
  });

  return {
    email: syntax.email,
    normalized_email: syntax.normalized_email,
    syntax_valid: true,
    domain_exists: dns.domain_exists,
    mx_exists: dns.mx_exists,
    is_disposable: disposable,
    is_role_based: role,
    smtp_status: smtp_status.status,
    catch_all_status: catch_all_status.status,
    overall_status,
    confidence,
    reason_codes: [...new Set(reason_codes)],
    checked_at,
    mx_hosts: dns.mx_hosts,
  };
}

function decideOverall(input: {
  dnsTemporary: boolean;
  domainExists: boolean | null;
  mxExists: boolean | null;
  disposable: boolean;
  role: boolean;
  smtpStatus: ValidationResult['smtp_status'];
  catchAll: ValidationResult['catch_all_status'];
}): { overall_status: OverallStatus; confidence: Confidence } {
  if (input.dnsTemporary || input.domainExists === null) {
    return { overall_status: 'temporary_error', confidence: 'low' };
  }
  if (input.domainExists === false) {
    return { overall_status: 'invalid_domain', confidence: 'high' };
  }
  if (input.mxExists === false) {
    return { overall_status: 'no_mx', confidence: 'high' };
  }
  if (input.disposable) {
    return { overall_status: 'disposable', confidence: 'high' };
  }
  if (input.smtpStatus === 'invalid') {
    return { overall_status: 'risky', confidence: 'medium' };
  }
  if (input.role || input.catchAll === 'yes' || input.smtpStatus === 'temporary_error') {
    return { overall_status: 'risky', confidence: 'medium' };
  }
  if (input.smtpStatus === 'blocked' || input.smtpStatus === 'unknown') {
    return { overall_status: 'unknown', confidence: 'low' };
  }
  // Domain + MX look good. This does NOT prove the mailbox exists.
  return { overall_status: 'valid_domain', confidence: 'medium' };
}

export async function checkDomain(domainRaw: string) {
  const syntax = validateSyntax(`probe@${domainRaw.trim()}`);
  const domain = syntax.syntax_valid ? syntax.domain : domainRaw.trim().toLowerCase();
  const dns = await lookupDomainDns(domain);
  return {
    domain: domainRaw,
    normalized_domain: domain,
    domain_exists: dns.domain_exists,
    mx_exists: dns.mx_exists,
    a_records: dns.a_records,
    aaaa_records: dns.aaaa_records,
    mx_hosts: dns.mx_hosts,
    is_disposable: isDisposableDomain(domain),
    dns_error: dns.error_code,
    checked_at: new Date().toISOString(),
  };
}
