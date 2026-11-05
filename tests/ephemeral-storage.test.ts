import './setup-env.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  resetConfigCache,
  loadConfig,
  getConfig,
  isMemoryDbPath,
  describeDbBackend,
} from '../src/config/env.js';
import { closeDb, getDb, getJob } from '../src/database/db.js';
import { startCsvValidationJob } from '../src/processing/csv.js';
import { createHttpApp } from '../src/http/app.js';
import { resetLogger } from '../src/utils/logger.js';

function withTempRuntime(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mailsure-ephemeral-'));
  process.env.OPENVERIFY_DATA_DIR = root;
  process.env.OPENVERIFY_UPLOAD_DIR = path.join(root, 'uploads');
  process.env.OPENVERIFY_OUTPUT_DIR = path.join(root, 'output');
  process.env.OPENVERIFY_DISPOSABLE_PATH = path.join(root, 'disposable-domains.txt');
  process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
  process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
  return root;
}

describe('memory / ephemeral DB helpers', () => {
  it('detects memory DB paths', () => {
    expect(isMemoryDbPath(':memory:')).toBe(true);
    expect(isMemoryDbPath('/data/openverify.sqlite')).toBe(false);
    expect(describeDbBackend(':memory:')).toBe('memory');
    expect(describeDbBackend('/tmp/x.sqlite')).toBe('file');
  });
});

describe('SQLite :memory: mode', () => {
  let root: string;

  beforeEach(() => {
    root = withTempRuntime();
    process.env.OPENVERIFY_DB_PATH = ':memory:';
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'true';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    resetConfigCache();
    resetLogger();
    closeDb();
    loadConfig();
    getDb();
  });

  afterEach(() => {
    closeDb();
    resetConfigCache();
    resetLogger();
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'false';
    rmSync(root, { recursive: true, force: true });
  });

  it('starts, migrates, and answers SQL without a DB file', () => {
    expect(getConfig().dbPath).toBe(':memory:');
    expect(describeDbBackend()).toBe('memory');
    const db = getDb();
    expect(db.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
  });

  it('runs CSV job with upload cleanup and keeps downloadable output', async () => {
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'ephemeral-sample.csv');
    writeFileSync(input, 'email\nbad-address\nalso-bad\n', 'utf8');
    expect(existsSync(input)).toBe(true);

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      concurrency: 2,
    });
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.processed).toBe(2);
    expect(final.output_path).toBeTruthy();
    expect(existsSync(final.output_path!)).toBe(true);
    // Upload removed after processing in ephemeral mode
    expect(existsSync(input)).toBe(false);
    const out = readFileSync(final.output_path!, 'utf8');
    expect(out).toMatch(/overall_status/);
    expect(out).toMatch(/invalid_syntax/);
  });
});

describe('ephemeral file DB under temp dir (no persistent disk)', () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    root = withTempRuntime();
    process.env.OPENVERIFY_DB_PATH = path.join(root, 'ephemeral.sqlite');
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'true';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_CORS_ORIGINS = 'https://eneelkant.github.io';
    process.env.OPENVERIFY_WEBSITE_MAX_BATCH_SIZE = '50';
    // Non-empty token so MCP stays protected even on loopback for this suite
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = 'ephemeral-test-token';
    resetConfigCache();
    resetLogger();
    closeDb();
    loadConfig();
    getDb();
    const app = createHttpApp();
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
    resetConfigCache();
    resetLogger();
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'false';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'false';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    rmSync(root, { recursive: true, force: true });
  });

  it('health reports ephemeral storage + file db', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      service: 'mailsure-api',
      website_api: true,
      storage: 'ephemeral',
      db: 'file',
    });
  });

  it('single verify returns ValidationResult without persistent disk', async () => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://eneelkant.github.io',
      },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { overall_status: string; syntax_valid: boolean } };
    expect(body.result.syntax_valid).toBe(false);
    expect(body.result.overall_status).toBe('invalid_syntax');
  });

  it('bulk verify (website CSV path) returns results array', async () => {
    const res = await fetch(`${base}/api/verify/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://eneelkant.github.io',
      },
      body: JSON.stringify({ emails: ['bad', 'also-bad', 'still-bad'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; count: number };
    expect(body.count).toBe(3);
    expect(body.results).toHaveLength(3);
  });

  it('allows CORS from Pages origin and rejects MCP without bearer', async () => {
    const verify = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://eneelkant.github.io',
      },
      body: JSON.stringify({ email: 'x' }),
    });
    expect(verify.status).toBe(200);
    expect(verify.headers.get('access-control-allow-origin')).toBe('https://eneelkant.github.io');

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ephemeral-test', version: '0' },
        },
      }),
    });
    expect(mcp.status).toBe(401);
  });
});

describe('PORT startup with ephemeral storage', () => {
  let root: string;

  beforeEach(() => {
    root = withTempRuntime();
    process.env.OPENVERIFY_DB_PATH = ':memory:';
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'true';
    process.env.PORT = '18787';
    process.env.OPENVERIFY_HTTP_PORT = '8787';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    resetConfigCache();
    resetLogger();
  });

  afterEach(() => {
    closeDb();
    resetConfigCache();
    resetLogger();
    delete process.env.PORT;
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'false';
    rmSync(root, { recursive: true, force: true });
  });

  it('loadConfig prefers PORT for free-tier-like hosts', () => {
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(18787);
    expect(cfg.ephemeralStorage).toBe(true);
    expect(cfg.dbPath).toBe(':memory:');
  });
});
