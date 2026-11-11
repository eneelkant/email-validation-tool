import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { getConfig } from '../config/env.js';
import type { CatchAllStatus, SmtpStatus } from '../types/results.js';
import { getLogger } from '../utils/logger.js';
import type { SmtpDiagResult } from './smtp.js';

const log = getLogger('reacher');

/** MailSure-owned Safe/Risky/Invalid/Unknown facet — never a copy of Reacher `is_reachable`. */
export type ReachabilityClass = 'safe' | 'risky' | 'invalid' | 'unknown';

const CoreErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
});

const SmtpDetailsSchema = z.object({
  can_connect_smtp: z.boolean(),
  has_full_inbox: z.boolean(),
  is_catch_all: z.boolean(),
  is_deliverable: z.boolean(),
  is_disabled: z.boolean(),
});

const MiscDetailsSchema = z.object({
  is_disposable: z.boolean().optional(),
  is_role_account: z.boolean().optional(),
});

const ReacherResponseSchema = z.object({
  input: z.string().optional(),
  is_reachable: z.enum(['safe', 'risky', 'invalid', 'unknown']).optional(),
  misc: z.union([MiscDetailsSchema, CoreErrorSchema]).optional(),
  smtp: z.union([SmtpDetailsSchema, CoreErrorSchema]).optional(),
  syntax: z
    .object({
      is_valid_syntax: z.boolean().optional(),
      domain: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
});

export type ReacherCheckResult = {
  /** True when HTTP/timeout/parse failed — callers may fall back to local SMTP. */
  transportFailed: boolean;
  smtp: SmtpDiagResult;
  catch_all_status: CatchAllStatus;
  catch_all_reason_codes: string[];
  /** Opaque upstream hint only — never use as product verdict. */
  is_reachable_hint?: ReachabilityClass;
};

export type ReacherFetch = typeof fetch;

/**
 * Map MailSure validation signals to Safe/Risky/Invalid/Unknown.
 * Does not read Reacher `is_reachable`.
 */
export function classifyReachability(signals: {
  syntaxValid: boolean;
  dnsTemporary: boolean;
  domainExists: boolean | null;
  mxExists: boolean | null;
  disposable: boolean;
  role: boolean;
  smtpStatus: SmtpStatus;
  catchAll: CatchAllStatus;
}): ReachabilityClass {
  if (!signals.syntaxValid) return 'invalid';
  if (signals.dnsTemporary || signals.domainExists === null) return 'unknown';
  if (signals.domainExists === false || signals.mxExists === false) return 'invalid';
  if (signals.disposable || signals.role || signals.catchAll === 'yes') return 'risky';
  if (signals.smtpStatus === 'invalid') return 'invalid';
  if (signals.smtpStatus === 'temporary_error') return 'risky';
  if (signals.smtpStatus === 'blocked' || signals.smtpStatus === 'unknown') return 'unknown';
  if (signals.smtpStatus === 'ok') return 'safe';
  // not_checked: domain-only hygiene — do not claim Safe without SMTP evidence
  return 'unknown';
}

/**
 * Map Reacher SMTP details into MailSure smtp_status.
 * Source of truth is smtp.* fields — not is_reachable.
 */
export function mapReacherSmtpToDiag(
  smtp: z.infer<typeof SmtpDetailsSchema> | z.infer<typeof CoreErrorSchema> | undefined,
  extras: string[] = [],
): SmtpDiagResult {
  if (!smtp) {
    return { status: 'unknown', reason_codes: ['REACHER_SMTP_MISSING', ...extras] };
  }
  if ('type' in smtp && 'message' in smtp && !('can_connect_smtp' in smtp)) {
    return {
      status: 'unknown',
      reason_codes: [
        'REACHER_SMTP_ERROR',
        `REACHER_ERR_${smtp.type.slice(0, 40)}`,
        ...extras,
      ],
    };
  }

  const details = smtp as z.infer<typeof SmtpDetailsSchema>;
  const reason_codes = ['REACHER_SMTP', ...extras];

  if (details.has_full_inbox) {
    reason_codes.push('REACHER_FULL_INBOX');
    return { status: 'temporary_error', reason_codes };
  }
  if (!details.can_connect_smtp) {
    reason_codes.push('REACHER_NO_CONNECT');
    // Temporary/unknown path — never invent Invalid on connect failure
    return { status: 'temporary_error', reason_codes };
  }
  if (details.is_disabled) {
    reason_codes.push('REACHER_DISABLED');
    return { status: 'invalid', reason_codes };
  }
  if (details.is_deliverable) {
    reason_codes.push('REACHER_DELIVERABLE');
    return { status: 'ok', reason_codes };
  }
  // Connected but not deliverable
  reason_codes.push('REACHER_NOT_DELIVERABLE');
  if (details.is_catch_all) {
    // Catch-all accept/reject is inconclusive for a specific mailbox
    return { status: 'unknown', reason_codes };
  }
  return { status: 'invalid', reason_codes };
}

export function mapReacherCatchAll(
  smtp: z.infer<typeof SmtpDetailsSchema> | z.infer<typeof CoreErrorSchema> | undefined,
): { status: CatchAllStatus; reason_codes: string[] } {
  if (!smtp || ('type' in smtp && !('is_catch_all' in smtp))) {
    return { status: 'unknown', reason_codes: ['REACHER_CATCH_ALL_UNKNOWN'] };
  }
  const details = smtp as z.infer<typeof SmtpDetailsSchema>;
  if (details.is_catch_all) {
    return { status: 'yes', reason_codes: ['REACHER_CATCH_ALL_YES'] };
  }
  return { status: 'no', reason_codes: ['REACHER_CATCH_ALL_NO'] };
}

function hintReasonCode(hint: string | undefined): string[] {
  if (!hint) return [];
  return [`REACHER_HINT_${hint.toUpperCase()}`];
}

function miscReasonCodes(
  misc: z.infer<typeof MiscDetailsSchema> | z.infer<typeof CoreErrorSchema> | undefined,
): string[] {
  if (!misc || 'type' in misc) return [];
  const codes: string[] = [];
  if (misc.is_disposable) codes.push('REACHER_MISC_DISPOSABLE');
  if (misc.is_role_account) codes.push('REACHER_MISC_ROLE');
  return codes;
}

function transportFailureResult(
  status: SmtpStatus,
  reason_codes: string[],
): ReacherCheckResult {
  return {
    transportFailed: true,
    smtp: { status, reason_codes },
    catch_all_status: 'not_checked',
    catch_all_reason_codes: ['REACHER_CATCH_ALL_SKIPPED'],
  };
}

/**
 * POST /v1/check_email on the configured Reacher origin.
 * Failures/timeouts map to temporary_error/unknown — never false Invalid.
 */
export async function checkEmailWithReacher(
  email: string,
  config: AppConfig = getConfig(),
  fetchImpl: ReacherFetch = fetch,
): Promise<ReacherCheckResult> {
  if (!config.reacherEnabled) {
    return transportFailureResult('not_checked', ['REACHER_DISABLED']);
  }
  if (!config.reacherApiUrl) {
    return transportFailureResult('unknown', ['REACHER_URL_MISSING']);
  }

  const url = `${config.reacherApiUrl}/v1/check_email`;
  const timeoutMs = config.reacherTimeoutMs;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ to_email: email }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      log.debug({ status: res.status }, 'Reacher HTTP error');
      // 5xx / 429 / etc. → temporary, never Invalid
      return transportFailureResult('temporary_error', [
        'REACHER_HTTP_ERROR',
        `REACHER_HTTP_${res.status}`,
      ]);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return transportFailureResult('unknown', ['REACHER_INVALID_JSON']);
    }

    const parsed = ReacherResponseSchema.safeParse(json);
    if (!parsed.success) {
      return transportFailureResult('unknown', ['REACHER_SCHEMA_MISMATCH']);
    }

    const data = parsed.data;
    const hintExtras = [
      ...hintReasonCode(data.is_reachable),
      ...miscReasonCodes(data.misc),
    ];
    const smtp = mapReacherSmtpToDiag(data.smtp, hintExtras);
    const catchAll = mapReacherCatchAll(data.smtp);

    return {
      transportFailed: false,
      smtp,
      catch_all_status: catchAll.status,
      catch_all_reason_codes: catchAll.reason_codes,
      is_reachable_hint: data.is_reachable,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    const timedOut =
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      /timeout|aborted/i.test(msg);

    log.debug({ err: msg.slice(0, 120) }, 'Reacher request failed');

    if (timedOut) {
      return transportFailureResult('temporary_error', ['REACHER_TIMEOUT']);
    }
    return transportFailureResult('temporary_error', [
      'REACHER_NETWORK_ERROR',
      msg.slice(0, 80),
    ]);
  }
}
