import { McpServer } from '@modelcontextprotocol/server';
import { getConfig } from '../config/env.js';
import { registerTools } from './tools.js';

/**
 * Factory: create a fresh McpServer with all OpenVerify tools registered.
 * Required for per-request Streamable HTTP and safe for STDIO.
 */
export function createOpenVerifyServer(): McpServer {
  const cfg = getConfig();
  const server = new McpServer({
    name: 'openverify-mcp',
    version: cfg.version,
  });
  registerTools(server);
  return server;
}
