import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resetConfigCache, loadConfig, getConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { createHttpApp, startHttpServer } from '../src/http/app.js';
import {
  assertHttpAuthConfig,
  isLoopbackBindHost,
  requireHttpAuth,
} from '../src/security/auth.js';
import { resetLogger, getLogger } from '../src/utils/logger.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { Request, Response } from 'express';

async function listenApp(host = '127.0.0.1'): Promise<{ server: Server; base: string; port: number }> {
  const app = createHttpApp();
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, host, () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address() as AddressInfo;
  return { server, base: `http://${host}:${addr.port}`, port: addr.port };
}

describe('loopback helpers', () => {
  it('recognizes loopback bind hosts', () => {
    expect(isLoopbackBindHost('127.0.0.1')).toBe(true);
    expect(isLoopbackBindHost('::1')).toBe(true);
    expect(isLoopbackBindHost('[::1]')).toBe(true);
    expect(isLoopbackBindHost('localhost')).toBe(true);
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);
    expect(isLoopbackBindHost('192.168.1.10')).toBe(false);
  });
});

describe('assertHttpAuthConfig fail-closed', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.OPENVERIFY_HTTP_AUTH_TOKEN;
    delete process.env.OPENVERIFY_HTTP_HOST;
    resetConfigCache();
  });

  it('allows localhost HTTP with no token', () => {
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    const cfg = loadConfig();
    expect(() => assertHttpAuthConfig(cfg)).not.toThrow();
  });

  it('fails startup config for external bind with no token', () => {
    process.env.OPENVERIFY_HTTP_HOST = '0.0.0.0';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    const cfg = loadConfig();
    expect(() => assertHttpAuthConfig(cfg)).toThrow(/OPENVERIFY_HTTP_AUTH_TOKEN is required/);
  });

  it('allows external bind when token is set', () => {
    process.env.OPENVERIFY_HTTP_HOST = '0.0.0.0';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = 'strong-token-value';
    const cfg = loadConfig();
    expect(() => assertHttpAuthConfig(cfg)).not.toThrow();
  });

  it('startHttpServer refuses non-loopback without token before listen', async () => {
    process.env.OPENVERIFY_HTTP_HOST = '0.0.0.0';
    process.env.OPENVERIFY_HTTP_PORT = '18787';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    loadConfig();
    await expect(startHttpServer()).rejects.toThrow(/OPENVERIFY_HTTP_AUTH_TOKEN is required/);
  });
});

describe('HTTP auth middleware', () => {
  let server: Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = 'test-secret-token';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    const started = await listenApp('127.0.0.1');
    server = started.server;
    base = started.base;
    port = started.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
    delete process.env.OPENVERIFY_HTTP_AUTH_TOKEN;
    resetConfigCache();
  });

  it('allows health without token', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('test-secret-token');
  });

  it('rejects MCP with missing bearer token — 401', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('test-secret-token');
  });

  it('rejects MCP with incorrect bearer token — 401', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts MCP with correct bearer token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer test-secret-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'auth-test', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('host-header validation rejects unauthorized host', async () => {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'evil.example',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer test-secret-token',
            'content-length': 2,
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
        },
      );
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatch(/Invalid Host/i);
  });

  it('never includes auth token in logger child bindings', () => {
    resetLogger();
    const logger = getLogger('auth-leak-check');
    const bindings = (logger as unknown as { bindings: () => Record<string, unknown> }).bindings?.();
    const serialized = JSON.stringify(bindings ?? {});
    expect(serialized).not.toContain('test-secret-token');
    expect(JSON.stringify(getConfig())).not.toMatch(/Bearer test-secret/);
  });
});

describe('localhost HTTP with no token', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    assertHttpAuthConfig(getConfig());
    const started = await listenApp('127.0.0.1');
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
  });

  it('allows MCP initialize without bearer on loopback when token unset', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'local-dev', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe('requireHttpAuth unit', () => {
  it('returns 401 JSON without leaking expected token', () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = 'super-secret-should-not-leak';
    loadConfig();
    const res = {
      statusCode: 0,
      body: '',
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = JSON.stringify(payload);
        return this;
      },
    };
    requireHttpAuth(
      { header: () => undefined } as unknown as Request,
      res as unknown as Response,
      () => {
        throw new Error('should not next');
      },
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('super-secret-should-not-leak');
  });
});
