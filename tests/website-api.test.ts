import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { corsOriginHostnames, createHttpApp } from '../src/http/app.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('corsOriginHostnames', () => {
  it('derives hostnames from full CORS origins for MCP Origin guard', () => {
    expect(
      corsOriginHostnames([
        'https://eneelkant.github.io',
        'http://127.0.0.1:3000',
        'localhost',
      ]),
    ).toEqual(['eneelkant.github.io', '127.0.0.1', 'localhost']);
  });
});

async function listen(app: ReturnType<typeof createHttpApp>): Promise<{
  server: Server;
  base: string;
}> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe('Website API disabled by default', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'false';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
  });

  it('does not mount /api/verify when disabled', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res.status).toBe(404);
  });

  it('does not mount /api/verify/batch when disabled', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: ['a@example.com'] }),
    });
    expect(res.status).toBe(404);
  });

  it('health reports website_api false', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { website_api: boolean; status: string };
    expect(body.status).toBe('ok');
    expect(body.website_api).toBe(false);
  });
});

describe('Website API when enabled', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_WEBSITE_MAX_BATCH_SIZE = '5';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX = '100';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.OPENVERIFY_CORS_ORIGINS = 'https://eneelkant.github.io';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'false';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
  });

  it('health reports website_api true', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { website_api: boolean };
    expect(body.website_api).toBe(true);
  });

  it('verifies a single email and returns ValidationResult fields', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        email: string;
        overall_status: string;
        syntax_valid: boolean;
        reason_codes: string[];
        confidence: string;
        smtp_status: string;
        catch_all_status: string;
        checked_at: string;
      };
    };
    expect(body.result.email).toBe('not-an-email');
    expect(body.result.syntax_valid).toBe(false);
    expect(body.result.overall_status).toBe('invalid_syntax');
    expect(Array.isArray(body.result.reason_codes)).toBe(true);
    expect(body.result.confidence).toBeTruthy();
    expect(body.result.smtp_status).toBeTruthy();
    expect(body.result.catch_all_status).toBeTruthy();
    expect(body.result.checked_at).toBeTruthy();
  });

  it('rejects invalid single-verify body', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects invalid batch body', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects oversized batches', async () => {
    const emails = Array.from({ length: 6 }, (_, i) => `u${i}@example.com`);
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('batch_too_large');
  });

  it('batch verifies within limit', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emails: ['bad', 'also-bad'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; count: number };
    expect(body.count).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it('allows CORS preflight from allowlisted Pages origin', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://eneelkant.github.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://eneelkant.github.io');
  });

  it('accepts verify POST with allowlisted browser Origin', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://eneelkant.github.io',
      },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://eneelkant.github.io');
  });

  it('rejects disallowed browser Origin at the MCP Origin guard', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('does not reflect disallowed CORS origin on preflight', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('does not expose MCP admin tools under /api', async () => {
    for (const pathSuffix of [
      '/api/clear_cache',
      '/api/update_disposable_domains',
      '/api/jobs',
      '/api/mcp',
    ]) {
      const res = await fetch(`${base}${pathSuffix}`, { method: 'POST' });
      expect(res.status).toBeGreaterThanOrEqual(404);
    }
  });

  it('keeps MCP on /mcp (not aliased under website API)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET' });
    expect([400, 404, 405, 406, 415]).toContain(res.status);
  });
});

describe('Website API rate limit', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX = '2';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.OPENVERIFY_RATE_LIMIT_MAX = '1000';
    process.env.OPENVERIFY_CORS_ORIGINS = 'https://eneelkant.github.io';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'false';
    process.env.OPENVERIFY_WEBSITE_RATE_LIMIT_MAX = '30';
  });

  it('returns rate_limited after website max is exceeded', async () => {
    const post = () =>
      fetch(`${base}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'bad' }),
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });
});

describe('MCP tool surface remains intact', () => {
  it('still registers the nine MCP tools in source', () => {
    const toolsPath = path.join(process.cwd(), 'src/mcp/tools.ts');
    const src = readFileSync(toolsPath, 'utf8');
    for (const name of [
      'verify_email',
      'verify_emails_batch',
      'verify_csv',
      'check_domain',
      'get_validation_job',
      'cancel_validation_job',
      'get_statistics',
      'clear_cache',
      'update_disposable_domains',
    ]) {
      expect(src).toContain(`'${name}'`);
    }
  });
});
