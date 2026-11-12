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
      <label id="csv-dropzone" class="csv-dropzone" for="csv-input">
        <input id="csv-input" type="file" accept=".csv,text/csv" />
        <span id="csv-filename">No file selected</span>
      </label>
      <p id="csv-file-error" hidden></p>
      <button id="bulk-submit" type="submit">Verify CSV</button>
      <button id="download-sample-csv" type="button">Download Sample CSV</button>
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
        is_free_provider: false,
        provider_type: 'custom',
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
    expect(out.split('\n')[0]).toContain('is_free_provider');
    expect(out.split('\n')[0]).toContain('provider_type');
    expect(out).toContain('a@example.com');
    expect(out).toContain('ok|mx');
  });

  it('ships a matching sample CSV template and downloads it client-side', () => {
    const csv = window.MailSureCsv;
    const disk = readFileSync(
      path.join(process.cwd(), 'public/MailSure-Sample-Email-List.csv'),
      'utf8',
    );
    expect(csv.SAMPLE_CSV_FILENAME).toBe('MailSure-Sample-Email-List.csv');
    expect(csv.SAMPLE_CSV_CONTENT).toBe(
      'Email\njohn@example.com\nalice@example.com\nsupport@example.org\n',
    );
    expect(disk.replace(/\r\n/g, '\n')).toBe(csv.SAMPLE_CSV_CONTENT);

    const createObjectURL = vi.fn(() => 'blob:sample');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: click });
      }
      return el;
    });
    csv.downloadSampleCsv();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses the sample CSV Email header (case-insensitive aliases)', async () => {
    const csv = window.MailSureCsv;
    expect(csv.findEmailColumnIndex(['Email'])).toBe(0);
    expect(csv.findEmailColumnIndex(['EMAIL'])).toBe(0);
    expect(csv.findEmailColumnIndex(['e-mail'])).toBe(0);
    expect(csv.findEmailColumnIndex(['name', 'email_address'])).toBe(1);

    const file = new File([csv.SAMPLE_CSV_CONTENT], csv.SAMPLE_CSV_FILENAME, {
      type: 'text/csv',
    });
    const { emails, emailColumn } = await csv.extractEmailsFromCsvFile(file, {
      maxBytes: 1024,
      maxEmails: 50,
    });
    expect(emailColumn).toBe(0);
    expect(emails).toEqual([
      'john@example.com',
      'alice@example.com',
      'support@example.org',
    ]);
  });

  it('extracts unique emails from multi-column CSV and skips empty rows', async () => {
    const csv = window.MailSureCsv;
    const content = 'name,email\nA,a@x.com\nB,\nC,b@x.com\nD,a@x.com\n';
    const file = new File([content], 'list.csv', { type: 'text/csv' });
    const { emails } = await csv.extractEmailsFromCsvFile(file, {
      maxBytes: 1024,
      maxEmails: 50,
    });
    expect(emails).toEqual(['a@x.com', 'b@x.com']);
  });

  it('keeps invalid email values for API validation instead of discarding them', async () => {
    const csv = window.MailSureCsv;
    const content = 'Email\nnot-an-email\nvalid@example.com\n';
    const file = new File([content], 'mixed.csv', { type: 'text/csv' });
    const { emails } = await csv.extractEmailsFromCsvFile(file, {
      maxBytes: 1024,
      maxEmails: 50,
    });
    expect(emails).toEqual(['not-an-email', 'valid@example.com']);
  });

  it('rejects missing email header, empty CSV, and invalid extensions', async () => {
    const csv = window.MailSureCsv;
    await expect(
      csv.extractEmailsFromCsvFile(
        new File(['name,phone\nAda,555\n'], 'contacts.csv', { type: 'text/csv' }),
        { maxBytes: 1024, maxEmails: 50 },
      ),
    ).rejects.toThrow(/email column/i);

    await expect(
      csv.extractEmailsFromCsvFile(new File([''], 'empty.csv', { type: 'text/csv' }), {
        maxBytes: 1024,
        maxEmails: 50,
      }),
    ).rejects.toThrow(/empty/i);

    await expect(
      csv.extractEmailsFromCsvFile(
        new File(['Email\na@x.com\n'], 'notes.txt', { type: 'text/plain' }),
        { maxBytes: 1024, maxEmails: 50 },
      ),
    ).rejects.toThrow(/\.csv/i);

    expect(() =>
      csv.assertCsvFile(new File(['x'], 'photo.png', { type: 'image/png' })),
    ).toThrow(/Unsupported file type/i);
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

describe('MailSure published config.js', () => {
  it('points Pages at the stable Enzonic website API without secrets or trailing slash', () => {
    const raw = readFileSync(path.join(process.cwd(), 'public/js/config.js'), 'utf8');
    expect(raw).toMatch(
      /API_BASE_URL:\s*"https:\/\/email-validation-tool\.enzonic\.dev"/,
    );
    // Reject ephemeral Enzonic deploy hostnames that omit newer ValidationResult fields.
    expect(raw).not.toMatch(/email-validation-tool-8d370a7d\.enzonic\.dev/);
    expect(raw).not.toMatch(/email-validation-tool-8121831f\.enzonic\.dev/);
    expect(raw).not.toMatch(/API_BASE_URL:\s*"https:\/\/[^"]+\/"/);
    // No env secrets or Authorization credentials in published frontend config.
    expect(raw).not.toMatch(/OPENVERIFY_HTTP_AUTH_TOKEN\s*=/);
    expect(raw).not.toMatch(/Authorization\s*:\s*['"]Bearer\s+/i);
    // Evaluate published config the same way the browser loads it.
    (0, eval)(raw);
    expect(window.MAILSURE_CONFIG.API_BASE_URL).toBe(
      'https://email-validation-tool.enzonic.dev',
    );
    expect(String(window.MAILSURE_CONFIG.API_BASE_URL).endsWith('/')).toBe(false);
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

  it('builds verify URLs from configured API_BASE_URL and parses live-shaped results', async () => {
    const base = 'https://email-validation-tool.enzonic.dev';
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: base });
    loadBrowserScript('public/js/verify.js');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(base + '/api/verify');
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('omit');
      const headers = init?.headers as Record<string, string>;
      expect(headers['content-type']).toMatch(/application\/json/i);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            result: {
              email: 'not-an-email',
              normalized_email: 'not-an-email',
              syntax_valid: false,
              domain_exists: null,
              mx_exists: null,
              is_disposable: null,
              is_free_provider: null,
              provider_type: null,
              is_role_based: null,
              smtp_status: 'not_checked',
              catch_all_status: 'not_checked',
              overall_status: 'invalid_syntax',
              confidence: 'high',
              reason_codes: ['MISSING_AT'],
              checked_at: '2026-11-09T00:00:00.000Z',
            },
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = (await window.MailSureApi.verifyEmail('not-an-email')) as {
      overall_status: string;
      syntax_valid: boolean;
    };
    expect(result.syntax_valid).toBe(false);
    expect(result.overall_status).toBe('invalid_syntax');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('unwraps {result} envelope and keeps is_free_provider for syntax-valid rows', async () => {
    const base = 'https://email-validation-tool.enzonic.dev';
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: base });
    loadBrowserScript('public/js/verify.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          result: {
            email: 'user@gmail.com',
            normalized_email: 'user@gmail.com',
            syntax_valid: true,
            domain_exists: true,
            mx_exists: true,
            is_disposable: false,
            is_free_provider: true,
            provider_type: 'free',
            is_role_based: false,
            smtp_status: 'not_checked',
            catch_all_status: 'not_checked',
            overall_status: 'valid_domain',
            confidence: 'medium',
            reason_codes: ['FREE_EMAIL_PROVIDER', 'SMTP_DISABLED'],
            checked_at: '2026-11-12T00:00:00.000Z',
          },
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = (await window.MailSureApi.verifyEmail('user@gmail.com')) as {
      is_free_provider: boolean;
      provider_type: string;
    };
    expect(result.is_free_provider).toBe(true);
    expect(result.provider_type).toBe('free');
  });

  it('rejects stale-host shaped verify payloads that omit is_free_provider', async () => {
    const base = 'https://email-validation-tool.enzonic.dev';
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: base });
    loadBrowserScript('public/js/verify.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            result: {
              email: 'user@gmail.com',
              normalized_email: 'user@gmail.com',
              syntax_valid: true,
              domain_exists: true,
              mx_exists: true,
              is_disposable: false,
              // intentionally omit is_free_provider + provider_type (legacy host)
              is_role_based: false,
              smtp_status: 'not_checked',
              catch_all_status: 'not_checked',
              overall_status: 'valid_domain',
              confidence: 'medium',
              reason_codes: ['SMTP_DISABLED'],
              checked_at: '2026-11-12T00:00:00.000Z',
            },
          }),
      })),
    );
    await expect(window.MailSureApi.verifyEmail('user@gmail.com')).rejects.toThrow(
      /is_free_provider/,
    );
  });

  it('posts CSV-derived emails to /api/verify/batch and returns typed results', async () => {
    const base = 'https://email-validation-tool.enzonic.dev';
    window.MAILSURE_CONFIG = Object.freeze({ API_BASE_URL: base });
    loadBrowserScript('public/js/verify.js');
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(base + '/api/verify/batch');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            count: 2,
            results: [
              {
                email: 'bad',
                normalized_email: 'bad',
                syntax_valid: false,
                domain_exists: null,
                mx_exists: null,
                is_disposable: null,
                is_free_provider: null,
                provider_type: null,
                is_role_based: null,
                smtp_status: 'not_checked',
                catch_all_status: 'not_checked',
                overall_status: 'invalid_syntax',
                confidence: 'high',
                reason_codes: ['MISSING_AT'],
                checked_at: '2026-11-09T00:00:00.000Z',
              },
              {
                email: 'also-bad',
                normalized_email: 'also-bad',
                syntax_valid: false,
                domain_exists: null,
                mx_exists: null,
                is_disposable: null,
                is_free_provider: null,
                provider_type: null,
                is_role_based: null,
                smtp_status: 'not_checked',
                catch_all_status: 'not_checked',
                overall_status: 'invalid_syntax',
                confidence: 'high',
                reason_codes: ['MISSING_AT'],
                checked_at: '2026-11-09T00:00:00.000Z',
              },
            ],
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const rows = await window.MailSureApi.verifyBatch(['bad', 'also-bad']);
    expect(rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      SAMPLE_CSV_FILENAME: string;
      SAMPLE_CSV_CONTENT: string;
      sanitizeCsvCell: (value: unknown) => string;
      parseCsv: (text: string) => string[][];
      findEmailColumnIndex: (header: string[]) => number;
      assertCsvFile: (file: File | null | undefined) => void;
      extractEmailsFromCsvFile: (
        file: File,
        limits: { maxBytes: number; maxEmails: number },
      ) => Promise<{ emails: string[]; header: string[]; emailColumn: number }>;
      resultsToCsv: (results: Array<Record<string, unknown>>) => string;
      downloadText: (filename: string, text: string, mime?: string) => void;
      downloadSampleCsv: () => void;
    };
  }
}
