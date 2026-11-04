import { describe, expect, it } from 'vitest';
import { validateSyntax } from '../src/validators/syntax.js';

describe('validateSyntax', () => {
  it('accepts common addresses', () => {
    const r = validateSyntax('john.doe+tag@Example.COM');
    expect(r.syntax_valid).toBe(true);
    expect(r.normalized_email).toBe('john.doe+tag@example.com');
    expect(r.domain).toBe('example.com');
  });

  it('trims whitespace without rejecting', () => {
    const r = validateSyntax('  user@example.com  ');
    expect(r.syntax_valid).toBe(true);
    expect(r.reason_codes).toContain('WHITESPACE_TRIMMED');
  });

  it('rejects missing at', () => {
    const r = validateSyntax('not-an-email');
    expect(r.syntax_valid).toBe(false);
    expect(r.reason_codes).toContain('MISSING_AT');
  });

  it('rejects empty', () => {
    expect(validateSyntax('').syntax_valid).toBe(false);
  });

  it('rejects domain without TLD', () => {
    const r = validateSyntax('a@localhost');
    expect(r.syntax_valid).toBe(false);
    expect(r.reason_codes).toContain('DOMAIN_NO_TLD');
  });
});
