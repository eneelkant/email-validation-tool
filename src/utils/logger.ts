import pino from 'pino';
import { getConfig } from '../config/env.js';

let root: pino.Logger | undefined;

/**
 * Logs must go to stderr so STDIO MCP stdout stays protocol-clean.
 */
export function getLogger(name?: string): pino.Logger {
  if (!root) {
    let level: string = 'info';
    let logEmails = false;
    try {
      const cfg = getConfig();
      level = cfg.logLevel;
      logEmails = cfg.logEmails;
    } catch {
      level = process.env.OPENVERIFY_LOG_LEVEL ?? 'info';
    }
    root = pino(
      {
        name: 'openverify',
        level,
        base: { service: 'openverify-mcp' },
        redact: logEmails
          ? undefined
          : {
              paths: ['email', 'emails', 'normalized_email', '*.email', '*.emails'],
              censor: '[redacted]',
            },
      },
      pino.destination({ dest: 2, sync: false }),
    );
  }
  return name ? root.child({ module: name }) : root;
}

/** Reset logger between tests when env changes. */
export function resetLogger(): void {
  root = undefined;
}

export function hashEmailForLog(email: string): string {
  // Short non-reversible-ish fingerprint for correlation without storing PII in logs by default.
  let h = 2166136261;
  for (let i = 0; i < email.length; i++) {
    h ^= email.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `e_${(h >>> 0).toString(16)}`;
}
