/**
 * Focused coverage for MCP middleware order:
 * requireRuntimeReady → requireHttpAuth → MCP handler,
 * plus fail-closed auth config for non-loopback binds.
 */
import './setup-env.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  resetConfigCache,
  loadConfig,
  getConfig,
} from '../src/config/env.js';
import { closeDb } from '../src/database/db.js';
import { createHttpApp, startHttpServer } from '../src/http/app.js';
import { assertHttpAuthConfig, isLoopbackBindHost } from '../src/security/auth.js';
import { resetLogger } from '../src/utils/logger.js';
import {
  beginRuntimeInitialization,
  initializeRuntime,
  resetRuntimeLifecycle,
  getRuntimeLifecycle,
} from '../src/runtime/lifecycle.js';

/** Test-only token — never logged or asserted in plaintext beyond equality checks. */
const TEST_MCP_TOKEN = 'mcp-readiness-test-token';

function withTempRuntime(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mailsure-mcp-gate-'));
  process.env.OPENVERIFY_DATA_DIR = root;
  process.env.OPENVERIFY_UPLOAD_DIR = path.join(root, 'uploads');
  process.env.OPENVERIFY_OUTPUT_DIR = path.join(root, 'output');
  process.env.OPENVERIFY_DISPOSABLE_PATH = path.join(root, 'disposable-domains.txt');
  process.env.OPENVERIFY_FREE_PROVIDERS_PATH = path.join(root, 'free-email-providers.txt');
  process.env.OPENVERIFY_DB_PATH = path.join(root, 'openverify.sqlite');
  process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
  process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
  process.env.OPENVERIFY_HTTP_AUTH_TOKEN = TEST_MCP_TOKEN;
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

function mcpInitializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-readiness-auth-test', version: '0.0.0' },
    },
  });
}

/**
 * Parse MCP Streamable HTTP bodies (SSE `data:` lines or raw JSON).
 * Matches the convention in tests/mcp-http.test.ts.
 */
function parseMcpPayload(text: string): Record<string, unknown> {
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data: '));
  const payloadText = dataLine ? dataLine.slice('data: '.length) : text;
  try {
    return JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function postMcp(
  base: string,
  mcpPath: string,
  opts: { authorization?: string; body?: string } = {},
): Promise<{
  status: number;
  contentType: string;
  json: Record<string, unknown>;
  text: string;
}> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (opts.authorization) headers.authorization = opts.authorization;
  const res = await fetch(`${base}${mcpPath}`, {
    method: 'POST',
    headers,
    body: opts.body ?? mcpInitializeBody(),
  });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    json: parseMcpPayload(text),
    text,
  };
}

describe('MCP readiness gating + bearer auth', () => {
  let root: string;
  let server: Server | undefined;
  let base = '';
  let mcpPath = '/mcp';

  beforeEach(() => {
    root = withTempRuntime();
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
    delete process.env.OPENVERIFY_HTTP_AUTH_TOKEN;
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    rmSync(root, { recursive: true, force: true });
  });

  it('Test A: MCP returns 503 not_ready while initializing (handler not reached)', async () => {
    loadConfig();
    mcpPath = getConfig().mcpPath;
    beginRuntimeInitialization();
    expect(getRuntimeLifecycle().dbStatus).toBe('initializing');

    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    // Even a correct bearer token must not reach the MCP handler before ready.
    const blocked = await postMcp(base, mcpPath, {
      authorization: `Bearer ${TEST_MCP_TOKEN}`,
    });
    expect(blocked.status).toBe(503);
    expect(blocked.json).toMatchObject({
      error: 'not_ready',
      status: 'starting',
      db_status: 'initializing',
    });
    // Gate response is app JSON — not JSON-RPC from the MCP handler.
    expect(blocked.json).not.toHaveProperty('jsonrpc');
    expect(blocked.json).not.toHaveProperty('result');
    expect(blocked.text).not.toContain(TEST_MCP_TOKEN);
  });

  it('Test B: after ready, MCP requires bearer auth and accepts a valid token', async () => {
    loadConfig();
    mcpPath = getConfig().mcpPath;
    beginRuntimeInitialization();

    const started = await listen(createHttpApp());
    server = started.server;
    base = started.base;

    await initializeRuntime();
    expect(getRuntimeLifecycle().dbStatus).toBe('ready');

    const missing = await postMcp(base, mcpPath);
    expect(missing.status).toBe(401);
    expect(missing.json).toMatchObject({ error: 'unauthorized' });
    expect(missing.json).not.toHaveProperty('jsonrpc');
    expect(missing.text).not.toContain(TEST_MCP_TOKEN);

    const wrong = await postMcp(base, mcpPath, {
      authorization: 'Bearer wrong-token',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toMatchObject({ error: 'unauthorized' });
    expect(wrong.json).not.toHaveProperty('result');

    const ok = await postMcp(base, mcpPath, {
      authorization: `Bearer ${TEST_MCP_TOKEN}`,
    });
    expect(ok.status).toBe(200);
    expect(ok.contentType).toMatch(/text\/event-stream|application\/json/);
    // Reaching the MCP handler yields a JSON-RPC initialize result (not the gate/auth bodies).
    expect(ok.json).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(ok.json.error).toBeUndefined();
    const result = ok.json.result as
      | { serverInfo?: { name?: string }; protocolVersion?: string }
      | undefined;
    expect(result?.serverInfo?.name).toBe('mailsure-mcp');
    expect(result?.protocolVersion).toBeTruthy();
    expect(ok.text).not.toMatch(/"error"\s*:\s*"unauthorized"/);
    expect(ok.text).not.toMatch(/"error"\s*:\s*"not_ready"/);
    expect(ok.text).not.toContain(TEST_MCP_TOKEN);
  });
});

describe('Test C: authentication configuration fails closed', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.OPENVERIFY_HTTP_AUTH_TOKEN;
    delete process.env.OPENVERIFY_HTTP_HOST;
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    resetConfigCache();
  });

  it('rejects non-loopback HTTP bind without a token', () => {
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);
    process.env.OPENVERIFY_HTTP_HOST = '0.0.0.0';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    const cfg = loadConfig();
    expect(() => assertHttpAuthConfig(cfg)).toThrow(/OPENVERIFY_HTTP_AUTH_TOKEN is required/);
  });

  it('allows loopback HTTP bind without a token', () => {
    expect(isLoopbackBindHost('127.0.0.1')).toBe(true);
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    const cfg = loadConfig();
    expect(() => assertHttpAuthConfig(cfg)).not.toThrow();
  });

  it('startHttpServer refuses non-loopback without token before listen', async () => {
    process.env.OPENVERIFY_HTTP_HOST = '0.0.0.0';
    process.env.OPENVERIFY_HTTP_PORT = '18788';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    loadConfig();
    await expect(startHttpServer()).rejects.toThrow(/OPENVERIFY_HTTP_AUTH_TOKEN is required/);
  });
});
