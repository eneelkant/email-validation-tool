import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

async function listen(app: ReturnType<typeof createHttpApp>): Promise<{
  server: Server;
  base: string;
  port: number;
}> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  host: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          Host: opts.host,
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: d, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('HTTP health + MCP endpoint', () => {
  let server: Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
    process.env.OPENVERIFY_ALLOWED_HOSTS = '127.0.0.1,localhost';
    loadConfig();
    closeDb();
    getDb();
    const app = createHttpApp();
    const started = await listen(app);
    server = started.server;
    base = started.base;
    port = started.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    closeDb();
  });

  it('serves /health /ready /version', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);

    const version = await fetch(`${base}/version`);
    expect(version.status).toBe(200);
    const body = (await version.json()) as { name: string };
    expect(body.name).toBe('openverify-mcp');
  });

  it('rejects unauthorized Host header and does not reach MCP', async () => {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'host-reject', version: '0.0.0' },
      },
    });
    const res = await rawRequest({
      port,
      path: '/mcp',
      method: 'POST',
      host: 'evil.example',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(initBody)),
      },
      body: initBody,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Invalid Host/i);
    // Must not be a successful MCP initialize payload
    expect(res.body).not.toMatch(/"serverInfo"/);
    expect(res.body).not.toMatch(/protocolVersion/);
  });

  it('does not trust X-Forwarded-Host to bypass Host allowlist', async () => {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'xff-bypass', version: '0.0.0' },
      },
    });
    const res = await rawRequest({
      port,
      path: '/mcp',
      method: 'POST',
      host: 'evil.example',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-host': '127.0.0.1',
        'x-forwarded-proto': 'https',
        'content-length': String(Buffer.byteLength(initBody)),
      },
      body: initBody,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Invalid Host/i);
    expect(res.body).not.toMatch(/"serverInfo"/);
  });

  it('accepts authorized Host header on health', async () => {
    const res = await rawRequest({
      port,
      path: '/health',
      host: '127.0.0.1',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' });
  });

  it('accepts MCP initialize over Streamable HTTP with expected structure', async () => {
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
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'openverify-test', version: '0.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/text\/event-stream|application\/json/);

    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);

    // SSE framing from Streamable HTTP, or raw JSON
    const dataLine = text
      .split(/\r?\n/)
      .find((l) => l.startsWith('data: '));
    const payloadText = dataLine ? dataLine.slice('data: '.length) : text;
    const payload = JSON.parse(payloadText) as {
      jsonrpc: string;
      id: number;
      result?: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      };
      error?: unknown;
    };

    expect(payload.jsonrpc).toBe('2.0');
    expect(payload.id).toBe(1);
    expect(payload.error).toBeUndefined();
    expect(payload.result?.serverInfo.name).toBe('openverify-mcp');
    expect(payload.result?.protocolVersion).toBeTruthy();
    expect(payload.result?.capabilities).toBeTruthy();
  });
});
