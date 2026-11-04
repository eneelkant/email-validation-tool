import net from 'node:net';
import { getConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import type { SmtpStatus } from '../types/results.js';

const log = getLogger('smtp');

export type SmtpDiagResult = {
  status: SmtpStatus;
  reason_codes: string[];
  banner?: string;
};

/**
 * Optional SMTP diagnostics. Disabled by default.
 * Never sends an email. Conservative timeouts. Treats blocked connections as unknown.
 * Does NOT claim mailbox existence certainty.
 */
export async function diagnoseSmtp(
  email: string,
  mxHosts: string[],
): Promise<SmtpDiagResult> {
  const cfg = getConfig();
  if (!cfg.smtpEnabled) {
    return { status: 'not_checked', reason_codes: ['SMTP_DISABLED'] };
  }
  if (mxHosts.length === 0) {
    return { status: 'unknown', reason_codes: ['SMTP_NO_MX'] };
  }

  const host = mxHosts[0]!;
  const timeout = cfg.smtpTimeoutMs;

  try {
    const result = await smtpProbe(host, email, timeout);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug({ host, err: msg }, 'SMTP probe failed');
    if (/timeout|ECONNREFUSED|ECONNRESET|blocked|421|450|451|452/i.test(msg)) {
      return { status: 'temporary_error', reason_codes: ['SMTP_TEMPORARY', msg.slice(0, 80)] };
    }
    return { status: 'blocked', reason_codes: ['SMTP_BLOCKED'] };
  }
}

async function smtpProbe(host: string, email: string, timeoutMs: number): Promise<SmtpDiagResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 25 });
    let buffer = '';
    let stage: 'banner' | 'ehlo' | 'mail' | 'rcpt' | 'done' = 'banner';
    const reason_codes: string[] = [];
    let banner = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP_TIMEOUT'));
    }, timeoutMs);

    const finish = (status: SmtpStatus, extra: string[] = []) => {
      clearTimeout(timer);
      stage = 'done';
      socket.write('QUIT\r\n');
      socket.end();
      resolve({ status, reason_codes: [...reason_codes, ...extra], banner: banner || undefined });
    };

    socket.setEncoding('utf8');
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const code = Number(line.slice(0, 3));
        if (stage === 'banner') {
          banner = line;
          if (code === 220) {
            stage = 'ehlo';
            socket.write('EHLO openverify.local\r\n');
          } else {
            finish('blocked', ['SMTP_BANNER_REJECT']);
          }
        } else if (stage === 'ehlo') {
          if (code >= 200 && code < 400 && !line.match(/^\d{3}-/)) {
            stage = 'mail';
            socket.write('MAIL FROM:<>\r\n');
          } else if (code >= 400) {
            finish('blocked', ['SMTP_EHLO_REJECT']);
          }
        } else if (stage === 'mail') {
          if (code >= 200 && code < 300) {
            stage = 'rcpt';
            socket.write(`RCPT TO:<${email}>\r\n`);
          } else if (code === 421 || code === 450 || code === 451 || code === 452) {
            finish('temporary_error', [`SMTP_${code}`]);
          } else {
            finish('unknown', ['SMTP_MAIL_FROM_REJECT']);
          }
        } else if (stage === 'rcpt') {
          if (code === 250 || code === 251) {
            finish('ok', ['SMTP_RCPT_ACCEPTED']);
          } else if (code === 550 || code === 551 || code === 553 || code === 554) {
            finish('invalid', [`SMTP_${code}`]);
          } else if (code === 421 || code === 450 || code === 451 || code === 452) {
            finish('temporary_error', [`SMTP_${code}_GREYLIST_OR_TEMP`]);
          } else {
            finish('unknown', [`SMTP_RCPT_${code || 'UNKNOWN'}`]);
          }
        }
      }
    });
  });
}
