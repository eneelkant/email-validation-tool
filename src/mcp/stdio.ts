import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createOpenVerifyServer } from './server.js';
import { getLogger } from '../utils/logger.js';
import { closeDb, getDb } from '../database/db.js';
import { loadDisposableDomains } from '../validators/disposable.js';

const log = getLogger('stdio');

/**
 * Start OpenVerify over STDIO. Logs go to stderr only.
 */
export async function startStdioServer(): Promise<void> {
  // Touch DB + disposable dataset before protocol traffic
  getDb();
  loadDisposableDomains();

  log.info('Starting OpenVerify MCP over STDIO');

  const handle = serveStdio(() => createOpenVerifyServer());

  const shutdown = async () => {
    log.info('Shutting down STDIO server');
    try {
      await handle.close();
    } finally {
      closeDb();
    }
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}
