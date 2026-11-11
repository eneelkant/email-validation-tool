import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { getConfig } from '../config/env.js';
import type { CatchAllStatus, SmtpStatus } from '../types/results.js';
import { getLogger } from '../utils/logger.js';
import type { SmtpDiagResult } from './smtp.js';

const log = getLogger('reacher');

/** MailSure-owned Safe/Risky/Invalid/Unknown facet — never a copy of Reacher `is_reachable`. */
export type ReachabilityClass = 'safe' | 'risky' | 'invalid' | 'unknown';

/** Absolute ceiling so operators cannot hang website/MCP requests unboundedly. */
export const REACHER_TIMEOUT_MAX_MS = 60_000;

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

/**
 * Real Reacher/check-if-email-exists responses often serialize SMTP `Err` as nested:
 *   { "smtp": { "error": { "type": "AsyncSmtpError", "message": "..." }, "description": "..." } }
 * OpenAPI also documents a flat CoreError at the `smtp` field. Accept both.
 */
const SmtpNestedErrorSchema = z.object({
  error: CoreErrorSchema,
  description: z.string().optional(),
});

const MiscDetailsSchema = z.object({
  is_disposable: z.boolean().optional(),
  is_role_account: z.boolean().optional(),
});

const SmtpFieldSchema = z.union([
  SmtpDetailsSchema,
  SmtpNestedErrorSchema,
  CoreErrorSchema,
]);

export const ReacherResponseSchema = z.object({
  input: z.string().optional(),
  is_reachable: z.enum(['safe', 'risky', 'invalid', 'unknown']).optional(),
  misc: z.union([MiscDetailsSchema, CoreErrorSchema, SmtpNestedErrorSchema]).optional(),
  mx: z
    .union([
      z.object({
        accepts_mail: z.boolean().optional(),
        records: z.array(z.string()).optional(),
      }),
      CoreErrorSchema,
      SmtpNestedErrorSchema,
    ])
    .optional(),
  smtp: SmtpFieldSchema.optional(),
  syntax: z
    .object({
      is_valid_syntax: z.boolean().optional(),
      domain: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
});

export type ReacherSmtpField = z.infer<typeof SmtpFieldSchema>;
export type ReacherCoreError = z.infer<typeof CoreErrorSchema>;

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

function isCoreError(value: unknown): value is ReacherCoreError {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    'message' in value &&
    !('can_connect_smtp' in value) &&
    !('error' in value)
  );
}

function isNestedSmtpError(
  value: unknown,
): value is z.infer<typeof SmtpNestedErrorSchema> {
  return (
    !!value &&
    typeof value === 'object' &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'object' &&
    (value as { error: { type?: unknown } }).error !== null &&
    'type' in ((value as { error: object }).error ?? {}) &&
    'message' in ((value as { error: object }).error ?? {})
  );
}

function extractSmtpCoreError(
  smtp: ReacherSmtpField | undefined,
): (ReacherCoreError & { description?: string }) | null {
  if (!smtp) return null;
  if (isNestedSmtpError(smtp)) {
    return { ...smtp.error, description: smtp.description };
  }
  if (isCoreError(smtp)) return smtp;
  return null;
}

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

function mapCoreErrorToDiag(
  err: ReacherCoreError & { description?: string },
  extras: string[],
): SmtpDiagResult {
  const reason_codes = [
    'REACHER_SMTP_ERROR',
    `REACHER_ERR_${err.type.slice(0, 40)}`,
    ...extras,
  ];
  if (err.description) {
    reason_codes.push(`REACHER_DESC_${err.description.slice(0, 40)}`);
  }
  // Transient SMTP / timeout-like messages → temporary_error (never Invalid)
  if (/transient|timeout|temporar|greylist|try again|4\.\d\.\d/i.test(err.message)) {
    reason_codes.push('REACHER_SMTP_TRANSIENT');
    return { status: 'temporary_error', reason_codes };
  }
  return { status: 'unknown', reason_codes };
}

/**
 * Map Reacher SMTP details / nested smtp.error into MailSure smtp_status.
 * Source of truth is smtp.* fields — not is_reachable.
 */
export function mapReacherSmtpToDiag(
  smtp: ReacherSmtpField | undefined,
  extras: string[] = [],
): SmtpDiagResult {
  if (!smtp) {
    return { status: 'unknown', reason_codes: ['REACHER_SMTP_MISSING', ...extras] };
  }

  const coreErr = extractSmtpCoreError(smtp);
  if (coreErr) {
    return mapCoreErrorToDiag(coreErr, extras);
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
  smtp: ReacherSmtpField | undefined,
): { status: CatchAllStatus; reason_codes: string[] } {
  if (!smtp || extractSmtpCoreError(smtp) || !('is_catch_all' in smtp)) {
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
  misc: z.infer<typeof MiscDetailsSchema> | z.infer<typeof CoreErrorSchema> | z.infer<typeof SmtpNestedErrorSchema> | undefined,
): string[] {
  if (!misc || isCoreError(misc) || isNestedSmtpError(misc)) return [];
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
 * Clamp configured timeout into a safe request budget.
 * Default 15s; hard ceiling REACHER_TIMEOUT_MAX_MS so cold-start waits stay bounded.
 */
export function safeReacherTimeoutMs(configuredMs: number): number {
  if (!Number.isFinite(configuredMs) || configuredMs <= 0) return 15_000;
  return Math.min(Math.max(1_000, Math.floor(configuredMs)), REACHER_TIMEOUT_MAX_MS);
}

/**
 * Safe timeout strategy for sync Reacher calls:
 * - AbortController cancels the in-flight fetch
 * - Promise.race hard-deadline still resolves if a mock/native fetch ignores abort
 * - Outcome is always temporary_error on timeout — never Invalid
 *
 * Reacher `/v1/check_email` is request/response (server may queue internally); MailSure
 * does not poll a separate job API. Bound wait + fail-soft is the async-safe client strategy.
 */
export async function fetchWithSafeTimeout(
  fetchImpl: ReacherFetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
): Promise<Response> {
  const budget = safeReacherTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`Reacher request timed out after ${budget}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, budget);
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const timeoutMs = safeReacherTimeoutMs(config.reacherTimeoutMs);

  try {
    const res = await fetchWithSafeTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ to_email: email }),
      },
      timeoutMs,
    );

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
