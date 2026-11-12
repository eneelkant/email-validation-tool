import type { ValidationResult } from '../types/results.js';
import { validateSyntax } from './syntax.js';
import { classifyProvider } from './provider.js';

/**
 * True when free-provider classification is absent or incomplete.
 * Covers:
 * - Pre-PR#13 rows that omit the keys entirely
 * - Valid-syntax rows with `null` / `undefined` (or partial null) that must be rehydrated
 *
 * Invalid-syntax results intentionally carry nulls; callers still see this as
 * "incomplete keys" and `ensureProviderClassification` preserves those nulls.
 */
export function missingProviderClassification(
  result: Partial<ValidationResult> | null | undefined,
): boolean {
  if (!result || typeof result !== 'object') return true;
  if (!('is_free_provider' in result) || !('provider_type' in result)) return true;
  // null / undefined on either field ⇒ incomplete (partial null included).
  if (result.is_free_provider == null || result.provider_type == null) return true;
  return false;
}

/**
 * Ensure ValidationResult always carries usable is_free_provider + provider_type
 * for syntax-valid emails. Re-classifies when fields were omitted or null
 * (stale cache / older deploy / partial null). Invalid syntax keeps nulls.
 * Complete valid results are returned unchanged.
 */
export function ensureProviderClassification(
  result: ValidationResult,
): ValidationResult {
  if (!result.syntax_valid) {
    // Invalid syntax: null provider fields are the contract — never invent class.
    return {
      ...result,
      is_disposable: result.is_disposable ?? null,
      is_free_provider: null,
      provider_type: null,
    };
  }

  if (!missingProviderClassification(result)) {
    return result;
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
