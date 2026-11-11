import { isDisposableDomainListed } from './disposable.js';
import { isFreeProviderDomain } from './free-provider.js';

export const ProviderTypeSchemaValues = ['disposable', 'free', 'custom'] as const;
export type ProviderType = (typeof ProviderTypeSchemaValues)[number];

export type ProviderClassification = {
  provider_type: ProviderType;
  is_disposable: boolean;
  is_free_provider: boolean;
};

/**
 * Classify a normalized email domain.
 * Precedence after normalize: disposable candidate → free → custom,
 * with the hard rule that free providers are never marked disposable.
 */
export function classifyProvider(domain: string): ProviderClassification {
  // Free wins on overlap — never mark free as disposable.
  if (isFreeProviderDomain(domain)) {
    return {
      provider_type: 'free',
      is_disposable: false,
      is_free_provider: true,
    };
  }
  if (isDisposableDomainListed(domain)) {
    return {
      provider_type: 'disposable',
      is_disposable: true,
      is_free_provider: false,
    };
  }
  return {
    provider_type: 'custom',
    is_disposable: false,
    is_free_provider: false,
  };
}

/** Human-readable UI labels for provider classification. */
export function providerTypeLabel(providerType: ProviderType | null | undefined): string | null {
  if (providerType === 'disposable') return 'Disposable email address';
  if (providerType === 'free') return 'Free email provider';
  return null;
}
