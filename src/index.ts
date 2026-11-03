#!/usr/bin/env node
/**
 * OpenVerify MCP entrypoint.
 * Supports --transport stdio|http|both (or OPENVERIFY_TRANSPORT).
 * STDIO mode never writes banners to stdout.
 */
import { loadConfig } from './config/env.js';
import { getLogger } from './utils/logger.js';
import { getDb, closeDb } from './database/db.js';
import { loadDisposableDomains } from './validators/disposable.js';
import { startStdioServer } from './mcp/stdio.js';
import { startHttpServer } from './http/app.js';

function parseTransportArg(): string | undefined {
  const idx = process.argv.indexOf('--transport');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith('--transport='));
  if (eq) return eq.split('=')[1];
  return undefined;
}

async function main(): Promise<void> {
  const transportArg = parseTransportArg();
  if (transportArg) {
    process.env.OPENVERIFY_TRANSPORT = transportArg;
  }

  const cfg = loadConfig();
  const log = getLogger('main');

  getDb();
  loadDisposableDomains();

  const mode = cfg.transport;

  if (mode === 'stdio') {
    await startStdioServer();
    return;
  }

  if (mode === 'http') {
    const http = await startHttpServer();
    const shutdown = async () => {
      log.info('Shutting down HTTP server');
      await http.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    return;
  }

  // both
  const http = await startHttpServer();
  // STDIO in "both" is unusual for a single process; prefer HTTP here and
  // document that Cursor/Claude should use the stdio entry separately.
  log.warn(
    'Transport "both" starts HTTP in this process. For STDIO clients, run with --transport stdio.',
  );
  const shutdown = async () => {
    await http.close();
    closeDb();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  // Always stderr
  console.error(err);
  process.exit(1);
});
