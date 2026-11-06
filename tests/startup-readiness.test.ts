import './setup-env.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  resetConfigCache,
  loadConfig,
  getConfig,
  isReadonlyDeployPath,
  resolveHttpPort,
} from '../src/config/env.js';
import { closeDb } from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import { startCsvValidationJob } from '../src/processing/csv.js';
import { resetLogger } from '../src/utils/logger.js';
import {
  beginRuntimeInitialization,
  initializeRuntime,
  resetRuntimeLifecycle,
  getRuntimeLifecycle,
} from '../src/runtime/lifecycle.js';

function withTempRuntime(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mailsure-startup-'));
  process.env.OPENVERIFY_DATA_DIR = root;
  process.env.OPENVERIFY_UPLOAD_DIR = path.join(root, 'uploads');
  process.env.OPENVERIFY_OUTPUT_DIR = path.join(root, 'output');
  process.env.OPENVERIFY_DISPOSABLE_PATH = path.join(root, 'disposable-domains.txt');
  process.env.OPENVERIFY_DB_PATH = path.join(root, 'openverify.sqlite');
  process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
  process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
  process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
  return root;
}

async function listen(
  app: ReturnType<typeof createHttpApp>,
): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('HTTP readiness lifecycle', () => {
  let root: string;
  let server: Server | undefined;
  let base = '';

  beforeEach(() => {
    root = withTempRuntime();
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'true';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'true';
    process.env.OPENVERIFY_CORS_ORIGINS = 'https://eneelkant.github.io';
    resetConfigCache();
    resetLogger();
    closeDb();
    resetRuntimeLifecycle('ready');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((err) => (err ? reject(err) : resolve())),
      );
      server = undefined;
    }
    closeDb();
    resetConfigCache();
    resetLogger();
    resetRuntimeLifecycle('ready');
    process.env.OPENVERIFY_EPHEMERAL_STORAGE = 'false';
    process.env.OPENVERIFY_WEBSITE_API_ENABLED = 'false';
    process.env.OPENVERIFY_CORS_ORIGINS = '';
    rmSync(root, { recursive: true, force: true });
  });

  it('exposes /health 200 starting and /ready 503 while initializing', async () => {
    loadConfig();
    beginRuntimeInitialization();
    expect(getRuntimeLifecycle().dbStatus).toBe('initializing');

    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'starting',
      service: 'mailsure-api',
      db_status: 'initializing',
      storage: 'ephemeral',
    });

    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: 'not_ready',
      db_status: 'initializing',
    });

    const version = await fetch(`${base}/version`);
    expect(version.status).toBe(200);
    expect(await version.json()).toMatchObject({ db_status: 'initializing' });
  });

  it('gates DB-dependent API while initializing, then allows after ready', async () => {
    loadConfig();
    beginRuntimeInitialization();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    const blocked = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({
      error: 'not_ready',
      db_status: 'initializing',
    });

    await initializeRuntime();
    expect(getRuntimeLifecycle().dbStatus).toBe('ready');

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      db_status: 'ready',
    });

    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      db_status: 'ready',
    });

    const ok = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(ok.status).toBe(200);
  });

  it('reports degraded /health and keeps probes up after init failure', async () => {
    loadConfig();
    beginRuntimeInitialization();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    // Simulate background init failure recorded on the lifecycle (listener stays up).
    resetRuntimeLifecycle('failed');

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      status: 'degraded',
      db_status: 'failed',
      service: 'mailsure-api',
    });

    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);

    const version = await fetch(`${base}/version`);
    expect(version.status).toBe(200);

    const api = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    expect(api.status).toBe(503);
  });

  it('initializeRuntime opens SQLite and supports CSV after listen-first flow', async () => {
    loadConfig();
    beginRuntimeInitialization();
    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    await initializeRuntime();
    const cfg = getConfig();
    const input = path.join(cfg.uploadDir, 'startup-sample.csv');
    writeFileSync(input, 'email\nbad-address\n', 'utf8');

    const job = await startCsvValidationJob({
      inputPath: input,
      wait: true,
      concurrency: 2,
    });
    expect(job.status === 'completed' || job.status === 'failed').toBe(true);
    expect(existsSync(job.output_path!)).toBe(true);
    expect(isReadonlyDeployPath(cfg.dataDir)).toBe(false);
  });

  it('honors platform PORT=3000', () => {
    const port = resolveHttpPort({ PORT: '3000' }, 8787);
    expect(port).toBe(3000);
  });
});

describe('listen-before-db ordering helper', () => {
  it('beginRuntimeInitialization clears prior ready state', async () => {
    resetRuntimeLifecycle('ready');
    beginRuntimeInitialization();
    expect(getRuntimeLifecycle().dbStatus).toBe('initializing');
    // Restore for other suites
    resetRuntimeLifecycle('ready');
  });
});
