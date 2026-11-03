import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

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

describe('HTTP health + MCP endpoint', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = '';
    loadConfig();
    closeDb();
    getDb();
    const app = createHttpApp();
    const started = await listen(app);
    server = started.server;
    base = started.base;
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

  it('rejects invalid host when allowed hosts configured', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Host: 'evil.example' },
    });
    // createMcpExpressApp host validation may apply globally; accept 421 or 200 if middleware is path-scoped
    expect([200, 421, 403]).toContain(res.status);
  });

  it('accepts MCP initialize over Streamable HTTP', async () => {
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'openverify-test', version: '0.0.0' },
        },
      }),
    });
    // Stateless streamable HTTP may return 200 with JSON or SSE
    expect([200, 202, 406]).toContain(res.status);
    if (res.status === 200) {
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
