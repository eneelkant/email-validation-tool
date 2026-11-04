import { getConfig } from '../config/env.js';
import type { CatchAllStatus } from '../types/results.js';
import { diagnoseSmtp } from './smtp.js';

export type CatchAllResult = {
  status: CatchAllStatus;
  reason_codes: string[];
};

/**
 * Best-effort catch-all detection using a single random RCPT probe.
 * Avoids repeated probes. Returns unknown when inconclusive.
 * Never classifies catch-all domains as invalid.
 */
export async function detectCatchAll(
  domain: string,
  mxHosts: string[],
): Promise<CatchAllResult> {
  const cfg = getConfig();
  if (!cfg.catchAllEnabled || !cfg.smtpEnabled) {
    return { status: 'not_checked', reason_codes: ['CATCH_ALL_DISABLED'] };
  }
  if (mxHosts.length === 0) {
    return { status: 'unknown', reason_codes: ['CATCH_ALL_NO_MX'] };
  }

  const randomLocal = `ov_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const probeEmail = `${randomLocal}@${domain}`;
  const result = await diagnoseSmtp(probeEmail, mxHosts);

  if (result.status === 'ok') {
    return { status: 'yes', reason_codes: ['CATCH_ALL_ACCEPTS_RANDOM', ...result.reason_codes] };
  }
  if (result.status === 'invalid') {
    return { status: 'no', reason_codes: ['CATCH_ALL_REJECTS_RANDOM', ...result.reason_codes] };
  }
  return { status: 'unknown', reason_codes: ['CATCH_ALL_INCONCLUSIVE', ...result.reason_codes] };
}
