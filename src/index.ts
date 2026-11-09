#!/usr/bin/env node
/**
 * MailSure MCP entrypoint.
 * Supports --transport stdio|http|both (or OPENVERIFY_TRANSPORT — env names kept for compatibility).
 * STDIO mode never writes banners to stdout.
 *
 * HTTP/both: bind the listener before SQLite/disposable init so cloud health probes
 * (Enzonic / Render) are not blocked by cold-start DB work. DB-dependent routes wait
 * until runtime is ready.
 */
import { loadConfig } from './config/env.js';
import { getLogger } from './utils/logger.js';
import { closeDb } from './database/db.js';
import { startStdioServer } from './mcp/stdio.js';
import { startHttpServer } from './http/app.js';
import {
  beginRuntimeInitialization,
  initializeRuntime,
} from './runtime/lifecycle.js';

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

  const mode = cfg.transport;

  if (mode === 'stdio') {
    // STDIO clients expect tools immediately — initialize before serving.
    await initializeRuntime();
    await startStdioServer();
    return;
  }

  // HTTP / both: listen first, then initialize runtime in the background.
  beginRuntimeInitialization();
  const http = await startHttpServer();

  void initializeRuntime().catch((err) => {
    // Failure is recorded on the lifecycle; keep the process alive so /health
    // can report degraded and operators can diagnose without COLD_START_TIMEOUT.
    log.error({ err }, 'Background runtime initialization failed');
  });

  if (mode === 'both') {
    log.warn(
      'Transport "both" starts HTTP in this process. For STDIO clients, run with --transport stdio.',
    );
  }

  const shutdown = async () => {
    log.info('Shutting down HTTP server');
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
