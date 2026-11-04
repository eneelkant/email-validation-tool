export type SyntaxParseResult = {
  syntax_valid: boolean;
  email: string;
  normalized_email: string;
  local: string;
  domain: string;
  reason_codes: string[];
};

/**
 * RFC-aware pragmatic email syntax check.
 * Preserves the original address; normalizes domain to lowercase ASCII where possible.
 * Intentionally not an ultra-strict regex that rejects legitimate addresses.
 */
export function validateSyntax(raw: string): SyntaxParseResult {
  const email = typeof raw === 'string' ? raw : String(raw ?? '');
  const trimmed = email.trim();
  const reason_codes: string[] = [];

  if (!trimmed) {
    return {
      syntax_valid: false,
      email,
      normalized_email: '',
      local: '',
      domain: '',
      reason_codes: ['EMPTY'],
    };
  }

  if (trimmed !== email) {
    reason_codes.push('WHITESPACE_TRIMMED');
  }

  if (trimmed.length > 254) {
    return {
      syntax_valid: false,
      email,
      normalized_email: trimmed,
      local: '',
      domain: '',
      reason_codes: [...reason_codes, 'TOO_LONG'],
    };
  }

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    return {
      syntax_valid: false,
      email,
      normalized_email: trimmed,
      local: '',
      domain: '',
      reason_codes: [...reason_codes, 'MISSING_AT'],
    };
  }

  const local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  if (local.length > 64) {
    reason_codes.push('LOCAL_TOO_LONG');
    return invalid(email, trimmed, local, domain, reason_codes);
  }

  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    reason_codes.push('LOCAL_DOTS');
    return invalid(email, trimmed, local, domain, reason_codes);
  }

  // Quoted local-part: accept basic quoted form
  const quoted = local.startsWith('"') && local.endsWith('"') && local.length >= 2;
  if (!quoted) {
    // Allow common atom characters including + and !
    if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) {
      // Soft-fail only if clearly broken control chars
      // Reject whitespace / separators / ASCII controls in unquoted local-parts
      // eslint-disable-next-line no-control-regex -- intentional control-char check
      if (/[\s<>()[\]\\,;:\x00-\x1f]/.test(local)) {
        reason_codes.push('LOCAL_INVALID_CHARS');
        return invalid(email, trimmed, local, domain, reason_codes);
      }
      reason_codes.push('LOCAL_UNUSUAL_CHARS');
    }
  }

  // Strip trailing dot on domain (common in DNS contexts)
  if (domain.endsWith('.')) {
    domain = domain.slice(0, -1);
    reason_codes.push('DOMAIN_TRAILING_DOT');
  }

  if (!domain || domain.includes('..') || domain.startsWith('-') || domain.endsWith('-')) {
    reason_codes.push('DOMAIN_MALFORMED');
    return invalid(email, trimmed, local, domain, reason_codes);
  }

  // Domain labels
  const labels = domain.split('.');
  if (labels.length < 2) {
    reason_codes.push('DOMAIN_NO_TLD');
    return invalid(email, trimmed, local, domain, reason_codes);
  }

  for (const label of labels) {
    if (!label || label.length > 63) {
      reason_codes.push('DOMAIN_LABEL_INVALID');
      return invalid(email, trimmed, local, domain, reason_codes);
    }
    // Allow IDNA / Unicode labels; reject spaces and @
    if (/[\s@]/.test(label)) {
      reason_codes.push('DOMAIN_INVALID_CHARS');
      return invalid(email, trimmed, local, domain, reason_codes);
    }
  }

  let asciiDomain = domain.toLowerCase();
  try {
    // Convert Unicode domains to punycode via URL
    asciiDomain = new URL(`http://${domain}`).hostname.toLowerCase();
  } catch {
    reason_codes.push('DOMAIN_IDNA_FAILED');
    return invalid(email, trimmed, local, domain, reason_codes);
  }

  const normalized_email = `${local}@${asciiDomain}`;
  return {
    syntax_valid: true,
    email,
    normalized_email,
    local,
    domain: asciiDomain,
    reason_codes,
  };
}

function invalid(
  email: string,
  normalized_email: string,
  local: string,
  domain: string,
  reason_codes: string[],
): SyntaxParseResult {
  return {
    syntax_valid: false,
    email,
    normalized_email,
    local,
    domain,
    reason_codes,
  };
}
