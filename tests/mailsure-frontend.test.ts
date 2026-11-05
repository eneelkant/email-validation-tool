/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadBrowserScript(relPath: string): void {
  const abs = path.join(process.cwd(), relPath);
  const code = readFileSync(abs, 'utf8');
  // Scripts are IIFEs that attach to window; evaluate in happy-dom context.
  (0, eval)(code);
}

function mountVerifyDom(): void {
  document.body.innerHTML = `
    <div id="backend-status" class="banner" hidden role="status"></div>
    <div id="verify-feedback" class="banner" hidden role="alert"></div>
    <div id="results" class="results" hidden></div>
    <form id="single-verify-form">
      <input id="email-input" type="email" />
      <button type="submit">Verify</button>
    </form>
    <form id="bulk-verify-form">
      <input id="csv-input" type="file" />
      <button type="submit">Verify CSV</button>
    </form>
    <button id="download-csv" type="button" hidden>Download</button>
  `;
}

describe('MailSure frontend CSV helpers', () => {
  beforeEach(() => {
    loadBrowserScript('public/js/csv.js');
  });

  it('sanitizes formula-like cells and builds download CSV', () => {
    const csv = window.MailSureCsv;
    expect(csv.sanitizeCsvCell('=cmd')).toBe("'=cmd");
    expect(csv.sanitizeCsvCell('+1')).toBe("'+1");
    expect(csv.sanitizeCsvCell('safe')).toBe('safe');

    const out = csv.resultsToCsv([
      {
        email: 'a@example.com',
        normalized_email: 'a@example.com',
        syntax_valid: true,
        domain_exists: true,
        mx_exists: true,
        is_disposable: false,
        is_role_based: false,
        smtp_status: 'not_checked',
        catch_all_status: 'not_checked',
        overall_status: 'valid_domain',
        confidence: 'medium',
        reason_codes: ['ok', 'mx'],
        checked_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(out.split('\n')[0]).toContain('email');
    expect(out).toContain('a@example.com');
    expect(out).toContain('ok|mx');
  });

  it('extracts unique emails from a CSV file with size/batch caps', async () => {
    const csv = window.MailSureCsv;
    const content = 'email,name\na@x.com,A\nb@x.com,B\na@x.com,dup\n';
    const file = new File([content], 'list.csv', { type: 'text/csv' });
    const { emails } = await csv.extractEmailsFromCsvFile(file, {
      maxBytes: 1024,
      maxEmails: 50,
    });
    expect(emails).toEqual(['a@x.com', 'b@x.com']);
  });

  it('rejects oversized CSV uploads', async () => {
    const csv = window.MailSureCsv;
    const file = new File(['email\na@x.com\n'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: 9_000_000 });
    await expect(
      csv.extractEmailsFromCsvFile(file, { maxBytes: 100, maxEmails: 50 }),
    ).rejects.toThrow(/too large/i);
  });
});

describe('MailSure API client', () => {
  beforeEach(() => {
    window.MAILSURE_CONFIG = Object.freeze({
      API_BASE_URL: '',
      MAX_CSV_BYTES: 1024,
      MAX_BATCH_EMAILS: 50,
    });
    loadBrowserScript('public/js/verify.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports not_configured when API_BASE_URL is empty', async () => {
    expect(window.MailSureApi.isConfigured()).toBe(false);
    const health = await window.MailSureApi.checkHealth();
    expect(health).toEqual({ ok: false, reason: 'not_configured' });
    expect(window.MailSureApi.unavailableMessage('not_configured')).toMatch(/not configured/i);
  });

  it('reports unreachable when fetch fails', async () => {
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'http://127.0.0.1:9' });
    loadBrowserScript('public/js/verify.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    const health = await window.MailSureApi.checkHealth();
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('unreachable');
  });

  it('rejects invalid verify response shapes (no fake success)', async () => {
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'http://127.0.0.1:8787' });
    loadBrowserScript('public/js/verify.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: { email: 'only' } }),
      })),
    );
    await expect(window.MailSureApi.verifyEmail('a@b.com')).rejects.toThrow(/missing field/i);
  });

  it('rejects invalid batch response shapes', async () => {
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'http://127.0.0.1:8787' });
    loadBrowserScript('public/js/verify.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: 'nope' }),
      })),
    );
    await expect(window.MailSureApi.verifyBatch(['a@b.com'])).rejects.toThrow(/results array/i);
  });

  it('surfaces HTTP error details without inventing results', async () => {
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: 'http://127.0.0.1:8787' });
    loadBrowserScript('public/js/verify.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate_limited' }),
      })),
    );
    await expect(window.MailSureApi.verifyEmail('a@b.com')).rejects.toMatchObject({
      message: 'rate_limited',
      code: 'rate_limited',
      status: 429,
    });
  });
});

describe('MailSure duplicate backend warning', () => {
  beforeEach(() => {
    mountVerifyDom();
    window.MAILSURE_CONFIG = Object.freeze({
      API_BASE_URL: '',
      MAX_CSV_BYTES: 1024,
      MAX_BATCH_EMAILS: 50,
    });
    loadBrowserScript('public/js/csv.js');
    loadBrowserScript('public/js/verify.js');
    loadBrowserScript('public/js/app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
  });

  it('shows the not-configured warning once in #backend-status, not twice on submit', async () => {
    const status = document.getElementById('backend-status');
    const feedback = document.getElementById('verify-feedback');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toMatch(/not configured/i);
    expect(feedback?.hidden).toBe(true);
    expect(feedback?.textContent).toBe('');

    const input = document.getElementById('email-input') as HTMLInputElement;
    input.value = 'test@example.com';
    const form = document.getElementById('single-verify-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toMatch(/not configured/i);
    // Root-cause fix: verify-feedback must stay empty for connection issues.
    expect(feedback?.hidden).toBe(true);
    expect(feedback?.textContent).toBe('');

    const warningCount = [status, feedback].filter(
      (el) => el && !el.hidden && /not configured/i.test(el.textContent || ''),
    ).length;
    expect(warningCount).toBe(1);
  });

  it('uses #verify-feedback only for form validation errors', () => {
    const form = document.getElementById('single-verify-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const feedback = document.getElementById('verify-feedback');
    expect(feedback?.hidden).toBe(false);
    expect(feedback?.textContent).toMatch(/enter an email/i);
  });
});

declare global {
  interface Window {
    MAILSURE_CONFIG: Record<string, unknown>;
    MailSureApi: {
      isConfigured: () => boolean;
      checkHealth: () => Promise<{ ok: boolean; reason?: string; body?: unknown }>;
      verifyEmail: (email: string) => Promise<unknown>;
      verifyBatch: (emails: string[]) => Promise<unknown[]>;
      unavailableMessage: (reason: string) => string;
      assertValidationResult: (value: unknown, label: string) => unknown;
      isConnectionReason: (reason: string) => boolean;
      renderResults: (container: Element | null, results: unknown[]) => void;
      escapeHtml: (value: unknown) => string;
    };
    MailSureCsv: {
      sanitizeCsvCell: (value: unknown) => string;
      parseCsv: (text: string) => string[][];
      extractEmailsFromCsvFile: (
        file: File,
        limits: { maxBytes: number; maxEmails: number },
      ) => Promise<{ emails: string[] }>;
      resultsToCsv: (results: Array<Record<string, unknown>>) => string;
      downloadText: (filename: string, text: string, mime?: string) => void;
    };
  }
}
