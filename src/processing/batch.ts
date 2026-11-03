import { getConfig } from '../config/env.js';
import {
  getCachedValidation,
  setCachedValidation,
} from '../database/db.js';
import type { ValidationResult } from '../types/results.js';
import { mapPool } from '../utils/concurrency.js';
import { validateSyntax } from '../validators/syntax.js';
import { validateEmail } from '../validators/orchestrator.js';

export async function verifyEmailsBatch(
  emails: string[],
  options?: {
    concurrency?: number;
    skipCache?: boolean;
    shouldStop?: () => boolean;
  },
): Promise<ValidationResult[]> {
  const cfg = getConfig();
  const concurrency = options?.concurrency ?? cfg.concurrency;

  return mapPool(
    emails,
    concurrency,
    async (email) => {
      const syntax = validateSyntax(email);
      if (syntax.syntax_valid && !options?.skipCache) {
        const cached = getCachedValidation(syntax.normalized_email);
        if (cached) return cached;
      }
      const result = await validateEmail(email);
      if (result.syntax_valid && result.overall_status !== 'temporary_error') {
        setCachedValidation(result);
      }
      return result;
    },
    { shouldStop: options?.shouldStop },
  );
}
