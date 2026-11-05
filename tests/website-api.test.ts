import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

  it('health reports website_api false', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { website_api: boolean };
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
      };
    };
    expect(body.result.email).toBe('not-an-email');
    expect(body.result.syntax_valid).toBe(false);
    expect(body.result.overall_status).toBe('invalid_syntax');
    expect(Array.isArray(body.result.reason_codes)).toBe(true);
    expect(body.result.confidence).toBeTruthy();
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

  it('does not expose MCP without auth when token later configured path still protected', async () => {
    // MCP path still exists; unauthenticated POST without session may fail protocol,
    // but endpoint must remain at /mcp (not aliased under /api).
    const res = await fetch(`${base}/mcp`, { method: 'GET' });
    // Protocol may return 405/400/406 — anything except leaking admin JSON tools list as public REST
    expect([400, 404, 405, 406, 415]).toContain(res.status);
  });
});
