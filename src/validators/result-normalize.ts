import type { ValidationResult } from '../types/results.js';
import { validateSyntax } from './syntax.js';
import { classifyProvider } from './provider.js';

/**
 * True when a cached / legacy payload is missing free-provider classification fields.
 * Pre-PR#13 results omit these keys entirely; CSV / UI then emit blank cells.
 */
export function missingProviderClassification(
  result: Partial<ValidationResult> | null | undefined,
): boolean {
  if (!result || typeof result !== 'object') return true;
  return (
    !('is_free_provider' in result) ||
    !('provider_type' in result) ||
    result.is_free_provider === undefined ||
    result.provider_type === undefined
  );
}

/**
 * Ensure ValidationResult always carries is_free_provider + provider_type.
 * Re-classifies from the normalized email domain when fields were omitted (stale
 * cache / older deploy artifact). Does not invent disposable/DNS/SMTP outcomes.
 */
export function ensureProviderClassification(
  result: ValidationResult,
): ValidationResult {
  if (!missingProviderClassification(result)) {
    return result;
  }

  if (!result.syntax_valid) {
    return {
      ...result,
      is_disposable: result.is_disposable ?? null,
      is_free_provider: null,
      provider_type: null,
    };
  }

  const syntax = validateSyntax(result.normalized_email || result.email);
  const domain = syntax.syntax_valid
    ? syntax.domain
    : String(result.normalized_email || result.email)
        .split('@')
        .pop()
        ?.toLowerCase()
        .trim() || '';
  const provider = classifyProvider(domain);
  const reason_codes = [...(result.reason_codes ?? [])];
  if (provider.is_free_provider && !reason_codes.includes('FREE_EMAIL_PROVIDER')) {
    reason_codes.push('FREE_EMAIL_PROVIDER');
  }
  if (provider.is_disposable && !reason_codes.includes('DISPOSABLE_DOMAIN')) {
    reason_codes.push('DISPOSABLE_DOMAIN');
  }

  return {
    ...result,
    is_disposable: provider.is_disposable,
    is_free_provider: provider.is_free_provider,
    provider_type: provider.provider_type,
    reason_codes: [...new Set(reason_codes)],
  };
}
