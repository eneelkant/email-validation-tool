import { McpServer } from '@modelcontextprotocol/server';
import { getConfig } from '../config/env.js';
import { registerTools } from './tools.js';

/**
 * Factory: create a fresh McpServer with all MailSure MCP tools registered.
 * Required for per-request Streamable HTTP and safe for STDIO.
 * Function name kept for import-path compatibility; MCP serverInfo.name is MailSure.
 */
export function createOpenVerifyServer(): McpServer {
  const cfg = getConfig();
  const server = new McpServer(
    {
      name: 'mailsure-mcp',
      version: cfg.version,
    },
    {
      instructions:
        'MailSure MCP — free, open-source, self-hosted email verification. ' +
        'Use verify_email / verify_emails_batch / verify_csv / check_domain for validation signals. ' +
        'Results do not prove individual mailbox existence. SMTP diagnostics are off unless configured. ' +
        'Admin tools (clear_cache, update_disposable_domains, job cancel) are MCP-only — not the public website API.',
    },
  );
  registerTools(server);
  return server;
}
