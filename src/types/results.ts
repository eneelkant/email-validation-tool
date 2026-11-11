import { z } from 'zod';

export const OverallStatusSchema = z.enum([
  'valid_domain',
  'invalid_syntax',
  'invalid_domain',
  'no_mx',
  'disposable',
  'risky',
  'unknown',
  'temporary_error',
]);

export type OverallStatus = z.infer<typeof OverallStatusSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SmtpStatusSchema = z.enum([
  'not_checked',
  'ok',
  'invalid',
  'temporary_error',
  'blocked',
  'unknown',
]);
export type SmtpStatus = z.infer<typeof SmtpStatusSchema>;

export const CatchAllStatusSchema = z.enum([
  'not_checked',
  'yes',
  'no',
  'unknown',
]);
export type CatchAllStatus = z.infer<typeof CatchAllStatusSchema>;

/** Mutually exclusive provider class after normalize (null when syntax invalid). */
export const ProviderTypeSchema = z.enum(['disposable', 'free', 'custom']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ValidationResultSchema = z.object({
  email: z.string(),
  normalized_email: z.string(),
  syntax_valid: z.boolean(),
  domain_exists: z.boolean().nullable(),
  mx_exists: z.boolean().nullable(),
  is_disposable: z.boolean().nullable(),
  is_free_provider: z.boolean().nullable(),
  provider_type: ProviderTypeSchema.nullable(),
  is_role_based: z.boolean().nullable(),
  smtp_status: SmtpStatusSchema,
  catch_all_status: CatchAllStatusSchema,
  overall_status: OverallStatusSchema,
  confidence: ConfidenceSchema,
  reason_codes: z.array(z.string()),
  checked_at: z.string(),
  mx_hosts: z.array(z.string()).optional(),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const DomainCheckResultSchema = z.object({
  domain: z.string(),
  normalized_domain: z.string(),
  domain_exists: z.boolean().nullable(),
  mx_exists: z.boolean().nullable(),
  a_records: z.array(z.string()),
  aaaa_records: z.array(z.string()),
  mx_hosts: z.array(z.string()),
  is_disposable: z.boolean(),
  is_free_provider: z.boolean(),
  provider_type: ProviderTypeSchema,
  dns_error: z.string().nullable(),
  checked_at: z.string(),
});

export type DomainCheckResult = z.infer<typeof DomainCheckResultSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;
