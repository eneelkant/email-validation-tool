import './setup-env.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resetConfigCache, loadConfig } from '../src/config/env.js';
import { closeDb, getDb } from '../src/database/db.js';
import { createHttpApp } from '../src/http/app.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('HTTP auth', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    resetConfigCache();
    process.env.OPENVERIFY_HTTP_AUTH_TOKEN = 'test-secret-token';
    loadConfig();
    closeDb();
    getDb();
    const app = createHttpApp();
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
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
  });

  it('rejects MCP without token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts MCP with bearer token', async () => {
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'auth-test', version: '0.0.0' },
        },
      }),
    });
    expect([200, 202, 406]).toContain(res.status);
  });
});
