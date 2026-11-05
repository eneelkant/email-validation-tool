# MCP client setup — MailSure

MailSure MCP speaks the Model Context Protocol over **STDIO** (local IDE clients) and **Streamable HTTP** (remote). After `npm install && npm run build`, point the client at `node dist/index.js --transport stdio` (use an absolute path where the client requires it).

> Proprietary client UIs are not exercised in CI. Validate locally after installing Cursor / Claude Desktop / Gemini CLI / ChatGPT connectors.

Env configuration keys remain `OPENVERIFY_*` for compatibility with existing `.env` files and Docker/Render Blueprints.

## Cursor (STDIO)

In-repo example: [`.cursor/mcp.json`](../.cursor/mcp.json).

```json
{
  "mcpServers": {
    "mailsure": {
      "command": "node",
      "args": ["dist/index.js", "--transport", "stdio"],
      "env": {
        "OPENVERIFY_TRANSPORT": "stdio",
        "OPENVERIFY_LOG_LEVEL": "info",
        "OPENVERIFY_SMTP_ENABLED": "false"
      }
    }
  }
}
```

Prefer an absolute `args` path if Cursor’s working directory is not the repo root. Logs go to stderr only — stdout is reserved for MCP JSON-RPC.

## Claude Desktop / Claude Code (STDIO)

Example: [`examples/claude-desktop-config.json`](../examples/claude-desktop-config.json). Replace `/ABSOLUTE/PATH/TO/email-validation-tool` with your clone path, then merge into Claude’s MCP config.

## Gemini CLI (STDIO)

Example: [`.gemini/settings.json`](../.gemini/settings.json) — server alias `mailsure`, same STDIO command as Cursor.

## Remote Streamable HTTP (ChatGPT / other remote MCP clients)

1. Bind non-loopback only with a strong bearer token (fail-closed if missing).
2. Terminate **HTTPS** at Render or a reverse proxy.
3. Restrict `OPENVERIFY_ALLOWED_HOSTS`.

See [`examples/chatgpt-remote.md`](../examples/chatgpt-remote.md) and [`docs/render-deploy.md`](render-deploy.md).

```bash
export OPENVERIFY_TRANSPORT=http
export OPENVERIFY_HTTP_HOST=0.0.0.0
export OPENVERIFY_HTTP_PORT=8787
export OPENVERIFY_HTTP_AUTH_TOKEN='generate-a-long-random-token'
export OPENVERIFY_ALLOWED_HOSTS='your.domain.example'
npm run build && node dist/index.js --transport http
```

Client URL: `https://your.domain.example/mcp` with `Authorization: Bearer <token>`.

## Smoke checks (any transport)

| Step | Expectation |
|------|-------------|
| Initialize | `serverInfo.name` = `mailsure-mcp` |
| `tools/list` | 9 tools (`verify_email`, `verify_emails_batch`, `verify_csv`, `check_domain`, `get_validation_job`, `cancel_validation_job`, `get_statistics`, `clear_cache`, `update_disposable_domains`) |
| `tools/call` `verify_email` with `not-an-email` | `overall_status: invalid_syntax` |
| Shutdown (SIGTERM) | Clean exit |

HTTP-only: `GET /health`, `/ready`, `/version` succeed without auth and must not echo secrets. Expect `service: mailsure-api` and `product: MailSure MCP` on health/version.
